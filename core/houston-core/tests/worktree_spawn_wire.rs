#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static SHIM: OnceLock<PathBuf> = OnceLock::new();

/// Fake agent CLIs that print their working directory, so a test sees where the
/// child process really started rather than what the daemon recorded.
fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'CWD:%s\\n' \"$PWD\"\necho FIXTURE-READY\nexec cat\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    !git(repo, &["branch", "--list", branch]).trim().is_empty()
}

struct Rig {
    daemon: Arc<Daemon>,
    addr: SocketAddr,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str, with_git: bool) -> Rig {
    shim_dir();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    if with_git {
        init_repo(&ws_dir);
    }
    let ws_dir = ws_dir.canonicalize().unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    Rig {
        daemon,
        addr,
        state,
        ws_dir,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Row {
    path: String,
    branch: String,
    provenance: String,
    created_by_session: Option<u32>,
}

impl Rig {
    fn pane(&self) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PANE-UP; exec cat".into(),
                ]),
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
            })
            .expect("fixture pane spawns")
    }

    fn token_for(&self, session: u32) -> String {
        self.daemon.mcp_creds.issue(McpScope {
            session_id: session,
            workspace_id: self.ws_dir.display().to_string(),
        })
    }

    fn db_path(&self) -> PathBuf {
        self.state.path().join("test.db")
    }

    fn rows(&self) -> Vec<Row> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT path, branch, provenance, created_by_session FROM managed_worktrees \
                 ORDER BY path",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Row {
                path: r.get(0)?,
                branch: r.get(1)?,
                provenance: r.get(2)?,
                created_by_session: r.get(3)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn worktrees_dir(&self) -> PathBuf {
        self.ws_dir.join(".houston").join("worktrees")
    }

    fn session_count(&self) -> usize {
        self.daemon.list().len()
    }

    async fn spawn(&self, token: &str, args: serde_json::Value) -> serde_json::Value {
        mcp_call(self.addr, token, "pane_spawn", args).await
    }
}

async fn http_json(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: &str,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let (method, path, token) = (method.to_string(), path.to_string(), token.to_string());
    tokio::task::spawn_blocking(move || {
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            addr,
            payload.len()
        );
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("http status line");
        let value: serde_json::Value =
            serde_json::from_str(resp.trim_start()).unwrap_or(serde_json::Value::Null);
        (status, value)
    })
    .await
    .unwrap()
}

async fn mcp_call(
    addr: SocketAddr,
    token: &str,
    tool: &str,
    args: serde_json::Value,
) -> serde_json::Value {
    let (status, body) = http_json(
        addr,
        "POST",
        "/mcp",
        token,
        Some(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        })),
    )
    .await;
    assert_eq!(status, 200, "tools/call {tool}: {body}");
    body["result"].clone()
}

fn refusal_text(result: &serde_json::Value) -> String {
    assert_eq!(result["isError"], true, "expected a refusal: {result}");
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn spawned_session(result: &serde_json::Value) -> u32 {
    assert_eq!(result["isError"], false, "expected a spawn: {result}");
    result["structuredContent"]["session"].as_u64().unwrap() as u32
}

async fn await_output(daemon: &Arc<Daemon>, session: u32, needle: &str) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let replay = daemon.scrollback(session, None).unwrap();
        let text = String::from_utf8_lossy(&replay.data).into_owned();
        if text.contains(needle) {
            return text;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "session {session} never printed {needle:?}: {text:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn pane_spawn_with_a_worktree_starts_the_child_inside_a_recorded_tree() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-tree", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);

    let result = r
        .spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await;
    let child = spawned_session(&result);
    let tree = r.worktrees_dir().join("demo");

    let out = await_output(&r.daemon, child, "FIXTURE-READY").await;
    assert!(
        out.contains(&format!("CWD:{}", tree.display())),
        "the child process must start in the worktree: {out:?}"
    );
    let listed = git(&r.ws_dir, &["worktree", "list", "--porcelain"]);
    assert!(
        listed.contains(&format!("worktree {}", tree.display()))
            && listed.contains("branch refs/heads/houston/demo"),
        "{listed}"
    );
    assert_eq!(
        r.rows(),
        vec![Row {
            path: tree.display().to_string(),
            branch: "houston/demo".into(),
            provenance: "pane_spawn".into(),
            created_by_session: Some(parent.id),
        }]
    );
}

#[tokio::test]
async fn pane_spawn_uses_the_branch_it_was_given() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-branch", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);

    let result = r
        .spawn(
            &token,
            serde_json::json!({
                "kind": "grok",
                "prompt": "go",
                "worktree": "demo",
                "branch": "feat/demo-branch",
            }),
        )
        .await;
    spawned_session(&result);
    let tree = r.worktrees_dir().join("demo");

    assert_eq!(
        git(&tree, &["branch", "--show-current"]).trim(),
        "feat/demo-branch"
    );
    assert!(!branch_exists(&r.ws_dir, "houston/demo"));
    assert_eq!(r.rows()[0].branch, "feat/demo-branch");
}

#[tokio::test]
async fn the_worktrees_dir_gets_a_gitignore_once() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-ignore", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let gitignore = r.worktrees_dir().join(".gitignore");

    spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "one"}),
        )
        .await,
    );
    assert_eq!(std::fs::read_to_string(&gitignore).unwrap(), "*\n");

    std::fs::write(&gitignore, "keep\n").unwrap();
    spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "two"}),
        )
        .await,
    );
    assert_eq!(
        std::fs::read_to_string(&gitignore).unwrap(),
        "keep\n",
        "an existing .gitignore is left alone"
    );
    std::fs::write(&gitignore, "*\n").unwrap();
    assert_eq!(
        git(&r.ws_dir, &["status", "--porcelain", "--", ".houston"]),
        "",
        "neither worktree may show in the workspace's own status"
    );
}

#[tokio::test]
async fn a_worktree_spawn_outside_git_is_refused_and_creates_nothing() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-no-git", false).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let before = r.session_count();

    let text = refusal_text(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await,
    );
    assert!(
        text.contains(&r.ws_dir.display().to_string()) && text.contains("not a git repository"),
        "{text}"
    );
    assert_eq!(r.session_count(), before);
    assert!(r.rows().is_empty());
    assert!(!r.worktrees_dir().exists());
}

#[tokio::test]
async fn a_taken_slug_or_branch_is_refused_by_name() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-taken", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);

    let taken = r.worktrees_dir().join("demo");
    std::fs::create_dir_all(&taken).unwrap();
    let before = r.session_count();
    let text = refusal_text(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await,
    );
    assert!(text.contains(&taken.display().to_string()), "{text}");
    assert_eq!(r.session_count(), before);

    git(&r.ws_dir, &["branch", "houston/other"]);
    let text = refusal_text(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "other"}),
        )
        .await,
    );
    assert!(text.contains("houston/other"), "{text}");
    assert_eq!(r.session_count(), before);
    assert!(r.rows().is_empty());
}

#[tokio::test]
async fn worktree_and_cwd_together_are_refused() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-cwd", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let before = r.session_count();

    let text = refusal_text(
        &r.spawn(
            &token,
            serde_json::json!({
                "kind": "grok",
                "prompt": "go",
                "worktree": "demo",
                "cwd": r.ws_dir.display().to_string(),
            }),
        )
        .await,
    );
    assert!(text.contains("cannot be combined"), "{text}");
    assert_eq!(r.session_count(), before);
    assert!(!r.worktrees_dir().join("demo").exists());
}

#[tokio::test]
async fn an_invalid_slug_is_refused_naming_the_rule() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-slug", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let before = r.session_count();

    for (slug, rule) in [
        ("", "it is empty"),
        ("a/b", "path separator"),
        ("..", "`..`"),
        ("a b", "whitespace"),
    ] {
        let text = refusal_text(
            &r.spawn(
                &token,
                serde_json::json!({"kind": "grok", "prompt": "go", "worktree": slug}),
            )
            .await,
        );
        assert!(
            text.contains(&format!("{slug:?}")) && text.contains(rule),
            "slug {slug:?} must be refused naming it and the rule {rule:?}: {text}"
        );
    }
    assert_eq!(r.session_count(), before);
    assert!(r.rows().is_empty());
}

#[tokio::test]
async fn a_spawn_that_fails_after_the_tree_was_made_removes_it() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-rollback", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);

    // With the delegations table gone the child spawns and then cannot be recorded, so
    // the daemon rolls it back after the worktree already exists.
    let conn = rusqlite::Connection::open(r.db_path()).unwrap();
    conn.execute_batch("ALTER TABLE delegations RENAME TO delegations_hidden_by_test")
        .unwrap();
    drop(conn);
    let result = r
        .spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await;
    let conn = rusqlite::Connection::open(r.db_path()).unwrap();
    conn.execute_batch("ALTER TABLE delegations_hidden_by_test RENAME TO delegations")
        .unwrap();
    drop(conn);

    refusal_text(&result);
    assert!(!r.worktrees_dir().join("demo").exists());
    assert!(!branch_exists(&r.ws_dir, "houston/demo"));
    assert!(r.rows().is_empty());
    assert!(!git(&r.ws_dir, &["worktree", "list"]).contains("demo"));
}

#[tokio::test]
async fn a_changes_pane_worktree_is_recorded() {
    let _guard = SERIAL.lock().await;
    let r = rig("changes-pane", true).await;
    let mut ws = connect_and_hello(r.addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::GitWorktreeCreate {
            dir: r.ws_dir.display().to_string(),
            name: "review".to_string(),
            base: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let message = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::GitWorktrees {
                message: Some(m), ..
            } => break m,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    };

    let rows = r.rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].provenance, "changes_pane");
    assert_eq!(rows[0].created_by_session, None);
    assert_eq!(rows[0].branch, "houston/review");
    assert!(
        message.contains(&rows[0].path),
        "the reply names the recorded path: {message} / {}",
        rows[0].path
    );
}

#[tokio::test]
async fn the_hs_pane_door_creates_the_worktree_and_reports_refusals() {
    let _guard = SERIAL.lock().await;
    let r = rig("hs-pane-door", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);

    // The body `hs-pane spawn --worktree demo --branch feat/door` sends.
    let (status, body) = http_json(
        r.addr,
        "POST",
        "/orchestrate/spawn",
        &token,
        Some(serde_json::json!({
            "kind": "grok",
            "prompt": "go",
            "worktree": "demo",
            "branch": "feat/door",
        })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let child = body["session_id"].as_u64().unwrap() as u32;
    let tree = r.worktrees_dir().join("demo");
    let out = await_output(&r.daemon, child, "FIXTURE-READY").await;
    assert!(out.contains(&format!("CWD:{}", tree.display())), "{out:?}");
    assert_eq!(
        r.rows(),
        vec![Row {
            path: tree.display().to_string(),
            branch: "feat/door".into(),
            provenance: "pane_spawn".into(),
            created_by_session: Some(parent.id),
        }]
    );

    let (status, body) = http_json(
        r.addr,
        "POST",
        "/orchestrate/spawn",
        &token,
        Some(serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "a/b"})),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("path separator"),
        "{body}"
    );
    assert_eq!(r.rows().len(), 1);
}

async fn changes_pane_reply(ws: &mut WsStream, msg: proto::ClientMsg) -> String {
    ws.send(Message::text(serde_json::to_string(&msg).unwrap()))
        .await
        .unwrap();
    loop {
        match next_control(ws).await {
            proto::ServerMsg::GitWorktrees {
                message: Some(m), ..
            } => return m,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn removing_a_worktree_from_the_changes_pane_frees_its_slug() {
    let _guard = SERIAL.lock().await;
    let r = rig("changes-remove", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let tree = r.worktrees_dir().join("demo");
    spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await,
    );

    let mut ws = connect_and_hello(r.addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    changes_pane_reply(
        &mut ws,
        proto::ClientMsg::GitWorktreeRemove {
            dir: r.ws_dir.display().to_string(),
            path: tree.display().to_string(),
            force: false,
        },
    )
    .await;
    assert!(
        r.rows().is_empty(),
        "a removed worktree keeps no row: {:?}",
        r.rows()
    );

    git(&r.ws_dir, &["branch", "-D", "houston/demo"]);
    spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await,
    );
    assert!(tree.is_dir());
    assert_eq!(r.rows().len(), 1, "{:?}", r.rows());
}

#[tokio::test]
async fn a_worktree_deleted_by_hand_does_not_block_its_slug() {
    let _guard = SERIAL.lock().await;
    let r = rig("hand-deleted", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let tree = r.worktrees_dir().join("demo");
    spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await,
    );

    std::fs::remove_dir_all(&tree).unwrap();
    git(&r.ws_dir, &["worktree", "prune"]);
    let second = r
        .spawn(
            &token,
            serde_json::json!({
                "kind": "grok",
                "prompt": "go",
                "worktree": "demo",
                "branch": "feat/second",
            }),
        )
        .await;
    spawned_session(&second);
    assert!(tree.is_dir(), "the new worktree must survive its spawn");
    assert_eq!(
        r.rows(),
        vec![Row {
            path: tree.display().to_string(),
            branch: "feat/second".into(),
            provenance: "pane_spawn".into(),
            created_by_session: Some(parent.id),
        }],
        "the stale row gives way to the new worktree's"
    );
}

#[tokio::test]
async fn an_invalid_branch_is_refused_before_anything_is_created() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-bad-branch", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let before = r.session_count();

    for branch in ["a..b", "x.lock", "-x"] {
        let text = refusal_text(
            &r.spawn(
                &token,
                serde_json::json!({
                    "kind": "grok",
                    "prompt": "go",
                    "worktree": "demo",
                    "branch": branch,
                }),
            )
            .await,
        );
        assert!(
            text.contains(&format!("{branch:?}")) && text.contains("branch name"),
            "branch {branch:?} must be refused by name: {text}"
        );
    }
    assert_eq!(r.session_count(), before);
    assert!(r.rows().is_empty());
    assert!(
        !r.ws_dir.join(".houston").join("worktrees").exists(),
        "a refused branch must not leave the worktrees dir behind"
    );
}

#[tokio::test]
async fn a_rollback_that_cannot_remove_the_tree_keeps_its_row() {
    let _guard = SERIAL.lock().await;
    let r = rig("spawn-stuck-rollback", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let tree = r.worktrees_dir().join("demo");

    // A locked worktree refuses a single `--force`, so the rollback's removal fails.
    let hook = r.ws_dir.join(".git").join("hooks").join("post-checkout");
    std::fs::write(
        &hook,
        "#!/bin/sh\ngit worktree lock --reason held-by-test \"$(pwd)\"\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let conn = rusqlite::Connection::open(r.db_path()).unwrap();
    conn.execute_batch("ALTER TABLE delegations RENAME TO delegations_hidden_by_test")
        .unwrap();
    drop(conn);
    let result = r
        .spawn(
            &token,
            serde_json::json!({"kind": "grok", "prompt": "go", "worktree": "demo"}),
        )
        .await;
    let conn = rusqlite::Connection::open(r.db_path()).unwrap();
    conn.execute_batch("ALTER TABLE delegations_hidden_by_test RENAME TO delegations")
        .unwrap();
    drop(conn);

    refusal_text(&result);
    assert!(tree.is_dir(), "the locked tree is still there");
    assert!(branch_exists(&r.ws_dir, "houston/demo"));
    assert_eq!(
        r.rows().iter().map(|row| &row.path).collect::<Vec<_>>(),
        vec![&tree.display().to_string()],
        "a tree the rollback could not remove stays known to Houston"
    );
}

#[tokio::test]
async fn k4_session_worktree_metadata_groups_nested_shared_checkouts_and_survives_reopen() {
    let _guard = SERIAL.lock().await;
    let r = rig("metadata", true).await;
    let parent = r.pane();
    let token = r.token_for(parent.id);
    let mut ws = connect_and_hello(r.addr, TOKEN).await;
    assert!(matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::HelloOk { .. }
    ));
    let child = spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({
                "kind": "grok", "prompt": "go", "worktree": "metadata", "branch": "feat/metadata"
            }),
        )
        .await,
    );
    let created = loop {
        if let proto::ServerMsg::SessionCreated { info } = next_control(&mut ws).await {
            if info.id == child {
                break info;
            }
        }
    };
    let tree = r.worktrees_dir().join("metadata").canonicalize().unwrap();
    let root = tree.display().to_string();
    assert_eq!(created.checkout_root.as_deref(), Some(root.as_str()));
    let metadata = created.worktree.unwrap();
    assert_eq!(metadata.path, root);
    assert_eq!(metadata.branch, "feat/metadata");
    assert_eq!(
        metadata.repo_common_dir,
        git(
            &r.ws_dir,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"]
        )
        .trim()
    );
    let nested = tree.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let sibling = spawned_session(
        &r.spawn(
            &token,
            serde_json::json!({
                "kind": "grok", "prompt": "read", "cwd": nested
            }),
        )
        .await,
    );
    let infos = r.daemon.list();
    let shared = infos.iter().find(|info| info.id == sibling).unwrap();
    assert_eq!(shared.checkout_root.as_deref(), Some(root.as_str()));
    assert_eq!(shared.worktree.as_ref().unwrap().path, root);
    assert!(infos
        .iter()
        .find(|info| info.id == parent.id)
        .unwrap()
        .worktree
        .is_none());
    assert_eq!(
        parent.checkout_root.as_deref(),
        Some(r.ws_dir.to_str().unwrap())
    );
    let snapshot = r.state.path().join("metadata-reopen.db");
    rusqlite::Connection::open(r.db_path())
        .unwrap()
        .execute("VACUUM INTO ?1", [snapshot.to_str().unwrap()])
        .unwrap();
    r.daemon.kill(child).unwrap();
    r.daemon.kill(sibling).unwrap();
    r.daemon.kill(parent.id).unwrap();
    let reopened = Daemon::new_with_safe_mode_flags_for_test(
        houston_core::daemon::DaemonConfig {
            token: TOKEN.into(),
            db_path: snapshot,
        },
        houston_core::daemon::SafeModeFlags {
            disable_auto_restore: true,
            ..Default::default()
        },
    )
    .unwrap();
    let infos = reopened.list();
    for id in [child, sibling] {
        let info = infos.iter().find(|info| info.id == id).unwrap();
        assert_eq!(info.checkout_root.as_deref(), Some(root.as_str()));
        assert_eq!(info.worktree.as_ref().unwrap().branch, "feat/metadata");
    }
}

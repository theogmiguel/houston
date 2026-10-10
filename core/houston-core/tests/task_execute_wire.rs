#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

/// Fake agent CLIs that print their argv, so a test sees the launched brief and
/// can drive the child's turn by hand.
fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'ARG:%s\\n' \"$@\"\n\
                 echo FIXTURE-READY\nexec cat\n",
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

struct Rig {
    daemon: Arc<Daemon>,
    addr: std::net::SocketAddr,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str) -> Rig {
    shim_dir();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    init_repo(&ws_dir);
    let ws_dir = ws_dir.canonicalize().unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    Rig {
        daemon,
        addr,
        state,
        ws_dir,
    }
}

impl Rig {
    fn workspace(&self) -> String {
        self.ws_dir.display().to_string()
    }

    fn db_path(&self) -> PathBuf {
        self.state.path().join("test.db")
    }

    fn parent(&self) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PARENT-UP; exec cat".into(),
                ]),
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
                model: None,
                effort: None,
            })
            .expect("fixture pane spawns")
            .id
    }

    fn token_for(&self, session: u32) -> String {
        self.daemon.mcp_creds.issue(McpScope {
            session_id: session,
            workspace_id: self.workspace(),
        })
    }

    async fn mcp(&self, token: &str, method: &str, params: Value) -> Value {
        let (token, method, params) = (token.to_string(), method.to_string(), params);
        let addr = self.addr;
        tokio::task::spawn_blocking(move || {
            let payload =
                json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
                    .to_string();
            let req = format!(
                "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\
                 Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            let mut stream = std::net::TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            use std::io::{Read, Write};
            stream.write_all(req.as_bytes()).unwrap();
            let mut raw = String::new();
            stream.read_to_string(&mut raw).unwrap();
            let (_, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
            serde_json::from_str(resp.trim_start()).unwrap()
        })
        .await
        .unwrap()
    }

    async fn tools_list(&self, token: &str) -> Vec<String> {
        let body = self.mcp(token, "tools/list", json!({})).await;
        body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn create_task(&self, title: &str, acceptance: &[&str]) -> i64 {
        let patch = proto::TaskPatch {
            title: Some(title.to_string()),
            description: Some("The login page crashes on an empty password.".to_string()),
            status: Some(proto::TaskStatus::Todo),
            acceptance: Some(acceptance.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        };
        match self
            .daemon
            .task_save(&self.workspace(), None, None, patch)
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }

    fn task_status(&self, id: i64) -> String {
        let proto::ServerMsg::TaskDetail { task, .. } = self.daemon.task_get(id).unwrap() else {
            panic!("expected TaskDetail");
        };
        format!("{:?}", task.status).to_lowercase()
    }

    fn acceptance_checked(&self, id: i64) -> Vec<bool> {
        let proto::ServerMsg::TaskDetail { acceptance, .. } = self.daemon.task_get(id).unwrap()
        else {
            panic!("expected TaskDetail");
        };
        acceptance
            .into_iter()
            .map(|item| item.checked_at_ms.is_some())
            .collect()
    }

    fn comments(&self, id: i64) -> Vec<String> {
        let proto::ServerMsg::TaskDetail { comments, .. } = self.daemon.task_get(id).unwrap()
        else {
            panic!("expected TaskDetail");
        };
        comments.into_iter().map(|comment| comment.body).collect()
    }

    fn runs(&self) -> Vec<Run> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, attempt, kind, state, session_id, delegation_id, \
                        worktree_path, branch, summary, reason FROM backlog_task_runs ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Run {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt: r.get(2)?,
                kind: r.get(3)?,
                state: r.get(4)?,
                session_id: r.get(5)?,
                delegation_id: r.get(6)?,
                worktree_path: r.get(7)?,
                branch: r.get(8)?,
                summary: r.get(9)?,
                reason: r.get(10)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn latest_run_of(&self, kind: &str) -> Run {
        self.runs()
            .into_iter()
            .rfind(|run| run.kind == kind)
            .unwrap_or_else(|| panic!("no {kind} run recorded"))
    }

    async fn await_output(&self, session: u32, needle: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let replay = self.daemon.scrollback(session, None).unwrap();
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
}

#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
struct Run {
    id: i64,
    task_id: i64,
    attempt: u32,
    kind: String,
    state: String,
    session_id: Option<u32>,
    delegation_id: Option<u32>,
    worktree_path: Option<String>,
    branch: Option<String>,
    summary: Option<String>,
    reason: Option<String>,
}

#[tokio::test]
async fn execute_is_advertised_only_to_a_spawnable_caller_and_refused_by_name() {
    let _guard = SERIAL.lock().await;
    let r = rig("execute-advert").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let parent_token = r.token_for(parent);
    let names = r.tools_list(&parent_token).await;
    for must in ["task_execute", "task_review"] {
        assert!(
            names.iter().any(|name| name == must),
            "a spawnable orchestrator sees {must}: {names:?}"
        );
    }

    // An operator (orchestration off) does not see them.
    r.daemon.orchestration_set(false).unwrap();
    let operator = r.parent();
    let operator_token = r.token_for(operator);
    let names = r.tools_list(&operator_token).await;
    for forbidden in ["task_execute", "task_review"] {
        assert!(
            !names.iter().any(|name| name == forbidden),
            "an operator sees no {forbidden}: {names:?}"
        );
    }
    let refused = r
        .mcp(
            &operator_token,
            "tools/call",
            json!({
                "name": "task_execute",
                "arguments": { "id": 1, "agent": "grok" },
            }),
        )
        .await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    let message = refused["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_lowercase();
    assert!(message.contains("orchestration"), "{message}");
    assert!(message.contains("settings"), "{message}");

    // A leaf child sees no task tool at all.
    r.daemon.orchestration_set(true).unwrap();
    let child = r
        .daemon
        .orchestrate_spawn(
            parent,
            proto::AgentKind::Grok,
            None,
            None,
            "leaf brief".to_string().into(),
            None,
            None,
            None,
        )
        .unwrap();
    let child_token = r.token_for(child.id);
    let names = r.tools_list(&child_token).await;
    assert!(
        names.iter().all(|name| !name.starts_with("task_")),
        "a leaf child's scope is the brief: {names:?}"
    );
}

#[tokio::test]
async fn execute_spawns_a_child_with_a_delegation_and_the_task_worktree() {
    let _guard = SERIAL.lock().await;
    let r = rig("execute-child").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let id = r.create_task("Fix login", &["Login no longer crashes `true`"]);

    let reply = r
        .daemon
        .task_execute(
            &r.workspace(),
            id,
            parent,
            proto::AgentKind::Grok,
            None,
            "task_execute",
        )
        .unwrap();
    assert!(
        matches!(reply, proto::ServerMsg::TaskChanged { id: changed, .. } if changed == id),
        "{reply:?}"
    );

    let runs = r.runs();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let run = &runs[0];
    assert_eq!(run.kind, "implementation");
    assert_eq!(run.state, "running");
    assert_eq!(run.attempt, 1);
    let session = run.session_id.expect("the child is bound");
    let delegation_id = run.delegation_id.expect("the run stores its delegation");
    let worktree = PathBuf::from(run.worktree_path.clone().unwrap());
    assert!(worktree.is_dir(), "{}", worktree.display());
    assert!(
        run.branch
            .as_deref()
            .unwrap()
            .starts_with("houston/task/hou-1"),
        "{:?}",
        run.branch
    );
    let delegation = r
        .daemon
        .delegation_of(session)
        .expect("a delegation exists");
    assert_eq!(delegation.id, i64::from(delegation_id));
    assert_eq!(delegation.role.as_deref(), Some("hou-1"));
    assert_eq!(delegation.parent_session, parent);

    let out = r.await_output(session, "FIXTURE-READY").await;
    assert!(out.contains("HOUSTON-TASK-DATA"), "{out:?}");
    assert!(
        out.contains("task_result"),
        "the child brief names the structured result: {out:?}"
    );
    assert_eq!(r.task_status(id), "inprogress");
}

#[tokio::test]
async fn a_structured_result_ticks_acceptance_and_moves_to_review() {
    let _guard = SERIAL.lock().await;
    let r = rig("execute-result").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let id = r.create_task(
        "Fix login",
        &["Login no longer crashes `true`", "A test covers it `true`"],
    );
    r.daemon
        .task_execute(
            &r.workspace(),
            id,
            parent,
            proto::AgentKind::Grok,
            None,
            "task_execute",
        )
        .unwrap();
    let run = r.latest_run_of("implementation");
    let child = run.session_id.unwrap();

    let body = "The login fix is in.\n\
                {\"task_result\":{\"status\":\"complete\",\"summary\":\"guarded the empty \
                password\",\"checks\":[{\"name\":\"Login no longer crashes `true`\",\"passed\":true,\
                \"evidence\":\"tests/login.rs\"},{\"name\":\"A test covers it `true`\",\"passed\":false,\
                \"evidence\":\"\"}]}}";
    r.daemon
        .orchestrate_submit(child, body.to_string().into())
        .unwrap();

    assert_eq!(r.task_status(id), "inreview");
    assert_eq!(r.acceptance_checked(id), vec![true, false]);
    let settled = r.latest_run_of("implementation");
    assert_eq!(settled.state, "handed_back");
    let summary = settled.summary.expect("the run keeps the summary");
    assert!(summary.contains("guarded the empty password"), "{summary}");
    assert!(
        r.comments(id)
            .iter()
            .any(|comment| comment.contains("guarded the empty password")),
        "{:?}",
        r.comments(id)
    );
}

#[tokio::test]
async fn a_malformed_result_leaves_the_run_needing_review_with_the_raw_text() {
    let _guard = SERIAL.lock().await;
    let r = rig("execute-malformed").await;
    r.daemon.orchestration_set(true).unwrap();
    let parent = r.parent();
    let id = r.create_task("Fix login", &["Login no longer crashes `true`"]);
    r.daemon
        .task_execute(
            &r.workspace(),
            id,
            parent,
            proto::AgentKind::Grok,
            None,
            "task_execute",
        )
        .unwrap();
    let run = r.latest_run_of("implementation");
    let child = run.session_id.unwrap();

    r.daemon
        .orchestrate_submit(
            child,
            "I finished the work but forgot the structured line."
                .to_string()
                .into(),
        )
        .unwrap();

    let settled = r.latest_run_of("implementation");
    assert_eq!(settled.state, "needs_review");
    assert!(
        settled
            .summary
            .as_deref()
            .unwrap()
            .contains("forgot the structured line"),
        "{:?}",
        settled.summary
    );
    assert_eq!(
        r.task_status(id),
        "inprogress",
        "a malformed result never moves the task on its own"
    );
}

#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
#![cfg(unix)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::db::Db;
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use proto::RemoteTier;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Reply {
    status: u16,
    body: String,
}

impl Reply {
    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body is not JSON ({e}): {}", self.body))
    }

    fn error(&self) -> String {
        self.json()["error"]
            .as_str()
            .unwrap_or_else(|| panic!("no error in {}", self.body))
            .to_string()
    }
}

async fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Reply {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nHost: {addr}\r\n");
    if let Some(token) = token {
        req.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(body) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(body) = body {
        req.push_str(body);
    }
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(20), stream.read_to_end(&mut raw))
        .await
        .expect("response within 20 s")
        .unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").expect("a complete response");
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    Reply { status, body }
}

fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        body = &rest[n + 2..];
    }
    out
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn enable(daemon: &Daemon) -> SocketAddr {
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{}", free_port())),
            ..Default::default()
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(addr) = daemon.remote_listen_state().listening {
            return addr;
        }
        assert!(tokio::time::Instant::now() < deadline, "no listener");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A daemon with remote access on and one paired device at `tier`.
async fn phone(tier: RemoteTier) -> (Arc<Daemon>, SocketAddr, String, i64, tempfile::TempDir) {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Test phone" }).to_string();
    let reply = request(addr, "POST", "/api/pair", None, Some(&body)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let token = reply.json()["token"].as_str().unwrap().to_string();
    let id = reply.json()["device_id"].as_i64().unwrap();
    daemon.remote_device_set_tier(id, tier).unwrap();
    (daemon, addr, token, id, state)
}

fn pane(daemon: &Arc<Daemon>, cmd: &[&str]) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
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
        .unwrap();
    (info, dir)
}

#[test]
fn devices_paired_before_tiers_existed_migrate_to_drive() {
    let state = tempfile::tempdir().unwrap();
    let path = state.path().join("legacy.db");
    drop(Db::open(&path).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE remote_devices DROP COLUMN tier;
             INSERT INTO remote_devices (name, token_hash, created_at, last_seen_at)
             VALUES ('Old phone', 'hash-old', 1, 1);",
        )
        .unwrap();
    }
    let db = Db::open(&path).unwrap();
    let devices = db.remote_devices().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "Old phone");
    assert_eq!(devices[0].tier, RemoteTier::Drive);
    let id = db.remote_device_insert("New phone", "hash-new", 2).unwrap();
    let fresh = db.remote_device_by_hash("hash-new").unwrap().unwrap();
    assert_eq!((fresh.id, fresh.tier), (id, RemoteTier::Drive));
}

#[tokio::test]
async fn a_new_pairing_is_drive_and_me_reports_the_tier() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let _state = state;
    tokio::spawn(daemon.clone().remote_loops());
    let addr = enable(&daemon).await;
    let code = daemon.remote_pair_start().code;
    let body = serde_json::json!({ "code": code, "device_name": "Fresh" }).to_string();
    let reply = request(addr, "POST", "/api/pair", None, Some(&body)).await;
    let token = reply.json()["token"].as_str().unwrap().to_string();
    let me = request(addr, "GET", "/api/me", Some(&token), None).await;
    assert_eq!(me.status, 200, "{}", me.body);
    assert_eq!(me.json()["tier"], "drive");
    match daemon.remote_state_msg() {
        proto::ServerMsg::RemoteState { remote } => {
            assert_eq!(remote.devices[0].tier, RemoteTier::Drive)
        }
        other => panic!("expected remote_state, got {other:?}"),
    }
}

#[tokio::test]
async fn observe_reads_but_is_refused_input_decisions_and_dictation() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = pane(&daemon, &["sh", "-c", "echo ready; sleep 30"]);
    let id = info.id;
    for path in ["/api/me", "/api/sessions", "/api/activity"] {
        let reply = request(addr, "GET", path, Some(&token), None).await;
        assert_eq!(reply.status, 200, "{path}: {}", reply.body);
    }
    let screen = request(
        addr,
        "GET",
        &format!("/api/sessions/{id}/screen"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(screen.status, 200, "{}", screen.body);

    let attempts = [
        (
            format!("/api/sessions/{id}/input"),
            r#"{"text":"echo nope"}"#,
        ),
        (
            format!("/api/sessions/{id}/decide"),
            r#"{"epoch":"x","entry_seq":1,"choice":"approve"}"#,
        ),
        (format!("/api/sessions/{id}/dictate"), ""),
    ];
    for (path, body) in attempts {
        let reply = request(addr, "POST", &path, Some(&token), Some(body)).await;
        assert_eq!(reply.status, 403, "{path}: {}", reply.body);
        let message = reply.error();
        assert!(
            message.contains("paired as observe")
                && message.contains(&format!("POST {}", path.replace(&id.to_string(), "{id}")))
                && message.contains("needs drive")
                && message.contains("Settings > Phone & remote access > Paired devices"),
            "{message}"
        );
    }
    let screen = request(
        addr,
        "GET",
        &format!("/api/sessions/{id}/screen?lines=40"),
        Some(&token),
        None,
    )
    .await;
    assert!(
        !screen.body.contains("nope"),
        "a refused input reached the pane: {}",
        screen.body
    );
}

#[tokio::test]
async fn a_tier_change_applies_to_the_devices_next_request_and_reverses() {
    let (daemon, addr, token, id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = pane(
        &daemon,
        &["sh", "-c", "read line; echo got:$line; sleep 30"],
    );
    let path = format!("/api/sessions/{}/input", info.id);
    let body = r#"{"text":"hello"}"#;
    assert_eq!(
        request(addr, "POST", &path, Some(&token), Some(body))
            .await
            .status,
        403
    );
    daemon
        .remote_device_set_tier(id, RemoteTier::Drive)
        .unwrap();
    let sent = request(addr, "POST", &path, Some(&token), Some(body)).await;
    assert_eq!(sent.status, 200, "{}", sent.body);
    daemon
        .remote_device_set_tier(id, RemoteTier::Observe)
        .unwrap();
    assert_eq!(
        request(addr, "POST", &path, Some(&token), Some(body))
            .await
            .status,
        403
    );
    let err = daemon
        .remote_device_set_tier(id + 100, RemoteTier::Manage)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(&format!("{}", id + 100)) && err.contains("device list"),
        "{err}"
    );
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    #[allow(clippy::disallowed_methods)]
    let out = std::process::Command::new("git")
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
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn init_repo(dir: &std::path::Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\nworld\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "one\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

/// A pane working in a git repository with a modified file, a new file, and a secret-looking file.
fn repo_pane(daemon: &Arc<Daemon>) -> (proto::SessionInfo, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    std::fs::write(dir.path().join("README.md"), "hello\nthere\nworld\nagain\n").unwrap();
    std::fs::write(dir.path().join("fresh.txt"), "new\n").unwrap();
    std::fs::write(dir.path().join(".env"), "TOKEN=1\n").unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.path().to_path_buf(),
            cmd: Some(vec!["sleep".into(), "60".into()]),
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
        .unwrap();
    (info, dir)
}

async fn get(addr: SocketAddr, token: &str, path: &str) -> Reply {
    request(addr, "GET", path, Some(token), None).await
}

fn file<'a>(changes: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
    changes["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == path)
        .unwrap_or_else(|| panic!("{path} is not in {changes}"))
}

#[tokio::test]
async fn sessions_carry_the_pane_facts_a_phone_shows() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, dir) = repo_pane(&daemon);
    let reply = get(addr, &token, "/api/sessions").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let body = reply.json();
    let row = body["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == info.id)
        .unwrap();
    for key in [
        "model",
        "effort",
        "provider_version",
        "account",
        "context",
        "compactions",
        "cwd",
        "branch",
        "worktree",
        "live_children",
        "children_waiting",
        "task",
        "resumable",
        "sleep_notice",
        "resume_notice",
        "started_at",
    ] {
        assert!(row.get(key).is_some(), "{key} is missing from {row}");
    }
    assert_eq!(row["cwd"], dir.path().to_str().unwrap());
    assert_eq!(row["branch"], "main");
    assert_eq!(row["live_children"], 0);
    assert_eq!(row["resumable"], false);
    assert!(row["task"].is_null() && row["model"].is_null());
}

#[tokio::test]
async fn changes_lists_the_checkout_with_line_counts_and_flags_secrets() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = repo_pane(&daemon);
    let reply = get(addr, &token, &format!("/api/sessions/{}/changes", info.id)).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let changes = reply.json();
    assert_eq!(changes["branch"], "main");
    assert!(changes["upstream"].is_null());
    assert_eq!(
        (changes["ahead"].as_u64(), changes["behind"].as_u64()),
        (Some(0), Some(0))
    );
    assert_eq!(changes["truncated"], false);
    let readme = file(&changes, "README.md");
    assert_eq!(readme["status"], "M");
    assert_eq!(
        (readme["added"].as_i64(), readme["removed"].as_i64()),
        (Some(2), Some(0))
    );
    assert_eq!(file(&changes, "fresh.txt")["status"], "?");
    assert_eq!(file(&changes, ".env")["sensitive"], true);
}

#[tokio::test]
async fn changes_past_the_cap_are_cut_and_say_so() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, dir) = repo_pane(&daemon);
    for i in 0..210 {
        std::fs::write(dir.path().join(format!("bulk-{i:03}.txt")), "x\n").unwrap();
    }
    let changes = get(addr, &token, &format!("/api/sessions/{}/changes", info.id))
        .await
        .json();
    assert_eq!(changes["files"].as_array().unwrap().len(), 200);
    assert_eq!(changes["truncated"], true);
    assert_eq!(changes["limit"], 200);
    assert!(changes["total"].as_u64().unwrap() > 200);
}

#[tokio::test]
async fn diff_serves_only_listed_paths_masked_and_never_secret_files() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, dir) = repo_pane(&daemon);
    let token_in_file = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
    std::fs::write(
        dir.path().join("notes.txt"),
        format!("one\nkey = {token_in_file}\n"),
    )
    .unwrap();
    let base = format!("/api/sessions/{}/diff", info.id);

    let ok = get(addr, &token, &format!("{base}?path=README.md")).await;
    assert_eq!(ok.status, 200, "{}", ok.body);
    let diff = ok.json();
    assert_eq!(diff["path"], "README.md");
    assert!(diff["diff"].as_str().unwrap().contains("+there"), "{diff}");
    assert_eq!(diff["truncated"], false);

    let masked = get(addr, &token, &format!("{base}?path=notes.txt"))
        .await
        .json();
    assert!(
        !masked["diff"].as_str().unwrap().contains(token_in_file),
        "a credential reached the device: {masked}"
    );

    for path in [
        "../../etc/passwd",
        "/etc/passwd",
        "unchanged.rs",
        "README.md/../notes.txt",
    ] {
        let refused = get(addr, &token, &format!("{base}?path={path}")).await;
        assert_eq!(refused.status, 400, "{path}: {}", refused.body);
        let message = refused.error();
        assert!(
            message.contains(&format!("{path:?}")) && message.contains("/changes"),
            "{message}"
        );
    }
    let secret = get(addr, &token, &format!("{base}?path=.env")).await;
    assert_eq!(secret.status, 403, "{}", secret.body);
    assert!(secret.error().contains(".env"));
    assert_eq!(get(addr, &token, &base).await.status, 400);
}

#[tokio::test]
async fn a_large_diff_is_bounded_by_bytes() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, dir) = repo_pane(&daemon);
    let long = "line of text that is fairly long\n".repeat(5000);
    std::fs::write(dir.path().join("notes.txt"), long).unwrap();
    let diff = get(
        addr,
        &token,
        &format!("/api/sessions/{}/diff?path=notes.txt", info.id),
    )
    .await
    .json();
    assert_eq!(diff["truncated"], true);
    assert!(diff["diff"].as_str().unwrap().len() <= 64 * 1024);
}

#[tokio::test]
async fn a_pane_outside_git_has_no_changes_and_the_error_names_the_directory() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, dir) = pane(&daemon, &["sleep", "60"]);
    let reply = get(addr, &token, &format!("/api/sessions/{}/changes", info.id)).await;
    assert_eq!(reply.status, 409, "{}", reply.body);
    assert!(reply.error().contains(dir.path().to_str().unwrap()));
    assert_eq!(
        get(addr, &token, "/api/sessions/99999/changes")
            .await
            .status,
        404
    );
}

#[tokio::test]
async fn workspaces_list_name_path_branch_and_dirtiness() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let clean = tempfile::tempdir().unwrap();
    init_repo(clean.path());
    let dirty = tempfile::tempdir().unwrap();
    init_repo(dirty.path());
    std::fs::write(dirty.path().join("README.md"), "changed\n").unwrap();
    for dir in [&clean, &dirty] {
        daemon.workspace_add(dir.path().to_str().unwrap()).unwrap();
    }
    let reply = get(addr, &token, "/api/workspaces").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let rows = reply.json();
    let row = |dir: &tempfile::TempDir| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|r| r["path"] == dir.path().to_str().unwrap())
            .unwrap_or_else(|| panic!("{:?} is not in {rows}", dir.path()))
            .clone()
    };
    assert_eq!(
        (row(&clean)["branch"].clone(), row(&clean)["dirty"].clone()),
        ("main".into(), false.into())
    );
    assert_eq!(row(&dirty)["dirty"], true);
    assert!(row(&clean)["name"].as_str().is_some_and(|n| !n.is_empty()));
}

#[tokio::test]
async fn tasks_list_open_tasks_for_a_registered_workspace() {
    let (daemon, addr, token, _id, state) = phone(RemoteTier::Observe).await;
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    let path = dir.path().to_str().unwrap().to_string();
    daemon.workspace_add(&path).unwrap();
    let db = Db::open(&state.path().join("test.db")).unwrap();
    let make = |title: &str, status: proto::TaskStatus| {
        db.create_task(&houston_core::db::TaskWrite {
            workspace: Some(&path),
            title,
            description: "",
            status,
            priority: proto::TaskPriority::Medium,
            parent_id: None,
            ref_url: None,
            created_by: "test",
            now_ms: 1,
            acceptance: &[],
        })
        .unwrap()
    };
    let open = make("Open one", proto::TaskStatus::Todo);
    make("Finished", proto::TaskStatus::Done);
    let encoded = path.replace('/', "%2F");
    let reply = get(addr, &token, &format!("/api/tasks?workspace={encoded}")).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let tasks = reply.json();
    let tasks = tasks.as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{tasks:?}");
    assert_eq!(tasks[0]["id"], open.id);
    assert_eq!(tasks[0]["title"], "Open one");
    assert_eq!(tasks[0]["state"], "todo");
    assert!(tasks[0]["pane"].is_null());

    let unknown = get(addr, &token, "/api/tasks?workspace=%2Fnowhere").await;
    assert_eq!(unknown.status, 404);
    assert!(unknown.error().contains("/nowhere"));
    assert_eq!(get(addr, &token, "/api/tasks").await.status, 400);
}

#[tokio::test]
async fn usage_answers_from_the_cache_with_the_documented_shape() {
    let (_daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let reply = get(addr, &token, "/api/usage").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let usage = reply.json();
    assert!(usage["today"]["cost_usd"].is_number(), "{usage}");
    assert!(usage["today"]["by_provider"].is_array());
    assert!(usage["limits"].is_array());
    assert!(usage["stale"].is_boolean());
    let again = get(addr, &token, "/api/usage").await.json();
    assert_eq!(
        again["stale"], false,
        "a second read inside the window is fresh: {again}"
    );
}

#[tokio::test]
async fn pull_request_routes_refuse_unknown_targets_by_name() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let (info, _dir) = repo_pane(&daemon);
    let pr = get(addr, &token, &format!("/api/sessions/{}/pr", info.id)).await;
    assert_eq!(pr.status, 200, "{}", pr.body);
    assert!(pr.json().get("pr").is_some() || pr.json().get("number").is_some());
    let prs = get(addr, &token, "/api/workspaces/prs?path=%2Fnowhere").await;
    assert_eq!(prs.status, 404);
    assert!(prs.error().contains("/nowhere"));
    assert_eq!(get(addr, &token, "/api/workspaces/prs").await.status, 400);
}

const STUB_ENV: &str = "REMOTE_PHONE_STUB_PROVIDERS";

/// Re-runs the test in a child whose PATH holds stand-ins for the provider CLIs
/// (`claude` answers `--version` and then sleeps), so no real agent ever starts.
/// Returns true in the parent, after the child passed.
fn with_stub_providers(name: &str) -> bool {
    if std::env::var_os(STUB_ENV).is_some() {
        return false;
    }
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for provider in ["claude", "codex", "agy", "opencode", "zcode"] {
        let script = "#!/bin/sh\nif [ \"$1\" = '--version' ]; then echo 2.1.296; exit 0; fi\nexec sleep 60\n";
        let path = bin.join(provider);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut command = common::hermetic_command(std::env::current_exe().unwrap(), home.path());
    let inherited = command
        .get_envs()
        .find(|(key, _)| *key == "PATH")
        .and_then(|(_, value)| value)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let status = command
        .args([
            "--exact",
            &common::exact_path(module_path!(), name),
            "--nocapture",
        ])
        .env("PATH", format!("{}:{inherited}", bin.display()))
        .env(STUB_ENV, "1")
        .status()
        .unwrap();
    assert!(status.success(), "{name} failed with stand-in providers");
    true
}

async fn post(addr: SocketAddr, token: &str, path: &str, body: &str) -> Reply {
    request(addr, "POST", path, Some(token), Some(body)).await
}

fn spawn_body(workspace: &str, extra: &str) -> String {
    format!(r#"{{"kind":"claude","workspace":"{workspace}"{extra}}}"#)
}

async fn session_ids(addr: SocketAddr, token: &str) -> Vec<u64> {
    get(addr, token, "/api/sessions").await.json()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_u64().unwrap())
        .collect()
}

#[tokio::test]
async fn drive_is_refused_every_manage_route_and_manage_is_allowed() {
    if with_stub_providers("drive_is_refused_every_manage_route_and_manage_is_allowed") {
        return;
    }
    let (daemon, addr, token, id, _state) = phone(RemoteTier::Drive).await;
    let workspace = tempfile::tempdir().unwrap();
    init_repo(workspace.path());
    let path = workspace.path().to_str().unwrap().to_string();
    daemon.workspace_add(&path).unwrap();
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let pid = info.id;
    let routes = [
        ("/api/sessions".to_string(), spawn_body(&path, "")),
        (
            format!("/api/sessions/{pid}/rename"),
            r#"{"title":"x"}"#.into(),
        ),
        (format!("/api/sessions/{pid}/respawn"), String::new()),
        (format!("/api/sessions/{pid}/sleep"), String::new()),
        (format!("/api/sessions/{pid}/wake"), String::new()),
        (
            format!("/api/sessions/{pid}/close"),
            format!(r#"{{"confirm":"{pid}"}}"#),
        ),
        (
            format!("/api/sessions/{pid}/commit"),
            r#"{"message":"m"}"#.into(),
        ),
        (format!("/api/sessions/{pid}/push"), String::new()),
    ];
    for (route, body) in &routes {
        let reply = post(addr, &token, route, body).await;
        assert_eq!(reply.status, 403, "{route}: {}", reply.body);
        let message = reply.error();
        assert!(
            message.contains("paired as drive") && message.contains("needs manage"),
            "{route}: {message}"
        );
    }
    assert!(
        session_ids(addr, &token).await.contains(&u64::from(pid)),
        "a refused close closed the pane"
    );

    daemon
        .remote_device_set_tier(id, RemoteTier::Manage)
        .unwrap();
    let opened = post(addr, &token, "/api/sessions", &spawn_body(&path, "")).await;
    assert_eq!(opened.status, 200, "{}", opened.body);
    let new_id = opened.json()["id"].as_u64().unwrap();
    assert!(session_ids(addr, &token).await.contains(&new_id));
}

#[tokio::test]
async fn spawn_refuses_what_a_device_may_not_open_naming_it() {
    if with_stub_providers("spawn_refuses_what_a_device_may_not_open_naming_it") {
        return;
    }
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let workspace = tempfile::tempdir().unwrap();
    init_repo(workspace.path());
    let path = workspace.path().to_str().unwrap().to_string();
    daemon.workspace_add(&path).unwrap();
    let before = session_ids(addr, &token).await;

    for kind in ["shell", "cursor", "grok", "custom", "droid"] {
        let body = format!(r#"{{"kind":"{kind}","workspace":"{path}"}}"#);
        let reply = post(addr, &token, "/api/sessions", &body).await;
        assert_eq!(reply.status, 400, "{kind}: {}", reply.body);
        let message = reply.error();
        assert!(
            message.contains(&format!("{kind:?}"))
                && message.contains("claude, codex, antigravity, opencode, zcode"),
            "{message}"
        );
    }
    let auto = post(
        addr,
        &token,
        "/api/sessions",
        &spawn_body(&path, r#","auto_approve":true"#),
    )
    .await;
    assert_eq!(auto.status, 403, "{}", auto.body);
    assert!(auto.error().contains("auto_approve"));
    let unknown = post(addr, &token, "/api/sessions", &spawn_body("/nowhere", "")).await;
    assert_eq!(unknown.status, 404);
    assert!(unknown.error().contains("/nowhere"));
    let cmd = post(
        addr,
        &token,
        "/api/sessions",
        &spawn_body(&path, r#","cmd":["sh"]"#),
    )
    .await;
    assert_eq!(cmd.status, 422, "{}", cmd.body);
    assert!(cmd.error().contains("cmd"));
    let effort = post(
        addr,
        &token,
        "/api/sessions",
        &spawn_body(&path, r#","effort":"turbo""#),
    )
    .await;
    assert_eq!(effort.status, 400);
    assert!(effort.error().contains("turbo") && effort.error().contains("xhigh"));
    let model = post(
        addr,
        &token,
        "/api/sessions",
        &spawn_body(&path, &format!(r#","model":"{}""#, "m".repeat(101))),
    )
    .await;
    assert_eq!(model.status, 400);
    assert!(model.error().contains("101") && model.error().contains("100"));
    let profile = post(
        addr,
        &token,
        "/api/sessions",
        &spawn_body(&path, r#","profile":77"#),
    )
    .await;
    assert_eq!(profile.status, 400);
    assert!(profile.error().contains("77"));
    assert_eq!(
        session_ids(addr, &token).await,
        before,
        "a refused spawn opened a pane"
    );
}

#[tokio::test]
async fn spawn_options_offer_only_spawnable_providers_with_versions_and_workspaces() {
    if with_stub_providers(
        "spawn_options_offer_only_spawnable_providers_with_versions_and_workspaces",
    ) {
        return;
    }
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Observe).await;
    let workspace = tempfile::tempdir().unwrap();
    daemon
        .workspace_add(workspace.path().to_str().unwrap())
        .unwrap();
    let reply = get(addr, &token, "/api/spawn-options").await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let options = reply.json();
    let kinds: Vec<&str> = options["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        ["claude", "codex", "antigravity", "opencode", "zcode"]
    );
    let claude = &options["providers"][0];
    assert_eq!(claude["installed"], true);
    assert_eq!(claude["version"], "2.1.296");
    assert_eq!(
        claude["accounts"][0],
        serde_json::json!({"id": null, "name": "Default"})
    );
    assert_eq!(
        claude["efforts"],
        serde_json::json!(["low", "medium", "high", "xhigh", "max"])
    );
    assert!(
        options["providers"][4]["efforts"].is_null(),
        "zcode takes no effort flag"
    );
    assert!(options["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["path"] == workspace.path().to_str().unwrap()));
}

#[tokio::test]
async fn rename_sets_and_clears_the_title_and_records_who_did_it() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let title_of = |body: serde_json::Value| {
        body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == info.id)
            .unwrap()["title"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let path = format!("/api/sessions/{}/rename", info.id);
    let renamed = post(addr, &token, &path, r#"{"title":"Phone name"}"#).await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    assert_eq!(
        title_of(get(addr, &token, "/api/sessions").await.json()),
        "Phone name"
    );
    let long = post(
        addr,
        &token,
        &path,
        &format!(r#"{{"title":"{}"}}"#, "t".repeat(60)),
    )
    .await;
    assert_eq!(long.status, 409, "{}", long.body);
    assert!(long.error().contains("40"), "{}", long.error());
    let cleared = post(addr, &token, &path, r#"{"title":""}"#).await;
    assert_eq!(cleared.status, 200, "{}", cleared.body);
    assert_ne!(
        title_of(get(addr, &token, "/api/sessions").await.json()),
        "Phone name"
    );

    let activity = get(addr, &token, "/api/activity").await.json();
    let action = activity["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "action" && e["action"] == "rename")
        .unwrap_or_else(|| panic!("no rename action in {activity}"));
    assert_eq!(action["device"], "Test phone");
    assert_eq!(action["session"], info.id);
}

#[tokio::test]
async fn close_needs_the_pane_id_as_confirmation() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let (other, _other_dir) = pane(&daemon, &["sleep", "60"]);
    let path = format!("/api/sessions/{}/close", info.id);
    for body in [
        format!(r#"{{"confirm":"{}"}}"#, other.id),
        r#"{"confirm":""}"#.to_string(),
        r#"{"confirm":"close"}"#.to_string(),
    ] {
        let refused = post(addr, &token, &path, &body).await;
        assert_eq!(refused.status, 400, "{body}: {}", refused.body);
        assert!(
            refused.error().contains(&format!("pane {}", info.id)),
            "{}",
            refused.error()
        );
    }
    let numeric = post(
        addr,
        &token,
        &path,
        &format!(r#"{{"confirm":{}}}"#, info.id),
    )
    .await;
    assert_eq!(numeric.status, 422, "confirm is a string: {}", numeric.body);
    assert!(session_ids(addr, &token)
        .await
        .contains(&u64::from(info.id)));

    let closed = post(
        addr,
        &token,
        &path,
        &format!(r#"{{"confirm":"{}"}}"#, info.id),
    )
    .await;
    assert_eq!(closed.status, 200, "{}", closed.body);
    let ids = session_ids(addr, &token).await;
    assert!(!ids.contains(&u64::from(info.id)) && ids.contains(&u64::from(other.id)));
    let activity = get(addr, &token, "/api/activity").await.json();
    assert!(activity["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "action" && e["action"] == "close" && e["device"] == "Test phone"));
    assert_eq!(
        post(
            addr,
            &token,
            &path,
            &format!(r#"{{"confirm":"{}"}}"#, info.id)
        )
        .await
        .status,
        404
    );
}

#[tokio::test]
async fn respawn_restarts_an_exited_pane() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, _dir) = pane(&daemon, &["sh", "-c", "exit 0"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let body = get(addr, &token, "/api/sessions").await.json();
        let row = body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == info.id)
            .cloned();
        if row.is_some_and(|r| r["state"] != "running") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the pane never exited"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let reply = post(
        addr,
        &token,
        &format!("/api/sessions/{}/respawn", info.id),
        "",
    )
    .await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let missing = post(addr, &token, "/api/sessions/99999/respawn", "").await;
    assert_eq!(missing.status, 404);
}

#[tokio::test]
async fn sleep_and_wake_refuse_with_the_daemons_reason() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let sleep = post(
        addr,
        &token,
        &format!("/api/sessions/{}/sleep", info.id),
        "",
    )
    .await;
    assert_eq!(sleep.status, 409, "{}", sleep.body);
    assert!(
        sleep.error().contains(&info.id.to_string()),
        "{}",
        sleep.error()
    );
    let wake = post(addr, &token, &format!("/api/sessions/{}/wake", info.id), "").await;
    assert_eq!(wake.status, 409, "{}", wake.body);
    assert!(
        wake.error().contains(&info.id.to_string()),
        "{}",
        wake.error()
    );
}

#[tokio::test]
async fn commit_stages_exactly_the_request_and_refuses_what_it_was_not_shown() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, dir) = repo_pane(&daemon);
    let path = format!("/api/sessions/{}/commit", info.id);
    let repo = dir.path();

    let empty = post(addr, &token, &path, r#"{"message":"  "}"#).await;
    assert_eq!(empty.status, 400);
    assert!(empty.error().contains("0 characters") && empty.error().contains("4096"));
    let long = post(
        addr,
        &token,
        &path,
        &format!(r#"{{"message":"{}"}}"#, "m".repeat(4097)),
    )
    .await;
    assert_eq!(long.status, 400);
    assert!(long.error().contains("4097") && long.error().contains("4096"));
    let unlisted = post(
        addr,
        &token,
        &path,
        r#"{"message":"m","paths":["not-listed.rs"]}"#,
    )
    .await;
    assert_eq!(unlisted.status, 400);
    assert!(unlisted.error().contains("not-listed.rs"));
    let secret = post(addr, &token, &path, r#"{"message":"m","paths":[".env"]}"#).await;
    assert_eq!(secret.status, 403, "{}", secret.body);
    assert!(secret.error().contains(".env"));
    let none_selected = post(addr, &token, &path, r#"{"message":"m","paths":[]}"#).await;
    assert_eq!(none_selected.status, 400);
    assert!(
        git(repo, &["log", "--oneline"]).lines().count() == 1,
        "a refused commit committed"
    );

    git(repo, &["add", "fresh.txt"]);
    let staged_elsewhere = post(
        addr,
        &token,
        &path,
        r#"{"message":"m","paths":["README.md"]}"#,
    )
    .await;
    assert_eq!(staged_elsewhere.status, 409, "{}", staged_elsewhere.body);
    assert!(staged_elsewhere.error().contains("fresh.txt"));
    git(repo, &["reset", "-q", "fresh.txt"]);

    let done = post(
        addr,
        &token,
        &path,
        r#"{"message":"Edit the readme","paths":["README.md"]}"#,
    )
    .await;
    assert_eq!(done.status, 200, "{}", done.body);
    let body = done.json();
    assert!(body["sha"].as_str().is_some_and(|s| s.len() >= 7), "{body}");
    assert_eq!(
        git(repo, &["log", "-1", "--format=%s"]).trim(),
        "Edit the readme"
    );
    assert_eq!(
        git(repo, &["show", "--name-only", "--format=", "HEAD"]).trim(),
        "README.md"
    );
    assert!(
        git(repo, &["status", "--porcelain"]).contains("fresh.txt"),
        "an untracked file was swept in"
    );

    std::fs::write(repo.join("notes.txt"), "two\n").unwrap();
    std::fs::remove_file(repo.join(".env")).unwrap();
    let all = post(
        addr,
        &token,
        &path,
        r#"{"message":"All tracked","paths":null}"#,
    )
    .await;
    assert_eq!(all.status, 200, "{}", all.body);
    assert_eq!(
        git(repo, &["show", "--name-only", "--format=", "HEAD"]).trim(),
        "notes.txt"
    );
    let nothing = post(addr, &token, &path, r#"{"message":"again"}"#).await;
    assert_eq!(nothing.status, 409, "{}", nothing.body);
}

#[tokio::test]
async fn push_publishes_the_branch_and_names_a_missing_remote() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, dir) = repo_pane(&daemon);
    let path = format!("/api/sessions/{}/push", info.id);
    let none = post(addr, &token, &path, "").await;
    assert_eq!(none.status, 409, "{}", none.body);
    assert!(none.error().contains("no git remote"), "{}", none.error());

    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-b", "main"]);
    git(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    let pushed = post(addr, &token, &path, "").await;
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    assert_eq!(pushed.json()["ok"], true);
    assert_eq!(
        git(remote.path(), &["rev-parse", "main"]).trim(),
        git(dir.path(), &["rev-parse", "HEAD"]).trim()
    );
}

#[tokio::test]
async fn the_event_stream_announces_a_changed_pane_list() {
    let (daemon, addr, token, _id, _state) = phone(RemoteTier::Manage).await;
    let (info, _dir) = pane(&daemon, &["sleep", "60"]);
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req = format!(
        "GET /api/events HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut seen = String::new();
    let mut buf = [0u8; 4096];
    while !seen.contains("event: ready") {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0, "the stream closed before it was ready: {seen:?}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
    let renamed = post(
        addr,
        &token,
        &format!("/api/sessions/{}/rename", info.id),
        r#"{"title":"Announced"}"#,
    )
    .await;
    assert_eq!(renamed.status, 200, "{}", renamed.body);
    while !seen.contains("event: sessions") {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(
            n > 0,
            "the stream closed without a sessions notice: {seen:?}"
        );
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
    }
}

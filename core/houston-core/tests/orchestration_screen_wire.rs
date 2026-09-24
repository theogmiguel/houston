#![cfg(unix)]

mod common;

use common::{collect_broadcast_until, start_daemon_with_handle};
use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL.lock().await
}

const CLAUDE_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/fixtures/screen/claude-code-120x32.bin"
);
const SHELL_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/fixtures/screen/shell-100x30.bin"
);

static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let path = dir.join("agy");
        std::fs::write(
            &path,
            "#!/bin/sh\nstty -echo 2>/dev/null\ncat \"$HOME/frame-a\"\n\
             if [ -f \"$HOME/frame-b\" ]; then\n\
             while IFS= read -r line; do\n\
             case \"$line\" in *NEXT-FRAME*) break ;; esac\n\
             done\n\
             cat \"$HOME/frame-b\"\n\
             fi\n\
             exec cat > /dev/null\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

fn choose_fixture(which: &str) {
    let home = shim_dir().join("home");
    std::fs::copy(which, home.join("frame-a")).unwrap();
    let _ = std::fs::remove_file(home.join("frame-b"));
}

fn choose_frames(which: &str, at: usize, then: usize) {
    let home = shim_dir().join("home");
    let bytes = std::fs::read(which).unwrap();
    std::fs::write(home.join("frame-a"), &bytes[..at]).unwrap();
    std::fs::write(home.join("frame-b"), &bytes[at..then]).unwrap();
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

struct Rig {
    daemon: Arc<Daemon>,
    addr: SocketAddr,
    _state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str) -> Rig {
    shim_dir();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    daemon.orchestration_set(true).unwrap();
    Rig {
        daemon,
        addr,
        _state: state,
        ws_dir,
    }
}

impl Rig {
    fn parent(&self) -> proto::SessionInfo {
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

    async fn spawn_child(&self, token: &str, role: &str) -> u32 {
        let (status, body) = http_json(
            self.addr,
            "POST",
            "/orchestrate/spawn",
            token,
            Some(serde_json::json!({"kind": "antigravity", "prompt": "go", "role": role})),
        )
        .await;
        assert_eq!(status, 200, "spawn body: {body}");
        body["session_id"].as_u64().unwrap() as u32
    }

    async fn await_ring(&self, child: u32, bytes: usize) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let got = self.daemon.scrollback(child, None).unwrap().data.len();
            if got >= bytes {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "child {child} replayed {got} of {bytes} bytes"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn read(&self, token: &str, child: u32, source: &str, lines: usize) -> Vec<String> {
        let (status, body) = http_json(
            self.addr,
            "GET",
            &format!("/orchestrate/read?session={child}&lines={lines}&source={source}"),
            token,
            None,
        )
        .await;
        assert_eq!(status, 200, "read body: {body}");
        body["lines"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn fixture_len(path: &str) -> usize {
    std::fs::metadata(Path::new(path)).unwrap().len() as usize
}

const QUIET: u64 = houston_core::orchestrate::DELEGATION_SETTLE_QUIET_MS;

fn inboxes_delivered(daemon: &Arc<Daemon>, parent: u32) -> usize {
    let replay = daemon.scrollback(parent, None).unwrap();
    String::from_utf8_lossy(&replay.data)
        .matches("--- HoustonSwarm Inbox ---")
        .count()
}

#[tokio::test]
async fn a_handback_is_corroborated_by_the_childs_screen_not_its_byte_ring() {
    let _guard = serial().await;
    let r = rig("handback-excerpt-screen").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    choose_fixture(CLAUDE_FIXTURE);
    let kid = r.spawn_child(&token, "answerer").await;
    r.await_ring(kid, fixture_len(CLAUDE_FIXTURE)).await;

    let old = r.read(&token, kid, "tail", 6).await;
    assert_eq!(
        old.len(),
        1,
        "76 KB of Claude Code holds no newline to split on: {old:?}"
    );

    apply_hook_event(r._state.path(), parent.id, "Stop").await;
    r.daemon
        .orchestrate_submit(kid, "CHILD-BODY the work is done".to_string().into())
        .unwrap();
    let mut rx = r.daemon.observe();
    apply_hook_event(r._state.path(), kid, "Stop").await;

    let acc = collect_broadcast_until(&mut rx, parent.id, "End Inbox").await;
    assert!(acc.contains("CHILD-BODY"), "the handback body: {acc:?}");
    assert!(
        acc.contains("❯ Reply with only the word FILLER-6. No tools."),
        "the question, with the spaces the CLI drew by moving the cursor: {acc:?}"
    );
    assert!(
        acc.contains("● FILLER-6"),
        "and the answer it corroborates: {acc:?}"
    );
    let excerpt: Vec<&str> = acc
        .lines()
        .filter(|l| l.trim_start().starts_with("> "))
        .collect();
    assert!(
        excerpt.len() > 1,
        "rows, not the one line `tail_lines` collapsed them to: {excerpt:?}"
    );
}

#[tokio::test]
async fn an_unsubmitted_turn_end_carries_the_answer_off_the_childs_screen() {
    let _guard = serial().await;
    let r = rig("no-handback-excerpt-screen").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    choose_fixture(CLAUDE_FIXTURE);
    let kid = r.spawn_child(&token, "answerer").await;
    r.await_ring(kid, fixture_len(CLAUDE_FIXTURE)).await;

    let old = r
        .read(
            &token,
            kid,
            "tail",
            houston_core::orchestrate::UNSUBMITTED_TAIL_LINES,
        )
        .await;
    assert!(
        !old.iter().any(|l| l.contains("FILLER-6")),
        "the answer was unreachable through the ring: {old:?}"
    );

    apply_hook_event(r._state.path(), parent.id, "Stop").await;
    let mut rx = r.daemon.observe();
    apply_hook_event(r._state.path(), kid, "UserPromptSubmit").await;
    apply_hook_event(r._state.path(), kid, "Stop").await;

    let acc = collect_broadcast_until(&mut rx, parent.id, "End Inbox").await;
    assert!(acc.contains("(answerer)"), "the subject line: {acc:?}");
    assert!(
        acc.contains("❯ Reply with only the word FILLER-6. No tools."),
        "the question, with the spaces the CLI drew by moving the cursor: {acc:?}"
    );
    assert!(
        acc.contains("● FILLER-6"),
        "and the answer the parent was owed: {acc:?}"
    );
}

#[tokio::test]
async fn a_line_printing_child_hands_over_exactly_what_it_always_did() {
    let _guard = serial().await;
    let r = rig("no-handback-excerpt-lines").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    choose_fixture(SHELL_FIXTURE);
    let kid = r.spawn_child(&token, "printer").await;
    r.await_ring(kid, fixture_len(SHELL_FIXTURE)).await;

    let lines = houston_core::orchestrate::UNSUBMITTED_TAIL_LINES;
    let screen = r.read(&token, kid, "screen", lines).await;
    let tail: Vec<String> = r
        .read(&token, kid, "tail", lines)
        .await
        .iter()
        .map(|l| l.trim_end().to_string())
        .collect();
    assert_eq!(screen, tail, "the two sources agree on a pane that prints");

    apply_hook_event(r._state.path(), parent.id, "Stop").await;
    let mut rx = r.daemon.observe();
    apply_hook_event(r._state.path(), kid, "Stop").await;

    let acc = collect_broadcast_until(&mut rx, parent.id, "End Inbox").await;
    assert!(
        acc.contains(tail.first().unwrap().as_str()),
        "the excerpt still starts where it did: {acc:?}"
    );
    assert!(
        acc.contains(houston_core::orchestrate::HANDOFF_TRUNCATION_MARKER),
        "and still says where it stopped: {acc:?}"
    );
}

async fn apply_hook_event(state_dir: &Path, session: u32, event: &str) {
    let drop = houston_core::hook_drop::HookDrop {
        v: houston_core::hook_drop::DROP_V,
        event: event.into(),
        session,
        cwd: None,
        agent: None,
        prompt: None,
        ..Default::default()
    };
    let drop_path = houston_core::hook_drop::write_drop(
        &houston_core::hook_drop::drop_dir(state_dir),
        &drop,
        houston_core::daemon::now_ms(),
    )
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while drop_path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{event} drop never applied to session {session}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

const FRAME_MID_TURN: usize = 65_344;
const FRAME_NEXT_TURN: usize = 65_472;

#[ignore = "no shipped, orchestrate_spawn-able kind is hookless anymore; needs a maintainer decision, see PR body"]
#[tokio::test]
async fn quiet_settle_sees_a_turn_the_byte_ring_could_not_show_it() {
    let _guard = serial().await;
    let r = rig("quiet-settle-screen").await;
    let parent = r.parent();
    let token = r.token_for(parent.id);
    choose_frames(CLAUDE_FIXTURE, FRAME_MID_TURN, FRAME_NEXT_TURN);
    let kid = r.spawn_child(&token, "answerer").await;
    r.await_ring(kid, FRAME_MID_TURN).await;
    apply_hook_event(r._state.path(), parent.id, "Stop").await;

    let lines = houston_core::orchestrate::DELEGATION_SETTLE_TAIL_LINES;
    let tail_before = r.read(&token, kid, "tail", lines).await;
    let screen_before = r.read(&token, kid, "screen", lines).await;
    assert!(
        screen_before.contains(&"● FILLER-1".to_string()),
        "the first answer is on the grid: {screen_before:?}"
    );

    r.daemon.delegation_watch_tick_at(20_000);
    r.daemon.write_stdin(kid, b"NEXT-FRAME\n").unwrap();
    r.await_ring(kid, FRAME_NEXT_TURN).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let tail_after = r.read(&token, kid, "tail", lines).await;
    let screen_after = r.read(&token, kid, "screen", lines).await;
    assert_eq!(
        tail_before, tail_after,
        "the byte ring reads identically across the turn — this is what the \
         fingerprint used to be taken from"
    );
    assert!(
        screen_after.contains(&"● FILLER-2".to_string()),
        "the screen answered a second question: {screen_after:?}"
    );

    r.daemon.delegation_watch_tick_at(20_000 + QUIET + 1);
    tokio::time::sleep(Duration::from_millis(
        houston_core::orchestrate::HANDOFF_BATCH_MS + 300,
    ))
    .await;
    assert_eq!(
        inboxes_delivered(&r.daemon, parent.id),
        0,
        "a child that answered another question is not settled"
    );

    let mut rx = r.daemon.observe();
    r.daemon.delegation_watch_tick_at(20_000 + 2 * QUIET + 2);
    let acc = collect_broadcast_until(&mut rx, parent.id, "End Inbox").await;
    assert!(
        acc.contains("(answerer)"),
        "a still screen still settles: {acc:?}"
    );
    let excerpt: Vec<&str> = acc
        .lines()
        .filter(|l| l.trim_start().starts_with("> "))
        .collect();
    assert!(
        excerpt.len() > 1 && excerpt.iter().any(|l| l.contains("FILLER")),
        "and carries rows of the grid it settled on: {excerpt:?}"
    );
}

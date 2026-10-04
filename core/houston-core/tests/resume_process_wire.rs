#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use futures_util::SinkExt;
use houston_core::pid::{self, Signal};
use houston_protocol as proto;
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

const CHANNEL: &str = "resumeprocess";
const DEADLINE: Duration = Duration::from_secs(40);

const FAKE_CLI: &str = r#"#!/bin/sh
set -eu
[ -n "${HOUSTON_SESSION:-}" ] || exit 0
umask 077
out="$RESUME_RECORDS/$HOUSTON_SESSION"
printf '%s\n' "$@" > "$out.argv.tmp"
mv "$out.argv.tmp" "$out.argv"
printf '%s' "$HOUSTON_MCP_TOKEN" > "$out.token"
case "$0" in */claude) provider=claude ;; *) provider=codex ;; esac
native=""
previous=""
source=startup
for arg in "$@"; do
    case "$previous" in
        --session-id) native="$arg" ;;
        --resume|resume) native="$arg"; source=resume ;;
    esac
    previous="$arg"
done
[ -n "$native" ] || native=$(printf '00000000-0000-4000-8000-%012d' "$HOUSTON_SESSION")
transcript="$RESUME_RECORDS/$native.jsonl"
[ -s "$transcript" ] || printf '{}\n' > "$transcript"
printf '%s' "$native" > "$out.native"
hook() {
    printf '{"hook_event_name":"%s","session_id":"%s","transcript_path":"%s","cwd":"%s","source":"%s","prompt":"fixture turn","turn_id":"fixture-turn","stop_hook_active":false}\n' \
        "$1" "$native" "$transcript" "$PWD" "$source" |
        "$RESUME_HELPER" hook "$1" --agent "$provider" --houston-managed
}
hook SessionStart
: > "$out.ready"
while IFS= read -r input; do
    case "$input" in
        working) hook UserPromptSubmit ;;
        idle) hook Stop ;;
    esac
    printf '%s\n' "$input" >> "$out.input"
done
"#;

struct Fixture {
    home: tempfile::TempDir,
    records: PathBuf,
    project: PathBuf,
    bin: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let records = home.path().join("records");
        let project = home.path().join("project");
        let bin = home.path().join("bin");
        for path in [&records, &project, &bin] {
            std::fs::create_dir(path).unwrap();
        }
        for name in ["claude", "codex"] {
            executable(&bin.join(name), FAKE_CLI);
        }
        // Keep the login PATH probe inside the fixture instead of loading host rc files.
        executable(
            &bin.join("shell"),
            "#!/bin/sh\nif [ \"$1\" = -lic ]; then shift; exec /bin/sh -c \"$1\"; fi\nexec /bin/sh \"$@\"\n",
        );
        Self {
            home,
            records,
            project,
            bin,
        }
    }

    fn channel_dir(&self) -> PathBuf {
        self.home.path().join(format!(".houston-{CHANNEL}"))
    }

    fn record(&self, session: u32, suffix: &str) -> PathBuf {
        self.records.join(format!("{session}.{suffix}"))
    }

    async fn launch(&self, session: u32) -> Launch {
        poll("the native CLI's startup receipt", || {
            self.record(session, "ready").exists().then_some(())
        })
        .await;
        Launch {
            argv: std::fs::read_to_string(self.record(session, "argv"))
                .unwrap()
                .lines()
                .map(String::from)
                .collect(),
            native: std::fs::read_to_string(self.record(session, "native")).unwrap(),
            token: std::fs::read_to_string(self.record(session, "token")).unwrap(),
        }
    }
}

fn executable(path: &Path, script: &str) {
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct Launch {
    argv: Vec<String>,
    native: String,
    token: String,
}

#[derive(serde::Deserialize)]
struct Discovery {
    port: u16,
    pid: u32,
    token: String,
    pid_creation: Option<u64>,
}

fn discovery(dir: &Path) -> Option<Discovery> {
    serde_json::from_slice(&std::fs::read(dir.join("daemon.json")).ok()?).ok()
}

struct Process {
    child: Option<Child>,
    channel_dir: PathBuf,
}

impl Process {
    async fn start(fixture: &Fixture) -> (Self, Discovery, common::WsStream) {
        let channel_dir = fixture.channel_dir();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(fixture.home.path().join("daemon.log"))
            .unwrap();
        let child =
            common::hermetic_command(env!("CARGO_BIN_EXE_houston-core"), fixture.home.path())
                .env("HOUSTON_CHANNEL", CHANNEL)
                .env("PATH", format!("{}:/usr/bin:/bin", fixture.bin.display()))
                .env("SHELL", fixture.bin.join("shell"))
                .env("RESUME_RECORDS", &fixture.records)
                .env("RESUME_HELPER", env!("CARGO_BIN_EXE_tr-helper"))
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
                .expect("spawn the isolated daemon");
        let mut process = Self {
            child: Some(child),
            channel_dir,
        };
        let child_pid = process.child.as_ref().unwrap().id();
        let cfg = poll("the current daemon's discovery file", || {
            assert!(
                process
                    .child
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none(),
                "daemon exited during startup: {}",
                std::fs::read_to_string(fixture.home.path().join("daemon.log")).unwrap_or_default()
            );
            discovery(&process.channel_dir).filter(|cfg| cfg.pid == child_pid)
        })
        .await;
        let addr = format!("127.0.0.1:{}", cfg.port).parse().unwrap();
        let mut ws = common::connect_and_hello(addr, &cfg.token).await;
        assert!(matches!(
            common::next_control(&mut ws).await,
            proto::ServerMsg::HelloOk { .. }
        ));
        (process, cfg, ws)
    }

    async fn stop(&mut self, signal: Signal) {
        let child = self.child.as_mut().unwrap();
        let cfg = discovery(&self.channel_dir).expect("the daemon owns a discovery file");
        assert_eq!(cfg.pid, child.id());
        pid::signal_process_checked_identity(cfg.pid, signal, cfg.pid_creation).unwrap();
        let status = poll("the old daemon to exit and release its database", || {
            child.try_wait().unwrap()
        })
        .await;
        self.child.take();
        assert!(
            !pid::process_is_alive(cfg.pid),
            "the previous daemon must be reaped before another opens the database"
        );
        assert_eq!(
            self.channel_dir.join("clean-shutdown").exists(),
            signal == Signal::Term,
            "only a graceful stop writes the clean shutdown marker"
        );
        if signal == Signal::Term {
            assert!(status.success(), "SIGTERM shutdown failed: {status}");
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        // Discovery identifies the channel's current owner even if a test panics at boot.
        if let Some(cfg) = discovery(&self.channel_dir) {
            let _ = pid::signal_process_checked_identity(cfg.pid, Signal::Kill, cfg.pid_creation);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

async fn poll<T>(description: &str, mut condition: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        if let Some(value) = condition() {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn send(ws: &mut common::WsStream, message: proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(&message).unwrap()))
        .await
        .unwrap();
}

async fn sessions(ws: &mut common::WsStream) -> Vec<proto::SessionInfo> {
    send(ws, proto::ClientMsg::SessionList).await;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::SessionList { sessions } => return sessions,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => {}
        }
    }
}

async fn status(ws: &mut common::WsStream, session: u32, expected: proto::AgentStatus) {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        let listed = sessions(ws).await;
        if listed
            .iter()
            .any(|info| info.id == session && info.status == Some(expected) && info.resumable)
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "session {session} never reached {expected:?} with a resume handle: {listed:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn input(ws: &mut common::WsStream, fixture: &Fixture, session: u32, text: &str) {
    ws.send(Message::Binary(
        proto::encode_stdin_frame(session, format!("{text}\n").as_bytes()).into(),
    ))
    .await
    .unwrap();
    poll("the CLI's stdin receipt", || {
        std::fs::read_to_string(fixture.record(session, "input"))
            .ok()
            .filter(|received| received.lines().any(|line| line == text))
    })
    .await;
}

async fn mcp_status(cfg: &Discovery, token: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/mcp", cfg.port))
        .bearer_auth(token)
        .json(&serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"ping"}))
        .timeout(DEADLINE)
        .send()
        .await
        .unwrap()
        .status()
}

fn resumed_id(argv: &[String], agent: proto::AgentKind) -> Option<&str> {
    let flag = if agent == proto::AgentKind::Claude {
        "--resume"
    } else {
        "resume"
    };
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
}

struct Pane {
    origin: u32,
    current: u32,
    agent: proto::AgentKind,
    expected_status: proto::AgentStatus,
    launch: Launch,
}

async fn restart_roundtrip(signal: Signal) {
    let fixture = Fixture::new();
    let (mut daemon, cfg, mut ws) = Process::start(&fixture).await;
    let mut panes = Vec::new();
    for agent in [proto::AgentKind::Claude, proto::AgentKind::Codex] {
        for expected_status in [proto::AgentStatus::Idle, proto::AgentStatus::Working] {
            send(
                &mut ws,
                proto::ClientMsg::SessionCreate {
                    agent,
                    project_dir: fixture.project.display().to_string(),
                    cmd: None,
                    cols: Some(80),
                    rows: Some(24),
                    cwd_from: None,
                    shell_integration: Some(false),
                    auto_approve: Some(false),
                    acp: None,
                    profile: None,
                    prompt: None,
                    model: None,
                    effort: None,
                },
            )
            .await;
            let pane = common::expect_created(&mut ws).await;
            let launch = fixture.launch(pane.id).await;
            assert!(resumed_id(&launch.argv, agent).is_none());
            input(&mut ws, &fixture, pane.id, "working").await;
            status(&mut ws, pane.id, proto::AgentStatus::Working).await;
            if expected_status == proto::AgentStatus::Idle {
                input(&mut ws, &fixture, pane.id, "idle").await;
                status(&mut ws, pane.id, expected_status).await;
            }
            assert_eq!(
                mcp_status(&cfg, &launch.token).await,
                reqwest::StatusCode::OK
            );
            panes.push(Pane {
                origin: pane.id,
                current: pane.id,
                agent,
                expected_status,
                launch,
            });
        }
    }

    for generation in 1..=2 {
        drop(ws);
        daemon.stop(signal).await;
        let (next, cfg, mut next_ws) = Process::start(&fixture).await;
        daemon = next;
        let listed = sessions(&mut next_ws).await;
        assert_eq!(
            listed.len(),
            panes.len(),
            "restore must replace each old pane"
        );
        for pane in &mut panes {
            let restored = listed
                .iter()
                .find(|info| info.session_origin == Some(pane.origin))
                .unwrap_or_else(|| {
                    panic!(
                        "generation {generation} lost origin {}: {listed:?}",
                        pane.origin
                    )
                });
            assert_ne!(restored.id, pane.current);
            assert_eq!(restored.agent, pane.agent);
            assert_eq!(restored.state, proto::SessionState::Running);
            assert_eq!(restored.restore_deferred, None);
            assert_eq!(restored.resume_notice, None);
            assert!(restored.resumable);
            let launch = fixture.launch(restored.id).await;
            assert_eq!(
                resumed_id(&launch.argv, pane.agent),
                Some(pane.launch.native.as_str())
            );
            assert_eq!(launch.native, pane.launch.native);
            assert!(
                !launch.argv.iter().any(|arg| [
                    "--last",
                    "--continue",
                    "-p",
                    "--print",
                    "exec",
                    "fixture turn"
                ]
                .contains(&arg.as_str())),
                "a restored agent must launch interactively by exact conversation id"
            );
            assert!(
                !fixture.record(restored.id, "input").exists(),
                "restore must not inject a prompt"
            );
            assert_ne!(
                Sha256::digest(launch.token.as_bytes()),
                Sha256::digest(pane.launch.token.as_bytes()),
                "a new launch must have a new MCP bearer"
            );
            assert_eq!(
                mcp_status(&cfg, &pane.launch.token).await,
                reqwest::StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                mcp_status(&cfg, &launch.token).await,
                reqwest::StatusCode::OK
            );
            input(&mut next_ws, &fixture, restored.id, "interactive-probe").await;
            input(&mut next_ws, &fixture, restored.id, "working").await;
            status(&mut next_ws, restored.id, proto::AgentStatus::Working).await;
            if pane.expected_status == proto::AgentStatus::Idle {
                input(&mut next_ws, &fixture, restored.id, "idle").await;
                status(&mut next_ws, restored.id, pane.expected_status).await;
            }
            pane.current = restored.id;
            pane.launch = launch;
        }
        ws = next_ws;
    }
    drop(ws);
    daemon.stop(Signal::Term).await;
}

#[tokio::test]
async fn sigterm_restarts_resume_idle_and_working_agents_by_native_id() {
    restart_roundtrip(Signal::Term).await;
}

#[tokio::test]
async fn sigkill_restarts_automatically_resume_idle_and_working_agents_by_native_id() {
    restart_roundtrip(Signal::Kill).await;
}

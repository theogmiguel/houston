//! Live checks against a real WSL 2 distro (see docs/operations/development.md). Each
//! runs every in-distro command under a throwaway `/tmp` HOME, so the distro user's
//! home, launcher and state dirs are never touched.
#![cfg(windows)]
#![allow(clippy::disallowed_methods)]

#[allow(dead_code)]
mod wsl {
    #[path = "../../src/wsl/command.rs"]
    pub mod command;
    #[path = "../../src/wsl/relay.rs"]
    pub mod relay;
}

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use std::io::Write;
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use wsl::command::{Piped, Runner, WslExe, WSL_EXE};
use wsl::relay::{Backend, Relay, RETRY_DELAY};

const CHECKED_PROTOCOL: u32 = 131;
const HOME_PREFIX: &str = "/tmp/houston-live-";
const FRAME_OUTPUT: u8 = 1;
const FRAME_STDIN: u8 = 2;
const FRAME_GAP: u8 = 3;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone)]
struct Live {
    distro: String,
    channel: String,
    linux_bin: String,
    home: String,
}

impl Live {
    fn from_env(test: &str) -> Option<Live> {
        let Ok(distro) = std::env::var("HOUSTON_TEST_WSL_DISTRO") else {
            eprintln!("SKIPPED: set HOUSTON_TEST_WSL_DISTRO to a WSL 2 distro to run {test}");
            return None;
        };
        let linux_bin = std::env::var("HOUSTON_TEST_WSL_LINUX_BIN").expect(
            "HOUSTON_TEST_WSL_LINUX_BIN must name the in-distro directory holding release \
             houston-core, tr-helper and houston-supervisor",
        );
        let channel =
            std::env::var("HOUSTON_TEST_WSL_CHANNEL").unwrap_or_else(|_| "wslt".to_string());
        let home = format!("{HOME_PREFIX}{}-{test}", std::process::id());
        Some(Live {
            distro,
            channel,
            linux_bin,
            home,
        })
    }

    fn install_dir(&self) -> String {
        format!("{}/.local/lib/houston-wsl/live", self.home)
    }

    fn core(&self) -> String {
        format!("{}/houston-core", self.install_dir())
    }

    /// `-d <distro> --exec /usr/bin/env HOME=<throwaway> <argv...>`, never `--`.
    fn argv(&self, exec: &[&str]) -> Vec<String> {
        let home = format!("HOME={}", self.home);
        let argv: Vec<String> = ["-d", &self.distro, "--exec", "/usr/bin/env", &home]
            .iter()
            .chain(exec)
            .map(|arg| arg.to_string())
            .collect();
        assert!(!argv.iter().any(|arg| arg == "--"), "{argv:?}");
        argv
    }

    fn run(&self, exec: &[&str]) -> Output {
        houston_core::spawn::command(WSL_EXE)
            .args(self.argv(exec))
            .env("WSL_UTF8", "1")
            .stdin(Stdio::null())
            .output()
            .expect("starting wsl.exe")
    }

    fn sh(&self, script: &str, args: &[&str]) -> Output {
        let mut exec = vec!["/bin/sh", "-c", script, "sh"];
        exec.extend_from_slice(args);
        self.run(&exec)
    }

    fn ensure(&self) -> serde_json::Value {
        let out = self.run(&[&self.core(), "wsl-ensure", "--channel", &self.channel]);
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        assert_eq!(
            out.status.code(),
            Some(0),
            "wsl-ensure stdout {stdout:?}, stderr {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_str(stdout.trim()).unwrap_or_else(|e| panic!("{e}: {stdout:?}"))
    }

    fn state_dir(&self) -> String {
        format!("{}/.houston-{}", self.home, self.channel)
    }

    fn daemon_file(&self) -> Option<serde_json::Value> {
        let out = self.run(&["/bin/cat", &format!("{}/daemon.json", self.state_dir())]);
        if !out.status.success() {
            return None;
        }
        serde_json::from_slice(&out.stdout).ok()
    }

    /// One `POST /manage` through `wsl-proxy`, with stdin closed after the request.
    fn manage(&self, token: &str, verb: &str) -> String {
        let body = serde_json::json!({ "manage_version": 1, "verb": verb }).to_string();
        let request = format!(
            "POST /manage HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut child = houston_core::spawn::command(WSL_EXE)
            .args(self.argv(&[&self.core(), "wsl-proxy", "--channel", &self.channel]))
            .env("WSL_UTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("starting wsl.exe for wsl-proxy");
        let mut stdin = child.stdin.take().unwrap();
        let _ = stdin.write_all(request.as_bytes());
        drop(stdin);
        let out = child.wait_with_output().expect("waiting for wsl-proxy");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn pid_alive(&self, pid: u64) -> bool {
        self.sh("kill -0 \"$1\" 2>/dev/null", &[&pid.to_string()])
            .status
            .success()
    }
}

/// Installs the binaries under the throwaway HOME and runs `wsl-ensure`; dropping it
/// stops that daemon through `/manage` and removes the throwaway HOME.
struct Daemon {
    live: Live,
    report: serde_json::Value,
}

impl Daemon {
    fn start(live: Live) -> Daemon {
        assert!(live.home.starts_with(HOME_PREFIX));
        let mut daemon = Daemon {
            live,
            report: serde_json::Value::Null,
        };
        let out = daemon.live.sh(
            "set -e; d=\"$HOME/.local/lib/houston-wsl/live\"; mkdir -p \"$d\"; \
             for n in houston-core tr-helper houston-supervisor; do cp \"$1/$n\" \"$d/$n\"; done",
            &[&daemon.live.linux_bin],
        );
        assert!(
            out.status.success(),
            "installing from {}: {}",
            daemon.live.linux_bin,
            String::from_utf8_lossy(&out.stderr)
        );
        let started = Instant::now();
        daemon.report = daemon.live.ensure();
        eprintln!(
            "wsl-ensure answered {} in {:.1} s",
            daemon.report["state"],
            started.elapsed().as_secs_f64()
        );
        daemon
    }

    fn token(&self) -> String {
        self.report["token"]
            .as_str()
            .expect("ensure reports a token")
            .to_string()
    }

    fn pid(&self) -> u64 {
        let file = self.live.daemon_file().expect("daemon.json exists");
        file["pid"].as_u64().expect("daemon.json carries pid")
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let live = &self.live;
        if let Some(file) = live.daemon_file() {
            let pid = file["pid"].as_u64().unwrap_or(0);
            let token = file["token"].as_str().unwrap_or_default();
            let response = live.manage(token, "daemon_shutdown");
            eprintln!(
                "daemon_shutdown through wsl-proxy: {}",
                response.lines().next().unwrap_or("<no response>")
            );
            let deadline = Instant::now() + Duration::from_secs(15);
            while pid > 1 && live.pid_alive(pid) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(250));
            }
            if pid > 1 && live.pid_alive(pid) {
                eprintln!("daemon {pid} outlived daemon_shutdown; sending SIGTERM");
                live.sh("kill -TERM \"$1\"", &[&pid.to_string()]);
                std::thread::sleep(Duration::from_secs(2));
            }
        }
        let out = live.sh(
            "case \"$1\" in /tmp/houston-live-*) rm -rf \"$1\";; esac",
            &[&live.home],
        );
        if !out.status.success() {
            eprintln!(
                "removing {}: {}",
                live.home,
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}

struct LiveBackend(Live);

impl Backend for LiveBackend {
    fn connect(&self) -> std::io::Result<Piped> {
        let live = &self.0;
        WslExe.spawn_piped(&live.argv(&[&live.core(), "wsl-proxy", "--channel", &live.channel]))
    }

    fn ensure(&self) -> BoxFuture<'static, Result<(), String>> {
        let live = self.0.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                live.ensure();
            })
            .await
            .map_err(|e| e.to_string())
        })
    }
}

async fn relay_hello(daemon: &Daemon) -> (Relay, Ws, serde_json::Value) {
    let relay = Relay::start(Arc::new(LiveBackend(daemon.live.clone())), RETRY_DELAY)
        .await
        .expect("binding the relay");
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}/ws", relay.port()))
            .await
            .expect("WebSocket upgrade through the relay");
    let hello = serde_json::json!({
        "type": "hello",
        "token": daemon.token(),
        "protocol": CHECKED_PROTOCOL,
    });
    ws.send(Message::text(hello.to_string())).await.unwrap();
    let reply = next_control(&mut ws, |_| true).await;
    (relay, ws, reply)
}

async fn next_message(ws: &mut Ws) -> Message {
    tokio::time::timeout(Duration::from_secs(30), ws.next())
        .await
        .expect("the daemon answers within 30 s")
        .expect("the socket stays open")
        .expect("a well-formed frame")
}

async fn next_control(
    ws: &mut Ws,
    wanted: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    loop {
        if let Message::Text(text) = next_message(ws).await {
            let msg: serde_json::Value = serde_json::from_str(&text).unwrap();
            if msg["type"] == "error" {
                panic!("daemon error: {msg}");
            }
            if wanted(&msg) {
                return msg;
            }
        }
    }
}

fn stdin_frame(session: u32, bytes: &[u8]) -> Message {
    let mut frame = vec![FRAME_STDIN];
    frame.extend_from_slice(&session.to_be_bytes());
    frame.extend_from_slice(bytes);
    Message::binary(frame)
}

/// The payload of an output frame for `session`; `None` for anything else.
fn output_payload(msg: &Message, session: u32) -> Option<&[u8]> {
    let Message::Binary(frame) = msg else {
        return None;
    };
    if frame.len() >= 13
        && frame[0] == FRAME_OUTPUT
        && u32::from_be_bytes(frame[1..5].try_into().unwrap()) == session
    {
        return Some(&frame[13..]);
    }
    None
}

async fn read_output_until(ws: &mut Ws, session: u32, needle: &[u8]) -> Vec<u8> {
    let mut seen = Vec::new();
    while !seen.windows(needle.len()).any(|w| w == needle) {
        let msg = next_message(ws).await;
        if let Some(payload) = output_payload(&msg, session) {
            seen.extend_from_slice(payload);
        }
    }
    seen
}

/// Reads until nothing arrives for `quiet`, so a late banner or prompt is not
/// mistaken for the next echo.
async fn drain_until_quiet(ws: &mut Ws, quiet: Duration) {
    while tokio::time::timeout(quiet, ws.next()).await.is_ok() {}
}

/// Creates a workspace at `<HOME>/proj` and a shell session in it.
async fn shell_session(daemon: &Daemon, ws: &mut Ws) -> (String, serde_json::Value) {
    let project = format!("{}/proj", daemon.live.home);
    let out = daemon.live.run(&["/bin/mkdir", "-p", &project]);
    assert!(out.status.success(), "mkdir {project}");
    let add = serde_json::json!({ "type": "workspace_add", "path": project });
    ws.send(Message::text(add.to_string())).await.unwrap();
    next_control(ws, |msg| {
        msg["type"] == "workspace_list"
            && msg["workspaces"]
                .as_array()
                .is_some_and(|list| list.iter().any(|w| w["path"] == project.as_str()))
    })
    .await;
    let create = serde_json::json!({
        "type": "session_create",
        "agent": "shell",
        "project_dir": project,
        "cols": 120,
        "rows": 40,
    });
    ws.send(Message::text(create.to_string())).await.unwrap();
    let created = next_control(ws, |msg| msg["type"] == "session_created").await;
    (project, created["info"].clone())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a real WSL 2 distro: set HOUSTON_TEST_WSL_DISTRO"]
async fn live_daemon_outlives_its_launcher() {
    let Some(live) = Live::from_env("c17") else {
        return;
    };
    let daemon = tokio::task::spawn_blocking(move || Daemon::start(live))
        .await
        .unwrap();
    assert_eq!(daemon.report["state"], "spawned", "{}", daemon.report);
    let pid = daemon.pid();
    let cmdline = |daemon: &Daemon| {
        let out = daemon
            .live
            .sh("tr '\\0' ' ' < \"/proc/$1/cmdline\"", &[&pid.to_string()]);
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let before = cmdline(&daemon);
    assert!(before.contains("houston-core"), "pid {pid} runs {before:?}");

    // Every wsl.exe this test started has exited: each ran to completion above.
    tokio::time::sleep(Duration::from_secs(60)).await;

    assert!(
        daemon.live.pid_alive(pid),
        "daemon pid {pid} died within 60 s of its launcher exiting"
    );
    assert_eq!(cmdline(&daemon), before, "pid {pid} was reused");
    let file = daemon
        .live
        .daemon_file()
        .expect("daemon.json is still there");
    assert_eq!(file["pid"].as_u64(), Some(pid));
    tokio::task::spawn_blocking(move || drop(daemon))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a real WSL 2 distro: set HOUSTON_TEST_WSL_DISTRO"]
async fn live_relay_answers_hello() {
    let Some(live) = Live::from_env("c26") else {
        return;
    };
    let daemon = tokio::task::spawn_blocking(move || Daemon::start(live))
        .await
        .unwrap();
    let (relay, ws, reply) = relay_hello(&daemon).await;
    assert_eq!(reply["type"], "hello_ok", "{reply}");
    assert_eq!(reply["protocol"], CHECKED_PROTOCOL, "{reply}");
    assert_eq!(daemon.report["protocol"], CHECKED_PROTOCOL);
    drop(ws);
    drop(relay);
    tokio::task::spawn_blocking(move || drop(daemon))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a real WSL 2 distro: set HOUSTON_TEST_WSL_DISTRO"]
async fn live_session_runs_inside_distro() {
    let Some(live) = Live::from_env("c41") else {
        return;
    };
    let daemon = tokio::task::spawn_blocking(move || Daemon::start(live))
        .await
        .unwrap();
    let (relay, mut ws, reply) = relay_hello(&daemon).await;
    assert_eq!(reply["type"], "hello_ok", "{reply}");
    let (project, info) = shell_session(&daemon, &mut ws).await;
    assert_eq!(info["project_dir"], project.as_str(), "{info}");
    assert_eq!(info["cwd"], project.as_str(), "{info}");
    let session = info["id"].as_u64().unwrap() as u32;

    ws.send(stdin_frame(session, b"uname -s; pwd\n"))
        .await
        .unwrap();
    let mut wanted = b"Linux".to_vec();
    wanted.extend_from_slice(b"\r\n");
    wanted.extend_from_slice(project.as_bytes());
    let seen = read_output_until(&mut ws, session, &wanted).await;
    eprintln!("session output: {:?}", String::from_utf8_lossy(&seen));

    drop(ws);
    drop(relay);
    tokio::task::spawn_blocking(move || drop(daemon))
        .await
        .unwrap();
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a real WSL 2 distro: set HOUSTON_TEST_WSL_DISTRO"]
async fn live_relay_throughput_and_echo_latency() {
    let Some(live) = Live::from_env("perf") else {
        return;
    };
    let daemon = tokio::task::spawn_blocking(move || Daemon::start(live))
        .await
        .unwrap();
    let (relay, mut ws, _) = relay_hello(&daemon).await;
    let (_, info) = shell_session(&daemon, &mut ws).await;
    let session = info["id"].as_u64().unwrap() as u32;

    // Keystroke to echo: `cat` in canonical mode, so the tty echoes each byte at once;
    // 200 bytes fit the line buffer, so no newline is sent between samples.
    ws.send(stdin_frame(session, b"cat\n")).await.unwrap();
    read_output_until(&mut ws, session, b"cat\r\n").await;
    drain_until_quiet(&mut ws, Duration::from_millis(1000)).await;
    let mut samples = Vec::new();
    for i in 0..200u32 {
        let byte = b'a' + (i % 26) as u8;
        let sent = Instant::now();
        ws.send(stdin_frame(session, &[byte])).await.unwrap();
        loop {
            let msg = next_message(&mut ws).await;
            if output_payload(&msg, session).is_some_and(|p| p.contains(&byte)) {
                samples.push(sent.elapsed());
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    eprintln!("perf: {} echo samples taken", samples.len());
    samples.sort();
    let (p50, p95) = (percentile(&samples, 0.50), percentile(&samples, 0.95));
    ws.send(stdin_frame(session, b"\x03")).await.unwrap();
    drain_until_quiet(&mut ws, Duration::from_millis(1000)).await;

    // Throughput: 36 MiB of random bytes as base64 (about 49 MiB of output).
    ws.send(stdin_frame(
        session,
        b"head -c 37748736 /dev/urandom | base64; echo __DO\"\"NE__\n",
    ))
    .await
    .unwrap();
    read_output_until(&mut ws, session, b"__DO\"\"NE__").await;
    eprintln!("perf: throughput command echoed");
    let started = Instant::now();
    let (mut bytes, mut gaps, mut tail) = (0usize, 0usize, Vec::new());
    while !tail.windows(8).any(|w| w == b"__DONE__") {
        let msg = next_message(&mut ws).await;
        if let Message::Binary(frame) = &msg {
            if frame.first() == Some(&FRAME_GAP) {
                gaps += 1;
                eprintln!("perf: gap after {bytes} bytes");
            }
        }
        if let Some(payload) = output_payload(&msg, session) {
            bytes += payload.len();
            tail.extend_from_slice(payload);
            let keep = tail.len().saturating_sub(16);
            tail.drain(..keep);
        }
    }
    let elapsed = started.elapsed();
    let mib_per_s = bytes as f64 / (1024.0 * 1024.0) / elapsed.as_secs_f64();
    eprintln!(
        "LIVE relay: echo latency p50 {:.2} ms, p95 {:.2} ms over {} samples; \
         throughput {:.1} MiB/s ({} bytes in {:.2} s, {} gap frames)",
        p50.as_secs_f64() * 1000.0,
        p95.as_secs_f64() * 1000.0,
        samples.len(),
        mib_per_s,
        bytes,
        elapsed.as_secs_f64(),
        gaps
    );

    drop(ws);
    drop(relay);
    tokio::task::spawn_blocking(move || drop(daemon))
        .await
        .unwrap();
}

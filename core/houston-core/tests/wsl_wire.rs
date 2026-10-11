#![allow(clippy::disallowed_methods)]

mod common;

use common::TOKEN;
use houston_protocol as proto;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

fn core_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

fn run_core(bin: impl AsRef<std::ffi::OsStr>, home: &Path, args: &[&str]) -> Output {
    common::hermetic_command(bin, home)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("running houston-core")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// The same shape the daemon writes, pointing at a live in-process daemon.
fn write_daemon_json(state_dir: &Path, port: u16) {
    std::fs::create_dir_all(state_dir).unwrap();
    let json = serde_json::json!({
        "port": port,
        "token": TOKEN,
        "pid": std::process::id(),
        "protocol": proto::PROTOCOL_VERSION,
    });
    std::fs::write(state_dir.join("daemon.json"), json.to_string()).unwrap();
}

#[cfg(unix)]
fn manage_blocking(port: u16, token: &str, verb: proto::ManageVerb) -> reqwest::blocking::Response {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
        .post(format!("http://127.0.0.1:{port}/manage"))
        .bearer_auth(token)
        .json(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb,
            candidate_bin: None,
            expected_sessions: None,
            path: None,
        })
        .send()
        .expect("POST /manage")
}

#[cfg(unix)]
#[derive(serde::Deserialize)]
struct DaemonFile {
    port: u16,
    token: String,
    pid: u32,
    #[serde(default)]
    pid_creation: Option<u64>,
}

#[cfg(unix)]
fn read_daemon_file(state_dir: &Path) -> Option<DaemonFile> {
    serde_json::from_str(&std::fs::read_to_string(state_dir.join("daemon.json")).ok()?).ok()
}

// Stops a daemon that wsl-ensure detached, through /manage, never by name.
#[cfg(unix)]
struct EnsuredDaemon(std::path::PathBuf);

#[cfg(unix)]
impl Drop for EnsuredDaemon {
    fn drop(&mut self) {
        use houston_core::pid::{process_is_alive, signal_process_checked_identity, Signal};
        let Some(file) = read_daemon_file(&self.0) else {
            return;
        };
        let _ = std::panic::catch_unwind(|| {
            manage_blocking(file.port, &file.token, proto::ManageVerb::DaemonShutdown)
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while process_is_alive(file.pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if process_is_alive(file.pid) {
            let _ = signal_process_checked_identity(file.pid, Signal::Kill, file.pid_creation);
        }
    }
}

#[cfg(unix)]
fn ensure_report(output: &Output) -> serde_json::Value {
    let stdout = text(&output.stdout);
    let lines: Vec<_> = stdout.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "wsl-ensure must print exactly one stdout line; stdout {stdout:?}, stderr {:?}",
        text(&output.stderr)
    );
    serde_json::from_str(lines[0]).unwrap_or_else(|e| panic!("{e}: {:?}", lines[0]))
}

#[cfg(unix)]
#[test]
fn wsl_ensure_spawns_when_no_daemon() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".houston-wslt-it");
    let _daemon = EnsuredDaemon(state_dir.clone());

    let out = run_core(
        core_bin(),
        home.path(),
        &["wsl-ensure", "--channel", "wslt-it"],
    );
    let report = ensure_report(&out);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", text(&out.stderr));
    assert_eq!(report["state"], "spawned", "{report}");
    let port = report["port"].as_u64().expect("spawned carries a port") as u16;
    assert_ne!(port, 0);
    let token = report["token"].as_str().expect("spawned carries a token");
    assert!(!token.is_empty());
    assert_eq!(report["protocol"], proto::PROTOCOL_VERSION);

    let status: proto::ManageDaemonStatus =
        manage_blocking(port, token, proto::ManageVerb::DaemonStatus)
            .json()
            .unwrap();
    assert_eq!(report["build"], status.build.as_str());
    assert_eq!(status.protocol_version, proto::PROTOCOL_VERSION);
    let file = read_daemon_file(&state_dir).expect("the spawned daemon wrote daemon.json");
    assert_eq!(file.port, port);
    assert!(
        state_dir.join("supervisor.json").is_file(),
        "the daemon must run under houston-supervisor"
    );
    assert!(
        !text(&out.stderr).contains(token),
        "the token must never reach stderr"
    );
    let launcher = std::fs::read_to_string(home.path().join(".local/bin/houston")).unwrap();
    assert_eq!(launcher.lines().nth(1), Some("# houston-wsl-managed"));
}

#[cfg(unix)]
#[test]
fn wsl_ensure_attaches_to_matching_daemon() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".houston-wslt-it");
    let _daemon = EnsuredDaemon(state_dir.clone());

    let first = run_core(
        core_bin(),
        home.path(),
        &["wsl-ensure", "--channel", "wslt-it"],
    );
    let first = ensure_report(&first);
    assert_eq!(first["state"], "spawned", "{first}");
    let pid = read_daemon_file(&state_dir).unwrap().pid;

    let out = run_core(
        core_bin(),
        home.path(),
        &["wsl-ensure", "--channel", "wslt-it"],
    );
    let second = ensure_report(&out);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", text(&out.stderr));
    assert_eq!(second["state"], "attached", "{second}");
    assert_eq!(second["port"], first["port"]);
    assert_eq!(second["token"], first["token"]);
    assert_eq!(second["build"], first["build"]);
    assert_eq!(
        read_daemon_file(&state_dir).unwrap().pid,
        pid,
        "attaching must not replace the daemon"
    );
}

// Puts the real daemon's discovery record back before `EnsuredDaemon` shuts it down.
#[cfg(unix)]
struct RestoreDaemonFile(std::path::PathBuf, String);

#[cfg(unix)]
impl Drop for RestoreDaemonFile {
    fn drop(&mut self) {
        let _ = std::fs::write(self.0.join("daemon.json"), &self.1);
    }
}

// Answers every request with `body` as a 200, the way a daemon answers daemon_status,
// and hands each raw request back to the test.
#[cfg(unix)]
fn serve_status_stub(
    body: String,
) -> (
    u16,
    std::sync::mpsc::Receiver<String>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    let stopped = stop.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stopped.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let Ok(mut stream) = stream else { continue };
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let head_end = loop {
                if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(at + 4);
                }
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break None,
                    Ok(n) => raw.extend_from_slice(&buf[..n]),
                }
            };
            let Some(head_end) = head_end else { continue };
            let head = text(&raw[..head_end]).to_ascii_lowercase();
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            while raw.len() < head_end + length {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => raw.extend_from_slice(&buf[..n]),
                }
            }
            let _ = tx.send(text(&raw));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (port, rx, stop)
}

// A newer Houston daemon owns the channel: a live houston process in daemon.json whose
// daemon_status reports a higher protocol. Ensure must refuse it, not replace it.
#[cfg(unix)]
#[test]
fn wsl_ensure_exits_3_for_a_newer_daemon() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".houston-wslt-newer");
    let _daemon = EnsuredDaemon(state_dir.clone());

    let first = run_core(
        core_bin(),
        home.path(),
        &["wsl-ensure", "--channel", "wslt-newer"],
    );
    let first = ensure_report(&first);
    assert_eq!(first["state"], "spawned", "{first}");
    let real = read_daemon_file(&state_dir).unwrap();
    let mut status: proto::ManageDaemonStatus =
        manage_blocking(real.port, &real.token, proto::ManageVerb::DaemonStatus)
            .json()
            .unwrap();
    let newer = proto::PROTOCOL_VERSION + 1;
    status.protocol_version = newer;
    let (stub_port, requests, stop_stub) =
        serve_status_stub(serde_json::to_string(&status).unwrap());

    let original = std::fs::read_to_string(state_dir.join("daemon.json")).unwrap();
    let _restore = RestoreDaemonFile(state_dir.clone(), original.clone());
    let mut record: serde_json::Value = serde_json::from_str(&original).unwrap();
    record["port"] = stub_port.into();
    std::fs::write(state_dir.join("daemon.json"), record.to_string()).unwrap();

    let out = run_core(
        core_bin(),
        home.path(),
        &["wsl-ensure", "--channel", "wslt-newer"],
    );
    stop_stub.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = std::net::TcpStream::connect(("127.0.0.1", stub_port));
    let report = ensure_report(&out);
    assert_eq!(out.status.code(), Some(3), "stderr: {}", text(&out.stderr));
    assert_eq!(report["state"], "refused", "{report}");
    let fields = report.as_object().unwrap();
    assert!(
        !fields.contains_key("port") && !fields.contains_key("token"),
        "a refusal must not hand out the daemon's port or token: {report}"
    );
    assert_eq!(report["protocol"], newer);
    let reason = report["reason"].as_str().expect("refused carries a reason");
    assert!(
        reason.contains(&newer.to_string())
            && reason.contains(&proto::PROTOCOL_VERSION.to_string()),
        "the reason must name protocols {newer} and {}: {reason}",
        proto::PROTOCOL_VERSION
    );
    assert!(
        !text(&out.stderr).contains(&real.token),
        "the token must never reach stderr"
    );

    let asked = requests
        .try_recv()
        .expect("ensure must ask the owning daemon for its status");
    assert!(asked.starts_with("POST /manage "), "{asked:?}");
    assert!(asked.contains("\"daemon_status\""), "{asked:?}");
    assert!(
        asked
            .to_ascii_lowercase()
            .contains(&format!("authorization: bearer {}", real.token).to_ascii_lowercase()),
        "{asked:?}"
    );
    let after = read_daemon_file(&state_dir).expect("daemon.json survives a refusal");
    assert_eq!(after.pid, real.pid, "a refusal must not spawn a daemon");
    assert_eq!(
        after.port, stub_port,
        "a refusal must not touch daemon.json"
    );
    assert!(
        houston_core::pid::process_is_alive(real.pid),
        "a refusal must not stop the newer daemon"
    );
}

#[cfg(unix)]
#[test]
fn wsl_ensure_exits_1_when_supervisor_missing() {
    let home = tempfile::tempdir().unwrap();
    let bin_dir = home.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let lone_core = bin_dir.join("houston-core");
    if std::fs::hard_link(core_bin(), &lone_core).is_err() {
        std::fs::copy(core_bin(), &lone_core).unwrap();
    }

    let out = run_core(
        &lone_core,
        home.path(),
        &["wsl-ensure", "--channel", "wslt-it"],
    );
    assert_eq!(out.status.code(), Some(1), "stderr: {}", text(&out.stderr));
    assert!(
        out.stdout.is_empty(),
        "a failure prints no report: {}",
        text(&out.stdout)
    );
    let missing = bin_dir.join("houston-supervisor");
    assert!(
        text(&out.stderr).contains(&missing.display().to_string()),
        "stderr must name {}: {}",
        missing.display(),
        text(&out.stderr)
    );
    assert!(!home.path().join(".houston-wslt-it/daemon.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn wsl_proxy_splices_manage_request() {
    let (addr, _dir) = common::start_daemon().await;
    let home = tempfile::tempdir().unwrap();
    write_daemon_json(&home.path().join(".houston-wslt-proxy"), addr.port());
    let home_path = home.path().to_path_buf();

    let run = tokio::task::spawn_blocking(move || {
        let mut child = common::hermetic_command(core_bin(), &home_path)
            .args(["wsl-proxy", "--channel", "wslt-proxy"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let body = serde_json::to_string(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonStatus,
            candidate_bin: None,
            expected_sessions: None,
            path: None,
        })
        .unwrap();
        let request = format!(
            "POST /manage HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(request.as_bytes()).unwrap();
        stdin.flush().unwrap();
        let mut response = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut response)
            .unwrap();
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        drop(stdin);
        (text(&response), status, stderr)
    });
    let (response, status, stderr) = tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .expect("the proxy must exit once the daemon closes the connection")
        .unwrap();

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "response {response:?}, stderr {stderr:?}"
    );
    let build = format!("\"build\":\"{}\"", houston_core::daemon::build_commit());
    assert!(
        response.contains(&build),
        "{build} missing from {response:?}"
    );
    assert_eq!(status.code(), Some(0), "stderr: {stderr}");
}

// A piped request (`printf ... | wsl-proxy`) ends stdin before the daemon answers; a
// handler that yields, as daemon_shutdown does, must still answer and run.
#[tokio::test(flavor = "multi_thread")]
async fn wsl_proxy_completes_a_slow_request_after_stdin_eof() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".houston-wslt-slow");
    std::fs::create_dir_all(&state_dir).unwrap();
    let daemon = houston_core::daemon::Daemon::new(houston_core::daemon::DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap();
    let (addr, _handle) =
        houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
    daemon.set_port(addr.port());
    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let exited = exited.clone();
        daemon.reap_set_exit_hook_for_test(Box::new(move || {
            exited.store(true, std::sync::atomic::Ordering::SeqCst);
        }));
    }
    write_daemon_json(&state_dir, addr.port());
    let home_path = home.path().to_path_buf();

    let run = tokio::task::spawn_blocking(move || {
        let mut child = common::hermetic_command(core_bin(), &home_path)
            .args(["wsl-proxy", "--channel", "wslt-slow"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let body = serde_json::to_string(&proto::ManageRequest {
            manage_version: proto::MANAGE_VERSION,
            verb: proto::ManageVerb::DaemonShutdown,
            candidate_bin: None,
            expected_sessions: None,
            path: None,
        })
        .unwrap();
        let request = format!(
            "POST /manage HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(request.as_bytes()).unwrap();
        drop(stdin);
        let mut response = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut response)
            .unwrap();
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        (text(&response), status, stderr)
    });
    let (response, status, stderr) = tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .expect("the proxy must exit once the daemon closes the connection")
        .unwrap();

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "response {response:?}, stderr {stderr:?}"
    );
    assert!(response.contains("\"ok\":true"), "{response:?}");
    assert_eq!(status.code(), Some(0), "stderr: {stderr}");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !exited.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "daemon_shutdown answered but the daemon never ran its exit"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !state_dir.join("daemon.json").exists(),
        "a completed daemon_shutdown removes daemon.json"
    );
}

// A WebSocket peer never closes on its own: after the relay closes stdin, the proxy
// must still end within its grace so `wsl.exe` and the relay task exit.
#[test]
fn wsl_proxy_exits_after_stdin_eof_when_the_daemon_stays_open() {
    let home = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    write_daemon_json(
        &home.path().join(".houston-wslt-idle"),
        listener.local_addr().unwrap().port(),
    );
    let holder = std::thread::spawn(move || listener.accept().map(|(stream, _)| stream));

    let started = std::time::Instant::now();
    let mut child = common::hermetic_command(core_bin(), home.path())
        .args(["wsl-proxy", "--channel", "wslt-idle"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _held = holder.join().unwrap().expect("the proxy connects");
    drop(child.stdin.take());
    let deadline = started + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            panic!("wsl-proxy still running 30 s after stdin closed");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.code(), Some(0));
}

#[test]
fn wsl_proxy_exits_2_without_daemon() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(".houston-wslt-proxy");

    let out = run_core(
        core_bin(),
        home.path(),
        &["wsl-proxy", "--channel", "wslt-proxy"],
    );
    assert_eq!(out.status.code(), Some(2), "stderr: {}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains(&state_dir.display().to_string()),
        "stderr must name {}: {}",
        state_dir.display(),
        text(&out.stderr)
    );

    let closed_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    write_daemon_json(&state_dir, closed_port);
    let out = run_core(
        core_bin(),
        home.path(),
        &["wsl-proxy", "--channel", "wslt-proxy"],
    );
    assert_eq!(out.status.code(), Some(2), "stderr: {}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains(&state_dir.display().to_string()),
        "a refused port must also name {}: {}",
        state_dir.display(),
        text(&out.stderr)
    );
}

#[test]
fn open_exit_codes() {
    let home = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let project_arg = project.path().display().to_string();

    let out = run_core(
        core_bin(),
        home.path(),
        &["open", "--channel", "wslt-open", &project_arg],
    );
    assert_eq!(out.status.code(), Some(1), "stderr: {}", text(&out.stderr));
    assert_eq!(
        text(&out.stderr).trim_end(),
        "Houston is not running in this distro; enable it in Houston → Settings → WSL"
    );

    let file = project.path().join("notes.txt");
    std::fs::write(&file, "x").unwrap();
    let file_arg = file.display().to_string();
    let out = run_core(
        core_bin(),
        home.path(),
        &["open", "--channel", "wslt-open", &file_arg],
    );
    assert_eq!(out.status.code(), Some(2), "stderr: {}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains("notes.txt"),
        "{}",
        text(&out.stderr)
    );

    let missing = project.path().join("missing").display().to_string();
    let out = run_core(core_bin(), home.path(), &["open", &missing]);
    assert_eq!(out.status.code(), Some(2), "stderr: {}", text(&out.stderr));
}

#[tokio::test(flavor = "multi_thread")]
async fn open_adds_workspace_through_running_daemon() {
    let (addr, _dir) = common::start_daemon().await;
    let home = tempfile::tempdir().unwrap();
    write_daemon_json(&home.path().join(".houston-wslt-open"), addr.port());
    let project = tempfile::tempdir().unwrap();
    let canonical = std::fs::canonicalize(project.path()).unwrap();
    #[cfg(windows)]
    let canonical = houston_core::paths::windows_command_path(&canonical);
    let expected = canonical.display().to_string();

    let mut ws = common::connect_and_hello(addr, TOKEN).await;
    common::next_control(&mut ws).await;
    let (home_path, arg) = (
        home.path().to_path_buf(),
        project.path().display().to_string(),
    );
    let out = tokio::task::spawn_blocking(move || {
        run_core(
            core_bin(),
            &home_path,
            &["open", "--channel", "wslt-open", &arg],
        )
    })
    .await
    .unwrap();
    assert_eq!(out.status.code(), Some(0), "stderr: {}", text(&out.stderr));
    loop {
        match common::next_control(&mut ws).await {
            proto::ServerMsg::WorkspaceFocus { path } => {
                assert_eq!(path, expected);
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => {}
        }
    }
}

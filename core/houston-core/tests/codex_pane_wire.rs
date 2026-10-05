#![cfg(target_os = "linux")]

use houston_core::{codex_pane, hook_drop::HookDrop, pid};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const THREAD_ID: &str = "b5722fca-c1de-47e9-8d07-9cdb401de084";

const FAKE_CODEX: &str = r#"#!/usr/bin/python3
import base64, hashlib, json, os, pathlib, socket, struct, subprocess, sys, threading, time
root = pathlib.Path.cwd()
thread_id = 'b5722fca-c1de-47e9-8d07-9cdb401de084'
mode = (root / 'mode').read_text()
if '--version' in sys.argv:
    print('codex-cli 0.160.0')
    sys.exit(0)
if 'login' in sys.argv:
    (root / 'passthrough.argv').write_text(json.dumps(sys.argv[1:]))
    print('PASSTHROUGH', flush=True)
    sys.exit(0)

def receive_exact(conn, count):
    data = b''
    while len(data) < count:
        part = conn.recv(count - len(data))
        if not part:
            raise EOFError()
        data += part
    return data

def receive(conn):
    first, second = receive_exact(conn, 2)
    size = second & 127
    if size == 126:
        size = struct.unpack('!H', receive_exact(conn, 2))[0]
    elif size == 127:
        size = struct.unpack('!Q', receive_exact(conn, 8))[0]
    mask = receive_exact(conn, 4) if second & 128 else None
    payload = receive_exact(conn, size)
    if mask:
        payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
    if first & 15 == 8:
        raise EOFError()
    return json.loads(payload)

def send(conn, value):
    payload = json.dumps(value).encode()
    header = bytes([129, len(payload)]) if len(payload) < 126 else bytes([129, 126]) + struct.pack('!H', len(payload))
    conn.sendall(header + payload)

def handle(conn):
    try:
        request = b''
        while b'\r\n\r\n' not in request:
            part = conn.recv(4096)
            if not part:
                return
            request += part
        headers = dict(line.split(':', 1) for line in request.decode().split('\r\n')[1:] if ':' in line)
        key = next(value.strip() for name, value in headers.items() if name.lower() == 'sec-websocket-key')
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n').encode())
        while True:
            value = receive(conn)
            method = value.get('method')
            with (root / 'rpc.log').open('a') as log:
                log.write(json.dumps(value) + '\n')
            if 'id' not in value:
                continue
            ready = (root / 'ready').exists()
            if method == 'initialize':
                result = {'userAgent': 'fake-codex', 'platformFamily': 'unix', 'platformOs': 'linux'}
            elif method == 'thread/loaded/list':
                result = {'data': [thread_id] if ready else [], 'nextCursor': None}
            elif method == 'thread/read':
                status = {'type': 'active', 'activeFlags': ['waitingOnApproval']} if mode == 'blocked' else {'type': 'idle' if ready else 'notLoaded'}
                source = {'subAgent': {'parentThreadId': 'parent', 'depth': 1}} if mode == 'subagent' else 'vscode'
                result = {'thread': {'id': thread_id, 'cwd': str(root), 'source': source, 'agentRole': None, 'status': status}}
            else:
                result = {}
            send(conn, {'jsonrpc': '2.0', 'id': value['id'], 'result': result})
    except (EOFError, OSError):
        pass
    finally:
        conn.close()

if 'app-server' in sys.argv:
    (root / 'server.env').write_text(json.dumps({'session': os.getenv('HOUSTON_SESSION'), 'mcpToken': os.getenv('HOUSTON_MCP_TOKEN')}))
    address = sys.argv[sys.argv.index('--listen') + 1]
    assert address.startswith('unix://')
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(address[7:])
    listener.listen()
    (root / 'server.pid').write_text(str(os.getpid()))
    descendant = subprocess.Popen([sys.executable, '-c', 'import os,pathlib,signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(120)', str(root / 'server-child.pid')], start_new_session=True)
    while not (root / 'server-child.pid').exists():
        time.sleep(0.005)
    while True:
        conn, _ = listener.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()
else:
    assert os.isatty(0) and os.isatty(1), 'native CLI requires a real PTY'
    assert '--remote' in sys.argv
    address = sys.argv[sys.argv.index('--remote') + 1]
    assert address.startswith('unix://') and pathlib.Path(address[7:]).exists()
    (root / 'tui.argv').write_text(json.dumps(sys.argv))
    (root / 'tui.pid').write_text(str(os.getpid()))
    if mode == 'trust':
        print('TRUST_REQUIRED', flush=True)
    print('TTY_READY', flush=True)
    for line in sys.stdin:
        if line.strip() == 'ready':
            (root / 'ready').touch()
            print('TTY_ACCEPTED:ready', flush=True)
        elif line.strip() == 'exit':
            break
"#;

struct Rig {
    dir: tempfile::TempDir,
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    output: Receiver<String>,
    descendants: Vec<(u32, u64)>,
}

impl Rig {
    fn start(mode: &str) -> Option<Self> {
        use std::os::unix::fs::PermissionsExt;
        if houston_core::session_isolation::launcher().is_none() {
            eprintln!("SKIPPED: user systemd unavailable for a native Codex scope and guardian");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("mode"), mode).unwrap();
        let fake = dir.path().join("fake-codex");
        std::fs::write(&fake, FAKE_CODEX).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let drop_dir = dir.path().join("drop");
        std::fs::create_dir(&drop_dir).unwrap();
        let mut command = CommandBuilder::new(&fake);
        command.cwd(dir.path());
        command.env("HOUSTON_SESSION", "41");
        command.env("HOUSTON_MCP_TOKEN", "fixture-token");
        command.env(houston_core::paths::CHANNEL_ENV, "test-codex-pane");
        let resume = (mode != "fresh").then_some(THREAD_ID);
        if let Some(resume) = resume {
            command.args(["resume", resume]);
        }
        let launcher = Path::new(env!("CARGO_BIN_EXE_houston-core"));
        codex_pane::wrap(
            &mut command,
            launcher,
            &dir.path().join("codex.sock"),
            &drop_dir,
            resume,
        )
        .unwrap();
        houston_core::session_isolation::wrap(&mut command, launcher, "test-codex-pane", 41);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (send, output) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0
                    || send
                        .send(String::from_utf8_lossy(&bytes[..count]).into_owned())
                        .is_err()
                {
                    break;
                }
            }
        });
        let mut rig = Self {
            dir,
            child,
            _master: pair.master,
            writer,
            output,
            descendants: Vec::new(),
        };
        rig.expect_output("TTY_READY");
        let backend_env: serde_json::Value =
            serde_json::from_slice(&std::fs::read(rig.dir.path().join("server.env")).unwrap())
                .unwrap();
        assert_eq!(
            backend_env,
            serde_json::json!({"session": "41", "mcpToken": "fixture-token"}),
            "the backend must inherit only this pane's synthetic identity and MCP token"
        );
        for name in ["server.pid", "server-child.pid", "tui.pid"] {
            let pid = rig.file_pid(name);
            let creation = pid::process_creation_token(pid).unwrap();
            rig.descendants.push((pid, creation));
        }
        let root = rig.child.process_id().unwrap();
        let children =
            std::fs::read_to_string(format!("/proc/{root}/task/{root}/children")).unwrap();
        let observer = children
            .split_whitespace()
            .filter_map(|child| child.parse::<u32>().ok())
            .find(|child| {
                std::fs::read(format!("/proc/{child}/cmdline"))
                    .ok()
                    .is_some_and(|command| {
                        command
                            .split(|byte| *byte == 0)
                            .any(|argument| argument == b"codex-observe")
                    })
            })
            .expect("pane must own a separate startup observer");
        rig.descendants
            .push((observer, pid::process_creation_token(observer).unwrap()));
        let observer_pid = pid::checked_pid(observer).unwrap();
        assert_eq!(
            unsafe { libc::getpgid(observer_pid) },
            observer_pid,
            "guardian must survive termination of the TUI group"
        );
        let root = pid::checked_pid(root).unwrap();
        assert_eq!(
            unsafe { libc::getsid(root) },
            root,
            "helper remains PTY session leader"
        );
        assert_eq!(
            unsafe { libc::getsid(observer_pid) },
            root,
            "guardian remains in the owned terminal session"
        );
        let detached = pid::checked_pid(rig.file_pid("server-child.pid")).unwrap();
        assert_eq!(
            unsafe { libc::getsid(detached) },
            detached,
            "fixture must escape the backend process group"
        );
        let tui = pid::checked_pid(rig.file_pid("tui.pid")).unwrap();
        assert_eq!(
            unsafe { libc::getsid(tui) },
            root,
            "TUI retains controlling terminal session"
        );
        assert_eq!(
            unsafe { libc::getpgid(tui) },
            root,
            "TUI retains terminal foreground group"
        );
        Some(rig)
    }

    fn file_pid(&self, name: &str) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(contents) = std::fs::read_to_string(self.dir.path().join(name)) {
                if let Ok(process) = contents.trim().parse() {
                    return process;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fake Codex did not record {name}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn expect_output(&self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        while !output.contains(needle) {
            output.push_str(
                &self
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|error| {
                        panic!("real PTY did not produce {needle}: {error}; output: {output}")
                    }),
            );
        }
    }

    fn send(&mut self, text: &str) {
        self.writer.write_all(text.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn drops(&self) -> Vec<HookDrop> {
        std::fs::read_dir(self.dir.path().join("drop"))
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                (path
                    .extension()
                    .is_some_and(|extension| extension == "json"))
                .then(|| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
            })
            .collect()
    }

    fn await_probes(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let log = std::fs::read_to_string(self.dir.path().join("rpc.log")).unwrap_or_default();
            if log
                .lines()
                .filter(|line| line.contains("thread/read") || line.contains("thread/loaded/list"))
                .count()
                >= 3
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "observer did not query native thread state"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn await_idle_drop(&self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let drops = self.drops();
            if let Some(drop) = drops.iter().find(|drop| drop.event == "SessionStart") {
                assert_eq!(drop.agent.as_deref(), Some("codex"));
                assert_eq!(drop.session, 41);
                assert_eq!(drop.session_id.as_deref(), Some(THREAD_ID));
                assert_eq!(drop.cwd.as_deref(), self.dir.path().to_str());
                return;
            }
            assert!(
                Instant::now() < deadline,
                "native idle did not produce startup lifecycle evidence"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn await_exit_and_cleanup(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.child.try_wait().unwrap().is_some()
                && self
                    .descendants
                    .iter()
                    .all(|(process, token)| !owned_process_running(*process, *token))
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "TUI exit left an owned backend process alive"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn owned_process_running(process: u32, token: u64) -> bool {
    pid::process_creation_token(process) == Some(token)
        && std::fs::read_to_string(format!("/proc/{process}/stat"))
            .ok()
            .is_some_and(|stat| {
                stat.rsplit_once(')')
                    .is_some_and(|(_, rest)| !rest.trim_start().starts_with('Z'))
            })
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.writer.write_all(b"exit\n");
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.child.try_wait().ok().flatten().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        for (process, token) in &self.descendants {
            let _ = pid::signal_process_checked_identity(*process, pid::Signal::Kill, Some(*token));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[test]
fn fresh_native_idle_keeps_the_tui_and_cleans_backend_on_natural_exit() {
    let Some(mut rig) = Rig::start("fresh") else {
        return;
    };
    rig.await_probes();
    assert!(
        rig.drops().is_empty(),
        "an unloaded thread must not report idle"
    );
    rig.send("ready\n");
    rig.expect_output("TTY_ACCEPTED:ready");
    rig.await_idle_drop();
    rig.send("exit\n");
    rig.await_exit_and_cleanup();
    assert!(
        rig.child.try_wait().unwrap().unwrap().success(),
        "guardian cleanup must preserve the TUI exit code"
    );
}

#[test]
fn resumed_native_not_loaded_waits_for_the_existing_thread_to_be_idle() {
    let Some(mut rig) = Rig::start("resume") else {
        return;
    };
    rig.await_probes();
    assert!(rig.drops().is_empty(), "notLoaded is not resumed idle");
    rig.send("ready\n");
    rig.expect_output("TTY_ACCEPTED:ready");
    rig.await_idle_drop();
    let argv: Vec<String> =
        serde_json::from_slice(&std::fs::read(rig.dir.path().join("tui.argv")).unwrap()).unwrap();
    assert!(argv
        .windows(2)
        .any(|args| args[0] == "resume" && args[1] == THREAD_ID));
    rig.send("exit\n");
    rig.await_exit_and_cleanup();
    assert!(
        rig.child.try_wait().unwrap().unwrap().success(),
        "guardian cleanup must preserve the resumed TUI exit code"
    );
}

#[test]
fn native_approval_block_does_not_report_startup_idle() {
    let Some(mut rig) = Rig::start("blocked") else {
        return;
    };
    rig.await_probes();
    assert!(
        rig.drops().is_empty(),
        "waitingOnApproval is not startup idle"
    );
    rig.send("exit\n");
    rig.await_exit_and_cleanup();
}

#[test]
fn native_trust_prompt_without_a_loaded_thread_does_not_report_startup_idle() {
    let Some(mut rig) = Rig::start("trust") else {
        return;
    };
    rig.await_probes();
    assert!(
        rig.drops().is_empty(),
        "an unresolved native trust prompt is not startup idle"
    );
    rig.send("exit\n");
    rig.await_exit_and_cleanup();
}

#[test]
fn an_idle_subagent_cannot_supply_the_resumed_root_pane_status() {
    let Some(mut rig) = Rig::start("subagent") else {
        return;
    };
    rig.send("ready\n");
    rig.expect_output("TTY_ACCEPTED:ready");
    rig.await_probes();
    assert!(
        rig.drops().is_empty(),
        "matching thread IDs must also identify the root CLI thread"
    );
    rig.send("exit\n");
    rig.await_exit_and_cleanup();
}

#[test]
fn closing_a_scoped_native_pane_kills_its_backend_without_signalling_the_host() {
    let Some(mut rig) = Rig::start("resume") else {
        return;
    };
    let root = rig.child.process_id().unwrap();
    let root_token = pid::process_creation_token(root).unwrap();
    let host_token = pid::self_creation_token().unwrap();
    let pane_cgroup = std::fs::read_to_string(format!("/proc/{root}/cgroup")).unwrap();
    let server = rig.file_pid("server.pid");
    assert_eq!(
        pane_cgroup,
        std::fs::read_to_string(format!("/proc/{server}/cgroup")).unwrap()
    );
    assert_ne!(
        pane_cgroup,
        std::fs::read_to_string("/proc/self/cgroup").unwrap()
    );
    assert!(!houston_core::session_isolation::terminate_owned_scope(
        root,
        41,
        Some("test-codex-pane"),
        Some(root_token + 1)
    )
    .unwrap());
    assert!(
        owned_process_running(root, root_token),
        "a stale creation token must not kill the pane"
    );
    assert!(houston_core::session_isolation::terminate_owned_scope(
        root,
        41,
        Some("test-codex-pane"),
        Some(root_token)
    )
    .unwrap());
    rig.await_exit_and_cleanup();
    assert_eq!(pid::self_creation_token(), Some(host_token));
    assert!(pid::process_is_alive(std::process::id()));
}

#[test]
fn the_guardian_cleans_detached_backend_descendants_after_root_hangup() {
    let Some(mut rig) = Rig::start("resume") else {
        return;
    };
    rig.send("ready\n");
    rig.expect_output("TTY_ACCEPTED:ready");
    rig.await_idle_drop();
    let root = rig.child.process_id().unwrap();
    let creation = pid::process_creation_token(root).unwrap();
    assert!(
        rig.descendants
            .iter()
            .all(|(process, token)| owned_process_running(*process, *token)),
        "the guardian must remain alive after the first idle report"
    );
    pid::signal_process_checked_identity(root, pid::Signal::Hup, Some(creation)).unwrap();
    rig.await_exit_and_cleanup();
    assert!(pid::process_is_alive(std::process::id()));
}

#[test]
fn shell_helper_passes_login_and_version_to_the_original_cli() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("mode"), "fresh").unwrap();
    let fake = dir.path().join("fake-codex");
    std::fs::write(&fake, FAKE_CODEX).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    let run = |arguments: &[&str]| {
        let mut command = houston_core::spawn::command(env!("CARGO_BIN_EXE_houston-core"));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", dir.path())
            .env("CODEX_HOME", dir.path().join("codex-home"));
        command
            .current_dir(dir.path())
            .arg(codex_pane::SHELL_SUBCOMMAND)
            .arg(dir.path().join("drop"))
            .arg("--")
            .arg(&fake)
            .args(arguments)
            .output()
            .unwrap()
    };
    let login = run(&["login", "--device-auth"]);
    assert!(login.status.success());
    assert_eq!(String::from_utf8_lossy(&login.stdout).trim(), "PASSTHROUGH");
    let argv: Vec<String> =
        serde_json::from_slice(&std::fs::read(dir.path().join("passthrough.argv")).unwrap())
            .unwrap();
    assert_eq!(argv, ["login", "--device-auth"]);
    let version = run(&["--version"]);
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "codex-cli 0.160.0"
    );
    assert!(
        !dir.path().join("server.pid").exists(),
        "noninteractive commands must not launch a server"
    );
}

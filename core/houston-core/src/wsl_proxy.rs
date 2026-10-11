//! `wsl-proxy` and `open`: commands that reach an already running daemon of a channel.
//! The proxy carries one relay connection's bytes between stdio and the daemon's port.

use crate::wsl_ensure::{channel_state_dir, read_daemon_file, split_channel};
use std::io::{Read, Write};

pub const NOT_RUNNING: &str =
    "Houston is not running in this distro; enable it in Houston → Settings → WSL";
pub const EXIT_NO_DAEMON: i32 = 2;
// Matches a WebSocket burst of PTY output, so one read rarely splits a frame.
const SPLICE_BUFFER: usize = 64 * 1024;
// Covers daemon_shutdown, which drains sessions for up to 5 s before it answers.
const STDIN_EOF_GRACE: std::time::Duration = std::time::Duration::from_secs(10);

pub fn run_proxy(args: &[String]) -> i32 {
    let channel = match split_channel("wsl-proxy", args) {
        Ok((Some(channel), rest)) if rest.is_empty() => channel,
        Ok((_, rest)) => {
            eprintln!(
                "houston-core wsl-proxy: unexpected arguments {rest:?}; expected --channel <name>"
            );
            return EXIT_NO_DAEMON;
        }
        Err(message) => {
            eprintln!("{message}");
            return EXIT_NO_DAEMON;
        }
    };
    let state_dir = match channel_state_dir("wsl-proxy", &channel) {
        Ok((_, dir)) => dir,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_NO_DAEMON;
        }
    };
    let Some(file) = read_daemon_file(&state_dir) else {
        eprintln!(
            "houston-core wsl-proxy: no daemon for channel {channel}: {} is missing or unreadable (state dir {})",
            state_dir.join("daemon.json").display(),
            state_dir.display()
        );
        return EXIT_NO_DAEMON;
    };
    let upstream = match std::net::TcpStream::connect(("127.0.0.1", file.port)) {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!(
                "houston-core wsl-proxy: no daemon for channel {channel}: connecting to 127.0.0.1:{} failed: {e} (state dir {})",
                file.port,
                state_dir.display()
            );
            return EXIT_NO_DAEMON;
        }
    };
    let _ = upstream.set_nodelay(true);
    splice(upstream)
}

// Returns when the daemon or stdout closes. Stdin EOF leaves the socket open, because
// the daemon's HTTP server drops an unanswered request once its peer half-closes;
// the reply keeps flowing until the daemon closes or the grace ends the process.
fn splice(upstream: std::net::TcpStream) -> i32 {
    let mut to_daemon = match upstream.try_clone() {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!("houston-core wsl-proxy: cloning the daemon socket: {e}");
            return 1;
        }
    };
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = vec![0u8; SPLICE_BUFFER];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if to_daemon.write_all(&buf[..n]).is_err() {
                        std::process::exit(0);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        std::thread::sleep(STDIN_EOF_GRACE);
        std::process::exit(0);
    });
    let mut from_daemon = upstream;
    let mut stdout = std::io::stdout().lock();
    let mut buf = vec![0u8; SPLICE_BUFFER];
    loop {
        match from_daemon.read(&mut buf) {
            Ok(0) => return 0,
            Ok(n) => {
                if stdout
                    .write_all(&buf[..n])
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    return 0;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return 0,
        }
    }
}

pub fn run_open(args: &[String]) -> i32 {
    let (flag, rest) = match split_channel("open", args) {
        Ok(split) => split,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };
    let [dir] = rest.as_slice() else {
        eprintln!(
            "houston-core open: expected exactly one directory, got {rest:?}; usage: houston-core open [--channel <name>] <dir>"
        );
        return 2;
    };
    let raw_channel = flag
        .or_else(|| std::env::var(crate::paths::CHANNEL_ENV).ok())
        .unwrap_or_else(|| "release".to_string());
    let state_dir = match channel_state_dir("open", &raw_channel) {
        Ok((_, dir)) => dir,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };
    let absolute = match std::fs::canonicalize(dir) {
        Ok(path) if path.is_dir() => path,
        _ => {
            eprintln!(
                "houston-core open: {dir:?} is not a directory; expected an existing directory"
            );
            return 2;
        }
    };
    #[cfg(windows)]
    let absolute = crate::paths::windows_command_path(&absolute);
    let Some(path) = absolute.to_str().map(str::to_string) else {
        eprintln!(
            "houston-core open: {absolute:?} is not valid UTF-8; expected a UTF-8 directory path"
        );
        return 2;
    };
    let Some(file) = read_daemon_file(&state_dir) else {
        eprintln!("{NOT_RUNNING}");
        return 1;
    };
    let sent = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .and_then(|client| {
            client
                .post(format!("http://127.0.0.1:{}/manage", file.port))
                .bearer_auth(&file.token)
                .json(&houston_protocol::ManageRequest {
                    manage_version: houston_protocol::MANAGE_VERSION,
                    verb: houston_protocol::ManageVerb::WorkspaceOpen,
                    candidate_bin: None,
                    expected_sessions: None,
                    path: Some(path.clone()),
                })
                .send()
        });
    let resp = match sent {
        Ok(resp) => resp,
        Err(_) => {
            eprintln!("{NOT_RUNNING}");
            return 1;
        }
    };
    let status = resp.status();
    if status.is_success() {
        println!("Opened {path} in Houston");
        return 0;
    }
    let body = resp.text().unwrap_or_default();
    eprintln!("houston-core open: the daemon refused {path:?} (HTTP {status}): {body}");
    1
}

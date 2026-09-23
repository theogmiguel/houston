use anyhow::{Context, Result};
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct DaemonFileConfig {
    port: u16,
    token: String,
    pid: u32,
    protocol: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid_creation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supervisor_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    generation: Option<u64>,
}

// Refuses to own EITHER channel's state when `HOUSTON_CHANNEL` is unset,
// unlike `paths::config_dir` (which treats unset as the release channel):
// defense in depth against a stray direct invocation of this binary.
fn owning_config_dir() -> Result<PathBuf> {
    let home = houston_core::home_dir::home_dir().context("cannot resolve home directory")?;
    let env_value = std::env::var(houston_core::paths::CHANNEL_ENV).ok();
    match houston_core::paths::resolve_owning_channel(env_value.as_deref(), &home) {
        Ok(channel) => Ok(houston_core::paths::dir_for(&home, channel.as_deref())),
        Err(refusal) => {
            eprintln!("{}", refusal.message());
            std::process::exit(1);
        }
    }
}

fn print_protocol_requested(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--print-protocol")
}

fn status_requested(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--status")
}

#[cfg(unix)]
fn adopt_socket_requested(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--adopt")
        .and_then(|i| args.get(i + 1))
        .cloned()
}

#[derive(Deserialize)]
struct DaemonFileForStatus {
    port: u16,
    token: String,
}

async fn run_status() -> Result<()> {
    let dir = owning_config_dir()?;
    let cfg_path = dir.join("daemon.json");
    let raw = fs::read_to_string(&cfg_path).with_context(|| {
        format!(
            "reading {} — is a houston-core daemon running on this channel?",
            cfg_path.display()
        )
    })?;
    let cfg: DaemonFileForStatus =
        serde_json::from_str(&raw).with_context(|| format!("parsing {}", cfg_path.display()))?;
    let url = format!("http://127.0.0.1:{}/manage", cfg.port);
    let client = reqwest::Client::new();
    let request = houston_protocol::ManageRequest {
        manage_version: houston_protocol::MANAGE_VERSION,
        verb: houston_protocol::ManageVerb::DaemonStatus,
        candidate_bin: None,
    };
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .json(&request)
        .send()
        .await
        .with_context(|| format!("requesting {url}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .context("parsing the /manage response body")?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    if !status.is_success() {
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(unix)]
fn spawn_supervisor_reader(daemon: &std::sync::Arc<houston_core::daemon::Daemon>) -> Option<u32> {
    use std::os::unix::io::FromRawFd;
    let fd_str = std::env::var(houston_core::supervisor::SUPERVISOR_FD_ENV).ok()?;
    let fd: i32 = match fd_str.parse() {
        Ok(fd) => fd,
        Err(_) => {
            tracing::warn!(
                "{} = {fd_str:?} is not a valid fd number; running unsupervised",
                houston_core::supervisor::SUPERVISOR_FD_ENV
            );
            return None;
        }
    };
    // SAFETY: `houston-supervisor` dup2's the daemon's end of its control
    // socketpair onto this fd before exec and clears FD_CLOEXEC, so it is
    // guaranteed open and ours alone to own.
    let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
    let writer_half = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("cloning the supervisor control socket for writes: {e}; handoff will be unavailable");
            // SAFETY: `getppid` is a plain syscall with no preconditions.
            return Some(unsafe { libc::getppid() } as u32);
        }
    };
    daemon.set_supervisor_writer(writer_half);
    let daemon = std::sync::Arc::clone(daemon);
    std::thread::Builder::new()
        .name("supervisor-read".to_string())
        .spawn(move || {
            let mut r = stream;
            loop {
                match houston_core::supervisor::read_from_supervisor(&mut r) {
                    Ok(houston_core::supervisor::FromSupervisor::ChildExited(report)) => {
                        daemon.supervisor_child_exited(report);
                    }
                    Err(e) => {
                        tracing::info!("supervisor control socket closed: {e}");
                        break;
                    }
                }
            }
        })
        .expect("spawn supervisor-read thread");
    // SAFETY: `getppid` is a plain syscall with no preconditions.
    Some(unsafe { libc::getppid() } as u32)
}

#[cfg(not(unix))]
fn spawn_supervisor_reader(_daemon: &std::sync::Arc<houston_core::daemon::Daemon>) -> Option<u32> {
    None
}

async fn wait_for_sigterm() {
    #[cfg(unix)]
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut sigterm) => {
            let _ = sigterm.recv().await;
        }
        Err(e) => tracing::warn!("no SIGTERM stream installed: {e}"),
    }
    #[cfg(not(unix))]
    std::future::pending::<()>().await;
}

async fn exit_retired_daemon(daemon: &std::sync::Arc<Daemon>) {
    tracing::info!("retired: a new generation owns this channel");
    // Let /manage flush its handoff receipt, then exit without waiting for
    // blocking background work: the supervisor must inherit the transferred children.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    daemon.call_exit_hook();
}

#[cfg(unix)]
async fn run_adopt(socket_path: String) -> Result<()> {
    use houston_core::adoption::{self, FromNew, FromOld};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};

    let mut sock = std::os::unix::net::UnixStream::connect(&socket_path)
        .with_context(|| format!("connecting to adoption socket {socket_path}"))?;

    let hello = adoption::AdoptionHello {
        build: houston_core::daemon::build_commit().to_string(),
        protocol_version: houston_protocol::PROTOCOL_VERSION,
        schema_version: houston_core::db::SCHEMA_VERSION,
        manifest_version: adoption::MANIFEST_VERSION,
        platform: "linux".to_string(),
    };
    adoption::write_frame(&mut sock, &FromNew::Hello(hello)).context("sending adoption hello")?;

    let manifest = match adoption::read_frame::<_, FromOld>(&mut sock)
        .context("reading the old daemon's reply")?
    {
        FromOld::Refuse { reason } => {
            eprintln!("houston-core: adoption refused: {reason}");
            std::process::exit(1);
        }
        FromOld::Manifest(m) => m,
        FromOld::Commit { .. } => {
            eprintln!("houston-core: old daemon sent commit before a manifest");
            std::process::exit(1);
        }
    };

    let fd_cap = manifest.sessions.len() + 2;
    let fds = adoption::recv_fds(sock.as_raw_fd(), fd_cap)
        .context("receiving transferred descriptors")?;
    if fds.len() != fd_cap {
        eprintln!(
            "houston-core: expected {fd_cap} descriptors ({} sessions + listener + lock), \
             received {}",
            manifest.sessions.len(),
            fds.len()
        );
        std::process::exit(1);
    }
    let mut fds = fds.into_iter();
    let mut reconstructed = Vec::with_capacity(manifest.sessions.len());
    for m in &manifest.sessions {
        let fd = fds.next().expect("checked len above");
        let pair = Daemon::session_from_manifest(m, fd)
            .with_context(|| format!("reconstructing adopted session {}", m.session_id))?;
        reconstructed.push(pair);
    }
    let listener_owned_fd = fds.next().expect("checked len above");
    let lock_owned_fd = fds.next().expect("checked len above");

    // SAFETY: both just received via `recvmsg`/`SCM_RIGHTS`, ours alone.
    let std_listener =
        unsafe { std::net::TcpListener::from_raw_fd(listener_owned_fd.into_raw_fd()) };
    let port = std_listener
        .local_addr()
        .context("reading the transferred listener's port")?
        .port();
    std_listener
        .set_nonblocking(true)
        .context("setting the transferred listener non-blocking")?;
    let tokio_listener =
        tokio::net::TcpListener::from_std(std_listener).context("wrapping transferred listener")?;
    // SAFETY: see above.
    let daemon_lock = unsafe { houston_core::lock::StateLock::from_raw_fd(lock_owned_fd) };

    let dir = owning_config_dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let daemon = Daemon::new_adopting(
        DaemonConfig {
            token: manifest.token.clone(),
            db_path: dir.join("houston.db"),
        },
        port,
        reconstructed,
    )
    .context("constructing the adopting daemon")?;

    for m in &manifest.sessions {
        if let Some(cred) = &m.mcp_cred {
            daemon.mcp_creds.import_hashed(
                cred.hash.clone(),
                houston_core::mcp_creds::McpScope {
                    session_id: m.session_id,
                    workspace_id: cred.workspace_id.clone(),
                },
                std::time::Duration::from_secs(cred.remaining_secs),
            );
        }
    }

    daemon.set_listener_fd(tokio_listener.as_raw_fd());
    daemon.set_lock_fd(daemon_lock.as_raw_fd());

    adoption::write_frame(&mut sock, &FromNew::Prepared).context("sending prepared")?;

    let generation = match adoption::read_frame::<_, FromOld>(&mut sock)
        .context("reading the commit message")?
    {
        FromOld::Commit { generation } => generation,
        other => {
            eprintln!("houston-core: expected a commit message, got {other:?}");
            std::process::exit(1);
        }
    };

    let cfg_path = dir.join("daemon.json");
    let cfg = DaemonFileConfig {
        port,
        token: manifest.token.clone(),
        pid: std::process::id(),
        protocol: houston_protocol::PROTOCOL_VERSION,
        pid_creation: houston_core::pid::self_creation_token(),
        // SAFETY: `getppid` is a plain syscall with no preconditions.
        supervisor_pid: Some(unsafe { libc::getppid() } as u32),
        generation: Some(generation),
    };
    let tmp_path = cfg_path.with_extension("json.tmp");
    fs::write(&tmp_path, serde_json::to_string_pretty(&cfg)?)
        .with_context(|| format!("writing {}", tmp_path.display()))?;
    fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp_path, &cfg_path)
        .with_context(|| format!("renaming into place {}", cfg_path.display()))?;

    let _ = adoption::write_frame(&mut sock, &FromNew::CommitAck);
    drop(sock);
    let _ = fs::remove_file(&socket_path);

    let _log_guard = houston_core::logging::init();
    houston_core::env_hygiene::scrub();
    houston_core::login_path::adopt();

    let _supervisor_pid = spawn_supervisor_reader(&daemon);

    houston_core::boot::spawn_startup_refresh(&daemon);
    houston_core::boot::spawn_background_loops(&daemon);

    println!("{}", serde_json::to_string(&cfg)?);
    tracing::info!(
        "houston-core adopted generation {generation}: {} session(s), listening on port {port}",
        manifest.sessions.len()
    );

    let (_addr, handle) = server::start_with_listener(daemon.clone(), tokio_listener).await?;
    daemon.set_server_abort(handle.abort_handle());
    tokio::select! {
        _ = handle => {},
        _ = tokio::signal::ctrl_c() => { tracing::info!("shutting down (SIGINT)"); }
        _ = wait_for_sigterm() => { tracing::info!("shutting down (SIGTERM)"); }
    }
    if daemon.has_handed_off() {
        exit_retired_daemon(&daemon).await;
        return Ok(());
    }
    if let Err(e) = daemon.checkpoint_scrollback() {
        tracing::warn!("shutdown: checkpoint failed: {e:#}");
    }
    if let Err(e) = daemon.mark_clean_shutdown() {
        tracing::warn!("shutdown: writing the clean-shutdown marker failed: {e:#}");
    }
    let _ = fs::remove_file(&cfg_path);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if print_protocol_requested(&args) {
        println!("{}", houston_protocol::PROTOCOL_VERSION);
        return Ok(());
    }
    if status_requested(&args) {
        return run_status().await;
    }
    #[cfg(unix)]
    if let Some(socket_path) = adopt_socket_requested(&args) {
        return run_adopt(socket_path).await;
    }
    if args.get(1).map(String::as_str) == Some("hook") {
        houston_core::claude_hooks::run_hook_client(&args);
        return Ok(());
    }
    match args.get(1).map(String::as_str) {
        Some("hs-mail") => {
            eprintln!(
                "hs-mail is gone: messages between panes are inbox rows; use pane_submit, or \
                 hs-pane for the CLI-only providers"
            );
            std::process::exit(1)
        }
        Some("hs-pane") => std::process::exit(houston_core::orchestrate::run_pane_cli(&args[2..])),
        _ => {}
    }

    let dir = owning_config_dir()?;

    let _log_guard = houston_core::logging::init();

    houston_core::env_hygiene::scrub();

    houston_core::login_path::adopt();

    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

    let _daemon_lock =
        houston_core::lock::acquire_exclusive(&dir).context("refusing to start houston-core")?;

    let token = uuid::Uuid::new_v4().to_string();
    let listener = server::bind("127.0.0.1:0".parse()?).await?;
    let daemon = Daemon::new_bound(
        DaemonConfig {
            token: token.clone(),
            db_path: dir.join("houston.db"),
        },
        listener.local_addr()?.port(),
    )?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        daemon.set_listener_fd(listener.as_raw_fd());
        daemon.set_lock_fd(_daemon_lock.as_raw_fd());
    }
    let (addr, handle) = server::start_with_listener(daemon.clone(), listener).await?;
    daemon.set_server_abort(handle.abort_handle());

    let supervisor_pid = spawn_supervisor_reader(&daemon);

    let cfg_path = dir.join("daemon.json");
    let cfg = DaemonFileConfig {
        port: addr.port(),
        token,
        pid: std::process::id(),
        protocol: houston_protocol::PROTOCOL_VERSION,
        pid_creation: houston_core::pid::self_creation_token(),
        supervisor_pid,
        generation: None,
    };
    fs::write(&cfg_path, serde_json::to_string_pretty(&cfg)?)
        .with_context(|| format!("writing {}", cfg_path.display()))?;
    #[cfg(unix)]
    fs::set_permissions(&cfg_path, fs::Permissions::from_mode(0o600))?;

    houston_core::boot::spawn_startup_refresh(&daemon);
    houston_core::boot::spawn_background_loops(&daemon);

    println!("{}", serde_json::to_string(&cfg)?);
    tracing::info!(
        "houston-core listening on {addr}, config at {}",
        cfg_path.display()
    );

    tokio::select! {
        _ = handle => {},
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("shutting down (SIGINT)");
        }
        _ = wait_for_sigterm() => {
            tracing::info!("shutting down (SIGTERM)");
        }
    }
    if daemon.has_handed_off() {
        exit_retired_daemon(&daemon).await;
        return Ok(());
    }
    if let Err(e) = daemon.checkpoint_scrollback() {
        tracing::warn!("shutdown: checkpoint failed: {e:#}");
    }
    if let Err(e) = daemon.mark_clean_shutdown() {
        tracing::warn!("shutdown: writing the clean-shutdown marker failed: {e:#}");
    }
    let _ = fs::remove_file(&cfg_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_protocol_flag_is_detected() {
        assert!(print_protocol_requested(&[
            "houston-core".to_string(),
            "--print-protocol".to_string()
        ]));
        assert!(!print_protocol_requested(&["houston-core".to_string()]));
        assert!(!print_protocol_requested(&[
            "houston-core".to_string(),
            "hook".to_string()
        ]));
    }

    #[cfg(all(test, unix))]
    #[test]
    fn adopt_socket_flag_is_parsed() {
        assert_eq!(
            adopt_socket_requested(&[
                "houston-core".to_string(),
                "--adopt".to_string(),
                "/tmp/x.sock".to_string()
            ]),
            Some("/tmp/x.sock".to_string())
        );
        assert_eq!(adopt_socket_requested(&["houston-core".to_string()]), None);
        assert_eq!(
            adopt_socket_requested(&["houston-core".to_string(), "--adopt".to_string()]),
            None
        );
    }
}

use anyhow::{anyhow, bail, Result};
use std::ffi::{OsStr, OsString};
use std::path::Path;

pub const SUBCOMMAND: &str = "codex-exec";
pub const OBSERVER_SUBCOMMAND: &str = "codex-observe";
pub const SHELL_SUBCOMMAND: &str = "codex-shell";

#[derive(Debug, PartialEq, Eq)]
pub struct LaunchPlan {
    pub server_args: Vec<OsString>,
    pub tui_args: Vec<OsString>,
    pub cwd: Option<OsString>,
}

impl LaunchPlan {
    pub fn from_args(args: &[OsString]) -> Result<Self> {
        let mut server_args = Vec::new();
        let mut index = 0;
        let mut runtime_overrides = Vec::new();
        let mut cwd = None;
        while index < args.len() {
            let argument = args[index]
                .to_str()
                .ok_or_else(|| anyhow!("Codex native launch requires UTF-8 arguments"))?;
            if argument == "--" {
                break;
            }
            match argument {
                "-c" | "--config" | "--enable" | "--disable" => {
                    server_args.push(argument.into());
                    server_args.push(flag_value(args, &mut index, argument)?);
                }
                "-m" | "--model" => push_config(&mut runtime_overrides, "model", &flag_value(args, &mut index, argument)?),
                "-a" | "--ask-for-approval" => push_config(&mut runtime_overrides, "approval_policy", &flag_value(args, &mut index, argument)?),
                "-s" | "--sandbox" => push_config(&mut runtime_overrides, "sandbox_mode", &flag_value(args, &mut index, argument)?),
                "--approve-for-me" | "--not-so-yolo" => {
                    push_config(&mut runtime_overrides, "approvals_reviewer", OsStr::new("auto_review"));
                    push_config(&mut runtime_overrides, "approval_policy", OsStr::new("on-request"));
                    push_config(&mut runtime_overrides, "sandbox_mode", OsStr::new("workspace-write"));
                }
                "--dangerously-bypass-hook-trust" => runtime_overrides.extend(["-c".into(), "bypass_hook_trust=true".into()]),
                "--full-auto" => {
                    push_config(&mut runtime_overrides, "approval_policy", OsStr::new("on-request"));
                    push_config(&mut runtime_overrides, "sandbox_mode", OsStr::new("workspace-write"));
                }
                "--dangerously-bypass-approvals-and-sandbox" | "--yolo" => {
                    push_config(&mut runtime_overrides, "approval_policy", OsStr::new("never"));
                    push_config(&mut runtime_overrides, "sandbox_mode", OsStr::new("danger-full-access"));
                }
                "--search" => push_config(&mut runtime_overrides, "web_search", OsStr::new("live")),
                "--strict-config" => server_args.push(argument.into()),
                "--no-alt-screen" => {}
                "-C" | "--cd" => { cwd = Some(flag_value(args, &mut index, argument)?); }
                "-i" | "--image" => { flag_value(args, &mut index, argument)?; }
                "--remote" | "--no-daemon" | "-p" | "--profile" | "--oss" | "--local-provider" => {
                    bail!("Codex native pane does not support {argument}; use the direct CLI launch with --no-daemon")
                }
                _ if argument.starts_with("--config=") || argument.starts_with("-c=") || argument.starts_with("--enable=") || argument.starts_with("--disable=") => server_args.push(args[index].clone()),
                _ if argument.starts_with("--model=") => push_config(&mut runtime_overrides, "model", OsStr::new(&argument[8..])),
                _ if argument.starts_with("--ask-for-approval=") => push_config(&mut runtime_overrides, "approval_policy", OsStr::new(&argument[19..])),
                _ if argument.starts_with("--sandbox=") => push_config(&mut runtime_overrides, "sandbox_mode", OsStr::new(&argument[10..])),
                _ if argument.starts_with('-') => bail!("Codex native pane does not support flag {}; use the direct CLI launch with --no-daemon", argument.split('=').next().unwrap_or(argument)),
                _ => {}
            }
            index += 1;
        }
        server_args.extend(runtime_overrides);
        Ok(Self {
            server_args,
            tui_args: args.to_vec(),
            cwd,
        })
    }
}

fn flag_value(args: &[OsString], index: &mut usize, flag: &str) -> Result<OsString> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| anyhow!("Codex flag {flag} requires a value"))
}

fn push_config(arguments: &mut Vec<OsString>, key: &str, value: &OsStr) {
    let quoted = toml::Value::String(value.to_string_lossy().into_owned()).to_string();
    arguments.extend(["-c".into(), format!("{key}={quoted}").into()]);
}

pub fn supports_native(version: &str) -> bool {
    let Some(version) = crate::cli_probe::parse_version(version) else {
        return false;
    };
    let components: Vec<u64> = version
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    matches!(components.as_slice(), [major, minor, _] if *major > 0 || *minor >= 160)
}

pub fn wrap(
    command: &mut portable_pty::CommandBuilder,
    launcher: &Path,
    socket: &Path,
    drop_dir: &Path,
    resume: Option<&str>,
) -> Result<()> {
    let original = command.get_argv().to_vec();
    if original.is_empty() {
        bail!("Codex native pane requires an executable");
    }
    let arguments = command.get_argv_mut();
    arguments.clear();
    arguments.extend([
        launcher.as_os_str().to_owned(),
        SUBCOMMAND.into(),
        socket.as_os_str().to_owned(),
        drop_dir.as_os_str().to_owned(),
        resume.unwrap_or("-").into(),
        "--".into(),
    ]);
    arguments.extend(original);
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use anyhow::Context;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Child, Stdio};
    use std::time::Duration;
    use tokio_tungstenite::{
        tungstenite::{protocol::WebSocketConfig, Message},
        WebSocketStream,
    };

    const RPC_TIMEOUT: Duration = Duration::from_secs(2);
    const POLL_INTERVAL: Duration = Duration::from_millis(250);
    // Keep ownership checks responsive without a continuous 40 Hz process poll.
    const OWNER_POLL_INTERVAL: Duration = Duration::from_millis(250);
    // Summary-only responses stay small; never buffer the provider's transcript stream.
    const FRAME_CAP: usize = 64 * 1024;

    struct SocketCleanup(PathBuf);

    impl Drop for SocketCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_file(self.0.with_extension("ready"));
            if let Some(parent) = self.0.parent().filter(|parent| {
                parent
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("houston-codex-"))
            }) {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    struct OwnedChild {
        child: Child,
        creation: Option<u64>,
        group: bool,
        active: bool,
    }

    impl OwnedChild {
        fn new(child: Child, group: bool) -> Self {
            let creation = crate::pid::process_creation_token(child.id());
            Self {
                child,
                creation,
                group,
                active: true,
            }
        }

        fn stop(&mut self) -> Result<()> {
            if !self.active {
                return Ok(());
            }
            if self.group {
                if crate::pid::signal_owned_process_group(
                    self.child.id(),
                    self.creation,
                    crate::pid::Signal::Term,
                )? == crate::pid::SignalOutcome::IdentityMismatch
                {
                    bail!("Codex backend process-group ownership could not be verified");
                }
                std::thread::sleep(Duration::from_millis(500));
                if crate::pid::signal_owned_process_group(
                    self.child.id(),
                    self.creation,
                    crate::pid::Signal::Kill,
                )? == crate::pid::SignalOutcome::IdentityMismatch
                {
                    bail!("Codex backend process-group ownership changed during cleanup");
                }
            } else {
                crate::pid::signal_process_checked_identity(
                    self.child.id(),
                    crate::pid::Signal::Kill,
                    self.creation,
                )?;
            }
            self.child
                .wait()
                .context("reaping Codex pane helper child")?;
            self.active = false;
            Ok(())
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn helper_arguments(args: &[OsString]) -> Result<(PathBuf, PathBuf, Option<String>)> {
        if args.len() < 3 {
            bail!("Codex helper requires socket path, drop directory and resume ID or -");
        }
        let socket = PathBuf::from(&args[0]);
        if !socket.is_absolute() || socket.as_os_str().len() > 100 {
            bail!("Codex pane socket path must be absolute and at most 100 bytes");
        }
        let drop_dir = PathBuf::from(&args[1]);
        let resume = args[2]
            .to_str()
            .filter(|value| *value != "-")
            .map(str::to_string);
        Ok((socket, drop_dir, resume))
    }

    fn ownership() -> Result<(String, u32)> {
        let channel = crate::paths::channel()?.unwrap_or_else(|| "release".into());
        let session = std::env::var("HOUSTON_SESSION")?.parse::<u32>()?;
        if session == 0 {
            bail!("Codex helper requires a positive HOUSTON_SESSION");
        }
        Ok((channel, session))
    }

    fn server_has_exited(process: u32) -> Result<bool> {
        // WNOWAIT preserves the unreaped child's process-group identity for cleanup.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let pid = crate::pid::checked_pid(process)?;
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as u32,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error()).context("observing Codex backend exit");
        }
        Ok(unsafe { info.si_pid() } != 0)
    }

    pub fn run(args: Vec<OsString>) -> Result<i32> {
        let (socket, drop_dir, resume) = helper_arguments(&args)?;
        if args.get(3).is_none_or(|arg| arg != "--") || args.len() < 5 {
            bail!("codex-exec requires -- followed by the original Codex executable and arguments");
        }
        let version = args[4]
            .to_str()
            .and_then(|executable| crate::cli_probe::probe(executable).version);
        let native = version.as_deref().is_some_and(supports_native);
        let (channel, session) = ownership()?;
        let planned = if native {
            LaunchPlan::from_args(&args[5..]).and_then(|plan| {
                if crate::session_isolation::current_owned_scope(&channel, session)
                    .map_err(anyhow::Error::msg)?
                    .is_none()
                {
                    bail!("an owned systemd session scope is unavailable");
                }
                Ok(plan)
            })
        } else {
            Err(anyhow!(
                "installed Codex version is older than 0.160.0 or unknown"
            ))
        };
        let plan = match planned {
            Ok(plan) => plan,
            Err(reason) => {
                eprintln!("houston-core: Codex pane uses lifecycle hooks only: {reason}");
                if let Some(parent) = socket.parent().filter(|parent| {
                    parent
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("houston-codex-"))
                }) {
                    let _ = std::fs::remove_dir(parent);
                }
                let mut command = crate::spawn::command(&args[4]);
                if native
                    && !args[5..]
                        .iter()
                        .take_while(|argument| *argument != "--")
                        .any(|argument| argument == "--no-daemon")
                {
                    command.arg("--no-daemon");
                }
                command.args(&args[5..]);
                return Err(command.exec().into());
            }
        };
        if socket.exists() || socket.with_extension("ready").exists() {
            bail!("Codex pane socket already exists; expected a fresh private endpoint");
        }
        let _socket_cleanup = SocketCleanup(socket.clone());
        let base_cwd = std::env::current_dir()?;
        let launch_cwd = plan
            .cwd
            .as_ref()
            .map_or_else(|| base_cwd.clone(), |directory| base_cwd.join(directory));
        let launch_cwd =
            std::fs::canonicalize(launch_cwd).context("resolving Codex pane working directory")?;
        let owner = std::process::id();
        let owner_creation = crate::pid::self_creation_token()
            .ok_or_else(|| anyhow!("Codex helper process identity is unavailable"))?;
        let mut observer_command = crate::spawn::command(std::env::current_exe()?);
        observer_command.args([
            OBSERVER_SUBCOMMAND.into(),
            socket.as_os_str().to_owned(),
            drop_dir.as_os_str().to_owned(),
            resume.as_deref().unwrap_or("-").into(),
            owner.to_string().into(),
            owner_creation.to_string().into(),
        ]);
        observer_command.current_dir(&launch_cwd);
        observer_command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        observer_command.process_group(0);
        let mut observer = OwnedChild::new(
            observer_command
                .spawn()
                .context("starting Codex lifetime guardian")?,
            true,
        );
        // The guardian must outlive abnormal helper exits to clean the complete owned scope.
        observer.active = false;
        let guardian_ready = socket.with_extension("ready");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::fs::read(&guardian_ready).ok().as_deref() != Some(b"ready") {
            if server_has_exited(observer.child.id())? {
                bail!("Codex lifetime guardian exited before becoming ready");
            }
            if std::time::Instant::now() >= deadline {
                bail!("Codex lifetime guardian did not become ready within 10 seconds");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut server_command = crate::spawn::command(&args[4]);
        server_command.current_dir(&launch_cwd);
        server_command.args([OsStr::new("app-server"), OsStr::new("--listen")]);
        server_command.arg(format!("unix://{}", socket.display()));
        server_command.args(&plan.server_args);
        server_command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        server_command.process_group(0);
        let mut server = OwnedChild::new(
            server_command
                .spawn()
                .context("starting pane-owned Codex app-server")?,
            true,
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                if server_has_exited(server.child.id())? {
                    bail!("pane-owned Codex app-server exited during startup");
                }
                if Rpc::connect(&socket).await.is_ok() {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    bail!("pane-owned Codex app-server did not become ready within 10 seconds");
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })?;
        let mut tui_command = crate::spawn::command(&args[4]);
        tui_command.args(["--remote", &format!("unix://{}", socket.display())]);
        tui_command.args(&plan.tui_args);
        let mut tui = OwnedChild::new(tui_command.spawn().context("starting Codex TUI")?, false);
        let status = loop {
            if let Some(status) = tui.child.try_wait().context("waiting for Codex TUI")? {
                break status;
            }
            if server_has_exited(server.child.id())? {
                bail!("pane-owned Codex app-server exited before the TUI");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        // try_wait already reaped the TUI; do not let its guard target a recycled PID.
        tui.active = false;
        server.stop()?;
        Ok(status.code().unwrap_or(1))
    }

    pub fn run_shell(args: Vec<OsString>) -> Result<i32> {
        if args.len() < 3 || args[1] != "--" {
            bail!("codex-shell requires a drop directory and -- followed by the real Codex executable");
        }
        let cli = &args[3..];
        let mut index = 0;
        let mut positional = None;
        while index < cli.len() {
            let argument = cli[index].to_str().unwrap_or("");
            if argument == "--" {
                break;
            }
            if matches!(
                argument,
                "-c" | "--config"
                    | "--enable"
                    | "--disable"
                    | "-m"
                    | "--model"
                    | "-a"
                    | "--ask-for-approval"
                    | "-s"
                    | "--sandbox"
                    | "-C"
                    | "--cd"
                    | "-i"
                    | "--image"
                    | "-p"
                    | "--profile"
                    | "--remote"
            ) {
                index += 2;
                continue;
            }
            if !argument.starts_with('-') {
                positional = Some((index, argument));
                break;
            }
            index += 1;
        }
        if positional.is_some_and(|(_, argument)| {
            matches!(
                argument,
                "exec"
                    | "e"
                    | "review"
                    | "login"
                    | "logout"
                    | "mcp"
                    | "plugin"
                    | "app-server"
                    | "exec-server"
                    | "completion"
                    | "sandbox"
                    | "debug"
                    | "apply"
                    | "a"
                    | "cloud"
                    | "cloud-tasks"
                    | "features"
                    | "queue"
                    | "archive"
                    | "delete"
                    | "unarchive"
                    | "remote-control"
                    | "update"
                    | "help"
                    | "agents"
                    | "doctor"
                    | "execpolicy"
                    | "migrate-rollouts"
                    | "responses-api-proxy"
                    | "stdio-to-uds"
                    | "tcp-tunnel"
            )
        }) || cli
            .iter()
            .take_while(|argument| *argument != "--")
            .any(|argument| {
                matches!(
                    argument.to_str(),
                    Some("--help" | "-h" | "--version" | "-V")
                )
            })
        {
            return Err(crate::spawn::command(&args[2]).args(cli).exec().into());
        }
        let resume = positional
            .filter(|(_, argument)| *argument == "resume")
            .and_then(|(index, _)| cli.get(index + 1))
            .and_then(|argument| argument.to_str())
            .filter(|id| uuid::Uuid::parse_str(id).is_ok());
        let version = args[2]
            .to_str()
            .and_then(|executable| crate::cli_probe::probe(executable).version);
        if version.as_deref().is_some_and(supports_native) && LaunchPlan::from_args(cli).is_ok() {
            let (channel, session) = ownership()?;
            match crate::session_isolation::enter_owned_scope(&channel, session) {
                Ok(()) => {}
                Err(crate::session_isolation::ScopeError::Unavailable(reason)) => {
                    eprintln!(
                        "houston-core: Codex shell launch uses lifecycle hooks only: {reason}"
                    );
                    let mut command = crate::spawn::command(&args[2]);
                    if !cli
                        .iter()
                        .take_while(|argument| *argument != "--")
                        .any(|argument| argument == "--no-daemon")
                    {
                        command.arg("--no-daemon");
                    }
                    return Err(command.args(cli).exec().into());
                }
                Err(crate::session_isolation::ScopeError::Pending(reason)) => {
                    bail!("Codex shell scope ownership is unresolved: {reason}")
                }
            }
        }
        let directory = tempfile::Builder::new()
            .prefix("houston-codex-")
            .tempdir_in("/tmp")?;
        let socket = directory.path().join("app.sock");
        let mut forwarded = vec![
            socket.into_os_string(),
            args[0].clone(),
            resume.unwrap_or("-").into(),
            "--".into(),
        ];
        forwarded.push(args[2].clone());
        let mut launch_args = cli.to_vec();
        if let (Ok(endpoint), Ok(token)) = (
            std::env::var(crate::mcp_launch::URL_ENV),
            std::env::var(crate::mcp_launch::CODEX_TOKEN_ENV),
        ) {
            if !endpoint.is_empty() && !token.is_empty() {
                let managed = crate::mcp_launch::launch_for(
                    houston_protocol::AgentKind::Codex,
                    &endpoint,
                    "unused",
                );
                let insertion = launch_args
                    .iter()
                    .position(|argument| argument == "--")
                    .unwrap_or(launch_args.len());
                launch_args.splice(
                    insertion..insertion,
                    managed.args.into_iter().map(OsString::from),
                );
            }
        }
        forwarded.extend(launch_args);
        run(forwarded)
    }

    type Socket = WebSocketStream<tokio::net::UnixStream>;

    struct Rpc {
        socket: Socket,
        next_id: u64,
    }

    impl Rpc {
        async fn connect(path: &Path) -> Result<Self> {
            let stream =
                tokio::time::timeout(RPC_TIMEOUT, tokio::net::UnixStream::connect(path)).await??;
            let config = WebSocketConfig::default()
                .max_message_size(Some(FRAME_CAP))
                .max_frame_size(Some(FRAME_CAP));
            let (socket, _) = tokio::time::timeout(
                RPC_TIMEOUT,
                tokio_tungstenite::client_async_with_config(
                    "ws://localhost/",
                    stream,
                    Some(config),
                ),
            )
            .await??;
            let mut rpc = Self { socket, next_id: 1 };
            rpc.request("initialize", json!({"clientInfo":{"name":"houston_startup_observer","version":env!("CARGO_PKG_VERSION")}})).await?;
            rpc.send(json!({"method":"initialized"})).await?;
            Ok(rpc)
        }

        async fn send(&mut self, value: Value) -> Result<()> {
            let encoded = serde_json::to_string(&value)?;
            if encoded.len() > FRAME_CAP {
                bail!("Codex observer request exceeds 64 KiB");
            }
            tokio::time::timeout(RPC_TIMEOUT, self.socket.send(Message::Text(encoded.into())))
                .await??;
            Ok(())
        }

        async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
            let id = self.next_id;
            self.next_id += 1;
            self.send(json!({"id":id,"method":method,"params":params}))
                .await?;
            tokio::time::timeout(RPC_TIMEOUT, async {
                for _ in 0..256 {
                    let frame = self
                        .socket
                        .next()
                        .await
                        .ok_or_else(|| anyhow!("Codex observer connection closed"))??;
                    let Message::Text(text) = frame else { continue };
                    let value: Value = serde_json::from_str(&text)?;
                    if value.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if value.get("error").is_some() {
                        bail!("Codex observer RPC failed");
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| anyhow!("Codex observer response has no result"));
                }
                bail!("Codex observer received too many unrelated messages")
            })
            .await?
        }
    }

    fn root_thread(thread: &Value, cwd: &Path) -> bool {
        let source = thread.get("source").and_then(Value::as_str);
        let provider_cwd = thread
            .get("cwd")
            .and_then(Value::as_str)
            .and_then(|path| std::fs::canonicalize(path).ok());
        let Ok(expected_cwd) = std::fs::canonicalize(cwd) else {
            return false;
        };
        matches!(source, Some("cli" | "appServer" | "vscode"))
            && thread.get("agentRole").is_none_or(Value::is_null)
            && thread.get("agentNickname").is_none_or(Value::is_null)
            && provider_cwd.as_deref() == Some(expected_cwd.as_path())
    }

    async fn startup_thread(
        rpc: &mut Rpc,
        resume: Option<&str>,
        cwd: &Path,
    ) -> Result<Option<Value>> {
        if let Some(id) = resume {
            let response = rpc
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await?;
            return Ok(response
                .get("thread")
                .filter(|thread| {
                    thread.get("id").and_then(Value::as_str) == Some(id) && root_thread(thread, cwd)
                })
                .cloned());
        }
        let response = rpc
            .request("thread/loaded/list", json!({"limit":16}))
            .await?;
        if response
            .get("nextCursor")
            .is_some_and(|cursor| !cursor.is_null())
        {
            return Ok(None);
        }
        let ids = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("Codex loaded-thread response has no ID list"))?;
        if ids.len() > 16 {
            return Ok(None);
        }
        let mut root = None;
        for id in ids.iter().filter_map(Value::as_str) {
            let response = rpc
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await?;
            if let Some(thread) = response
                .get("thread")
                .filter(|thread| root_thread(thread, cwd))
            {
                if root.is_some() {
                    return Ok(None);
                }
                root = Some(thread.clone());
            }
        }
        Ok(root)
    }

    async fn observe_async(
        socket: &Path,
        drop_dir: &Path,
        resume: Option<&str>,
        session: u32,
        cwd: &Path,
    ) -> Result<()> {
        let mut rpc = None;
        let mut delay = POLL_INTERVAL;
        loop {
            if rpc.is_none() {
                rpc = Rpc::connect(socket).await.ok();
            }
            if let Some(connection) = rpc.as_mut() {
                match startup_thread(connection, resume, cwd).await {
                    Ok(Some(thread))
                        if thread.pointer("/status/type").and_then(Value::as_str)
                            == Some("idle") =>
                    {
                        let id = thread
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| anyhow!("Codex startup thread has no ID"))?;
                        let drop = crate::hook_drop::HookDrop {
                            event: "SessionStart".into(),
                            session,
                            agent: Some("codex".into()),
                            cwd: Some(cwd.display().to_string()),
                            session_id: Some(id.into()),
                            ..Default::default()
                        };
                        crate::hook_drop::write_drop(drop_dir, &drop, crate::hook_drop::now_ms())?;
                        return Ok(());
                    }
                    Ok(Some(_)) => {
                        delay = POLL_INTERVAL;
                    }
                    Ok(None) => {
                        delay = (delay * 2).min(Duration::from_secs(2));
                    }
                    Err(_) => {
                        rpc = None;
                        delay = (delay * 2).min(Duration::from_secs(2));
                    }
                }
            } else {
                delay = (delay * 2).min(Duration::from_secs(2));
            }
            tokio::time::sleep(delay).await;
        }
    }

    async fn owner_exited(owner: u32, creation: u64) {
        loop {
            let live = crate::pid::process_creation_token(owner) == Some(creation)
                && std::fs::read_to_string(format!("/proc/{owner}/stat"))
                    .ok()
                    .is_some_and(|stat| {
                        stat.rsplit_once(')')
                            .is_some_and(|(_, rest)| !rest.trim_start().starts_with(['Z', 'X']))
                    });
            if !live {
                return;
            }
            tokio::time::sleep(OWNER_POLL_INTERVAL).await;
        }
    }

    pub fn observe(args: Vec<OsString>) -> Result<i32> {
        let (socket, drop_dir, resume) = helper_arguments(&args)?;
        let owner = args
            .get(3)
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| anyhow!("Codex guardian requires its owning helper PID"))?;
        crate::pid::checked_pid(owner)?;
        let creation = args
            .get(4)
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| anyhow!("Codex guardian requires its owning helper process identity"))?;
        let (channel, session) = ownership()?;
        let unit = crate::session_isolation::current_owned_scope(&channel, session)
            .map_err(anyhow::Error::msg)?
            .ok_or_else(|| anyhow!("Codex guardian requires its inherited owned scope"))?;
        let terminal_owner = unsafe { libc::getsid(0) };
        if terminal_owner <= 1 {
            bail!("Codex guardian requires a real owned PTY session");
        }
        let terminal_owner = terminal_owner as u32;
        let terminal_creation = crate::pid::process_creation_token(terminal_owner)
            .ok_or_else(|| anyhow!("Codex guardian cannot identify its PTY owner"))?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let cwd = std::env::current_dir()?;
        std::fs::write(socket.with_extension("ready"), b"ready")?;
        runtime.block_on(async {
            let lifetime = async {
                tokio::select! {
                    _ = owner_exited(owner, creation) => {},
                    _ = owner_exited(terminal_owner, terminal_creation) => {},
                }
            };
            tokio::pin!(lifetime);
            tokio::select! {
                _ = &mut lifetime => {},
                _ = observe_async(&socket, &drop_dir, resume.as_deref(), session, &cwd) => {
                    lifetime.await;
                }
            }
        });
        drop(SocketCleanup(socket));
        loop {
            match crate::session_isolation::stop_recorded_scope(&unit, &channel, session) {
                Ok(()) => return Ok(0),
                Err(_) => std::thread::sleep(Duration::from_secs(2)),
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn startup_metadata_rejects_native_children_and_unresolved_directories() {
            let cwd = tempfile::tempdir().unwrap();
            let root = json!({"id":"root", "source":"cli", "cwd":cwd.path(), "agentRole":null});
            assert!(root_thread(&root, cwd.path()));
            let child = json!({"id":"root", "source":{"subAgent":{"parentThreadId":"parent","depth":1}}, "cwd":cwd.path()});
            assert!(!root_thread(&child, cwd.path()));
            let missing = cwd.path().join("missing");
            assert!(!root_thread(
                &json!({"source":"cli","cwd":missing}),
                &missing
            ));
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::{observe, run, run_shell};

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn backend_receives_mcp_and_session_flags_without_changing_tui_arguments() {
        let args = arguments(&[
            "resume",
            "conversation",
            "-c",
            "mcp_servers.houston.bearer_token_env_var=\"HOUSTON_MCP_TOKEN\"",
            "-m",
            "model-name",
            "-s",
            "read-only",
            "-a",
            "on-request",
            "--enable",
            "hooks",
            "--strict-config",
        ]);
        let plan = LaunchPlan::from_args(&args).unwrap();
        assert_eq!(plan.tui_args, args);
        assert_eq!(
            plan.server_args,
            arguments(&[
                "-c",
                "mcp_servers.houston.bearer_token_env_var=\"HOUSTON_MCP_TOKEN\"",
                "--enable",
                "hooks",
                "--strict-config",
                "-c",
                "model=\"model-name\"",
                "-c",
                "sandbox_mode=\"read-only\"",
                "-c",
                "approval_policy=\"on-request\""
            ])
        );
    }

    #[test]
    fn automatic_review_matches_codex_and_cli_model_overrides_win() {
        let plan = LaunchPlan::from_args(&arguments(&[
            "--approve-for-me",
            "-m",
            "selected",
            "-c",
            "model=\"base\"",
        ]))
        .unwrap();
        assert_eq!(
            plan.server_args,
            arguments(&[
                "-c",
                "model=\"base\"",
                "-c",
                "approvals_reviewer=\"auto_review\"",
                "-c",
                "approval_policy=\"on-request\"",
                "-c",
                "sandbox_mode=\"workspace-write\"",
                "-c",
                "model=\"selected\""
            ])
        );
    }

    #[test]
    fn end_of_options_keeps_prompt_literals_out_of_backend_configuration() {
        let args = arguments(&["--", "-c", "model=\"literal prompt\"", "--help"]);
        let plan = LaunchPlan::from_args(&args).unwrap();
        assert!(plan.server_args.is_empty());
        assert_eq!(plan.tui_args, args);
    }

    #[test]
    fn working_directory_parsing_respects_option_values_and_prompt_delimiters() {
        let plan = LaunchPlan::from_args(&arguments(&[
            "--model",
            "--cd",
            "--",
            "--cd",
            "literal prompt",
        ]))
        .unwrap();
        assert_eq!(plan.cwd, None);
        let plan = LaunchPlan::from_args(&arguments(&[
            "--cd",
            "project",
            "--",
            "--cd",
            "literal prompt",
        ]))
        .unwrap();
        assert_eq!(plan.cwd, Some("project".into()));
    }

    #[test]
    fn unsupported_flags_require_a_direct_cli_launch() {
        for flag in ["--profile", "--remote", "--oss", "--unknown"] {
            assert!(LaunchPlan::from_args(&arguments(&[flag, "value"])).is_err());
        }
        assert!(LaunchPlan::from_args(&arguments(&["-c"])).is_err());
    }

    #[test]
    fn native_launch_requires_the_verified_protocol_version() {
        assert!(supports_native("codex-cli 0.160.0"));
        assert!(supports_native("0.161.1"));
        assert!(!supports_native("0.159.0"));
        assert!(!supports_native("unknown"));
    }
}

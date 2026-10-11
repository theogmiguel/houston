//! WSL environments: the bundled Linux daemon runs inside an enabled WSL2 distro and is
//! reached through a loopback relay. Windows only; elsewhere every `wsl_*` command refuses.

pub mod command;
pub mod config;
pub mod distros;
pub mod provision;
pub mod relay;
pub mod unc;

use command::{Piped, RunOutput, Runner, WslExe};
use distros::{decode, Distro};
use futures_util::future::BoxFuture;
use houston_core::wsl_ensure::{EnsureReport, EnsureState};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

pub const NOT_WINDOWS: &str = "WSL environments are only available on Windows";
/// Emitted with no payload whenever `env_list` would answer differently.
pub const ENVIRONMENTS_EVENT: &str = "wsl://environments";
/// Development override for the directory holding the three Linux binaries.
pub const BIN_DIR_ENV: &str = "HOUSTON_WSL_BIN_DIR";
const MIN_GLIBC: (u32, u32) = (2, 35);

pub fn platform_supported() -> bool {
    cfg!(windows)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvState {
    Starting,
    Ready,
    Error,
}

impl EnvState {
    fn as_str(self) -> &'static str {
        match self {
            EnvState::Starting => "starting",
            EnvState::Ready => "ready",
            EnvState::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WslList {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub distros: Vec<WslDistro>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub version: u8,
    pub default: bool,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<u8>,
    /// `disabled`, `starting`, `ready` or `error`.
    pub status: &'static str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Enabled {
    pub name: String,
    pub slot: u8,
    pub status: &'static str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Disabled {
    pub name: String,
}

/// One daemon the renderer can reach. Deliberately not `Debug`: it carries a token.
#[derive(Clone, Serialize)]
pub struct EnvEntry {
    pub id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    pub slot: u8,
    pub port: u16,
    pub token: String,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

struct Env {
    slot: u8,
    state: EnvState,
    reason: Option<String>,
    token: Option<String>,
    install_dir: Option<String>,
    relay: Option<relay::Relay>,
}

pub struct Options {
    pub runner: Arc<dyn Runner>,
    pub state_dir: PathBuf,
    /// The app's channel label (`release` for the default); the distro uses the same one.
    pub channel: String,
    pub build: String,
    pub bundle_dir: Result<PathBuf, String>,
    pub supported: bool,
    pub retry_delay: Duration,
    pub notify: Box<dyn Fn() + Send + Sync>,
}

struct Inner {
    opts: Options,
    ops: tokio::sync::Mutex<()>,
    envs: Mutex<BTreeMap<String, Env>>,
}

#[derive(Clone)]
pub struct WslManager {
    inner: Arc<Inner>,
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|e| format!("a WSL task stopped unexpectedly: {e}"))?
}

fn stderr_text(out: &RunOutput) -> String {
    decode(&out.stderr).trim().to_string()
}

fn state_name(state: EnsureState) -> &'static str {
    match state {
        EnsureState::Attached => "attached",
        EnsureState::Spawned => "spawned",
        EnsureState::HandedOff => "handed_off",
        EnsureState::Refused => "refused",
    }
}

/// The one line logged per `wsl-ensure`; the token never reaches it.
pub fn ensure_log_line(distro: &str, outcome: &Result<EnsureReport, String>) -> String {
    match outcome {
        Ok(report) => format!(
            "houston-tauri: wsl {distro}: wsl-ensure {}, build {}, protocol {}{}",
            state_name(report.state),
            report.build,
            report.protocol,
            report
                .reason
                .as_deref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        ),
        Err(e) => format!("houston-tauri: wsl {distro}: wsl-ensure failed: {e}"),
    }
}

/// Exit 0 and 3 print one JSON line; anything else is a failure described on stderr.
/// Stdout is never quoted in an error: it carries the token.
fn interpret_ensure(
    distro: &str,
    argv: &[String],
    out: &RunOutput,
) -> Result<EnsureReport, String> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let report = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<EnsureReport>(line.trim()).ok());
    match (out.code, report) {
        (Some(0 | 3), Some(report)) => Ok(report),
        _ => Err(format!(
            "wsl-ensure failed in {distro}: {}",
            command::failure(argv, out, false)
        )),
    }
}

/// Why `daemon_shutdown` did not stop the daemon, if it says so: it answers HTTP 200
/// with `ok: false` when a session would not end.
fn shutdown_refusal(
    answer: Result<(reqwest::StatusCode, serde_json::Value), String>,
) -> Option<String> {
    match answer {
        Ok((status, body)) if status.is_success() && body["ok"] != false => None,
        Ok((status, body)) => Some(format!(
            "daemon_shutdown answered HTTP {status}: {}",
            body["error"].as_str().unwrap_or("no reason given")
        )),
        Err(e) => Some(format!("daemon_shutdown failed: {e}")),
    }
}

fn check_stopped(
    distro: &str,
    channel: &str,
    stopped: Result<RunOutput, String>,
    shutdown_failure: Option<String>,
) -> Result<(), String> {
    let still = match stopped {
        Ok(out) if out.code == Some(0) => return Ok(()),
        Ok(out) if out.code == Some(1) => {
            let pid = String::from_utf8_lossy(&out.stdout).trim().to_string();
            format!(
                "Houston's {channel} daemon in {distro} (pid {}) is still running",
                if pid.is_empty() { "unknown" } else { &pid }
            )
        }
        Ok(out) => format!(
            "could not check whether Houston's daemon in {distro} stopped: {}",
            command::failure(&command::daemon_stopped(distro, channel), &out, true)
        ),
        Err(e) => format!("could not check whether Houston's daemon in {distro} stopped: {e}"),
    };
    Err(match shutdown_failure {
        Some(reason) => format!("{distro} is disabled, but {still}; {reason}"),
        None => format!("{distro} is disabled, but {still}"),
    })
}

fn accept_report(distro: &str, report: EnsureReport) -> Result<EnsureReport, String> {
    if report.state == EnsureState::Refused {
        return Err(format!(
            "Houston's daemon in {distro} refused this app: {}",
            report.reason.as_deref().unwrap_or("no reason given")
        ));
    }
    if report.port.is_none() || report.token.is_none() {
        return Err(format!(
            "wsl-ensure in {distro} reported {} without a port and token",
            state_name(report.state)
        ));
    }
    Ok(report)
}

fn parse_version(raw: &str) -> Option<(u32, u32)> {
    let mut parts = raw.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn probe_failure(distro: &str, out: &RunOutput) -> String {
    let failure = command::failure(&command::probe(distro), out, true);
    format!("could not start {distro} to check it: {failure}")
}

fn check_capabilities(distro: &str, out: &RunOutput) -> Result<(), String> {
    if out.code != Some(0) {
        return Err(probe_failure(distro, out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines().map(str::trim);
    let arch = lines.next().unwrap_or_default();
    if arch != "x86_64" {
        return Err(format!(
            "{distro} reports architecture {arch:?}; Houston's bundled daemon is built for x86_64"
        ));
    }
    let (major, minor) = MIN_GLIBC;
    let Some(found) = lines.find_map(|line| line.strip_prefix("glibc ")) else {
        return Err(format!(
            "{distro} has no glibc (getconf GNU_LIBC_VERSION printed nothing); Houston's \
             bundled daemon needs glibc {major}.{minor} or newer"
        ));
    };
    match parse_version(found.trim()) {
        Some(version) if version >= MIN_GLIBC => Ok(()),
        _ => Err(format!(
            "{distro} has glibc {}; Houston's bundled daemon needs glibc {major}.{minor} or newer",
            found.trim()
        )),
    }
}

impl Inner {
    fn gate(&self) -> Result<(), String> {
        if self.opts.supported {
            Ok(())
        } else {
            Err(NOT_WINDOWS.to_string())
        }
    }

    fn notify(&self) {
        (self.opts.notify)();
    }

    async fn run(&self, argv: Vec<String>) -> Result<RunOutput, String> {
        let runner = Arc::clone(&self.opts.runner);
        blocking(move || {
            runner
                .run(&argv, command::Stdin::Null)
                .map_err(|e| match e.kind() {
                    std::io::ErrorKind::TimedOut => format!("{} {e}", command::describe(&argv)),
                    _ => format!("{} could not be started: {e}", command::describe(&argv)),
                })
        })
        .await
    }

    /// A distro that is still booting can make `wsl.exe` itself fail, so a non-zero exit
    /// is retried once. A timeout is not: it already waited the full deadline.
    async fn probe(&self, distro: &str) -> Result<RunOutput, String> {
        let out = self.run(command::probe(distro)).await?;
        if out.code == Some(0) {
            return Ok(out);
        }
        eprintln!(
            "houston-tauri: wsl {distro}: probe failed, retrying once: {}",
            probe_failure(distro, &out)
        );
        self.run(command::probe(distro)).await
    }

    /// `Err` is the reason WSL is unavailable.
    async fn distros(&self) -> Result<Vec<Distro>, String> {
        let out = self.run(command::list()).await?;
        if out.code != Some(0) {
            return Err(command::failure(&command::list(), &out, true));
        }
        Ok(distros::parse_list(&decode(&out.stdout)))
    }

    fn update_env(&self, distro: &str, apply: impl FnOnce(&mut Env)) {
        if let Some(env) = self.envs.lock().expect("wsl envs lock").get_mut(distro) {
            apply(env);
        }
    }

    async fn ensure(&self, distro: &str, install_dir: &str) -> Result<EnsureReport, String> {
        let argv = command::ensure(distro, install_dir, &self.opts.channel);
        let outcome = match self.run(argv.clone()).await {
            Ok(out) => interpret_ensure(distro, &argv, &out),
            Err(e) => Err(e),
        };
        eprintln!("{}", ensure_log_line(distro, &outcome));
        outcome.and_then(|report| accept_report(distro, report))
    }

    async fn start_env(self: &Arc<Self>, distro: &str, slot: u8) -> Result<(), String> {
        self.envs.lock().expect("wsl envs lock").insert(
            distro.to_string(),
            Env {
                slot,
                state: EnvState::Starting,
                reason: None,
                token: None,
                install_dir: None,
                relay: None,
            },
        );
        self.notify();
        let bundle_dir = self.opts.bundle_dir.clone()?;
        let installed = {
            let runner = Arc::clone(&self.opts.runner);
            let (distro, build) = (distro.to_string(), self.opts.build.clone());
            blocking(move || provision::provision(runner.as_ref(), &distro, &build, &bundle_dir))
                .await?
        };
        if !installed.written.is_empty() {
            eprintln!(
                "houston-tauri: wsl {distro}: installed {} into {}",
                installed.written.join(", "),
                installed.install_dir
            );
        }
        let report = self.ensure(distro, &installed.install_dir).await?;
        self.update_env(distro, |env| {
            env.install_dir = Some(installed.install_dir.clone());
            env.token = report.token.clone();
        });
        let backend = Arc::new(EnvBackend {
            inner: Arc::downgrade(self),
            distro: distro.to_string(),
        });
        let relay = relay::Relay::start(backend, self.opts.retry_delay)
            .await
            .map_err(|e| format!("opening the loopback relay for {distro}: {e}"))?;
        self.update_env(distro, |env| {
            env.relay = Some(relay);
            env.state = EnvState::Ready;
        });
        self.notify();
        Ok(())
    }

    fn mark_error(&self, distro: &str, slot: u8, reason: String) {
        self.envs.lock().expect("wsl envs lock").insert(
            distro.to_string(),
            Env {
                slot,
                state: EnvState::Error,
                reason: Some(reason),
                token: None,
                install_dir: None,
                relay: None,
            },
        );
        self.notify();
    }

    async fn reensure(self: Arc<Self>, distro: String) -> Result<(), String> {
        let install_dir = self
            .envs
            .lock()
            .expect("wsl envs lock")
            .get(&distro)
            .and_then(|env| env.install_dir.clone())
            .ok_or_else(|| format!("{distro} has no recorded install directory"))?;
        let outcome = self.ensure(&distro, &install_dir).await;
        match &outcome {
            Ok(report) => self.update_env(&distro, |env| {
                env.state = EnvState::Ready;
                env.reason = None;
                env.token = report.token.clone();
            }),
            Err(e) => self.update_env(&distro, |env| {
                env.state = EnvState::Error;
                env.reason = Some(e.clone());
            }),
        }
        self.notify();
        outcome.map(drop)
    }

    async fn remove_launcher(&self, distro: &str, install_dir: Option<String>) {
        let install_dir = match install_dir {
            Some(dir) => Ok(dir),
            None => {
                let runner = Arc::clone(&self.opts.runner);
                let (owned, build) = (distro.to_string(), self.opts.build.clone());
                blocking(move || provision::remote_state(runner.as_ref(), &owned, &build))
                    .await
                    .map(|(home, _)| provision::install_dir(&home, &self.opts.build))
            }
        };
        let outcome = match install_dir {
            Ok(dir) => self
                .run(command::launcher_remove(distro, &dir))
                .await
                .map(|out| format!("{}: {}", command::exit_text(out.code), stderr_text(&out))),
            Err(e) => Err(e),
        };
        match outcome {
            Ok(said) => eprintln!("houston-tauri: wsl {distro}: wsl-launcher-remove {said}"),
            Err(e) => eprintln!("houston-tauri: wsl {distro}: wsl-launcher-remove not run: {e}"),
        }
    }
}

struct EnvBackend {
    inner: Weak<Inner>,
    distro: String,
}

impl relay::Backend for EnvBackend {
    fn connect(&self) -> std::io::Result<Piped> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| std::io::Error::other("the WSL manager is gone"))?;
        let install_dir = inner
            .envs
            .lock()
            .expect("wsl envs lock")
            .get(&self.distro)
            .and_then(|env| env.install_dir.clone())
            .ok_or_else(|| {
                std::io::Error::other(format!("{} has no recorded install directory", self.distro))
            })?;
        inner.opts.runner.spawn_piped(&command::proxy(
            &self.distro,
            &install_dir,
            &inner.opts.channel,
        ))
    }

    fn ensure(&self) -> BoxFuture<'static, Result<(), String>> {
        let inner = self.inner.upgrade();
        let distro = self.distro.clone();
        Box::pin(async move {
            match inner {
                Some(inner) => inner.reensure(distro).await,
                None => Err("the WSL manager is gone".to_string()),
            }
        })
    }
}

impl WslManager {
    pub fn new(opts: Options) -> Self {
        Self {
            inner: Arc::new(Inner {
                opts,
                ops: tokio::sync::Mutex::new(()),
                envs: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    pub fn for_app(app: &tauri::AppHandle, state_dir: PathBuf, channel: String) -> Self {
        use tauri::{Emitter, Manager};
        let bundle_dir = match std::env::var_os(BIN_DIR_ENV) {
            Some(dir) => Ok(PathBuf::from(dir)),
            None => app
                .path()
                .resolve("wsl", tauri::path::BaseDirectory::Resource)
                .map_err(|e| format!("resolving the bundled wsl/ resource directory: {e}")),
        };
        let app = app.clone();
        Self::new(Options {
            runner: Arc::new(WslExe),
            state_dir,
            channel,
            build: houston_core::daemon::build_commit().to_string(),
            bundle_dir,
            supported: platform_supported(),
            retry_delay: relay::RETRY_DELAY,
            notify: Box::new(move || {
                if let Err(e) = app.emit(ENVIRONMENTS_EVENT, ()) {
                    eprintln!("houston-tauri: wsl: emitting {ENVIRONMENTS_EVENT} failed: {e}");
                }
            }),
        })
    }

    pub async fn list(&self) -> Result<WslList, String> {
        let inner = &self.inner;
        inner.gate()?;
        let config = config::load(&inner.opts.state_dir)?;
        let found = match inner.distros().await {
            Ok(found) => found,
            Err(reason) => {
                return Ok(WslList {
                    available: false,
                    reason: Some(reason),
                    distros: Vec::new(),
                })
            }
        };
        let envs = inner.envs.lock().expect("wsl envs lock");
        // An enabled utility distro stays listed so it can still be disabled.
        let distros = found
            .into_iter()
            .filter(|distro| !distros::is_utility(&distro.name) || config.is_enabled(&distro.name))
            .map(|distro| {
                let entry = config.entry(&distro.name);
                let enabled = entry.is_some_and(|e| e.enabled);
                let status = match (enabled, envs.get(&distro.name)) {
                    (false, _) => "disabled",
                    (true, Some(env)) => env.state.as_str(),
                    (true, None) => EnvState::Starting.as_str(),
                };
                WslDistro {
                    slot: entry.map(|e| e.slot),
                    name: distro.name,
                    state: distro.state,
                    version: distro.version,
                    default: distro.default,
                    enabled,
                    status,
                }
            })
            .collect();
        Ok(WslList {
            available: true,
            reason: None,
            distros,
        })
    }

    pub async fn enable(&self, name: String) -> Result<Enabled, String> {
        let inner = &self.inner;
        inner.gate()?;
        // Logged so the app log shows which request a state change answered.
        eprintln!("houston-tauri: wsl {name}: enable requested");
        if distros::is_utility(&name) {
            return Err(format!(
                "{name} is a container engine's utility distro; Houston does not run in {}",
                distros::UTILITY.join(", ")
            ));
        }
        let _ops = inner.ops.lock().await;
        let mut config = config::load(&inner.opts.state_dir)?;
        if let Some(env) = inner.envs.lock().expect("wsl envs lock").get(&name) {
            if env.state == EnvState::Ready && config.is_enabled(&name) {
                return Ok(Enabled {
                    name,
                    slot: env.slot,
                    status: EnvState::Ready.as_str(),
                });
            }
        }
        let found = inner.distros().await?;
        let Some(distro) = found.iter().find(|d| d.name == name) else {
            let names: Vec<&str> = found.iter().map(|d| d.name.as_str()).collect();
            return Err(format!(
                "no WSL distro named {name:?}; wsl.exe -l -v lists: {}",
                names.join(", ")
            ));
        };
        if distro.version == 1 {
            return Err(format!(
                "{name} runs under WSL 1; Houston needs WSL 2 (convert it with \
                 wsl.exe --set-version {name} 2)"
            ));
        }
        provision::bundled_files(&inner.opts.bundle_dir.clone()?)?;
        check_capabilities(&name, &inner.probe(&name).await?)?;
        let slot = config.enable(&name)?;
        config::save(&inner.opts.state_dir, &config)?;
        if let Err(e) = inner.start_env(&name, slot).await {
            inner.envs.lock().expect("wsl envs lock").remove(&name);
            if let Err(undo) = config
                .disable(&name)
                .and_then(|_| config::save(&inner.opts.state_dir, &config))
            {
                eprintln!("houston-tauri: wsl {name}: undoing the enable failed: {undo}");
            }
            inner.notify();
            return Err(e);
        }
        Ok(Enabled {
            name,
            slot,
            status: EnvState::Ready.as_str(),
        })
    }

    /// Stops the distro's daemon first, so its sessions end before the relay goes away.
    pub async fn disable(&self, name: String) -> Result<Disabled, String> {
        let inner = &self.inner;
        inner.gate()?;
        eprintln!("houston-tauri: wsl {name}: disable requested");
        let _ops = inner.ops.lock().await;
        let mut config = config::load(&inner.opts.state_dir)?;
        if !config.is_enabled(&name) {
            return Err(config::not_enabled(&name));
        }
        let (relay_port, token, install_dir) = {
            let envs = inner.envs.lock().expect("wsl envs lock");
            match envs.get(&name) {
                Some(env) => {
                    if let Some(relay) = &env.relay {
                        relay.close();
                    }
                    (
                        env.relay.as_ref().map(relay::Relay::port),
                        env.token.clone(),
                        env.install_dir.clone(),
                    )
                }
                None => (None, None, None),
            }
        };
        let mut shutdown_failure = None;
        if let (Some(port), Some(token)) = (relay_port, token) {
            let client = crate::daemon_host::manage_http_client();
            let answer = crate::daemon_host::manage_post(
                &client,
                port,
                &token,
                houston_protocol::ManageVerb::DaemonShutdown,
            )
            .await;
            eprintln!(
                "houston-tauri: wsl {name}: daemon_shutdown {}",
                match &answer {
                    Ok((status, body)) => format!("answered HTTP {status}: {body}"),
                    Err(e) => format!("failed: {e}"),
                }
            );
            shutdown_failure = shutdown_refusal(answer);
        }
        // The distro is disabled either way; a daemon that outlived it is reported.
        let stopped = inner
            .run(command::daemon_stopped(&name, &inner.opts.channel))
            .await;
        config.disable(&name)?;
        config::save(&inner.opts.state_dir, &config)?;
        inner.envs.lock().expect("wsl envs lock").remove(&name);
        inner.notify();
        inner.remove_launcher(&name, install_dir).await;
        check_stopped(&name, &inner.opts.channel, stopped, shutdown_failure)?;
        Ok(Disabled { name })
    }

    pub fn wsl_envs(&self) -> Vec<EnvEntry> {
        self.inner
            .envs
            .lock()
            .expect("wsl envs lock")
            .iter()
            .map(|(distro, env)| EnvEntry {
                id: format!("wsl:{distro}"),
                kind: "wsl",
                distro: Some(distro.clone()),
                slot: env.slot,
                port: env.relay.as_ref().map_or(0, relay::Relay::port),
                token: env.token.clone().unwrap_or_default(),
                state: env.state.as_str(),
                reason: env.reason.clone(),
            })
            .collect()
    }

    /// Brings up every enabled distro in the background; a failure marks only that one.
    pub fn start_enabled(&self) {
        let inner = &self.inner;
        if !inner.opts.supported {
            return;
        }
        let config = match config::load(&inner.opts.state_dir) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("houston-tauri: wsl: not starting WSL environments: {e}");
                return;
            }
        };
        for entry in config.distros.into_iter().filter(|d| d.enabled) {
            let inner = Arc::clone(inner);
            tokio::spawn(async move {
                let _ops = inner.ops.lock().await;
                let still_enabled = config::load(&inner.opts.state_dir)
                    .is_ok_and(|config| config.is_enabled(&entry.name));
                if !still_enabled {
                    return;
                }
                if let Err(e) = inner.start_env(&entry.name, entry.slot).await {
                    eprintln!("houston-tauri: wsl {}: not started: {e}", entry.name);
                    inner.mark_error(&entry.name, entry.slot, e);
                }
            });
        }
    }
}

#[tauri::command]
pub async fn wsl_list(wsl: tauri::State<'_, WslManager>) -> Result<WslList, String> {
    wsl.list().await
}

#[tauri::command]
pub async fn wsl_enable(
    name: String,
    wsl: tauri::State<'_, WslManager>,
) -> Result<Enabled, String> {
    wsl.enable(name).await
}

#[tauri::command]
pub async fn wsl_disable(
    name: String,
    wsl: tauri::State<'_, WslManager>,
) -> Result<Disabled, String> {
    wsl.disable(name).await
}

#[tauri::command]
pub async fn env_list(
    wsl: tauri::State<'_, WslManager>,
    connection: tauri::State<'_, crate::host::ConnectionCell>,
) -> Result<Vec<EnvEntry>, ()> {
    let local = connection.get().await;
    let mut entries = vec![EnvEntry {
        id: "local".to_string(),
        kind: "local",
        distro: None,
        slot: 0,
        port: local.port,
        token: local.token,
        state: EnvState::Ready.as_str(),
        reason: None,
    }];
    entries.extend(wsl.wsl_envs());
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    const BUILD: &str = "b2";
    const TOKEN: &str = "tok-SECRET-42";
    const RECORDED_UTF16: &[u8] = include_bytes!("fixtures/wsl-l-v-utf16.bin");

    enum ListReply {
        Missing,
        Bytes(Vec<u8>),
    }

    struct FakeWsl {
        list: ListReply,
        probes: HashMap<String, String>,
        /// Answers the probe gives before falling back to `probes`, first one first.
        probe_replies: Mutex<std::collections::VecDeque<std::io::Result<RunOutput>>>,
        /// What `daemon_stopped` answers; a stopped daemon by default.
        stopped: Option<RunOutput>,
        ensure: String,
        calls: Mutex<Vec<Vec<String>>>,
        daemons: tokio::sync::mpsc::UnboundedSender<DuplexStream>,
    }

    impl FakeWsl {
        fn new(list: ListReply) -> (Self, tokio::sync::mpsc::UnboundedReceiver<DuplexStream>) {
            let (daemons, rx) = tokio::sync::mpsc::unbounded_channel();
            let fake = FakeWsl {
                list,
                probes: HashMap::new(),
                probe_replies: Mutex::new(Default::default()),
                stopped: None,
                ensure: format!(
                    r#"{{"state":"spawned","port":40001,"token":"{TOKEN}","build":"{BUILD}","protocol":131}}"#
                ),
                calls: Mutex::new(Vec::new()),
                daemons,
            };
            (fake, rx)
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }

        fn ran_inside_a_distro(&self) -> bool {
            self.calls()
                .iter()
                .any(|argv| argv.first().map(String::as_str) == Some("-d"))
        }
    }

    fn ok(stdout: impl Into<Vec<u8>>) -> std::io::Result<RunOutput> {
        Ok(RunOutput {
            code: Some(0),
            stdout: stdout.into(),
            stderr: Vec::new(),
        })
    }

    impl Runner for FakeWsl {
        fn run(&self, argv: &[String], _stdin: command::Stdin<'_>) -> std::io::Result<RunOutput> {
            self.calls.lock().unwrap().push(argv.to_vec());
            if argv == command::list().as_slice() {
                return match &self.list {
                    ListReply::Missing => Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "program not found",
                    )),
                    ListReply::Bytes(bytes) => ok(bytes.clone()),
                };
            }
            let distro = argv[1].as_str();
            if argv == command::probe(distro).as_slice() {
                if let Some(reply) = self.probe_replies.lock().unwrap().pop_front() {
                    return reply;
                }
                return ok(self.probes.get(distro).cloned().unwrap_or_default());
            }
            if argv == command::daemon_stopped(distro, "wslt").as_slice() {
                if let Some(reply) = &self.stopped {
                    return Ok(reply.clone());
                }
            }
            if argv == command::remote_hashes(distro, BUILD).as_slice() {
                return ok("/home/u\n");
            }
            if argv.get(4).map(String::as_str) == Some("wsl-ensure") {
                let code = if self.ensure.contains(r#""refused""#) {
                    3
                } else {
                    0
                };
                return Ok(RunOutput {
                    code: Some(code),
                    stdout: format!("{}\n", self.ensure).into_bytes(),
                    stderr: Vec::new(),
                });
            }
            ok(Vec::new())
        }

        fn spawn_piped(&self, argv: &[String]) -> std::io::Result<Piped> {
            self.calls.lock().unwrap().push(argv.to_vec());
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            self.daemons.send(theirs).unwrap();
            let (read, write) = tokio::io::split(ours);
            Ok(Piped {
                stdin: Box::new(write),
                stdout: Box::new(read),
                child: None,
            })
        }
    }

    fn manager(
        fake: Arc<FakeWsl>,
        state_dir: &Path,
        bundle_dir: &Path,
        supported: bool,
    ) -> WslManager {
        WslManager::new(Options {
            runner: fake,
            state_dir: state_dir.to_path_buf(),
            channel: "wslt".into(),
            build: BUILD.into(),
            bundle_dir: Ok(bundle_dir.to_path_buf()),
            supported,
            retry_delay: relay::RETRY_DELAY,
            notify: Box::new(|| {}),
        })
    }

    fn list_text(rows: &str) -> ListReply {
        ListReply::Bytes(format!("  NAME   STATE   VERSION\n{rows}").into_bytes())
    }

    /// Answers one relayed request as a daemon would, and hands back what it read.
    async fn serve_manage(daemon: DuplexStream) -> String {
        serve_manage_with(daemon, r#"{"ok":true}"#).await
    }

    async fn serve_manage_with(mut daemon: DuplexStream, body: &str) -> String {
        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        let total = loop {
            let n = daemon.read(&mut buf).await.unwrap();
            assert!(
                n > 0,
                "request ended early: {:?}",
                String::from_utf8_lossy(&raw)
            );
            raw.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&raw).to_ascii_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                break end + 4 + len;
            }
        };
        while raw.len() < total {
            let n = daemon.read(&mut buf).await.unwrap();
            raw.extend_from_slice(&buf[..n]);
        }
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        daemon.write_all(reply.as_bytes()).await.unwrap();
        daemon.shutdown().await.unwrap();
        String::from_utf8(raw).unwrap()
    }

    #[tokio::test]
    async fn list_runs_only_list_verbose() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let mut config = config::WslConfig::default();
        config.enable("Ubuntu").unwrap();
        config.enable("docker-desktop").unwrap();
        config.disable("docker-desktop").unwrap();
        config::save(state.path(), &config).unwrap();
        let (fake, _daemons) = FakeWsl::new(ListReply::Bytes(RECORDED_UTF16.to_vec()));
        let fake = Arc::new(fake);

        let listed = manager(fake.clone(), state.path(), bundle.path(), true)
            .list()
            .await
            .unwrap();
        assert!(listed.available);
        assert_eq!(
            listed.distros,
            [WslDistro {
                name: "Ubuntu".into(),
                state: "Running".into(),
                version: 2,
                default: true,
                enabled: true,
                slot: Some(1),
                status: "starting",
            }],
            "the recorded docker-desktop row is a utility distro"
        );
        assert_eq!(fake.calls(), [vec!["-l".to_string(), "-v".to_string()]]);
    }

    #[tokio::test]
    async fn an_enabled_utility_distro_stays_listed() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let mut config = config::WslConfig::default();
        config.enable("docker-desktop").unwrap();
        config::save(state.path(), &config).unwrap();
        let (fake, _daemons) = FakeWsl::new(ListReply::Bytes(RECORDED_UTF16.to_vec()));

        let listed = manager(Arc::new(fake), state.path(), bundle.path(), true)
            .list()
            .await
            .unwrap();
        let names: Vec<&str> = listed.distros.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["Ubuntu", "docker-desktop"]);
        assert!(listed.distros[1].enabled);
    }

    #[tokio::test]
    async fn enable_refuses_utility_distros_by_name() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (fake, _daemons) = FakeWsl::new(list_text(
            "  docker-desktop  Stopped  2\n  docker-desktop-data  Stopped  2\n  \
             rancher-desktop  Stopped  2\n  rancher-desktop-data  Stopped  2\n",
        ));
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        for name in distros::UTILITY {
            let err = wsl.enable(name.into()).await.unwrap_err();
            assert!(
                err.starts_with(name) && err.contains("utility distro"),
                "{err}"
            );
        }
        assert!(!fake.ran_inside_a_distro());
        assert!(config::load(state.path()).unwrap().distros.is_empty());
    }

    #[tokio::test]
    async fn capability_refusals_name_values() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (mut fake, _daemons) = FakeWsl::new(list_text(
            "* Legacy  Stopped  1\n  Arm  Stopped  2\n  Old  Running  2\n",
        ));
        fake.probes
            .insert("Arm".into(), "aarch64\nglibc 2.39\n".into());
        fake.probes
            .insert("Old".into(), "x86_64\nglibc 2.31\n".into());
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let err = wsl.enable("Legacy".into()).await.unwrap_err();
        assert!(err.contains("Legacy") && err.contains("WSL 1"), "{err}");
        assert!(
            !fake.ran_inside_a_distro(),
            "a WSL 1 distro is never booted"
        );

        let err = wsl.enable("Arm".into()).await.unwrap_err();
        assert!(err.contains("Arm") && err.contains("aarch64"), "{err}");

        let err = wsl.enable("Old".into()).await.unwrap_err();
        assert!(err.contains("2.31") && err.contains("2.35"), "{err}");

        let err = wsl.enable("Missing".into()).await.unwrap_err();
        assert!(err.contains("Missing") && err.contains("Legacy"), "{err}");

        let config = config::load(state.path()).unwrap();
        assert!(
            config.distros.is_empty(),
            "a refusal records nothing: {config:?}"
        );
        assert!(wsl.wsl_envs().is_empty());
    }

    #[tokio::test]
    async fn list_reports_unavailable_when_wsl_missing() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (fake, _daemons) = FakeWsl::new(ListReply::Missing);
        let listed = manager(Arc::new(fake), state.path(), bundle.path(), true)
            .list()
            .await
            .unwrap();
        assert!(!listed.available);
        assert!(listed.distros.is_empty());
        let reason = listed.reason.clone().expect("a reason");
        assert!(reason.contains("wsl.exe"), "{reason}");
        let wire = serde_json::to_value(&listed).unwrap();
        assert_eq!(wire["available"], false);
        assert_eq!(wire["reason"], reason.as_str());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn commands_refuse_off_windows() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Running  2\n"));
        let fake = Arc::new(fake);
        let wsl = manager(
            fake.clone(),
            state.path(),
            bundle.path(),
            platform_supported(),
        );

        let refusal = "WSL environments are only available on Windows";
        assert_eq!(wsl.list().await.unwrap_err(), refusal);
        assert_eq!(wsl.enable("Ubuntu".into()).await.unwrap_err(), refusal);
        assert_eq!(wsl.disable("Ubuntu".into()).await.unwrap_err(), refusal);
        assert!(fake.calls().is_empty(), "nothing runs off Windows");
        wsl.start_enabled();
        assert!(wsl.wsl_envs().is_empty());
    }

    #[tokio::test]
    async fn disable_reports_a_daemon_that_did_not_stop() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (mut fake, mut daemons) = FakeWsl::new(list_text("* Ubuntu  Running  2\n"));
        fake.probes
            .insert("Ubuntu".into(), "x86_64\nglibc 2.39\n".into());
        fake.stopped = Some(RunOutput {
            code: Some(1),
            stdout: b"6822\n".to_vec(),
            stderr: Vec::new(),
        });
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);
        wsl.enable("Ubuntu".into()).await.unwrap();

        let refusal = r#"{"ok":false,"error":"failed to terminate 1 of 1 session(s): 1: InvalidArgs","unterminated":[1]}"#;
        tokio::spawn(async move {
            while let Some(daemon) = daemons.recv().await {
                serve_manage_with(daemon, refusal).await;
            }
        });
        let err = wsl.disable("Ubuntu".into()).await.unwrap_err();

        assert!(err.starts_with("Ubuntu is disabled, but"), "{err}");
        assert!(err.contains("(pid 6822) is still running"), "{err}");
        assert!(
            err.contains("failed to terminate 1 of 1 session(s)"),
            "{err}"
        );
        assert!(fake
            .calls()
            .contains(&command::daemon_stopped("Ubuntu", "wslt")));
        assert!(!config::load(state.path()).unwrap().is_enabled("Ubuntu"));
        assert!(wsl.wsl_envs().is_empty());
    }

    #[test]
    fn a_shutdown_answer_with_ok_false_is_a_refusal() {
        let ok = Ok((reqwest::StatusCode::OK, serde_json::json!({"ok": true})));
        assert_eq!(shutdown_refusal(ok), None);
        let refused = Ok((
            reqwest::StatusCode::OK,
            serde_json::json!({"ok": false, "error": "session 1 would not end"}),
        ));
        assert_eq!(
            shutdown_refusal(refused).unwrap(),
            "daemon_shutdown answered HTTP 200 OK: session 1 would not end"
        );
        let failed = shutdown_refusal(Err("connection refused".into())).unwrap();
        assert!(failed.contains("connection refused"), "{failed}");
    }

    #[tokio::test]
    async fn disable_shuts_down_and_keeps_slot() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (mut fake, mut daemons) = FakeWsl::new(list_text("* Ubuntu  Running  2\n"));
        fake.probes
            .insert("Ubuntu".into(), "x86_64\nglibc 2.39\n".into());
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let enabled = wsl.enable("Ubuntu".into()).await.unwrap();
        assert_eq!(
            enabled,
            Enabled {
                name: "Ubuntu".into(),
                slot: 1,
                status: "ready"
            }
        );
        let envs = wsl.wsl_envs();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].id, "wsl:Ubuntu");
        assert_eq!(envs[0].token, TOKEN);
        assert_eq!(envs[0].state, "ready");
        assert_ne!(envs[0].port, 0);
        let install_dir = "/home/u/.local/lib/houston-wsl/b2";
        assert!(fake
            .calls()
            .contains(&command::ensure("Ubuntu", install_dir, "wslt")));

        let requests = tokio::spawn(async move {
            let mut seen = Vec::new();
            while let Some(daemon) = daemons.recv().await {
                seen.push(serve_manage(daemon).await);
            }
            seen
        });
        assert_eq!(
            wsl.disable("Ubuntu".into()).await.unwrap(),
            Disabled {
                name: "Ubuntu".into()
            }
        );

        assert_eq!(
            config::load(state.path()).unwrap().entry("Ubuntu"),
            Some(&config::DistroEntry {
                name: "Ubuntu".into(),
                slot: 1,
                enabled: false
            })
        );
        assert!(wsl.wsl_envs().is_empty());
        assert!(fake
            .calls()
            .contains(&command::launcher_remove("Ubuntu", install_dir)));
        let proxies = fake
            .calls()
            .into_iter()
            .filter(|argv| argv == &command::proxy("Ubuntu", install_dir, "wslt"))
            .count();
        assert_eq!(proxies, 1, "one relayed connection");

        let err = wsl.disable("Ubuntu".into()).await.unwrap_err();
        assert!(err.contains("Ubuntu"), "{err}");
        let err = wsl.disable("Debian".into()).await.unwrap_err();
        assert!(err.contains("Debian"), "{err}");

        drop(wsl);
        drop(fake);
        let seen = tokio::time::timeout(Duration::from_secs(10), requests)
            .await
            .expect("the fake daemon task ends with the runner")
            .unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        let request = seen[0].to_ascii_lowercase();
        assert!(request.starts_with("post /manage "), "{request}");
        let bearer = format!("authorization: bearer {}", TOKEN.to_ascii_lowercase());
        assert!(request.contains(&bearer), "{request}");
        assert!(request.contains(r#""verb":"daemon_shutdown""#), "{request}");
    }

    #[test]
    fn ensure_log_line_omits_token() {
        let report = EnsureReport {
            state: EnsureState::Attached,
            port: Some(40001),
            token: Some(TOKEN.into()),
            build: BUILD.into(),
            protocol: 131,
            reason: None,
        };
        let line = ensure_log_line("Ubuntu", &Ok(report.clone()));
        assert!(
            line.contains("Ubuntu") && line.contains("attached"),
            "{line}"
        );
        assert!(!line.contains(TOKEN), "{line}");

        let out = RunOutput {
            code: Some(0),
            stdout: format!("{}\n", serde_json::to_string(&report).unwrap()).into_bytes(),
            stderr: b"houston-core wsl-ensure: channel wslt: Attached".to_vec(),
        };
        let line = ensure_log_line("Ubuntu", &interpret_ensure("Ubuntu", &ensure_argv(), &out));
        assert!(line.contains("attached") && !line.contains(TOKEN), "{line}");

        let garbled = RunOutput {
            code: Some(1),
            stdout: format!("{{\"token\":\"{TOKEN}\"").into_bytes(),
            stderr: b"failed for channel wslt".to_vec(),
        };
        let line = ensure_log_line(
            "Ubuntu",
            &interpret_ensure("Ubuntu", &ensure_argv(), &garbled),
        );
        assert!(line.contains("Ubuntu") && line.contains("failed"), "{line}");
        assert!(!line.contains(TOKEN), "{line}");

        let refused = EnsureReport {
            state: EnsureState::Refused,
            port: None,
            token: None,
            build: "b3".into(),
            protocol: 132,
            reason: Some("protocol 132 is newer than 131".into()),
        };
        let line = ensure_log_line("Ubuntu", &Ok(refused.clone()));
        assert!(line.contains("refused") && line.contains("132"), "{line}");
        let err = accept_report("Ubuntu", refused).unwrap_err();
        assert!(err.contains("Ubuntu") && err.contains("132"), "{err}");
    }

    #[tokio::test]
    async fn enable_refuses_when_bundle_missing() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        std::fs::remove_file(bundle.path().join("houston-core")).unwrap();
        let (mut fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Running  2\n"));
        fake.probes
            .insert("Ubuntu".into(), "x86_64\nglibc 2.39\n".into());
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let err = wsl.enable("Ubuntu".into()).await.unwrap_err();
        let expected = bundle.path().join("houston-core").display().to_string();
        assert!(err.contains(&expected), "{err} should name {expected}");
        assert!(
            !fake.ran_inside_a_distro(),
            "nothing boots without a bundle"
        );
        assert!(config::load(state.path()).unwrap().distros.is_empty());
    }

    /// What `wsl.exe` printed when it could not start a cold distro: exit -1, its own
    /// UTF-16 message on stdout, nothing on stderr.
    fn wsl_exe_failure() -> std::io::Result<RunOutput> {
        let text = "The operation timed out.\r\nError code: Wsl/Service/E_UNEXPECTED\r\n";
        Ok(RunOutput {
            code: Some(-1),
            stdout: text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            stderr: Vec::new(),
        })
    }

    fn ensure_argv() -> Vec<String> {
        command::ensure("Ubuntu", "/home/u/.local/lib/houston-wsl/b2", "wslt")
    }

    fn probe_calls(fake: &FakeWsl, distro: &str) -> usize {
        let probe = command::probe(distro);
        fake.calls().iter().filter(|argv| **argv == probe).count()
    }

    #[tokio::test]
    async fn a_cold_distro_probe_is_retried_once() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (mut fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Stopped  2\n"));
        fake.probes
            .insert("Ubuntu".into(), "x86_64\nglibc 2.39\n".into());
        fake.probe_replies
            .get_mut()
            .unwrap()
            .push_back(wsl_exe_failure());
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let enabled = wsl.enable("Ubuntu".into()).await.unwrap();
        assert_eq!(enabled.status, "ready");
        assert_eq!(probe_calls(&fake, "Ubuntu"), 2);
    }

    #[tokio::test]
    async fn a_failed_probe_quotes_wsl_exe() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Stopped  2\n"));
        let replies = [wsl_exe_failure(), wsl_exe_failure()];
        fake.probe_replies.lock().unwrap().extend(replies);
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let err = wsl.enable("Ubuntu".into()).await.unwrap_err();
        assert!(err.contains("Wsl/Service/E_UNEXPECTED"), "{err}");
        assert!(
            err.contains("exit code -1") && !err.contains("Some("),
            "{err}"
        );
        assert_eq!(probe_calls(&fake, "Ubuntu"), 2);
        assert!(config::load(state.path()).unwrap().distros.is_empty());
    }

    #[tokio::test]
    async fn a_timed_out_probe_says_so_and_is_not_retried() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Stopped  2\n"));
        fake.probe_replies
            .lock()
            .unwrap()
            .push_back(Err(command::timed_out()));
        let fake = Arc::new(fake);
        let wsl = manager(fake.clone(), state.path(), bundle.path(), true);

        let err = wsl.enable("Ubuntu".into()).await.unwrap_err();
        let expected = format!(
            "{} timed out after 180 s",
            command::describe(&command::probe("Ubuntu"))
        );
        assert_eq!(err, expected);
        assert_eq!(probe_calls(&fake, "Ubuntu"), 1);
    }

    #[tokio::test]
    async fn a_refused_ensure_undoes_the_enable() {
        let state = tempfile::tempdir().unwrap();
        let bundle = provision::tests::bundle_dir();
        let (mut fake, _daemons) = FakeWsl::new(list_text("* Ubuntu  Running  2\n"));
        fake.probes
            .insert("Ubuntu".into(), "x86_64\nglibc 2.39\n".into());
        fake.ensure = r#"{"state":"refused","build":"b3","protocol":132,"reason":"protocol 132 is newer than 131"}"#.into();
        let wsl = manager(Arc::new(fake), state.path(), bundle.path(), true);
        let err = wsl.enable("Ubuntu".into()).await.unwrap_err();
        assert!(err.contains("132"), "{err}");
        assert!(!config::load(state.path()).unwrap().is_enabled("Ubuntu"));
        assert!(wsl.wsl_envs().is_empty());
    }
}

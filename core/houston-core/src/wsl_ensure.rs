//! `wsl-ensure` and `wsl-launcher-remove`: run inside a WSL distro by the Windows app.
//! Ensure leaves this channel's daemon running this binary's build, then prints one
//! JSON line (`EnsureReport`); everything else goes to stderr.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LAUNCHER_MARKER: &str = "# houston-wsl-managed";
pub const INSTALL_DIR_NAME: &str = "houston-wsl";
pub const EXIT_FAILED: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnsureState {
    Attached,
    Spawned,
    HandedOff,
    Refused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnsureReport {
    pub state: EnsureState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub build: String,
    pub protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn exit_code(state: EnsureState) -> i32 {
    match state {
        EnsureState::Attached | EnsureState::Spawned | EnsureState::HandedOff => 0,
        EnsureState::Refused => 3,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveDaemon {
    pub protocol: u32,
    pub build: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Spawn,
    Attach,
    Handoff { candidate: PathBuf },
    Refuse { reason: String },
}

/// A daemon newer than this binary is never replaced: SHAs carry no order, protocols do.
pub fn decide(
    live: Option<&LiveDaemon>,
    own_protocol: u32,
    own_build: &str,
    own_exe: &Path,
) -> Decision {
    let Some(live) = live else {
        return Decision::Spawn;
    };
    if live.protocol > own_protocol {
        return Decision::Refuse {
            reason: format!(
                "the running daemon speaks protocol {}, newer than this binary's protocol \
                 {own_protocol}; update Houston on Windows",
                live.protocol
            ),
        };
    }
    if live.protocol == own_protocol && live.build == own_build {
        Decision::Attach
    } else {
        Decision::Handoff {
            candidate: own_exe.to_path_buf(),
        }
    }
}

/// The state a refused handoff leaves: only an equal protocol can still serve the app.
pub fn after_refused_handoff(
    live: &LiveDaemon,
    own_protocol: u32,
    refusal: &str,
) -> (EnsureState, String) {
    if live.protocol == own_protocol {
        (
            EnsureState::Attached,
            format!(
                "kept build {} because the handoff was refused: {refusal}",
                live.build
            ),
        )
    } else {
        (
            EnsureState::Refused,
            format!(
                "the running daemon speaks protocol {}, older than this binary's protocol \
                 {own_protocol}, and refused the handoff: {refusal}",
                live.protocol
            ),
        )
    }
}

/// Removes every sibling of `own_exe`'s build directory, and only under `houston-wsl/`.
pub fn prune_other_builds(own_exe: &Path) -> std::io::Result<Vec<PathBuf>> {
    let Some(build_dir) = own_exe.parent() else {
        return Ok(Vec::new());
    };
    let Some(root) = build_dir.parent() else {
        return Ok(Vec::new());
    };
    if root.file_name() != Some(std::ffi::OsStr::new(INSTALL_DIR_NAME)) {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir()
            && Some(entry.file_name().as_os_str()) != build_dir.file_name()
        {
            std::fs::remove_dir_all(entry.path())?;
            removed.push(entry.path());
        }
    }
    Ok(removed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherOutcome {
    Written,
    Removed,
    Absent,
    KeptForeign,
}

pub fn launcher_path(home: &Path) -> PathBuf {
    home.join(".local").join("bin").join("houston")
}

fn sh_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', r"'\''"))
}

pub fn launcher_script(own_exe: &Path, channel: &str) -> String {
    format!(
        "#!/bin/sh\n{LAUNCHER_MARKER}\n[ \"$#\" -eq 0 ] && set -- .\nexec {} open --channel {} \"$@\"\n",
        sh_quote(&own_exe.to_string_lossy()),
        sh_quote(channel)
    )
}

// None: absent. A symlink or directory is never ours, whatever it points at.
fn launcher_is_managed(path: &Path) -> std::io::Result<Option<bool>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Ok(Some(false));
    }
    let bytes = std::fs::read(path)?;
    let second = bytes.split(|b| *b == b'\n').nth(1).unwrap_or_default();
    let second = second.strip_suffix(b"\r").unwrap_or(second);
    Ok(Some(second == LAUNCHER_MARKER.as_bytes()))
}

pub fn write_launcher(
    home: &Path,
    own_exe: &Path,
    channel: &str,
) -> std::io::Result<LauncherOutcome> {
    let path = launcher_path(home);
    if launcher_is_managed(&path)? == Some(false) {
        return Ok(LauncherOutcome::KeptForeign);
    }
    let dir = path.parent().expect("launcher path has a parent");
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".houston.new");
    std::fs::write(&tmp, launcher_script(own_exe, channel))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(LauncherOutcome::Written)
}

pub fn remove_launcher(home: &Path) -> std::io::Result<LauncherOutcome> {
    let path = launcher_path(home);
    match launcher_is_managed(&path)? {
        None => Ok(LauncherOutcome::Absent),
        Some(false) => Ok(LauncherOutcome::KeptForeign),
        Some(true) => {
            std::fs::remove_file(&path)?;
            Ok(LauncherOutcome::Removed)
        }
    }
}

/// Splits `--channel <name>` out of `args`; the rest are positional.
pub(crate) fn split_channel(
    command: &str,
    args: &[String],
) -> Result<(Option<String>, Vec<String>), String> {
    let mut channel = None;
    let mut rest = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg != "--channel" {
            rest.push(arg.clone());
            continue;
        }
        let value = it.next().ok_or_else(|| {
            format!(
                "houston-core {command}: --channel is missing its value; expected --channel <name>"
            )
        })?;
        if channel.replace(value.clone()).is_some() {
            return Err(format!(
                "houston-core {command}: repeated --channel {value:?}; expected one channel flag"
            ));
        }
    }
    Ok((channel, rest))
}

/// The channel's spelled name (`release` for the default) and its state directory.
pub(crate) fn channel_state_dir(command: &str, raw: &str) -> Result<(String, PathBuf), String> {
    let channel = crate::paths::validate_channel(raw)
        .map_err(|e| format!("houston-core {command}: refusing --channel {raw:?}: {e}"))?;
    let home = crate::home_dir::home_dir()
        .ok_or_else(|| format!("houston-core {command}: cannot resolve the home directory"))?;
    let dir = crate::paths::dir_for(&home, channel.as_deref());
    Ok((channel.unwrap_or_else(|| "release".to_string()), dir))
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DaemonFile {
    pub port: u16,
    pub token: String,
    #[cfg_attr(not(unix), allow(dead_code))]
    pub pid: u32,
}

pub(crate) fn read_daemon_file(state_dir: &Path) -> Option<DaemonFile> {
    let raw = std::fs::read_to_string(state_dir.join("daemon.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn required_channel(command: &str, args: &[String]) -> Result<String, String> {
    match split_channel(command, args)? {
        (Some(channel), rest) if rest.is_empty() => Ok(channel),
        (_, rest) => Err(format!(
            "houston-core {command}: unexpected arguments {rest:?}; expected --channel <name>"
        )),
    }
}

pub fn run_cli(args: &[String]) -> i32 {
    let channel = match required_channel("wsl-ensure", args) {
        Ok(channel) => channel,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_FAILED;
        }
    };
    #[cfg(unix)]
    {
        match unix::run(&channel) {
            Ok(report) => {
                println!(
                    "{}",
                    serde_json::to_string(&report).expect("EnsureReport serializes")
                );
                exit_code(report.state)
            }
            Err(message) => {
                eprintln!("houston-core wsl-ensure: failed for channel {channel}: {message}");
                EXIT_FAILED
            }
        }
    }
    #[cfg(not(unix))]
    {
        eprintln!(
            "houston-core wsl-ensure: refusing channel {channel}: wsl-ensure is Linux-only; it runs inside a WSL distro"
        );
        EXIT_FAILED
    }
}

pub fn run_launcher_remove(args: &[String]) -> i32 {
    if !args.is_empty() {
        eprintln!("houston-core wsl-launcher-remove: unexpected arguments {args:?}; expected none");
        return EXIT_FAILED;
    }
    if cfg!(not(unix)) {
        eprintln!("houston-core wsl-launcher-remove: refused: it is Linux-only; it runs inside a WSL distro");
        return EXIT_FAILED;
    }
    let Some(home) = crate::home_dir::home_dir() else {
        eprintln!("houston-core wsl-launcher-remove: cannot resolve the home directory");
        return EXIT_FAILED;
    };
    let path = launcher_path(&home);
    match remove_launcher(&home) {
        Ok(LauncherOutcome::Removed) => eprintln!("houston-core: removed {}", path.display()),
        Ok(LauncherOutcome::KeptForeign) => eprintln!(
            "houston-core: kept {}: it does not carry {LAUNCHER_MARKER:?} on its second line",
            path.display()
        ),
        Ok(_) => eprintln!("houston-core: {} is absent", path.display()),
        Err(e) => {
            eprintln!("houston-core wsl-launcher-remove: {}: {e}", path.display());
            return EXIT_FAILED;
        }
    }
    0
}

#[cfg(unix)]
mod unix {
    use super::*;
    use houston_protocol as proto;
    use std::time::{Duration, Instant};

    const READY_TIMEOUT: Duration = Duration::from_secs(20);
    // A status probe is a local loopback request; a handoff parks every session first.
    const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
    const HANDOFF_TIMEOUT: Duration = Duration::from_secs(60);

    pub(super) fn run(channel: &str) -> Result<EnsureReport, String> {
        let (channel, state_dir) = channel_state_dir("wsl-ensure", channel)?;
        let home = crate::home_dir::home_dir().ok_or("cannot resolve the home directory")?;
        let own_exe = crate::exe_path::strip_deleted_exe_suffix(
            &std::env::current_exe().map_err(|e| format!("resolving this binary's path: {e}"))?,
        );
        let own_build = crate::daemon::build_commit();
        let own_protocol = proto::PROTOCOL_VERSION;
        let client = |timeout| {
            reqwest::blocking::Client::builder()
                .timeout(timeout)
                .connect_timeout(STATUS_TIMEOUT)
                .build()
                .map_err(|e| format!("building the HTTP client: {e}"))
        };
        let status_client = client(STATUS_TIMEOUT)?;

        let live = match live_daemon_file(&state_dir) {
            None => None,
            Some(_) => Some(wait_answering(&status_client, &state_dir, |_| true)?),
        };
        let report = |state, file: Option<&DaemonFile>, live: &LiveDaemon, reason| EnsureReport {
            state,
            port: file.map(|f| f.port),
            token: file.map(|f| f.token.clone()),
            build: live.build.clone(),
            protocol: live.protocol,
            reason,
        };
        let outcome = match (
            decide(
                live.as_ref().map(|(_, l)| l),
                own_protocol,
                own_build,
                &own_exe,
            ),
            live,
        ) {
            (Decision::Spawn, _) => {
                spawn_daemon(&own_exe, &state_dir, &channel, &home)?;
                let (file, live) = wait_answering(&status_client, &state_dir, |_| true)?;
                report(EnsureState::Spawned, Some(&file), &live, None)
            }
            (Decision::Attach, Some((file, live))) => {
                report(EnsureState::Attached, Some(&file), &live, None)
            }
            (Decision::Refuse { reason }, Some((_, live))) => {
                report(EnsureState::Refused, None, &live, Some(reason))
            }
            (Decision::Handoff { candidate }, Some((file, live))) => {
                match handoff(&client(HANDOFF_TIMEOUT)?, &file, &candidate) {
                    Ok(()) => {
                        let (file, live) = wait_answering(&status_client, &state_dir, |l| {
                            l.build == own_build && l.protocol == own_protocol
                        })?;
                        report(EnsureState::HandedOff, Some(&file), &live, None)
                    }
                    Err(refusal) => {
                        let (state, reason) = after_refused_handoff(&live, own_protocol, &refusal);
                        let file = (state == EnsureState::Attached).then_some(&file);
                        report(state, file, &live, Some(reason))
                    }
                }
            }
            (decision, None) => unreachable!("{decision:?} needs a live daemon"),
        };
        eprintln!(
            "houston-core wsl-ensure: channel {channel}: {:?}, build {}, protocol {}{}",
            outcome.state,
            outcome.build,
            outcome.protocol,
            outcome
                .reason
                .as_deref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        );
        if outcome.state != EnsureState::Refused {
            if outcome.build == own_build && outcome.protocol == own_protocol {
                match prune_other_builds(&own_exe) {
                    Ok(removed) => {
                        for dir in removed {
                            eprintln!(
                                "houston-core wsl-ensure: removed old build {}",
                                dir.display()
                            );
                        }
                    }
                    Err(e) => eprintln!("houston-core wsl-ensure: pruning old builds: {e}"),
                }
            }
            match write_launcher(&home, &own_exe, &channel) {
                Ok(LauncherOutcome::KeptForeign) => eprintln!(
                    "houston-core wsl-ensure: kept {}: it is not managed by Houston",
                    launcher_path(&home).display()
                ),
                Ok(_) => {}
                Err(e) => eprintln!(
                    "houston-core wsl-ensure: writing {}: {e}",
                    launcher_path(&home).display()
                ),
            }
        }
        Ok(outcome)
    }

    fn live_daemon_file(state_dir: &Path) -> Option<DaemonFile> {
        let file = read_daemon_file(state_dir)?;
        crate::pid::process_comm(file.pid)
            .filter(|comm| comm.starts_with("houston"))
            .map(|_| file)
    }

    fn status(client: &reqwest::blocking::Client, file: &DaemonFile) -> Result<LiveDaemon, String> {
        let resp = manage_post(client, file, proto::ManageVerb::DaemonStatus, None)?;
        let status = resp.status();
        let body: proto::ManageDaemonStatus = resp.json().map_err(|e| {
            format!("/manage daemon_status (HTTP {status}) did not match ManageDaemonStatus: {e}")
        })?;
        Ok(LiveDaemon {
            protocol: body.protocol_version,
            build: body.build,
        })
    }

    fn handoff(
        client: &reqwest::blocking::Client,
        file: &DaemonFile,
        candidate: &Path,
    ) -> Result<(), String> {
        let resp = manage_post(
            client,
            file,
            proto::ManageVerb::DaemonHandoff,
            Some(candidate.to_string_lossy().into_owned()),
        )?;
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        match serde_json::from_str::<proto::ManageDaemonHandoffResult>(&text) {
            Ok(result) if result.accepted => Ok(()),
            Ok(result) => Err(result.reason.unwrap_or_else(|| "no reason given".into())),
            Err(_) => Err(format!("HTTP {status}: {text}")),
        }
    }

    fn manage_post(
        client: &reqwest::blocking::Client,
        file: &DaemonFile,
        verb: proto::ManageVerb,
        candidate_bin: Option<String>,
    ) -> Result<reqwest::blocking::Response, String> {
        client
            .post(format!("http://127.0.0.1:{}/manage", file.port))
            .bearer_auth(&file.token)
            .json(&proto::ManageRequest {
                manage_version: proto::MANAGE_VERSION,
                verb,
                candidate_bin,
                expected_sessions: None,
                path: None,
            })
            .send()
            .map_err(|e| format!("POST /manage {verb:?} to port {}: {e}", file.port))
    }

    fn wait_answering(
        client: &reqwest::blocking::Client,
        state_dir: &Path,
        accept: impl Fn(&LiveDaemon) -> bool,
    ) -> Result<(DaemonFile, LiveDaemon), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let last = match live_daemon_file(state_dir) {
                None => "no live daemon owns it".to_string(),
                Some(file) => match status(client, &file) {
                    Ok(live) if accept(&live) => return Ok((file, live)),
                    Ok(live) => format!(
                        "its daemon reports build {} protocol {}",
                        live.build, live.protocol
                    ),
                    Err(e) => e,
                },
            };
            if Instant::now() >= deadline {
                return Err(format!(
                    "timed out after {}s waiting for a daemon in {} ({last}); see {}",
                    READY_TIMEOUT.as_secs(),
                    state_dir.display(),
                    state_dir.join("logs").join("daemon.log").display()
                ));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn spawn_daemon(
        own_exe: &Path,
        state_dir: &Path,
        channel: &str,
        home: &Path,
    ) -> Result<(), String> {
        let bin_dir = own_exe.parent().unwrap_or(Path::new("/"));
        let supervisor = bin_dir.join("houston-supervisor");
        let core = bin_dir.join("houston-core");
        for required in [&supervisor, &core] {
            if !required.is_file() {
                return Err(format!(
                    "cannot spawn a daemon: {} does not exist; expected houston-supervisor and \
                     houston-core beside {}",
                    required.display(),
                    own_exe.display()
                ));
            }
        }
        let log_path = state_dir.join("logs").join("daemon.log");
        std::fs::create_dir_all(log_path.parent().expect("log path has a parent"))
            .map_err(|e| format!("creating {}: {e}", state_dir.join("logs").display()))?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("opening {}: {e}", log_path.display()))?;
        let log_err = log
            .try_clone()
            .map_err(|e| format!("cloning {}: {e}", log_path.display()))?;
        let mut cmd = crate::spawn::command(&supervisor);
        cmd.arg("--channel-dir")
            .arg(state_dir)
            .arg("--daemon")
            .arg(&core)
            .arg("--")
            .arg("--channel")
            .arg(channel)
            .env(crate::paths::CHANNEL_ENV, channel)
            .current_dir(home)
            .stdin(std::process::Stdio::null())
            .stdout(log)
            .stderr(log_err);
        // SAFETY: `pre_exec` runs in the forked child before exec; `setsid` only
        // detaches it, so the daemon outlives the `wsl.exe` that ran this command.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn()
            .map(drop)
            .map_err(|e| format!("spawning {}: {e}", supervisor.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(protocol: u32, build: &str) -> LiveDaemon {
        LiveDaemon {
            protocol,
            build: build.to_string(),
        }
    }

    #[test]
    fn decides_every_branch() {
        let exe = Path::new("/home/u/.local/lib/houston-wsl/b2/houston-core");
        assert_eq!(decide(None, 131, "b2", exe), Decision::Spawn);
        assert_eq!(
            decide(Some(&live(131, "b2")), 131, "b2", exe),
            Decision::Attach
        );
        let handoff = Decision::Handoff {
            candidate: exe.to_path_buf(),
        };
        assert_eq!(decide(Some(&live(131, "b1")), 131, "b2", exe), handoff);
        assert_eq!(decide(Some(&live(130, "b1")), 131, "b2", exe), handoff);
        assert_eq!(decide(Some(&live(130, "b2")), 131, "b2", exe), handoff);
        match decide(Some(&live(132, "b3")), 131, "b2", exe) {
            Decision::Refuse { reason } => {
                assert!(reason.contains("132") && reason.contains("131"), "{reason}")
            }
            other => panic!("a newer daemon protocol must be refused, got {other:?}"),
        }

        let (state, reason) = after_refused_handoff(&live(131, "b1"), 131, "a live SSH session");
        assert_eq!(state, EnsureState::Attached);
        assert!(reason.contains("a live SSH session"), "{reason}");
        let (state, reason) = after_refused_handoff(&live(130, "b1"), 131, "a live SSH session");
        assert_eq!(state, EnsureState::Refused);
        assert!(
            reason.contains("a live SSH session")
                && reason.contains("130")
                && reason.contains("131"),
            "{reason}"
        );
    }

    #[test]
    fn exit_codes_per_state() {
        assert_eq!(exit_code(EnsureState::Attached), 0);
        assert_eq!(exit_code(EnsureState::Spawned), 0);
        assert_eq!(exit_code(EnsureState::HandedOff), 0);
        assert_eq!(exit_code(EnsureState::Refused), 3);
        assert_eq!(EXIT_FAILED, 1);
    }

    #[test]
    fn report_wire_shape() {
        let refused = EnsureReport {
            state: EnsureState::Refused,
            port: None,
            token: None,
            build: "abc1234".into(),
            protocol: 132,
            reason: Some("newer".into()),
        };
        assert_eq!(
            serde_json::to_string(&refused).unwrap(),
            r#"{"state":"refused","build":"abc1234","protocol":132,"reason":"newer"}"#
        );
        let handed: EnsureReport = serde_json::from_str(
            r#"{"state":"handed_off","port":7,"token":"t","build":"b","protocol":131}"#,
        )
        .unwrap();
        assert_eq!(handed.state, EnsureState::HandedOff);
        assert_eq!(handed.port, Some(7));
        assert_eq!(handed.reason, None);
    }

    #[test]
    fn prunes_other_build_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(INSTALL_DIR_NAME);
        for dir in ["old1", "old2", "current"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
            std::fs::write(root.join(dir).join("houston-core"), b"elf").unwrap();
        }
        let exe = root.join("current").join("houston-core");
        let removed = prune_other_builds(&exe).unwrap();
        assert_eq!(removed.len(), 2, "{removed:?}");
        let mut left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["current"]);
        assert!(exe.is_file());

        let elsewhere = tmp.path().join("target");
        for dir in ["debug", "release"] {
            std::fs::create_dir_all(elsewhere.join(dir)).unwrap();
        }
        assert!(
            prune_other_builds(&elsewhere.join("debug").join("houston-core"))
                .unwrap()
                .is_empty()
        );
        assert!(
            elsewhere.join("release").is_dir(),
            "only houston-wsl/ is pruned"
        );
    }

    #[test]
    fn launcher_respects_marker() {
        let home = tempfile::tempdir().unwrap();
        let path = launcher_path(home.path());
        let exe = Path::new("/home/u/.local/lib/houston-wsl/b2/houston-core");

        assert_eq!(
            write_launcher(home.path(), exe, "dev").unwrap(),
            LauncherOutcome::Written
        );
        let script = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = script.lines().collect();
        assert_eq!(lines[0], "#!/bin/sh");
        assert_eq!(lines[1], LAUNCHER_MARKER);
        assert!(
            script.contains(
                "exec '/home/u/.local/lib/houston-wsl/b2/houston-core' open --channel 'dev'"
            ),
            "{script}"
        );

        std::fs::write(
            &path,
            format!("#!/bin/sh\n{LAUNCHER_MARKER}\nexec /old/houston-core open\n"),
        )
        .unwrap();
        assert_eq!(
            write_launcher(home.path(), exe, "dev").unwrap(),
            LauncherOutcome::Written
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            launcher_script(exe, "dev")
        );

        let foreign = b"#!/bin/sh\nexec /usr/lib/houston/houston \"$@\"\n";
        std::fs::write(&path, foreign).unwrap();
        assert_eq!(
            write_launcher(home.path(), exe, "dev").unwrap(),
            LauncherOutcome::KeptForeign
        );
        assert_eq!(std::fs::read(&path).unwrap(), foreign);
        assert_eq!(
            remove_launcher(home.path()).unwrap(),
            LauncherOutcome::KeptForeign
        );
        assert_eq!(std::fs::read(&path).unwrap(), foreign);

        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            write_launcher(home.path(), exe, "dev").unwrap(),
            LauncherOutcome::Written
        );
        assert_eq!(
            remove_launcher(home.path()).unwrap(),
            LauncherOutcome::Removed
        );
        assert!(!path.exists());
        assert_eq!(
            remove_launcher(home.path()).unwrap(),
            LauncherOutcome::Absent
        );
    }

    #[test]
    fn launcher_quotes_its_arguments() {
        let script = launcher_script(Path::new("/home/o'neil/houston-core"), "dev");
        assert!(
            script.contains(r"exec '/home/o'\''neil/houston-core' open"),
            "{script}"
        );
    }
}

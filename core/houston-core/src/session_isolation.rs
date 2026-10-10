use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const SUBCOMMAND: &str = "session-exec";
// Bound manager failures before the CLI starts; a queued request must never race its forks.
const MANAGER_TIMEOUT: Duration = Duration::from_secs(5);

fn connection() -> Result<zbus::blocking::Connection, String> {
    if !Path::new("/run/systemd/system").is_dir() {
        return Err("the host is not running systemd".into());
    }
    zbus::blocking::connection::Builder::session()
        .and_then(|builder| builder.method_timeout(MANAGER_TIMEOUT).build())
        .map_err(|error| format!("user session bus unavailable: {error}"))
}

fn manager(connection: &zbus::blocking::Connection) -> Result<zbus::blocking::Proxy<'_>, String> {
    zbus::blocking::Proxy::new(
        connection,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    )
    .map_err(|error| format!("user systemd manager unavailable: {error}"))
}

pub fn launcher() -> Option<PathBuf> {
    let result = (|| {
        let connection = connection()?;
        manager(&connection)?
            .get_property::<String>("Version")
            .map_err(|error| format!("user systemd manager unavailable: {error}"))?;
        std::env::current_exe().map_err(|error| format!("resolving session launcher: {error}"))
    })();
    match result {
        Ok(path) => Some(path),
        Err(reason) => {
            eprintln!("houston-core: session cgroup isolation unavailable: {reason}; using the existing PTY launch");
            None
        }
    }
}

pub fn resolve_program(command: &mut portable_pty::CommandBuilder) -> anyhow::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let program = command
        .get_argv()
        .first()
        .ok_or_else(|| anyhow::anyhow!("session command is empty; expected an executable"))?;
    let executable = |path: &Path| {
        std::ffi::CString::new(path.as_os_str().as_bytes())
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0)
            && path.is_file()
    };
    let path = Path::new(program);
    let resolved = if path.is_absolute() {
        executable(path).then(|| path.to_path_buf())
    } else {
        let cwd = command
            .get_cwd()
            .map(PathBuf::from)
            .unwrap_or(std::env::current_dir()?);
        let candidate = cwd.join(path);
        if executable(&candidate) {
            Some(candidate)
        } else {
            command.get_env("PATH").and_then(|search| {
                std::env::split_paths(search)
                    .map(|entry| {
                        let entry = if entry.is_absolute() {
                            entry
                        } else {
                            cwd.join(entry)
                        };
                        entry.join(path)
                    })
                    .find(|candidate| executable(candidate))
            })
        }
    }
    .ok_or_else(|| {
        anyhow::anyhow!(
            "executable {:?} was not found or cannot be executed in the session directory or PATH",
            program
        )
    })?;
    command.get_argv_mut()[0] = resolved.into_os_string();
    Ok(())
}

pub fn wrap(command: &mut portable_pty::CommandBuilder, launcher: &Path, channel: &str, id: u32) {
    let argv = command.get_argv_mut();
    let original = std::mem::take(argv);
    argv.extend([
        launcher.as_os_str().to_owned(),
        SUBCOMMAND.into(),
        channel.into(),
        id.to_string().into(),
        "--".into(),
    ]);
    argv.extend(original);
}

fn self_in_scope(contents: &str, unit: &str) -> bool {
    contents.lines().any(|line| {
        line.splitn(3, ':')
            .nth(2)
            .and_then(|path| Path::new(path).file_name())
            .is_some_and(|name| name == unit)
    })
}

pub(crate) enum ScopeError {
    Unavailable(String),
    Pending(String),
}

impl From<String> for ScopeError {
    fn from(reason: String) -> Self {
        Self::Pending(reason)
    }
}

fn definite_rejection(name: &str) -> bool {
    !matches!(
        name,
        "org.freedesktop.DBus.Error.NoReply"
            | "org.freedesktop.DBus.Error.Timeout"
            | "org.freedesktop.DBus.Error.TimedOut"
    )
}

fn enter_scope(channel: &str, id: u32) -> Result<(), ScopeError> {
    let connection = connection().map_err(ScopeError::Unavailable)?;
    let manager = manager(&connection).map_err(ScopeError::Unavailable)?;
    let unit = format!(
        "houston-session-{channel}-{id}-{}.scope",
        uuid::Uuid::new_v4().simple()
    );
    let properties = (|| -> zbus::zvariant::Result<Vec<(&str, OwnedValue)>> {
        Ok(vec![
            (
                "Description",
                OwnedValue::try_from(Value::new(format!("Houston session {id} ({channel})")))?,
            ),
            (
                "CollectMode",
                OwnedValue::try_from(Value::new("inactive-or-failed"))?,
            ),
            (
                "PIDs",
                // systemd resolves zero to the authenticated caller, including across PID namespaces.
                OwnedValue::try_from(Value::new(vec![0u32]))?,
            ),
        ])
    })()
    .map_err(|error| format!("constructing session scope {unit}: {error}"))?;
    let auxiliary: Vec<(&str, Vec<(&str, OwnedValue)>)> = Vec::new();
    let job: OwnedObjectPath = manager
        .call(
            "StartTransientUnit",
            &(unit.as_str(), "fail", properties, auxiliary),
        )
        .map_err(|error| {
            let reason = format!("starting session scope {unit}: {error}");
            match error {
                zbus::Error::MethodError(name, ..) if definite_rejection(name.as_str()) => {
                    ScopeError::Unavailable(reason)
                }
                _ => ScopeError::Pending(reason),
            }
        })?;
    let deadline = Instant::now() + MANAGER_TIMEOUT;
    loop {
        let contents = std::fs::read_to_string("/proc/self/cgroup")
            .map_err(|error| format!("reading session cgroup for {unit}: {error}"))?;
        if self_in_scope(&contents, &unit) {
            let path: OwnedObjectPath = manager
                .call("GetUnit", &(unit.as_str(),))
                .map_err(|error| format!("looking up session scope {unit}: {error}"))?;
            let scope = zbus::blocking::Proxy::new(
                &connection,
                "org.freedesktop.systemd1",
                path,
                "org.freedesktop.systemd1.Unit",
            )
            .map_err(|error| format!("reading session scope {unit}: {error}"))?;
            if scope
                .get_property::<String>("ActiveState")
                .map_err(|error| format!("reading session scope {unit}: {error}"))?
                == "active"
            {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(ScopeError::Pending(format!(
                "session scope {unit} job {job} did not become active within {}s",
                MANAGER_TIMEOUT.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(crate) fn enter_owned_scope(channel: &str, id: u32) -> Result<(), ScopeError> {
    crate::paths::validate_channel(channel)
        .map_err(|error| ScopeError::Unavailable(error.to_string()))?;
    if id == 0 {
        return Err(ScopeError::Unavailable(
            "session scope requires a positive session ID".into(),
        ));
    }
    enter_scope(channel, id)
}

fn owned_scope(contents: &str, channel: &str, id: u32) -> Option<String> {
    contents.lines().find_map(|line| {
        let path = line.splitn(3, ':').nth(2)?;
        let unit = Path::new(path).file_name()?.to_str()?;
        let nonce = unit
            .strip_prefix(&format!("houston-session-{channel}-{id}-"))?
            .strip_suffix(".scope")?;
        (nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| unit.to_string())
    })
}

pub fn current_owned_scope(channel: &str, id: u32) -> Result<Option<String>, String> {
    crate::paths::validate_channel(channel).map_err(|error| error.to_string())?;
    if id == 0 {
        return Err("session scope requires a positive session ID".into());
    }
    let contents = std::fs::read_to_string("/proc/self/cgroup")
        .map_err(|error| format!("reading session {id} cgroup: {error}"))?;
    Ok(owned_scope(&contents, channel, id))
}

pub fn stop_recorded_scope(unit: &str, channel: &str, id: u32) -> Result<(), String> {
    // The observer survives its PTY owner and remains a member of this exact unit.
    // Its own membership anchors ownership after the owner's PID has been reaped.
    if current_owned_scope(channel, id)?.as_deref() != Some(unit) {
        return Err(format!(
            "session {id} scope {unit:?} is not the caller's owned session scope"
        ));
    }
    let connection = connection()?;
    let manager = manager(&connection)?;
    manager
        .call::<_, _, ()>("KillUnit", &(unit, "all", libc::SIGKILL))
        .map_err(|error| format!("terminating session {id} scope {unit}: {error}"))
}

pub fn run(args: Vec<OsString>) -> anyhow::Result<()> {
    use std::os::unix::process::CommandExt;
    let channel = args
        .first()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            anyhow::anyhow!("session-exec: expected channel, session ID and -- command")
        })?;
    crate::paths::validate_channel(channel).map_err(anyhow::Error::msg)?;
    let id = args
        .get(1)
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "session-exec: session ID {:?}: expected a positive u32",
                args.get(1)
            )
        })?;
    if args.get(2).is_none_or(|argument| argument != "--") || args.len() < 4 {
        anyhow::bail!("session-exec: expected -- followed by a command");
    }
    // A helper cannot fork the CLI until its own scope is active. If a queued request
    // times out, refusing the launch prevents later PID migration from missing descendants.
    match enter_scope(channel, id) {
        Ok(()) => {}
        Err(ScopeError::Unavailable(reason)) => eprintln!(
            "houston-core: session {id} cgroup isolation unavailable: {reason}; using the existing PTY launch"
        ),
        Err(ScopeError::Pending(reason)) => return Err(anyhow::Error::msg(reason)),
    }
    let mut command = crate::spawn::command(&args[3]);
    command.args(&args[4..]);
    let error = command.exec();
    Err(anyhow::anyhow!(
        "session-exec: executing {:?}: {error}",
        args[3]
    ))
}

static FAIL_SCOPE_TERMINATION: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Makes every scope termination in this process fail, as WSL's user systemd does.
#[doc(hidden)]
pub fn fail_scope_termination_for_test(fail: bool) {
    FAIL_SCOPE_TERMINATION.store(fail, std::sync::atomic::Ordering::SeqCst);
}

/// Stops a session through its scope, else through `fallback` (the PTY's process groups).
/// A failed scope stop also falls back; docs/internals/overview.md explains why.
pub fn terminate_session(
    pid: u32,
    id: u32,
    channel: Option<&str>,
    expected_creation: Option<u64>,
    fallback: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match terminate_owned_scope(pid, id, channel, expected_creation) {
        Ok(true) => Ok(()),
        Ok(false) => fallback(),
        Err(scope) => {
            tracing::warn!("{scope}; terminating session {id}'s PTY process groups instead");
            fallback().map_err(|fallback| format!("{scope}; then {fallback}"))
        }
    }
}

pub fn terminate_owned_scope(
    pid: u32,
    id: u32,
    channel: Option<&str>,
    expected_creation: Option<u64>,
) -> Result<bool, String> {
    crate::pid::checked_pid(pid).map_err(|error| error.to_string())?;
    if FAIL_SCOPE_TERMINATION.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(format!(
            "terminating session {id} scope: injected InvalidArgs failure"
        ));
    }
    let Some(channel) = channel else {
        return Ok(false);
    };
    crate::paths::validate_channel(channel).map_err(|error| error.to_string())?;
    let Some(expected) = expected_creation else {
        return Ok(false);
    };
    if crate::pid::process_creation_token(pid) != Some(expected) {
        return Ok(false);
    }
    let contents = match std::fs::read_to_string(format!("/proc/{pid}/cgroup")) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("reading session {id} pid {pid} cgroup: {error}")),
    };
    let unit = owned_scope(&contents, channel, id);
    let Some(unit) = unit else {
        return Ok(false);
    };
    let connection = connection()?;
    let manager = manager(&connection)?;
    if crate::pid::process_creation_token(pid) != Some(expected) {
        return Err(format!(
            "session {id} pid {pid} changed before scope termination"
        ));
    }
    manager
        .call::<_, _, ()>("KillUnit", &(unit.as_str(), "all", libc::SIGKILL))
        .map_err(|error| format!("terminating session {id} scope {unit}: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapping_preserves_argv_environment_and_cwd() {
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf '%s' '$HOME %h'"]);
        command.cwd("/tmp/a directory");
        command.env("PANE_VALUE", "literal $HOME %h");
        command.env_remove("NO_COLOR");
        let original = command.get_argv().clone();
        wrap(&mut command, Path::new("/opt/houston-core"), "dev", 42);
        assert_eq!(&command.get_argv()[5..], original);
        assert_eq!(command.get_cwd().unwrap(), "/tmp/a directory");
        assert_eq!(command.get_env("PANE_VALUE").unwrap(), "literal $HOME %h");
        assert!(command.get_env("NO_COLOR").is_none());
        assert_eq!(command.get_argv()[2], "dev");
        assert_eq!(command.get_argv()[3], "42");
    }

    #[test]
    fn program_resolution_preserves_a_relative_executable_and_refuses_missing_commands() {
        use std::os::unix::fs::PermissionsExt;
        let project = tempfile::tempdir().unwrap();
        let executable = project.path().join("local-cli");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = portable_pty::CommandBuilder::new("local-cli");
        command.cwd(project.path());
        command.env("PATH", "");
        resolve_program(&mut command).unwrap();
        assert_eq!(command.get_argv()[0], executable.as_os_str());
        let mut missing = portable_pty::CommandBuilder::new("missing-cli");
        missing.cwd(project.path());
        missing.env("PATH", "");
        assert!(resolve_program(&mut missing)
            .unwrap_err()
            .to_string()
            .contains("missing-cli"));
    }

    #[test]
    fn scope_membership_requires_the_exact_unit() {
        assert!(self_in_scope(
            "0::/user.slice/app.slice/pane.scope\n",
            "pane.scope"
        ));
        assert!(!self_in_scope(
            "0::/user.slice/app.slice/other-pane.scope\n",
            "pane.scope"
        ));
        assert!(!self_in_scope(
            "0::/user.slice/app.slice/pane.scope/child\n",
            "pane.scope"
        ));
    }

    #[test]
    fn recorded_scope_cleanup_rejects_foreign_units_and_invalid_ids() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let contents = format!("0::/user.slice/houston-session-dev-42-{nonce}.scope\n");
        let unit = format!("houston-session-dev-42-{nonce}.scope");
        assert_eq!(owned_scope(&contents, "dev", 42), Some(unit.clone()));
        assert_eq!(owned_scope(&contents, "release", 42), None);
        assert_eq!(owned_scope(&contents, "dev", 41), None);
        assert!(stop_recorded_scope(&unit, "dev", 42).is_err());
        assert!(current_owned_scope("dev", 0).is_err());
        assert!(current_owned_scope("invalid/channel", 42).is_err());
    }

    #[test]
    fn bus_timeout_replies_cannot_trigger_an_unisolated_cli_fallback() {
        assert!(!definite_rejection("org.freedesktop.DBus.Error.NoReply"));
        assert!(!definite_rejection("org.freedesktop.DBus.Error.Timeout"));
        assert!(!definite_rejection("org.freedesktop.DBus.Error.TimedOut"));
        assert!(definite_rejection(
            "org.freedesktop.DBus.Error.ServiceUnknown"
        ));
        assert!(definite_rejection(
            "org.freedesktop.DBus.Error.PropertyReadOnly"
        ));
    }
}

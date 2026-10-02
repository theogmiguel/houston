use std::path::Path;
use std::process::Command;

// Keep an unavailable user manager from delaying the existing spawn fallback indefinitely.
const MANAGER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub fn start(command: &Command, channel: &str, log: &Path) -> Result<Option<String>, String> {
    use zbus::zvariant::{Fd, OwnedObjectPath, OwnedValue, Value};
    if !Path::new("/run/systemd/system").is_dir() {
        return Ok(None);
    }
    let inherited = std::env::vars_os()
        .map(|(key, value)| {
            let key = key
                .into_string()
                .map_err(|key| format!("environment key {key:?}: expected UTF-8"))?;
            let value = value
                .into_string()
                .map_err(|_| format!("environment value for {key:?}: expected UTF-8"))?;
            Ok((key, value))
        })
        .collect::<Result<_, String>>()?;
    let service = service_command(
        command,
        channel,
        &uuid::Uuid::new_v4().simple().to_string(),
        inherited,
    )?;
    let connection = zbus::blocking::connection::Builder::session()
        .and_then(|builder| builder.method_timeout(MANAGER_TIMEOUT).build())
        .map_err(|error| format!("user session bus unavailable: {error}"))?;
    let manager = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    )
    .map_err(|error| format!("user systemd manager unavailable: {error}"))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|error| format!("opening isolation log {}: {error}", log.display()))?;
    let cwd = match command.get_current_dir() {
        Some(path) => path.to_path_buf(),
        None => {
            std::env::current_dir().map_err(|error| format!("reading launch directory: {error}"))?
        }
    };
    let cwd = cwd
        .to_str()
        .ok_or_else(|| format!("launch directory {cwd:?}: expected UTF-8"))?;
    let properties = (|| -> zbus::zvariant::Result<Vec<(&str, OwnedValue)>> {
        Ok(vec![
            (
                "Description",
                OwnedValue::try_from(Value::new(format!("Houston daemon ({channel})")))?,
            ),
            ("Type", OwnedValue::try_from(Value::new("exec"))?),
            (
                "CollectMode",
                OwnedValue::try_from(Value::new("inactive-or-failed"))?,
            ),
            (
                "ExecStartEx",
                OwnedValue::try_from(Value::new(vec![(
                    service.program.clone(),
                    service.argv.clone(),
                    vec!["no-env-expand"],
                )]))?,
            ),
            (
                "Environment",
                OwnedValue::try_from(Value::new(service.environment.clone()))?,
            ),
            (
                "UnsetEnvironment",
                OwnedValue::try_from(Value::new(service.unset.clone()))?,
            ),
            ("WorkingDirectory", OwnedValue::try_from(Value::new(cwd))?),
            ("StandardInput", OwnedValue::try_from(Value::new("null"))?),
            (
                "StandardOutputFileDescriptor",
                OwnedValue::try_from(Value::new(Fd::from(&file)))?,
            ),
            (
                "StandardErrorFileDescriptor",
                OwnedValue::try_from(Value::new(Fd::from(&file)))?,
            ),
        ])
    })()
    .map_err(|error| format!("constructing transient service {}: {error}", service.unit))?;
    let auxiliary: Vec<(&str, Vec<(&str, OwnedValue)>)> = Vec::new();
    let result: Result<OwnedObjectPath, _> = manager.call(
        "StartTransientUnit",
        &(service.unit.as_str(), "fail", properties, auxiliary),
    );
    match result {
        Ok(_) => Ok(Some(service.unit)),
        // A timed-out request may already have queued the unit; readiness decides its outcome.
        Err(zbus::Error::InputOutput(error)) if error.kind() == std::io::ErrorKind::TimedOut => {
            Ok(Some(service.unit))
        }
        Err(error) => Err(format!(
            "StartTransientUnit for {} unavailable: {error}",
            service.unit
        )),
    }
}

#[derive(Debug)]
struct ServiceCommand {
    unit: String,
    program: String,
    argv: Vec<String>,
    environment: Vec<String>,
    unset: Vec<String>,
}

fn service_command(
    command: &Command,
    channel: &str,
    nonce: &str,
    mut inherited: std::collections::BTreeMap<String, String>,
) -> Result<ServiceCommand, String> {
    houston_core::paths::validate_channel(channel).map_err(|error| error.to_string())?;
    let program = command.get_program().to_str().ok_or_else(|| {
        format!(
            "program {:?}: expected a UTF-8 absolute path",
            command.get_program()
        )
    })?;
    if !Path::new(program).is_absolute() {
        return Err(format!("program {program:?}: expected an absolute path"));
    }
    let mut argv = vec![program.to_string()];
    for argument in command.get_args() {
        argv.push(
            argument
                .to_str()
                .ok_or_else(|| format!("argument {argument:?}: expected UTF-8"))?
                .to_string(),
        );
    }
    let mut unset = Vec::new();
    for (key, value) in command.get_envs() {
        let key = key
            .to_str()
            .ok_or_else(|| format!("environment key {key:?}: expected UTF-8"))?;
        match value {
            Some(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| format!("environment value for {key:?}: expected UTF-8"))?;
                inherited.insert(key.to_string(), value.to_string());
            }
            None => {
                inherited.remove(key);
                if valid_environment_name(key) {
                    unset.push(key.to_string());
                }
            }
        }
    }
    for (key, value) in &inherited {
        if !valid_environment_name(key) {
            return Err(format!(
                "environment key {key:?}: expected [A-Za-z_][A-Za-z0-9_]* for user systemd"
            ));
        }
        if value.chars().any(char::is_control) {
            return Err(format!(
                "environment value for {key:?}: expected printable UTF-8 for user systemd"
            ));
        }
    }
    Ok(ServiceCommand {
        unit: format!("houston-daemon-{channel}-{nonce}.service"),
        program: program.to_string(),
        argv,
        environment: inherited
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect(),
        unset,
    })
}

fn valid_environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_command_preserves_argv_channel_and_environment_removals() {
        let mut command = houston_core::spawn::command("/opt/houston/houston-supervisor");
        command
            .args([
                "--channel-dir",
                "/tmp/home with spaces/.houston-dev",
                "--",
                "--channel",
                "dev",
            ])
            .env("HOUSTON_CHANNEL", "dev")
            .env_remove("REMOVED");
        let inherited = [
            ("HOUSTON_CHANNEL".into(), "release".into()),
            ("REMOVED".into(), "1".into()),
        ]
        .into();
        let service = service_command(&command, "dev", "nonce", inherited).unwrap();
        assert_eq!(service.unit, "houston-daemon-dev-nonce.service");
        assert_eq!(service.argv[2], "/tmp/home with spaces/.houston-dev");
        assert_eq!(service.environment, ["HOUSTON_CHANNEL=dev"]);
        assert_eq!(service.unset, ["REMOVED"]);
        assert_ne!(
            service.unit,
            service_command(&command, "release", "nonce", Default::default())
                .unwrap()
                .unit
        );
    }

    #[test]
    fn unsupported_environment_names_and_values_name_the_fallback_reason() {
        let mut command = houston_core::spawn::command("/bin/true");
        let inherited = [("CARGO_BIN_EXE_houston-tauri".into(), "binary".into())].into();
        let error = service_command(&command, "dev", "nonce", inherited).unwrap_err();
        assert!(error.contains("CARGO_BIN_EXE_houston-tauri") && error.contains("expected"));
        command.env_remove("CARGO_BIN_EXE_houston-tauri");
        let inherited = [("CARGO_BIN_EXE_houston-tauri".into(), "binary".into())].into();
        let service = service_command(&command, "dev", "nonce", inherited).unwrap();
        assert!(service.environment.is_empty() && service.unset.is_empty());
        let inherited = [("CONTROL_VALUE".into(), "line\nline".into())].into();
        assert!(service_command(&command, "dev", "nonce", inherited)
            .unwrap_err()
            .contains("CONTROL_VALUE"));
    }

    #[test]
    fn relative_program_and_invalid_channel_require_fallback() {
        let command = houston_core::spawn::command("supervisor");
        assert!(
            service_command(&command, "dev", "nonce", Default::default())
                .unwrap_err()
                .contains("absolute path")
        );
        let command = houston_core::spawn::command("/bin/true");
        assert!(
            service_command(&command, "../bad", "nonce", Default::default())
                .unwrap_err()
                .contains("../bad")
        );
    }
}

pub fn fallback_reason(result: &Result<Option<String>, String>) -> Option<&str> {
    match result {
        Ok(Some(_)) => None,
        Ok(None) => Some("the host is not running systemd"),
        Err(reason) => Some(reason),
    }
}

#[cfg(test)]
mod fallback_tests {
    use super::*;

    #[test]
    fn accepted_unit_avoids_spawn_and_unavailable_manager_preserves_fallback_reason() {
        assert_eq!(fallback_reason(&Ok(Some("unit.service".into()))), None);
        assert_eq!(
            fallback_reason(&Ok(None)),
            Some("the host is not running systemd")
        );
        assert_eq!(
            fallback_reason(&Err("user manager unavailable".into())),
            Some("user manager unavailable")
        );
    }
}

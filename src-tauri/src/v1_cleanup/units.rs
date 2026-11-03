//! Stops a channel's v1 daemon and supervisor units. Houston 1 starts both in one transient
//! `houston-daemon-<channel>-<nonce>.service`, so stopping it stops the pair; only unit names
//! carrying this channel are touched. Tests inject the command runner and never run systemctl.

use crate::sys::spawn::command as spawn_command;
#[cfg(test)]
use std::path::Path;

const SYSTEMCTL: &str = "systemctl";
const UNIT_PREFIX: &str = "houston-daemon-";

/// What one stop attempt changed. `stopped` names the units whose stop succeeded.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StopReport {
    pub stopped: Vec<String>,
    pub notes: Vec<String>,
}

/// The outcome of one command the stopper ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Where the stopper runs `systemctl`; the host uses the process, tests use a fake.
pub trait CommandRunner {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, String>;
}

/// Runs the real `systemctl` from `PATH`.
pub struct ProcessCommands;

impl CommandRunner for ProcessCommands {
    fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, String> {
        let output = spawn_command(program)
            .args(args)
            .output()
            .map_err(|error| format!("running {program}: {error}"))?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Stops a channel's v1 units, or does nothing when no unit can be reached.
pub trait UnitStopper {
    fn stop(&self, channel: &str) -> StopReport;
    /// Whether a verified `daemon.json` pid may be signalled when no unit answered.
    fn may_signal_daemon(&self) -> bool {
        false
    }
}

/// The plain cleanup entry point: never touches systemd, so it is safe in tests.
#[cfg(test)]
pub struct Unavailable;

#[cfg(test)]
impl UnitStopper for Unavailable {
    fn stop(&self, _channel: &str) -> StopReport {
        StopReport::default()
    }
}

/// The v1 units under the current user's systemd manager.
pub struct Systemd<C: CommandRunner> {
    commands: C,
}

impl<C: CommandRunner> Systemd<C> {
    pub fn new(commands: C) -> Self {
        Self { commands }
    }

    /// Exactly this channel's units: the name must carry this channel's prefix and a 32-digit
    /// lowercase-hex nonce, so channel `dev` never matches `dev-extra`'s units.
    fn units(&self, channel: &str) -> Vec<String> {
        let prefix = format!("{UNIT_PREFIX}{channel}-");
        let pattern = format!("{prefix}*.service");
        let listed = self.commands.run(
            SYSTEMCTL,
            &[
                "--user",
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--plain",
                &pattern,
            ],
        );
        let Ok(output) = listed else {
            return Vec::new();
        };
        if !output.success {
            return Vec::new();
        }
        output
            .stdout
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .filter(|unit| unit.starts_with(&prefix) && unit.ends_with(".service"))
            .filter(|unit| {
                let nonce = &unit[prefix.len()..unit.len() - ".service".len()];
                // v1 names the nonce with `Uuid::new_v4().simple()`: 32 lowercase hex digits.
                nonce.len() == 32
                    && nonce
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
            .map(str::to_string)
            .collect()
    }
}

impl<C: CommandRunner> UnitStopper for Systemd<C> {
    fn stop(&self, channel: &str) -> StopReport {
        let mut report = StopReport::default();
        let mut disable_failed = Vec::new();
        for unit in self.units(channel) {
            match self.commands.run(SYSTEMCTL, &["--user", "stop", &unit]) {
                Ok(output) if output.success => report.stopped.push(unit.clone()),
                Ok(output) => report
                    .notes
                    .push(format!("could not stop {unit}: {}", output.stderr.trim())),
                Err(error) => report.notes.push(format!("could not stop {unit}: {error}")),
            }
            match self.commands.run(SYSTEMCTL, &["--user", "disable", &unit]) {
                Ok(output) if output.success => {}
                Ok(_) => disable_failed.push(unit),
                Err(_) => disable_failed.push(unit),
            }
        }
        if !disable_failed.is_empty() {
            report.notes.push(format!(
                "{} Houston 1 daemon unit(s) were transient, so stopping them removed them and \
                 there was nothing to disable",
                disable_failed.len()
            ));
        }
        report
    }

    fn may_signal_daemon(&self) -> bool {
        true
    }
}

/// Whether `path` names a v1 unit of `channel`; exposed so the stop rule is testable.
#[cfg(test)]
pub fn is_v1_unit(path: &Path, channel: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let prefix = format!("{UNIT_PREFIX}{channel}-");
            let Some(rest) = name.strip_prefix(&prefix) else {
                return false;
            };
            let Some(nonce) = rest.strip_suffix(".service") else {
                return false;
            };
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeCommands {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        list: String,
        stop_fails: bool,
        disable_fails: bool,
    }

    impl FakeCommands {
        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.borrow().clone()
        }
    }

    impl CommandRunner for FakeCommands {
        fn run(&self, program: &str, args: &[&str]) -> Result<CommandOutput, String> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|arg| arg.to_string()).collect(),
            ));
            let output = match args.get(1).copied() {
                Some("list-units") => CommandOutput {
                    success: true,
                    stdout: self.list.clone(),
                    stderr: String::new(),
                },
                Some("stop") if self.stop_fails => CommandOutput {
                    success: false,
                    stdout: String::new(),
                    stderr: "access denied".into(),
                },
                Some("disable") if self.disable_fails => CommandOutput {
                    success: false,
                    stdout: String::new(),
                    stderr: "Unit is transient.".into(),
                },
                _ => CommandOutput {
                    success: true,
                    stdout: String::new(),
                    stderr: String::new(),
                },
            };
            Ok(output)
        }
    }

    const DEV_NONCE: &str = "0123456789abcdef0123456789abcdef";
    const OTHER_NONCE: &str = "fedcba9876543210fedcba9876543210";
    const LIST: &str = "houston-daemon-dev-0123456789abcdef0123456789abcdef.service loaded active running Houston daemon (dev)";

    #[test]
    fn stops_and_disables_only_this_channels_units() {
        let commands = FakeCommands {
            list: LIST.into(),
            disable_fails: true,
            ..Default::default()
        };
        let report = Systemd::new(commands).stop("dev");
        assert_eq!(
            report.stopped,
            [format!("houston-daemon-dev-{DEV_NONCE}.service")]
        );
        assert!(
            report.notes.iter().any(|note| note.contains("transient")),
            "{:?}",
            report.notes
        );
    }

    #[test]
    fn the_unit_filter_names_the_channel_exactly() {
        assert!(is_v1_unit(
            Path::new(&format!("houston-daemon-dev-{DEV_NONCE}.service")),
            "dev"
        ));
        assert!(
            !is_v1_unit(
                Path::new(&format!("houston-daemon-dev-extra-{OTHER_NONCE}.service")),
                "dev"
            ),
            "a different channel whose name starts with this one is not this channel"
        );
        assert!(!is_v1_unit(
            Path::new(&format!("houston-daemon-release-{OTHER_NONCE}.service")),
            "dev"
        ));
    }

    #[test]
    fn a_list_command_failure_stops_nothing_and_names_no_unit() {
        let commands = FakeCommands::default();
        let report = Systemd::new(commands).stop("dev");
        assert!(report.stopped.is_empty());
        assert!(report.notes.is_empty());
    }

    #[test]
    fn a_stop_failure_is_named_and_does_not_count_as_stopped() {
        let commands = FakeCommands {
            list: format!("houston-daemon-dev-{DEV_NONCE}.service loaded active running\n"),
            stop_fails: true,
            ..Default::default()
        };
        let systemd = Systemd::new(commands);
        let report = systemd.stop("dev");
        assert!(report.stopped.is_empty());
        assert!(
            report
                .notes
                .iter()
                .any(|note| note.contains("access denied")),
            "{:?}",
            report.notes
        );
    }

    #[test]
    fn list_output_ignores_footers_and_other_services() {
        let commands = FakeCommands {
            list: format!(
                "houston-daemon-dev-{DEV_NONCE}.service loaded active running\n\n\
                 \n3 loaded units listed.\n"
            ),
            ..Default::default()
        };
        let report = Systemd::new(commands).stop("dev");
        assert_eq!(
            report.stopped,
            [format!("houston-daemon-dev-{DEV_NONCE}.service")]
        );
    }

    #[test]
    fn every_command_names_systemctl_and_the_exact_unit_or_pattern() {
        let commands = FakeCommands {
            list: format!("houston-daemon-dev-{DEV_NONCE}.service loaded active running\n"),
            ..Default::default()
        };
        let calls = {
            let systemd = Systemd::new(commands);
            systemd.stop("dev");
            systemd.commands.calls()
        };
        let expected: Vec<Vec<String>> = vec![
            vec![
                "--user",
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--plain",
                "houston-daemon-dev-*.service",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            vec![
                "--user".to_string(),
                "stop".to_string(),
                format!("houston-daemon-dev-{DEV_NONCE}.service"),
            ],
            vec![
                "--user".to_string(),
                "disable".to_string(),
                format!("houston-daemon-dev-{DEV_NONCE}.service"),
            ],
        ];
        assert_eq!(
            calls,
            expected
                .into_iter()
                .map(|args| (SYSTEMCTL.to_string(), args))
                .collect::<Vec<_>>()
        );
    }
}

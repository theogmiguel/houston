//! Reject cold replacement while the recorded PTY root still owns work.
//!
//! A missing root does not establish that escaped descendants have terminated.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessIdentity {
    version: u8,
    pid: u32,
    creation: u64,
    system: String,
    #[serde(default)]
    ownership: Option<Ownership>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ownership {
    LinuxScope { unit: String, cgroup: String },
    Uncontained { reason: String },
}

impl ProcessIdentity {
    pub fn capture(pid: Option<u32>) -> Result<Option<Self>> {
        let Some(pid) = pid else { return Ok(None) };
        let Some(system) = system_identity()? else {
            return Ok(None);
        };
        let Some(creation) = crate::pid::process_creation_token(pid) else {
            anyhow::ensure!(!crate::pid::process_is_alive(pid),
                "cannot record creation identity for live PTY process {pid}; refusing untracked recovery");
            return Ok(None);
        };
        Ok(Some(Self {
            version: 2,
            pid,
            creation,
            system,
            ownership: Some(Ownership::Uncontained {
                reason: if cfg!(windows) {
                    "Windows ConPTY has no committed pre-exec Job ownership proof".into()
                } else {
                    "launch has no verified session scope".into()
                },
            }),
        }))
    }

    pub fn with_ownership(mut self, ownership: Ownership) -> Self {
        self.ownership = Some(ownership);
        self
    }

    pub fn verify_root(&self, pid: u32) -> Result<()> {
        anyhow::ensure!(
            self.version == 2
                && self.pid == pid
                && Some(self.creation) == crate::pid::process_creation_token(pid)
                && Some(&self.system) == system_identity()?.as_ref(),
            "pre-exec ownership receipt does not identify the spawned process {pid}"
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn verify_scope_receipt(&self, expected: &str, pid: u32) -> Result<()> {
        match &self.ownership {
            Some(Ownership::LinuxScope { unit, cgroup }) => {
                anyhow::ensure!(
                    unit == expected,
                    "ownership scope nonce mismatch: expected {expected}, received {unit}"
                );
                let contents = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))?;
                anyhow::ensure!(
                    contents
                        .lines()
                        .any(|line| line.strip_prefix("0::") == Some(cgroup.as_str())),
                    "pre-exec process {pid} is not a member of recorded scope {unit}"
                );
                Ok(())
            }
            Some(Ownership::Uncontained { .. }) => Ok(()),
            None => bail!("pre-exec helper returned no ownership boundary"),
        }
    }

    pub fn check_acknowledgeable(&self) -> Result<()> {
        anyhow::ensure!(
            !matches!(self.ownership, Some(Ownership::LinuxScope { .. })),
            "a contained session requires verified scope quiescence; acknowledgement cannot bypass it"
        );
        self.check_root_stopped()
    }

    pub fn uncontained_reason(&self) -> Option<&str> {
        match &self.ownership {
            Some(Ownership::LinuxScope { .. }) => None,
            Some(Ownership::Uncontained { reason }) => Some(reason),
            None => Some("legacy session has no complete ownership receipt"),
        }
    }

    pub fn is_contained(&self) -> bool {
        matches!(self.ownership, Some(Ownership::LinuxScope { .. }))
    }

    pub fn check_stopped(&self) -> Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(Ownership::LinuxScope { unit, cgroup }) = &self.ownership {
            crate::session_isolation::validate_scope_receipt(unit, cgroup)
                .map_err(anyhow::Error::msg)?;
        }
        self.check_root_stopped()?;
        let current = system_identity()?.context("boot identity unavailable")?;
        if self.system.starts_with("linux:")
            && current.starts_with("linux:")
            && self.system != current
        {
            return Ok(());
        }
        match &self.ownership {
            #[cfg(target_os = "linux")]
            Some(Ownership::LinuxScope { unit, cgroup }) => {
                crate::session_isolation::check_scope_stopped(unit, cgroup).map_err(anyhow::Error::msg)
            }
            Some(Ownership::Uncontained { reason }) => bail!("Process ownership unknown: {reason}. Stop all previous workload processes, then explicitly acknowledge uncontained recovery; session, conversation and pending missions are retained."),
            _ => bail!("Process ownership unknown: legacy session has no complete ownership receipt. Recheck, or stop all previous workload processes and explicitly acknowledge uncontained recovery; session, conversation and pending missions are retained."),
        }
    }

    fn check_root_stopped(&self) -> Result<()> {
        let system = system_identity()?
            .context("process recovery identity is unavailable on this platform")?;
        self.check_observation(
            &system,
            crate::pid::process_creation_token(self.pid),
            crate::pid::process_is_alive(self.pid),
        )
    }

    fn check_observation(&self, system: &str, creation: Option<u64>, alive: bool) -> Result<()> {
        anyhow::ensure!((self.version == 1 || self.version == 2) && self.pid > 0 && self.pid <= i32::MAX as u32,
            "invalid recovery process identity version {} / pid {}; expected version 1 or 2 and a positive process ID", self.version, self.pid);
        anyhow::ensure!(
            self.version != 2 || self.ownership.is_some(),
            "invalid recovery receipt version 2: expected an explicit ownership boundary"
        );
        if let Some(boot) = self.system.strip_prefix("linux:") {
            uuid::Uuid::parse_str(boot).context("invalid recorded Linux boot identity")?;
        } else {
            anyhow::ensure!(
                self.system == "windows",
                "invalid recorded process platform {}",
                self.system
            );
        }
        if self.system != system {
            // Linux start ticks repeat across boots; the boot UUID must match too.
            anyhow::ensure!(
                self.system.starts_with("linux:") && system.starts_with("linux:"),
                "recovery process {} belongs to a different platform",
                self.pid
            );
            return Ok(());
        }
        if !alive || creation.is_some_and(|current| current != self.creation) {
            return Ok(());
        }
        bail!("Previous PTY process {} is still present; replacement is refused to avoid running the conversation twice. Stop that previous process or reboot, then retry. Houston has not signalled it.", self.pid)
    }
}

fn system_identity() -> Result<Option<String>> {
    #[cfg(target_os = "linux")]
    {
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .context("reading Linux boot identity for session recovery")?;
        let boot = uuid::Uuid::parse_str(boot.trim()).context("invalid Linux boot identity")?;
        Ok(Some(format!("linux:{boot}")))
    }
    #[cfg(windows)]
    {
        // GetProcessTimes returns an absolute FILETIME, not ticks reset at boot.
        Ok(Some("windows".into()))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded() -> ProcessIdentity {
        ProcessIdentity {
            version: 1,
            pid: 42,
            creation: 70,
            system: "linux:00000000-0000-4000-8000-000000000001".into(),
            ownership: None,
        }
    }

    #[test]
    fn matching_or_unreadable_live_identity_refuses_replacement() {
        assert!(recorded()
            .check_observation("linux:00000000-0000-4000-8000-000000000001", Some(70), true)
            .is_err());
        assert!(recorded()
            .check_observation("linux:00000000-0000-4000-8000-000000000001", None, true)
            .is_err());
    }

    #[test]
    fn dead_recycled_or_previous_boot_root_does_not_block() {
        assert!(recorded()
            .check_observation(
                "linux:00000000-0000-4000-8000-000000000001",
                Some(70),
                false
            )
            .is_ok());
        assert!(recorded()
            .check_observation("linux:00000000-0000-4000-8000-000000000001", Some(71), true)
            .is_ok());
        assert!(recorded()
            .check_observation("linux:00000000-0000-4000-8000-000000000002", Some(70), true)
            .is_ok());
    }

    #[test]
    fn invalid_identity_and_cross_platform_import_refuse() {
        assert!(recorded()
            .check_observation("windows", Some(70), true)
            .is_err());
        let mut identity = recorded();
        identity.pid = u32::MAX;
        assert!(identity
            .check_observation("linux:00000000-0000-4000-8000-000000000001", None, false)
            .is_err());
    }

    #[test]
    fn current_process_is_detected_without_signalling_it() {
        if let Some(identity) = ProcessIdentity::capture(Some(std::process::id())).unwrap() {
            assert!(identity.check_stopped().is_err());
        }
    }
}

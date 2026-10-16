//! Reclaims a pane's previous workload by its receipt: the nonce-bearing scope unit, else
//! the root's PID, creation token and boot identity, never a name or path. See the cold
//! recovery paragraphs under "Spawning a session" in docs/internals/daemon.md.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

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

    pub fn uncontained_reason(&self) -> Option<&str> {
        match &self.ownership {
            Some(Ownership::LinuxScope { .. }) => None,
            Some(Ownership::Uncontained { reason }) => Some(reason),
            None => Some("legacy session has no complete ownership receipt"),
        }
    }

    /// Stops whatever the recorded workload left running, before the pane is replaced.
    /// The caller holds the channel lock, so no other daemon can own this pane.
    pub fn reclaim(&self, channel: &str, id: u32) -> Result<()> {
        let current = system_identity()?
            .context("process recovery identity is unavailable on this platform")?;
        if !self.same_system(&current)? {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if let Some(Ownership::LinuxScope { unit, cgroup }) = &self.ownership {
            use crate::session_isolation::ReclaimError;
            match crate::session_isolation::reclaim_scope(unit, cgroup, channel, id) {
                Ok(()) => {}
                Err(ReclaimError::Unavailable(reason)) => tracing::warn!(
                    "session {id}: cannot stop previous workload scope {unit} ({reason}); \
                     stopping its recorded PTY root only"
                ),
                Err(ReclaimError::Refused(reason)) => bail!("{reason}"),
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (channel, id);
        if self.root_state(
            crate::pid::process_creation_token(self.pid),
            root_running(self.pid),
        )? == Root::Live
        {
            self.stop_root()?;
        }
        Ok(())
    }

    fn same_system(&self, system: &str) -> Result<bool> {
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
            return Ok(false);
        }
        Ok(true)
    }

    fn root_state(&self, creation: Option<u64>, running: bool) -> Result<Root> {
        match creation {
            _ if !running => Ok(Root::Gone),
            Some(current) if current != self.creation => Ok(Root::Gone),
            Some(_) => Ok(Root::Live),
            None => bail!(
                "previous PTY root {} is running but its creation identity is unreadable; \
                 expected creation token {} to verify it before stopping it",
                self.pid,
                self.creation
            ),
        }
    }

    fn live(&self) -> bool {
        root_running(self.pid)
            && crate::pid::process_creation_token(self.pid) == Some(self.creation)
    }

    fn stop_root(&self) -> Result<()> {
        use crate::pid::{signal_process_checked_identity, Signal};
        let pid = self.pid;
        anyhow::ensure!(
            pid != std::process::id(),
            "previous PTY root {pid} is this daemon; refusing to signal it"
        );
        tracing::info!("stopping previous PTY root {pid} left by an earlier daemon");
        signal_process_checked_identity(pid, Signal::Term, Some(self.creation))
            .with_context(|| format!("terminating previous PTY root {pid}"))?;
        if self.wait_gone(ROOT_TERM_GRACE) {
            return Ok(());
        }
        // The root leads its PTY session; its process group holds the CLI's foreground work.
        #[cfg(unix)]
        crate::pid::terminate_pty_session(pid, None, Some(self.creation))
            .with_context(|| format!("killing previous PTY root {pid}"))?;
        #[cfg(windows)]
        signal_process_checked_identity(pid, Signal::Kill, Some(self.creation))
            .with_context(|| format!("killing previous PTY root {pid}"))?;
        anyhow::ensure!(
            self.wait_gone(ROOT_KILL_WAIT),
            "previous PTY root {pid} still runs {} ms after SIGKILL (limit {} ms); replacement deferred",
            ROOT_KILL_WAIT.as_millis(),
            ROOT_KILL_WAIT.as_millis()
        );
        Ok(())
    }

    fn wait_gone(&self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            if !self.live() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Root {
    Gone,
    Live,
}

// CLIs persist their conversation on SIGTERM well within this; interactive shells ignore
// SIGTERM, so it also bounds the wait before SIGKILL.
const ROOT_TERM_GRACE: Duration = Duration::from_secs(2);
// SIGKILL is immediate; the bound reports an unkillable (uninterruptible) root instead of
// hanging restore.
const ROOT_KILL_WAIT: Duration = Duration::from_secs(2);

// A zombie has exited; only its reaper's wait remains.
fn root_running(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rfind(')')
            .and_then(|end| {
                stat[end + 1..]
                    .split_whitespace()
                    .next()
                    .map(|state| state == "Z")
            })
            .unwrap_or(false)
    }) {
        return false;
    }
    crate::pid::process_is_alive(pid)
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

    const BOOT: &str = "linux:00000000-0000-4000-8000-000000000001";

    #[test]
    fn only_a_running_root_with_the_recorded_creation_is_live() {
        assert_eq!(recorded().root_state(Some(70), true).unwrap(), Root::Live);
        assert_eq!(recorded().root_state(Some(70), false).unwrap(), Root::Gone);
        assert_eq!(recorded().root_state(Some(71), true).unwrap(), Root::Gone);
        assert_eq!(recorded().root_state(None, false).unwrap(), Root::Gone);
        let error = recorded().root_state(None, true).unwrap_err().to_string();
        assert!(error.contains("42") && error.contains("70"), "{error}");
    }

    #[test]
    fn a_previous_boot_needs_no_reclaim() {
        assert!(recorded().same_system(BOOT).unwrap());
        assert!(!recorded()
            .same_system("linux:00000000-0000-4000-8000-000000000002")
            .unwrap());
    }

    #[test]
    fn invalid_identity_and_cross_platform_import_refuse() {
        assert!(recorded().same_system("windows").is_err());
        let mut identity = recorded();
        identity.pid = u32::MAX;
        assert!(identity.same_system(BOOT).is_err());
        let mut identity = recorded();
        identity.version = 2;
        assert!(identity.same_system(BOOT).is_err(), "v2 requires ownership");
    }

    #[test]
    fn the_daemon_never_reclaims_itself() {
        if let Some(identity) = ProcessIdentity::capture(Some(std::process::id())).unwrap() {
            let error = identity.reclaim("dev", 7).unwrap_err().to_string();
            assert!(error.contains("this daemon"), "{error}");
        }
    }
}

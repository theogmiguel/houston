use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::common;
use houston_protocol as proto;

/// A fake `codex` on an otherwise empty PATH: `--version` counts its runs in `calls.txt`,
/// prints `version.txt`, and first sleeps 3 s while `slow` exists.
struct FakeCli {
    dir: tempfile::TempDir,
}

impl FakeCli {
    fn new(version: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.path().join("codex");
            std::fs::write(
                &path,
                "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\nd=${0%/*}\necho x >> \"$d/calls.txt\"\n\
                 [ -e \"$d/slow\" ] && /bin/sleep 3\nread -r v < \"$d/version.txt\"\necho \"$v\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        std::fs::write(
            dir.path().join("codex.cmd"),
            "@echo off\r\nif not \"%~1\"==\"--version\" exit /b 1\r\necho x>>\"%~dp0calls.txt\"\r\n\
             if exist \"%~dp0slow\" \"%SystemRoot%\\System32\\ping.exe\" -n 4 127.0.0.1 >nul\r\n\
             type \"%~dp0version.txt\"\r\n",
        )
        .unwrap();
        let cli = Self { dir };
        cli.set_version(version);
        cli
    }

    fn set_version(&self, version: &str) {
        std::fs::write(self.dir.path().join("version.txt"), format!("{version}\n")).unwrap();
    }

    fn set_slow(&self) {
        std::fs::write(self.dir.path().join("slow"), "").unwrap();
    }

    fn calls(&self) -> usize {
        std::fs::read_to_string(self.dir.path().join("calls.txt"))
            .map(|calls| calls.lines().count())
            .unwrap_or(0)
    }

    /// PATH holding only this CLI (and, on Windows, System32 for `cmd.exe` and `ping`).
    fn env(&self) -> houston_core::host_env::HostEnv {
        let mut dirs: Vec<PathBuf> = vec![self.dir.path().to_path_buf()];
        #[cfg(windows)]
        dirs.push(Path::new(&common::process_var("SystemRoot").unwrap()).join("System32"));
        let path = std::env::join_paths(dirs).unwrap();
        common::base_env().with("PATH", Some(path))
    }

    async fn wait_for_calls(&self, calls: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while self.calls() < calls {
            assert!(
                Instant::now() < deadline,
                "codex --version ran {} times; expected {calls}",
                self.calls()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn codex(rows: &[proto::AgentHookState]) -> &proto::AgentHookState {
    rows.iter()
        .find(|row| row.provider == proto::AgentKind::Codex)
        .unwrap_or_else(|| panic!("no codex row in {rows:#?}"))
}

/// A rescan probes without holding the cache: a listing (and a spawn reading the Claude
/// version) meanwhile answers from the last sweep instead of waiting behind the probe.
#[tokio::test]
async fn a_listing_during_a_rescan_answers_from_the_last_sweep() {
    let cli = FakeCli::new("1.0.0");
    let (_addr, _state, daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    let rows = daemon.agent_hooks_state();
    assert_eq!(codex(&rows).version.as_deref(), Some("1.0.0"));

    cli.set_version("2.0.0");
    cli.set_slow();
    let rescan = tokio::task::spawn_blocking({
        let daemon = daemon.clone();
        move || daemon.agent_hooks_state_rescanned()
    });
    cli.wait_for_calls(2).await;

    let started = Instant::now();
    let during = tokio::task::spawn_blocking({
        let daemon = daemon.clone();
        move || daemon.agent_hooks_state()
    })
    .await
    .unwrap();
    let waited = started.elapsed();
    assert!(
        waited < Duration::from_millis(1500),
        "a listing waited {waited:?} behind a 3 s probe"
    );
    assert_eq!(codex(&during).version.as_deref(), Some("1.0.0"));

    let after = rescan.await.unwrap();
    assert_eq!(codex(&after).version.as_deref(), Some("2.0.0"));
    assert_eq!(
        cli.calls(),
        2,
        "the listing during the rescan probed nothing"
    );
}

async fn wait_until_primed(daemon: &houston_core::daemon::Daemon) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !daemon.cli_probes_primed() {
        assert!(Instant::now() < deadline, "the boot prime never finished");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The boot prime probes each CLI once, so the first listing (and the first spawn's
/// Claude version) runs no `--version` of its own.
#[tokio::test]
async fn the_boot_prime_answers_the_first_listing_without_a_probe() {
    let cli = FakeCli::new("1.0.0");
    let (_addr, _state, daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    assert!(
        !daemon.cli_probes_primed(),
        "a new daemon has answered nothing"
    );
    houston_core::boot::spawn_cli_probe_prime(&daemon);
    wait_until_primed(&daemon).await;
    assert_eq!(cli.calls(), 1);

    let rows = daemon.agent_hooks_state();
    assert_eq!(codex(&rows).version.as_deref(), Some("1.0.0"));
    assert!(codex(&rows).present, "{rows:#?}");
    assert_eq!(cli.calls(), 1, "the listing ran a probe of its own");
}

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::common;
use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

/// Fake CLIs on an otherwise empty PATH: `--version` logs the CLI's name to `calls.txt`,
/// prints `version.txt`, and first sleeps 3 s while `slow-<name>` exists.
struct FakeCli {
    dir: tempfile::TempDir,
}

impl FakeCli {
    /// A fake `codex` printing `version`.
    fn new(version: &str) -> Self {
        let cli = Self::empty(version);
        cli.install("codex");
        cli
    }

    fn empty(version: &str) -> Self {
        let cli = Self {
            dir: tempfile::tempdir().unwrap(),
        };
        cli.set_version(version);
        cli
    }

    fn install(&self, name: &str) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = self.dir.path().join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\nd=${0%/*}\nn=${0##*/}\n\
                 echo \"$n\" >> \"$d/calls.txt\"\n[ -e \"$d/slow-$n\" ] && /bin/sleep 3\n\
                 read -r v < \"$d/version.txt\"\necho \"$v\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        std::fs::write(
            self.dir.path().join(format!("{name}.cmd")),
            "@echo off\r\nif not \"%~1\"==\"--version\" exit /b 1\r\necho %~n0>>\"%~dp0calls.txt\"\r\n\
             if exist \"%~dp0slow-%~n0\" \"%SystemRoot%\\System32\\ping.exe\" -n 4 127.0.0.1 >nul\r\n\
             type \"%~dp0version.txt\"\r\n",
        )
        .unwrap();
    }

    fn set_version(&self, version: &str) {
        std::fs::write(self.dir.path().join("version.txt"), format!("{version}\n")).unwrap();
    }

    fn set_slow(&self) {
        self.set_slow_for("codex");
    }

    fn set_slow_for(&self, name: &str) {
        std::fs::write(self.dir.path().join(format!("slow-{name}")), "").unwrap();
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
                "fake CLIs ran --version {} times; expected {calls}",
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

async fn request_agent_hooks(ws: &mut common::WsStream) {
    let msg = serde_json::to_string(&proto::ClientMsg::AgentHooks).unwrap();
    ws.send(Message::text(msg)).await.unwrap();
}

/// The next hooks listing sent to this client within `wait`, skipping other messages.
async fn next_agent_hooks(
    ws: &mut common::WsStream,
    wait: Duration,
) -> Option<Vec<proto::AgentHookState>> {
    let deadline = Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, ws.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(Message::Text(text)))) => {
                if let Ok(proto::ServerMsg::AgentHooks { providers }) = serde_json::from_str(&text)
                {
                    return Some(providers);
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("the socket ended while awaiting agent_hooks: {other:?}"),
        }
    }
}

async fn primed_daemon(
    cli: &FakeCli,
) -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<houston_core::daemon::Daemon>,
) {
    let (addr, state, daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    houston_core::boot::spawn_cli_probe_prime(&daemon);
    wait_until_primed(&daemon).await;
    (addr, state, daemon)
}

/// A primed daemon answers the hooks request from its cache at once; the rescan behind
/// it sends the listing again because the CLI changed meanwhile.
#[tokio::test]
async fn a_primed_listing_replies_at_once_and_again_when_the_rescan_finds_a_change() {
    let cli = FakeCli::new("1.0.0");
    let (addr, _state, _daemon) = primed_daemon(&cli).await;
    cli.set_version("2.0.0");
    cli.set_slow();
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;

    let started = Instant::now();
    request_agent_hooks(&mut ws).await;
    let first = next_agent_hooks(&mut ws, Duration::from_secs(10))
        .await
        .expect("a first listing");
    let waited = started.elapsed();
    assert!(
        waited < Duration::from_millis(1500),
        "the cached listing waited {waited:?} for a 3 s probe"
    );
    assert_eq!(codex(&first).version.as_deref(), Some("1.0.0"));

    let second = next_agent_hooks(&mut ws, Duration::from_secs(20))
        .await
        .expect("the rescan's changed listing");
    assert_eq!(codex(&second).version.as_deref(), Some("2.0.0"));
    assert_eq!(cli.calls(), 2, "one prime and one rescan");
}

#[tokio::test]
async fn a_rescan_that_changes_nothing_sends_no_second_listing() {
    let cli = FakeCli::new("1.0.0");
    let (addr, _state, _daemon) = primed_daemon(&cli).await;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    request_agent_hooks(&mut ws).await;
    let first = next_agent_hooks(&mut ws, Duration::from_secs(10))
        .await
        .expect("a first listing");
    assert_eq!(codex(&first).version.as_deref(), Some("1.0.0"));
    cli.wait_for_calls(2).await;
    let extra = next_agent_hooks(&mut ws, Duration::from_millis(1500)).await;
    assert_eq!(extra, None, "an unchanged rescan was sent again");
}

/// Before any sweep finished, the reply waits for the probe: one complete listing,
/// never one that lists a CLI as unknown.
#[tokio::test]
async fn an_unprimed_listing_replies_once_after_the_probe() {
    let cli = FakeCli::new("1.0.0");
    cli.set_slow();
    let (addr, _state, _daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    request_agent_hooks(&mut ws).await;
    let only = next_agent_hooks(&mut ws, Duration::from_secs(20))
        .await
        .expect("a listing");
    let row = codex(&only);
    assert!(row.present, "{row:#?}");
    assert_eq!(row.version.as_deref(), Some("1.0.0"));
    assert_eq!(cli.calls(), 1);
    let extra = next_agent_hooks(&mut ws, Duration::from_millis(1500)).await;
    assert_eq!(extra, None, "a cold request answers once");
}

/// Reconnect bursts cannot stack sweeps: requests arriving while one runs share the next.
#[tokio::test]
async fn a_burst_of_hooks_requests_costs_at_most_two_sweeps() {
    let cli = FakeCli::new("1.0.0");
    cli.set_slow();
    let (addr, _state, _daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    for _ in 0..5 {
        request_agent_hooks(&mut ws).await;
    }
    for reply in 0..5 {
        let listing = next_agent_hooks(&mut ws, Duration::from_secs(20))
            .await
            .unwrap_or_else(|| panic!("reply {reply} of 5 never came"));
        assert_eq!(codex(&listing).version.as_deref(), Some("1.0.0"));
    }
    assert!(
        cli.calls() <= 2,
        "five requests ran {} sweeps; the running one and one after it at most",
        cli.calls()
    );
}

/// A request made while a sweep runs is answered by a sweep that starts after it, so a CLI
/// installed after the running sweep probed for it is listed.
#[tokio::test]
async fn a_request_during_a_sweep_lists_a_cli_installed_after_that_sweep_probed_it() {
    let cli = FakeCli::empty("1.0.0");
    cli.install("opencode");
    cli.set_slow_for("opencode");
    let (addr, _state, daemon) = common::start_daemon_with_handle_in(cli.env()).await;
    houston_core::boot::spawn_cli_probe_prime(&daemon);
    cli.wait_for_calls(1).await;

    cli.install("codex");
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    request_agent_hooks(&mut ws).await;
    let listing = next_agent_hooks(&mut ws, Duration::from_secs(30))
        .await
        .expect("a listing");
    let row = codex(&listing);
    assert!(
        row.present,
        "the request was answered by the sweep before it: {row:#?}"
    );
    assert_eq!(row.version.as_deref(), Some("1.0.0"));
}

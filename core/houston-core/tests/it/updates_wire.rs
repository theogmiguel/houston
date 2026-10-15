use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn scheduled_cycle_honors_a_persisted_disabled_policy() {
    let (_addr, dir, daemon) = start_daemon_without_mail_loop().await;
    let connection = rusqlite::Connection::open(dir.path().join("test.db")).unwrap();
    connection
        .execute(
            "INSERT INTO settings (key, value) VALUES ('updates_check', '0')",
            [],
        )
        .unwrap();
    assert_eq!(daemon.update_state(), proto::UpdateState::Unknown);

    let loop_task = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.update_check_loop().await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while daemon.update_state() != proto::UpdateState::Disabled {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("scheduled cycle did not apply the disabled policy");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(daemon.update_state(), proto::UpdateState::Disabled);
    loop_task.abort();
}

// The check is off, so `check_for_update` must return before it builds a client at all.
// `Disabled` is the discriminator: any request, reachable or not, moves the state through
// `Checking` to `UpToDate` or `Failed`, and none of those can be reached from here.
#[tokio::test]
async fn the_setting_off_means_the_check_makes_no_request() {
    let (_addr, _dir, daemon) = start_daemon_without_mail_loop().await;

    daemon
        .update_policy_set(proto::UpdatePolicy { check: false })
        .unwrap();
    assert_eq!(daemon.update_state(), proto::UpdateState::Disabled);

    daemon.check_for_update().await;
    assert_eq!(
        daemon.update_state(),
        proto::UpdateState::Disabled,
        "a check with the setting off must leave the state Disabled, never Checking or Failed"
    );
}

#[tokio::test]
async fn the_policy_defaults_to_on_and_survives_a_round_trip() {
    let (_addr, _dir, daemon) = start_daemon_without_mail_loop().await;

    assert!(
        daemon.update_policy().check,
        "an absent setting row reads as on"
    );

    daemon
        .update_policy_set(proto::UpdatePolicy { check: false })
        .unwrap();
    assert!(!daemon.update_policy().check);

    daemon
        .update_policy_set(proto::UpdatePolicy { check: true })
        .unwrap();
    assert!(daemon.update_policy().check);
    assert_eq!(
        daemon.update_state(),
        proto::UpdateState::Unknown,
        "turning it back on forgets Disabled rather than showing it under an enabled setting"
    );
}

#[tokio::test]
async fn update_get_answers_with_policy_and_state_together() {
    let (addr, _dir, _daemon) = start_daemon_without_mail_loop().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::UpdateGet).unwrap();
    ws.send(Message::text(msg)).await.unwrap();

    loop {
        if let proto::ServerMsg::Update { policy, state } = next_control(&mut ws).await {
            assert!(policy.check, "the default policy rides the reply");
            assert_eq!(
                state,
                proto::UpdateState::Unknown,
                "a daemon whose loop has not run yet has never asked"
            );
            return;
        }
    }
}

// Turning the check off refuses to keep answering `update_get` with a live offer.
#[tokio::test]
async fn update_policy_set_off_is_broadcast_as_disabled() {
    let (addr, _dir, _daemon) = start_daemon_without_mail_loop().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello_ok = next_control(&mut ws).await;

    let msg = serde_json::to_string(&proto::ClientMsg::UpdatePolicySet {
        policy: proto::UpdatePolicy { check: false },
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();

    loop {
        if let proto::ServerMsg::Update { policy, state } = next_control(&mut ws).await {
            assert!(!policy.check);
            assert_eq!(state, proto::UpdateState::Disabled);
            return;
        }
    }
}

// `.cargo/config.toml` points both endpoints at a dead port for every test process, and
// `hermetic_command` clears the environment. Losing the forwarding would let a spawned
// daemon reach the real manifest and catalog.
#[test]
fn hermetic_command_forwards_the_offline_endpoints() {
    let home = tempfile::tempdir().unwrap();
    let cmd = hermetic_command("true", home.path());
    for name in [
        houston_core::updates::UPDATE_MANIFEST_URL_ENV,
        houston_core::model_catalog::CATALOG_URL_ENV,
    ] {
        let expected = std::env::var_os(name)
            .unwrap_or_else(|| panic!("{name} is unset in the test process; expected the offline endpoint from .cargo/config.toml"));
        let forwarded = cmd
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new(name))
            .and_then(|(_, value)| value);
        assert_eq!(
            forwarded,
            Some(expected.as_os_str()),
            "{name} not forwarded"
        );
    }
}

// A booted daemon makes one update check and one catalog refresh; a local listener proves
// the overrides reach the spawned binary. Unix only, like the other spawned-daemon suites:
// `hermetic_command` drops `SystemRoot` on Windows, so Winsock fails to initialise.
#[cfg(unix)]
#[tokio::test]
async fn a_spawned_daemon_requests_both_configured_endpoints() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (paths_tx, mut paths_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let paths_tx = paths_tx.clone();
            tokio::spawn(async move {
                let mut request = vec![0; 4096];
                let read = stream.read(&mut request).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]).into_owned();
                let path = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                let _ = paths_tx.send(path);
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            });
        }
    });

    let home = tempfile::tempdir().unwrap();
    let mut cmd = hermetic_command(env!("CARGO_BIN_EXE_houston-core"), home.path());
    cmd.env("HOUSTON_CHANNEL", "dev")
        .env(
            houston_core::updates::UPDATE_MANIFEST_URL_ENV,
            format!("{base}/manifest/latest.json"),
        )
        .env(
            houston_core::model_catalog::CATALOG_URL_ENV,
            format!("{base}/catalog/prices.json"),
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().expect("spawn houston-core");

    let mut seen = Vec::new();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while !(seen.contains(&"/manifest/latest.json".to_string())
            && seen.contains(&"/catalog/prices.json".to_string()))
        {
            seen.push(paths_rx.recv().await.expect("listener closed"));
        }
    })
    .await;

    houston_core::pid::signal_process(child.id(), houston_core::pid::Signal::Term)
        .expect("signalling the spawned daemon");
    let _ = child.wait();
    assert!(
        outcome.is_ok(),
        "the daemon never asked both configured endpoints; requests seen: {seen:?}"
    );
}

mod common;

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

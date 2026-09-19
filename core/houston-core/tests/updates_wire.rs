mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

// The check is off, so `check_for_update` must return before it builds a client at all.
// `Disabled` is the discriminator: any request, reachable or not, moves the state through
// `Checking` to `UpToDate` or `Failed`, and none of those can be reached from here.
#[tokio::test]
async fn the_setting_off_means_the_check_makes_no_request() {
    let (_addr, _dir, daemon) = start_daemon_without_mail_loop().await;

    daemon
        .update_policy_set(proto::UpdatePolicy {
            check: false,
            channel: proto::UpdateChannel::Stable,
        })
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
        .update_policy_set(proto::UpdatePolicy {
            check: false,
            channel: proto::UpdateChannel::Stable,
        })
        .unwrap();
    assert!(!daemon.update_policy().check);

    daemon
        .update_policy_set(proto::UpdatePolicy {
            check: true,
            channel: proto::UpdateChannel::Stable,
        })
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
        policy: proto::UpdatePolicy {
            check: false,
            channel: proto::UpdateChannel::Stable,
        },
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

// An answer found on one channel is not an answer about the other, so moving the
// channel while the check stays on drops it back to `Unknown`.
#[tokio::test]
async fn changing_channel_while_checked_drops_the_standing_answer() {
    let (_addr, _dir, daemon) = start_daemon_without_mail_loop().await;

    daemon
        .update_policy_set(proto::UpdatePolicy {
            check: true,
            channel: proto::UpdateChannel::Stable,
        })
        .unwrap();

    daemon
        .update_policy_set(proto::UpdatePolicy {
            check: true,
            channel: proto::UpdateChannel::Nightly,
        })
        .unwrap();
    assert_eq!(
        daemon.update_state(),
        proto::UpdateState::Unknown,
        "the standing answer was about stable, so it does not survive the switch to nightly"
    );
    assert_eq!(
        daemon.update_policy().channel,
        proto::UpdateChannel::Nightly,
        "the channel round-trips through the settings row"
    );
}

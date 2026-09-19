mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

fn host_info(daemon: &houston_core::daemon::Daemon) -> proto::ServerMsg {
    daemon.host_info()
}

#[tokio::test]
async fn a_fresh_daemon_reports_believable_facts_about_itself() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let proto::ServerMsg::HostInfo {
        channel,
        pid,
        protocol_version,
        app_version,
        build_commit,
        live_sessions,
        restore_budget,
        restore_deferred,
        orchestration_depth_in_use,
        orchestration_max_depth,
        mailbox_files_on_disk,
        mailbox_retention_hours,
        command_history_ignore_glob_count,
        session_db_bytes,
        ..
    } = host_info(&daemon)
    else {
        panic!("expected HostInfo");
    };
    assert_eq!(channel, "release");
    assert_eq!(pid, std::process::id());
    assert_eq!(protocol_version, proto::PROTOCOL_VERSION);
    assert!(!app_version.is_empty());
    assert!(
        !build_commit.is_empty(),
        "falls back to \"unknown\", never empty"
    );
    assert_eq!(live_sessions, 0, "nothing spawned yet");
    assert_eq!(
        restore_budget,
        proto::RESTORE_BUDGET_DEFAULT,
        "a fresh daemon reports the shipped default (24 since the 2026-08-27 resume strip \
         — at 6, a seventh pane came back deferred, the corpse that change removes)"
    );
    assert_eq!(restore_deferred, 0);
    assert_eq!(orchestration_depth_in_use, 0);
    assert_eq!(
        orchestration_max_depth,
        houston_core::orchestrate::MAX_SPAWN_DEPTH
    );
    assert_eq!(
        mailbox_files_on_disk, 0,
        "no swarm scope was ever created on this fresh install"
    );
    assert_eq!(mailbox_retention_hours, 24);
    assert_eq!(command_history_ignore_glob_count, 0);
    assert!(
        session_db_bytes > 0,
        "the sqlite file Db::open just created must be non-empty"
    );
}

#[tokio::test]
async fn restore_budget_set_persists_and_is_visible_in_host_info() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    assert_eq!(
        daemon.set_restore_budget(0).unwrap(),
        0,
        "0 defers every husk"
    );
    let proto::ServerMsg::HostInfo { restore_budget, .. } = host_info(&daemon) else {
        panic!("expected HostInfo");
    };
    assert_eq!(restore_budget, 0);

    daemon.set_restore_budget(12).unwrap();
    let proto::ServerMsg::HostInfo { restore_budget, .. } = host_info(&daemon) else {
        panic!("expected HostInfo");
    };
    assert_eq!(restore_budget, 12);
}

#[tokio::test]
async fn restore_budget_set_refuses_over_the_cap_naming_it_and_leaves_the_stored_value_alone() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.set_restore_budget(9).unwrap();
    let err = daemon
        .set_restore_budget(100_000)
        .expect_err("over the cap must refuse");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("100000"),
        "must name what was asked for: {msg}"
    );
    assert!(msg.contains("500"), "must name the cap: {msg}");
    assert!(
        msg.contains('9'),
        "must name the value still in effect: {msg}"
    );
    assert_eq!(
        daemon.restore_budget(),
        9,
        "a refused set must not change the stored value"
    );
}

#[tokio::test]
async fn mailbox_retention_set_persists_and_is_visible_in_host_info() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.set_mailbox_retention_hours(48).unwrap();
    let proto::ServerMsg::HostInfo {
        mailbox_retention_hours,
        ..
    } = host_info(&daemon)
    else {
        panic!("expected HostInfo");
    };
    assert_eq!(mailbox_retention_hours, 48);
}

#[tokio::test]
async fn mailbox_retention_set_refuses_zero_and_over_the_cap() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let zero_err = daemon
        .set_mailbox_retention_hours(0)
        .expect_err("0 is not a retention window");
    assert!(format!("{zero_err:#}").contains('0'));

    let over_err = daemon
        .set_mailbox_retention_hours(10_000)
        .expect_err("over the cap must refuse");
    let msg = format!("{over_err:#}");
    assert!(msg.contains("10000"), "{msg}");
    assert!(
        msg.contains(&(24 * 30).to_string()),
        "must name the cap: {msg}"
    );
    assert_eq!(
        daemon.mailbox_retention_hours(),
        24,
        "neither refused set changed the stored value"
    );
}

#[tokio::test]
async fn orchestration_caps_set_persists_and_is_visible_in_orchestration_state() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.set_orchestration_caps(2, 3).unwrap();
    let proto::ServerMsg::OrchestrationState { caps, .. } = daemon.orchestration_state() else {
        panic!("expected OrchestrationState");
    };
    assert_eq!(caps.max_live_children, 2);
    assert_eq!(caps.max_spawn_depth, 3);
}

#[tokio::test]
async fn orchestration_caps_set_refuses_zero_and_over_the_cap_naming_each_independently() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .set_orchestration_caps(0, 2)
        .expect_err("0 children is not a usable cap");
    assert!(format!("{err:#}").contains("max child panes"), "{err:#}");

    let err = daemon
        .set_orchestration_caps(2, 999)
        .expect_err("over the ceiling must refuse");
    let msg = format!("{err:#}");
    assert!(msg.contains("max nesting depth"), "{msg}");
    assert!(msg.contains("999"), "must name what was asked for: {msg}");
    assert!(msg.contains("16"), "must name the ceiling: {msg}");

    let proto::ServerMsg::OrchestrationState { caps, .. } = daemon.orchestration_state() else {
        panic!("expected OrchestrationState");
    };
    assert_eq!(
        caps.max_live_children,
        houston_core::orchestrate::MAX_LIVE_CHILDREN
    );
    assert_eq!(
        caps.max_spawn_depth,
        houston_core::orchestrate::MAX_SPAWN_DEPTH
    );
}

async fn next_host_info(ws: &mut common::WsStream) -> proto::ServerMsg {
    loop {
        match next_control(ws).await {
            m @ proto::ServerMsg::HostInfo { .. } => return m,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn host_info_get_is_a_direct_reply_not_a_broadcast() {
    let (addr, _state, _daemon) = start_daemon_with_handle().await;
    let mut a = connect_and_hello(addr, TOKEN).await;
    let mut b = connect_and_hello(addr, TOKEN).await;

    a.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::HostInfoGet).unwrap(),
    ))
    .await
    .unwrap();
    let proto::ServerMsg::HostInfo { pid, .. } = next_host_info(&mut a).await else {
        unreachable!()
    };
    assert_eq!(pid, std::process::id());

    let raced = tokio::time::timeout(std::time::Duration::from_millis(300), async {
        next_host_info(&mut b).await
    })
    .await;
    assert!(
        raced.is_err(),
        "host_info_get must not broadcast to a connection that never asked"
    );
}

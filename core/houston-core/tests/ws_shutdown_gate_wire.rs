mod common;

use common::TOKEN;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn a_read_answers_and_a_mutation_is_refused_while_shutting_down() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let mut ws = common::connect_and_hello(addr, TOKEN).await;
    common::next_control(&mut ws).await;

    daemon.reap_set_exit_hook_for_test(Box::new(|| {}));
    daemon
        .manage_shutdown()
        .expect("shutdown with no live sessions must succeed");
    assert!(daemon.is_shutting_down());

    let list = serde_json::to_string(&proto::ClientMsg::SessionList).unwrap();
    ws.send(Message::text(list)).await.unwrap();
    match common::next_control(&mut ws).await {
        proto::ServerMsg::SessionList { .. } => {}
        other => panic!("a read-only message must still answer during shutdown: {other:?}"),
    }

    let create = common::create_custom_msg(vec!["sleep", "1"], dir.path());
    ws.send(Message::text(create)).await.unwrap();
    match common::next_control(&mut ws).await {
        proto::ServerMsg::Error { message, context } => {
            assert!(
                message.contains("shutting down"),
                "refusal must name why: {message:?}"
            );
            assert_eq!(context.as_deref(), Some("shutting_down"));
        }
        other => panic!("a mutation must be refused during shutdown: {other:?}"),
    }
}

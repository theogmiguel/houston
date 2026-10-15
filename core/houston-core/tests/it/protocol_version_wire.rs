use crate::common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn schemas_without_correlated_creation_are_refused_before_admission() {
    let (addr, _state) = start_daemon().await;
    for protocol in [136, 137] {
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        let hello = proto::ClientMsg::Hello {
            token: TOKEN.into(),
            protocol,
        };
        ws.send(Message::text(serde_json::to_string(&hello).unwrap()))
            .await
            .unwrap();
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(message.contains(&format!("client {protocol}")), "{message}");
                assert!(
                    message.contains(&format!("daemon {}", proto::PROTOCOL_VERSION)),
                    "{message}"
                );
            }
            other => panic!("unsupported schema {protocol} was admitted: {other:?}"),
        }
    }
    let mut current = connect_and_hello(addr, TOKEN).await;
    assert!(matches!(
        next_control(&mut current).await,
        proto::ServerMsg::HelloOk { .. }
    ));
}

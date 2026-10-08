mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use houston_protocol as proto;

async fn send(ws: &mut common::WsStream, msg: proto::ClientMsg) {
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(&msg).unwrap(),
    ))
    .await
    .unwrap();
}

#[tokio::test]
async fn custom_tag_colors_accept_hex_and_store_lowercase() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello = next_control(&mut ws).await;

    for (name, color, expected) in [
        ("lowercase", "#12abef", "#12abef"),
        ("uppercase", "#A1B2C3", "#a1b2c3"),
    ] {
        send(
            &mut ws,
            proto::ClientMsg::TagCreate {
                name: name.into(),
                color: color.into(),
            },
        )
        .await;
        loop {
            if let proto::ServerMsg::TagList { tags } = next_control(&mut ws).await {
                let tag = tags.iter().find(|tag| tag.name == name).unwrap();
                assert_eq!(tag.color, expected);
                break;
            }
        }
    }

    send(
        &mut ws,
        proto::ClientMsg::TagCreate {
            name: "invalid".into(),
            color: "#12xzef".into(),
        },
    )
    .await;
    loop {
        if let proto::ServerMsg::Error { message, .. } = next_control(&mut ws).await {
            assert!(message.contains("#12xzef"));
            assert!(message.contains("#rrggbb"));
            break;
        }
    }
}

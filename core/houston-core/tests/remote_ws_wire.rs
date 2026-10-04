#![cfg(unix)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, WsStream, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

async fn send(ws: &mut WsStream, msg: proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(&msg).unwrap()))
        .await
        .unwrap();
}

async fn next_matching<T>(
    ws: &mut WsStream,
    mut pick: impl FnMut(proto::ServerMsg) -> Option<T>,
) -> T {
    loop {
        if let Some(v) = pick(next_control(ws).await) {
            return v;
        }
    }
}

#[tokio::test]
async fn settings_read_configure_pair_and_revoke_over_ws() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    let mut ws = connect_and_hello(addr, TOKEN).await;

    send(&mut ws, proto::ClientMsg::RemoteGet).await;
    let state = next_matching(&mut ws, |m| match m {
        proto::ServerMsg::RemoteState { remote } => Some(remote),
        _ => None,
    })
    .await;
    assert!(!state.enabled, "off by default");
    assert_eq!(state.bind, "127.0.0.1:47823");
    assert_eq!(state.url, "http://127.0.0.1:47823");
    assert!(!state.listening);
    assert_eq!(state.ntfy_server, None);
    assert_eq!(state.notify_delay_secs, 30);
    assert_eq!(state.notify_detail, proto::RemoteNotifyDetail::Generic);
    assert!(state.devices.is_empty());

    send(
        &mut ws,
        proto::ClientMsg::RemoteConfigure {
            enabled: Some(true),
            bind: Some("not-an-address".into()),
            public_url: None,
            ntfy_url: None,
            notify_delay_secs: None,
            notify_detail: None,
            notify_finished: None,
        },
    )
    .await;
    let (message, context) = next_matching(&mut ws, |m| match m {
        proto::ServerMsg::Error { message, context } => Some((message, context)),
        _ => None,
    })
    .await;
    assert_eq!(context.as_deref(), Some("remote"));
    assert!(message.contains("not-an-address"), "{message}");

    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    send(
        &mut ws,
        proto::ClientMsg::RemoteConfigure {
            enabled: Some(true),
            bind: Some(format!("127.0.0.1:{port}")),
            public_url: None,
            ntfy_url: None,
            notify_delay_secs: Some(5),
            notify_detail: Some(proto::RemoteNotifyDetail::PaneName),
            notify_finished: None,
        },
    )
    .await;
    let listening = next_matching(&mut ws, |m| match m {
        proto::ServerMsg::RemoteState { remote } if remote.listening => Some(remote),
        _ => None,
    })
    .await;
    assert_eq!(listening.bind, format!("127.0.0.1:{port}"));
    assert_eq!(listening.notify_delay_secs, 5);
    assert_eq!(listening.notify_detail, proto::RemoteNotifyDetail::PaneName);

    send(&mut ws, proto::ClientMsg::RemotePairStart).await;
    let (url, qr_svg, expires_at) = next_matching(&mut ws, |m| match m {
        proto::ServerMsg::RemotePairing {
            url,
            qr_svg,
            expires_at,
        } => Some((url, qr_svg, expires_at)),
        _ => None,
    })
    .await;
    assert!(
        url.starts_with(&format!("http://127.0.0.1:{port}/#pair=")),
        "{url}"
    );
    assert!(qr_svg.contains("<svg"));
    assert!(expires_at > houston_core::daemon::now_ms());

    send(&mut ws, proto::ClientMsg::RemoteDeviceRevoke { id: 4242 }).await;
    let (message, context) = next_matching(&mut ws, |m| match m {
        proto::ServerMsg::Error { message, context } => Some((message, context)),
        _ => None,
    })
    .await;
    assert_eq!(context.as_deref(), Some("remote"));
    assert!(message.contains("4242"), "{message}");
}

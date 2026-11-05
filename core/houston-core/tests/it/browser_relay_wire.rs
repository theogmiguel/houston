use crate::common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::{SinkExt, StreamExt};
use houston_core::browser_relay::{
    agent_browser_off_message, no_window_connected_message, BrowserRelayTools,
};
use houston_core::mcp_creds::McpScope;
use houston_core::mcp_server::ToolProvider;
use houston_protocol as proto;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn no_registered_relay_fails_immediately_even_with_a_renderer_connected() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let mut renderer = connect_and_hello(addr, TOKEN).await;
    assert!(matches!(
        next_control(&mut renderer).await,
        proto::ServerMsg::HelloOk { .. }
    ));
    let provider = BrowserRelayTools::new(&daemon);
    let scope = McpScope {
        session_id: 1,
        workspace_id: "/workspace".into(),
    };
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        provider.call(&scope, "browser_tabs", &json!({})),
    )
    .await
    .expect("no registered relay must fail immediately");
    assert_eq!(result.unwrap_err().0, no_window_connected_message());
}

#[tokio::test]
async fn registered_relay_exclusively_receives_calls_and_disconnect_fails_its_pending_call() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let mut renderer = connect_and_hello(addr, TOKEN).await;
    next_control(&mut renderer).await;
    let mut relay = connect_and_hello(addr, TOKEN).await;
    next_control(&mut relay).await;
    relay
        .send(Message::text(r#"{"type":"browser_relay_register"}"#))
        .await
        .unwrap();
    // A request/reply after registration is an ordering barrier on this connection.
    relay
        .send(Message::text(
            serde_json::to_string(&proto::ClientMsg::WorkspaceLocalServers {
                workspace: "/workspace".into(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
    loop {
        if matches!(
            next_control(&mut relay).await,
            proto::ServerMsg::WorkspaceLocalServers { .. }
        ) {
            break;
        }
    }
    let provider = Arc::new(BrowserRelayTools::new(&daemon));
    let call = tokio::spawn(async move {
        let scope = McpScope {
            session_id: 1,
            workspace_id: "/workspace".into(),
        };
        provider.call(&scope, "browser_snapshot", &json!({})).await
    });
    assert!(matches!(
        next_control(&mut relay).await,
        proto::ServerMsg::BrowserToolCall { .. }
    ));
    // Drain initial unsolicited control messages; none may be a browser call.
    while let Ok(Some(Ok(Message::Text(text)))) =
        tokio::time::timeout(Duration::from_millis(100), renderer.next()).await
    {
        assert!(!matches!(
            serde_json::from_str::<proto::ServerMsg>(&text).unwrap(),
            proto::ServerMsg::BrowserToolCall { .. }
        ));
    }
    renderer.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !call.is_finished(),
        "renderer disconnect must preserve the relay's call"
    );
    relay.close(None).await.unwrap();
    let err = tokio::time::timeout(Duration::from_secs(1), call)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(err.0.contains("disconnected"), "{}", err.0);
}

async fn next_agent_browser(ws: &mut common::WsStream) -> bool {
    loop {
        if let proto::ServerMsg::AgentBrowser { enabled } = next_control(ws).await {
            return enabled;
        }
    }
}

#[tokio::test]
async fn agent_browser_off_withholds_the_tools_and_refuses_a_call_before_the_relay() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let mut relay = connect_and_hello(addr, TOKEN).await;
    next_control(&mut relay).await;
    relay
        .send(Message::text(r#"{"type":"browser_relay_register"}"#))
        .await
        .unwrap();
    relay
        .send(Message::text(r#"{"type":"agent_browser_get"}"#))
        .await
        .unwrap();
    assert!(
        next_agent_browser(&mut relay).await,
        "an unset switch keeps agents' browser tools on"
    );
    let provider = BrowserRelayTools::new(&daemon);
    let scope = McpScope {
        session_id: 1,
        workspace_id: "/workspace".into(),
    };
    assert!(provider
        .tools(&scope)
        .iter()
        .any(|spec| spec.name == "browser_new_tab"));
    assert!(provider.instructions(&scope).is_some());

    relay
        .send(Message::text(
            r#"{"type":"agent_browser_set","enabled":false}"#,
        ))
        .await
        .unwrap();
    assert!(!next_agent_browser(&mut relay).await);
    assert!(!daemon.agent_browser_enabled());
    assert!(provider.tools(&scope).is_empty());
    assert!(provider.instructions(&scope).is_none());
    assert!(
        provider
            .all_tools()
            .iter()
            .any(|spec| spec.name == "browser_new_tab"),
        "the catalogue still routes a direct call here for the named refusal"
    );
    for tool in [
        "browser_new_tab",
        "browser_navigate",
        "browser_local_servers",
    ] {
        let err = tokio::time::timeout(
            Duration::from_secs(1),
            provider.call(&scope, tool, &json!({"url": "http://127.0.0.1:8731/"})),
        )
        .await
        .expect("a refused call must not wait for the app")
        .unwrap_err();
        assert_eq!(err.0, agent_browser_off_message(tool));
        assert!(err.0.contains("Let agents use the browser"), "{}", err.0);
    }
    // The registered relay, which would open the page in a Houston browser tab, saw nothing.
    while let Ok(Some(Ok(Message::Text(text)))) =
        tokio::time::timeout(Duration::from_millis(200), relay.next()).await
    {
        assert!(!matches!(
            serde_json::from_str::<proto::ServerMsg>(&text).unwrap(),
            proto::ServerMsg::BrowserToolCall { .. }
        ));
    }

    relay
        .send(Message::text(
            r#"{"type":"agent_browser_set","enabled":true}"#,
        ))
        .await
        .unwrap();
    assert!(next_agent_browser(&mut relay).await);
    assert!(provider
        .tools(&scope)
        .iter()
        .any(|spec| spec.name == "browser_new_tab"));
}

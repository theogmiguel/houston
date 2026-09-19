use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use serde_json::Value;
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::Message;

use super::mcp_tools::BrowserTools;

// Not a tight loop: a daemon that just restarted needs a moment to rebind, and a
// tool call in flight during the gap times out on the daemon's own relay timeout
// and is retried by the agent.
const RECONNECT_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

pub async fn run(app: AppHandle, port: u16, token: String) {
    loop {
        if let Err(err) = connect_and_serve(&app, port, &token).await {
            eprintln!("houston-tauri: browser relay connection dropped: {err:#}; reconnecting…");
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn connect_and_serve(app: &AppHandle, port: u16, token: &str) -> anyhow::Result<()> {
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (ws, _response) = tokio_tungstenite::connect_async(&url).await?;
    let (write, mut read) = ws.split();
    // Shared, and each call answered from its own spawned task, so a slow act holding
    // this connection for the confirmation gate cannot serialize a second workspace's
    // browser call behind it.
    let write = std::sync::Arc::new(tokio::sync::Mutex::new(write));

    let hello = proto::ClientMsg::Hello {
        token: token.to_string(),
        protocol: proto::PROTOCOL_VERSION,
    };
    write
        .lock()
        .await
        .send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;

    match read.next().await {
        Some(Ok(Message::Text(text))) => {
            let msg: proto::ServerMsg = serde_json::from_str(&text)?;
            if !matches!(msg, proto::ServerMsg::HelloOk { .. }) {
                anyhow::bail!("expected hello_ok, got a different first message: {text}");
            }
        }
        Some(Ok(other)) => anyhow::bail!("expected hello_ok as text, got: {other:?}"),
        Some(Err(e)) => return Err(e.into()),
        None => anyhow::bail!("connection closed before hello_ok"),
    }

    loop {
        let Some(frame) = read.next().await else {
            anyhow::bail!("connection closed");
        };
        let text = match frame? {
            Message::Text(text) => text,
            Message::Close(_) => anyhow::bail!("daemon closed the connection"),
            _ => continue,
        };
        let Ok(msg) = serde_json::from_str::<proto::ServerMsg>(&text) else {
            continue;
        };
        let proto::ServerMsg::BrowserToolCall {
            request_id,
            tool,
            args,
            session_id,
            workspace_id,
        } = msg
        else {
            continue;
        };

        let app = app.clone();
        let write = write.clone();
        tokio::spawn(async move {
            let reply = answer_call(&app, request_id, tool, args, session_id, workspace_id).await;
            let Ok(text) = serde_json::to_string(&reply) else {
                return;
            };
            let _ = write.lock().await.send(Message::Text(text.into())).await;
        });
    }
}

async fn answer_call(
    app: &AppHandle,
    request_id: u64,
    tool: String,
    args: Value,
    session_id: u32,
    workspace_id: String,
) -> proto::ClientMsg {
    use houston_core::mcp_server::ToolProvider;
    let scope = houston_core::mcp_creds::McpScope {
        session_id,
        workspace_id,
    };
    let browser_tools = BrowserTools::new(app.clone());
    match browser_tools.call(&scope, &tool, &args).await {
        Ok(output) => proto::ClientMsg::BrowserToolResult {
            request_id,
            ok: true,
            output: output.structured.or(Some(Value::String(output.text))),
            error: None,
        },
        Err(err) => proto::ClientMsg::BrowserToolResult {
            request_id,
            ok: false,
            output: None,
            error: Some(err.0),
        },
    }
}

use futures_util::{SinkExt, StreamExt};
use houston_protocol as proto;
use serde_json::Value;
use tauri::AppHandle;
use tokio_tungstenite::tungstenite::Message;

use super::mcp_tools::BrowserTools;

// Not a tight loop: a daemon that just restarted needs a moment to rebind, and a
// tool call in flight during the gap times out on the daemon's own relay timeout
// and is retried by the agent.
// Bounded across all workspaces on one authenticated relay connection. A call
// expires before the daemon's 130s response deadline; writes cannot pin a slot.
const MAX_OUTSTANDING_CALLS: usize = 16;
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(125);
const RESPONSE_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
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

    let app = app.clone();
    serve_calls(
        read,
        write,
        move |request_id, tool, args, session_id, workspace_id| {
            let app = app.clone();
            async move { answer_call(&app, request_id, tool, args, session_id, workspace_id).await }
        },
    )
    .await
}

type RelaySocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type RelayWriter =
    std::sync::Arc<tokio::sync::Mutex<futures_util::stream::SplitSink<RelaySocket, Message>>>;

async fn serve_calls<F>(
    mut read: futures_util::stream::SplitStream<RelaySocket>,
    write: RelayWriter,
    answer: impl Fn(u64, String, Value, u32, String) -> F,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = proto::ClientMsg> + Send + 'static,
{
    let mut calls = tokio::task::JoinSet::new();
    loop {
        let frame = tokio::select! {
            frame = read.next() => frame,
            Some(_) = calls.join_next(), if !calls.is_empty() => continue,
        };
        let Some(frame) = frame else {
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

        let write = write.clone();
        if calls.len() >= MAX_OUTSTANDING_CALLS {
            let reply = proto::ClientMsg::BrowserToolResult { request_id, ok: false, output: None,
                error: Some(format!("browser relay outstanding call limit is {MAX_OUTSTANDING_CALLS}; actual {}, requested {tool}", calls.len())) };
            tokio::time::timeout(RESPONSE_WRITE_TIMEOUT, async {
                write
                    .lock()
                    .await
                    .send(Message::Text(serde_json::to_string(&reply)?.into()))
                    .await?;
                Ok::<_, anyhow::Error>(())
            })
            .await??;
            continue;
        }
        // JoinSet owns every call. Disconnect drops it and aborts requests, whose
        // confirmation and queued-native guards then clean up before any late dispatch.
        let answer = answer(request_id, tool, args, session_id, workspace_id);
        calls.spawn(async move {
            let reply = match tokio::time::timeout(CALL_TIMEOUT,
                answer).await {
                Ok(reply) => reply,
                Err(_) => proto::ClientMsg::BrowserToolResult { request_id, ok: false, output: None,
                    error: Some("browser relay request expired; an operation already executing has unknown outcome; do not automatically retry".into()) },
            };
            let Ok(text) = serde_json::to_string(&reply) else {
                return;
            };
            let _ = tokio::time::timeout(RESPONSE_WRITE_TIMEOUT, async {
                write.lock().await.send(Message::Text(text.into())).await
            }).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test]
    async fn disconnect_cancels_owned_calls_and_limit_refuses_excess() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(socket).await.unwrap()
        });
        let (client, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let mut server = server.await.unwrap();
        let (write, read) = client.split();
        let active = Arc::new(AtomicUsize::new(0));
        let effects = Arc::new(AtomicUsize::new(0));
        let (receipts, mut received) = tokio::sync::mpsc::unbounded_channel();
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let task = {
            let active = active.clone();
            let effects = effects.clone();
            tokio::spawn(serve_calls(
                read,
                Arc::new(tokio::sync::Mutex::new(write)),
                move |id, _, _, _, _| {
                    let active = active.clone();
                    let effects = effects.clone();
                    let receipts = receipts.clone();
                    async move {
                        active.fetch_add(1, Ordering::SeqCst);
                        let _guard = Guard(active);
                        receipts.send(id).unwrap();
                        std::future::pending::<()>().await; // Held user approval.
                        effects.fetch_add(1, Ordering::SeqCst);
                        proto::ClientMsg::BrowserToolResult {
                            request_id: id,
                            ok: true,
                            output: None,
                            error: None,
                        }
                    }
                },
            ))
        };
        for id in 0..MAX_OUTSTANDING_CALLS as u64 {
            let call = proto::ServerMsg::BrowserToolCall {
                request_id: id,
                tool: "browser_click".into(),
                args: serde_json::json!({}),
                session_id: 1,
                workspace_id: "/fixture".into(),
            };
            server
                .send(Message::Text(serde_json::to_string(&call).unwrap().into()))
                .await
                .unwrap();
            assert_eq!(received.recv().await, Some(id));
        }
        assert_eq!(active.load(Ordering::SeqCst), MAX_OUTSTANDING_CALLS);
        let extra = proto::ServerMsg::BrowserToolCall {
            request_id: 999,
            tool: "browser_click".into(),
            args: serde_json::json!({}),
            session_id: 1,
            workspace_id: "/fixture".into(),
        };
        server
            .send(Message::Text(serde_json::to_string(&extra).unwrap().into()))
            .await
            .unwrap();
        let Message::Text(reply) = server.next().await.unwrap().unwrap() else {
            panic!("expected limit refusal")
        };
        assert!(reply.contains("outstanding call limit is 16"));
        server.close(None).await.unwrap();
        assert!(task.await.unwrap().is_err());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while active.load(Ordering::SeqCst) != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }
}

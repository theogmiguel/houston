//! One Socket Mode connection: ack every envelope before handling it, forward
//! event and interaction payloads, and return when Slack asks for a reconnect or the link dies.
//! Reconnecting (and catching up on what the gap missed) is the caller's job.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Slack pings every few seconds; a socket silent this long is dead even if
/// TCP has not noticed yet.
const SILENCE_MAX: Duration = Duration::from_secs(90);
const PING_EVERY: Duration = Duration::from_secs(30);
/// A write the peer stops accepting (a zero TCP window) never fails on its
/// own; one that takes this long means the link is gone.
const WRITE_MAX: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// `disconnect` with `warning` or `refresh_requested`: reconnect now.
    Refresh(String),
    /// `disconnect` with `link_disabled`: Socket Mode was turned off for the app.
    LinkDisabled,
    Closed,
    Silent,
}

pub enum Signal {
    Hello,
    /// The `payload` of an `events_api` envelope, already acknowledged.
    Event(Value),
    /// The `payload` of an `interactive` envelope (a button click or a modal
    /// submission), already acknowledged; an empty acknowledgement closes a modal.
    Interactive(Value),
}

pub async fn run(url: Url, signals: mpsc::Sender<Signal>) -> Result<Ended> {
    run_with(url, signals, SILENCE_MAX, PING_EVERY).await
}

/// Silence is counted from the last frame received, so our own pings, which
/// restart the loop, never keep a dead link alive.
async fn run_with(
    url: Url,
    signals: mpsc::Sender<Signal>,
    silence_max: Duration,
    ping_every: Duration,
) -> Result<Ended> {
    let (ws, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .map_err(|e| anyhow!("opening the Slack Socket Mode connection failed: {e}"))?;
    run_socket(ws, signals, silence_max, ping_every, WRITE_MAX).await
}

async fn run_socket<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    signals: mpsc::Sender<Signal>,
    silence_max: Duration,
    ping_every: Duration,
    write_max: Duration,
) -> Result<Ended>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut tx, mut rx) = ws.split();
    let mut ping = tokio::time::interval(ping_every);
    ping.tick().await;
    let mut last_frame = tokio::time::Instant::now();
    loop {
        let frame = tokio::select! {
            f = tokio::time::timeout_at(last_frame + silence_max, rx.next()) => f,
            _ = ping.tick() => {
                match tokio::time::timeout(write_max, tx.send(Message::Ping(Vec::new().into()))).await {
                    Err(_) => return Ok(Ended::Silent),
                    Ok(sent) => sent.map_err(|e| anyhow!("pinging the Slack Socket Mode connection failed: {e}"))?,
                }
                continue;
            }
        };
        let msg = match frame {
            Err(_) => return Ok(Ended::Silent),
            Ok(None) => return Ok(Ended::Closed),
            Ok(Some(Err(e))) => {
                return Err(anyhow!("the Slack Socket Mode connection failed: {e}"))
            }
            Ok(Some(Ok(m))) => {
                last_frame = tokio::time::Instant::now();
                m
            }
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Ok(Ended::Closed),
            _ => continue,
        };
        let Ok(envelope) = serde_json::from_str::<Value>(&text) else {
            tracing::warn!("slack: ignoring a Socket Mode frame that is not JSON");
            continue;
        };
        if let Some(id) = envelope.get("envelope_id").and_then(Value::as_str) {
            let ack = tx.send(Message::Text(
                json!({ "envelope_id": id }).to_string().into(),
            ));
            match tokio::time::timeout(write_max, ack).await {
                Err(_) => return Ok(Ended::Silent),
                Ok(sent) => {
                    sent.map_err(|e| anyhow!("acknowledging a Slack envelope failed: {e}"))?
                }
            }
        }
        match envelope.get("type").and_then(Value::as_str) {
            Some("hello") => {
                let _ = signals.send(Signal::Hello).await;
            }
            Some("events_api") => {
                if let Some(payload) = envelope.get("payload") {
                    let _ = signals.send(Signal::Event(payload.clone())).await;
                }
            }
            Some("interactive") => {
                if let Some(payload) = envelope.get("payload") {
                    let _ = signals.send(Signal::Interactive(payload.clone())).await;
                }
            }
            Some("disconnect") => {
                let reason = envelope.get("reason").and_then(Value::as_str).unwrap_or("");
                let _ = tokio::time::timeout(write_max, tx.send(Message::Close(None))).await;
                return Ok(if reason == "link_disabled" {
                    Ended::LinkDisabled
                } else {
                    Ended::Refresh(reason.to_string())
                });
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};

    // Flow control can leave writes pending while inbound frames still arrive.
    struct WriteBlocked {
        inner: DuplexStream,
        blocked: bool,
    }

    impl AsyncRead for WriteBlocked {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for WriteBlocked {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.blocked {
                Poll::Pending
            } else {
                Pin::new(&mut self.inner).poll_write(cx, buf)
            }
        }

        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            if self.blocked {
                Poll::Pending
            } else {
                Pin::new(&mut self.inner).poll_flush(cx)
            }
        }

        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    async fn blocked_write_ends(frame: Option<Value>, expected: Ended) {
        let (client, peer) = tokio::io::duplex(4096);
        let (client, peer) = tokio::join!(
            tokio_tungstenite::client_async(
                "ws://localhost/",
                WriteBlocked {
                    inner: client,
                    blocked: false
                },
            ),
            tokio_tungstenite::accept_async(peer),
        );
        let (mut client, _) = client.unwrap();
        let mut peer = peer.unwrap();
        client.get_mut().blocked = true;
        if let Some(frame) = frame {
            peer.send(Message::Text(frame.to_string().into()))
                .await
                .unwrap();
        }
        let (signals, mut received) = mpsc::channel(8);
        let ended = tokio::time::timeout(
            Duration::from_secs(2),
            run_socket(
                client,
                signals,
                Duration::from_secs(10),
                Duration::from_millis(100),
                Duration::from_millis(50),
            ),
        )
        .await
        .expect("a blocked write must not hold the connection open")
        .unwrap();
        assert_eq!(ended, expected);
        assert!(
            received.try_recv().is_err(),
            "an unacknowledged event must not be forwarded"
        );
        drop(peer);
    }

    #[tokio::test]
    async fn a_blocked_ping_ends_the_connection() {
        blocked_write_ends(None, Ended::Silent).await;
    }

    #[tokio::test]
    async fn a_blocked_ack_ends_the_connection_before_forwarding_the_event() {
        blocked_write_ends(
            Some(json!({"type": "events_api", "envelope_id": "ack", "payload": {}})),
            Ended::Silent,
        )
        .await;
    }

    #[tokio::test]
    async fn a_blocked_close_does_not_prevent_a_requested_refresh() {
        blocked_write_ends(
            Some(json!({"type": "disconnect", "reason": "refresh_requested"})),
            Ended::Refresh("refresh_requested".into()),
        )
        .await;
    }

    #[tokio::test]
    async fn a_blocked_close_preserves_the_link_disabled_reason() {
        blocked_write_ends(
            Some(json!({"type": "disconnect", "reason": "link_disabled"})),
            Ended::LinkDisabled,
        )
        .await;
    }

    #[tokio::test]
    async fn received_control_frames_keep_a_healthy_connection_alive() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            for _ in 0..6 {
                ws.send(Message::Pong(Vec::new().into())).await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            ws.send(Message::Text(
                json!({"type": "disconnect", "reason": "refresh_requested"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
            // Drain through the client's close; unread pings reset TCP on Windows.
            tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(frame) = ws.next().await {
                    if matches!(frame.unwrap(), Message::Close(_)) {
                        return;
                    }
                }
                panic!("the client must send Close after the requested refresh");
            })
            .await
            .expect("the refresh must close the connection");
        });
        let (signals, _received) = mpsc::channel(8);
        let ended = tokio::time::timeout(
            Duration::from_secs(5),
            run_with(
                Url::parse(&format!("ws://{addr}/")).unwrap(),
                signals,
                Duration::from_millis(400),
                Duration::from_secs(10),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(ended, Ended::Refresh("refresh_requested".into()));
        peer.await.unwrap();
    }

    /// A peer that says hello and then goes quiet, while our pings keep the
    /// loop turning, must still be found dead.
    #[tokio::test]
    async fn a_peer_that_stops_talking_ends_the_connection_despite_our_pings() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::Text(r#"{"type":"hello"}"#.into()))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(ws);
        });
        let (tx, _rx) = mpsc::channel(8);
        let url = Url::parse(&format!("ws://{addr}/")).unwrap();
        let ended = tokio::time::timeout(
            Duration::from_secs(5),
            run_with(
                url,
                tx,
                Duration::from_millis(400),
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("a silent peer is detected within the silence limit");
        assert_eq!(ended.unwrap(), Ended::Silent);
    }
}

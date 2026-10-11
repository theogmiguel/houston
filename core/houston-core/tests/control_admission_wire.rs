#![cfg(all(target_os = "linux", feature = "test-barriers"))]
#![allow(clippy::disallowed_methods)]
mod common;
use futures_util::{SinkExt, StreamExt};
use houston_core::server;
use houston_protocol as proto;
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;

static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Home {
    _lock: std::sync::MutexGuard<'static, ()>,
    _dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}
impl Home {
    fn new() -> Self {
        let lock = ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", dir.path());
        Self {
            _lock: lock,
            _dir: dir,
            previous,
        }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        if let Some(home) = &self.previous {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn slow_control_bursts_bound_admission_across_disconnected_connections() {
    let _home = Home::new();
    let (addr, _state, daemon) = common::start_daemon_without_mail_loop().await;
    let fixture = Arc::new(server::ControlTestGate::default());
    server::set_control_test(&daemon, fixture.clone());
    let mut sockets = Vec::new();
    for _ in 0..6 {
        let mut socket = common::connect_and_hello(addr, common::TOKEN).await;
        let _ = common::next_control(&mut socket).await;
        for _ in 0..32 {
            socket
                .send(Message::text(r#"{"type":"session_list"}"#))
                .await
                .unwrap();
        }
        sockets.push(socket);
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        while fixture.started.load(Ordering::SeqCst) < 64 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.started.load(Ordering::SeqCst), 64);
    let mut refusals = 0;
    for socket in &mut sockets {
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(Ok(message)) = socket.next().await {
                if let Message::Text(text) = message {
                    if let Ok(proto::ServerMsg::Error { message, context }) =
                        serde_json::from_str(&text)
                    {
                        if context.as_deref() == Some("control_admission") {
                            assert!(message.contains("connection 16, process 64"));
                            refusals += 1;
                            break;
                        }
                    }
                }
            }
        })
        .await
        .unwrap();
        socket.close(None).await.unwrap();
    }
    assert_eq!(refusals, 6);
    drop(sockets);
    assert_eq!(fixture.finished.load(Ordering::SeqCst), 0);
    fixture.release.add_permits(64);
    tokio::time::timeout(Duration::from_secs(15), async {
        while fixture.finished.load(Ordering::SeqCst) != 64 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

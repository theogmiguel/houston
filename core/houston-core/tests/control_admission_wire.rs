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
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}
impl Home {
    fn new() -> Self {
        let lock = ENV.lock().unwrap_or_else(|error| error.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let previous = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]
            .into_iter()
            .map(|name| {
                let previous = std::env::var_os(name);
                std::env::set_var(name, dir.path());
                (name, previous)
            })
            .collect();
        Self {
            _lock: lock,
            _dir: dir,
            previous,
        }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        for (name, previous) in &self.previous {
            if let Some(value) = previous {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

struct IdleCleanup {
    daemon: Arc<houston_core::daemon::Daemon>,
    session: u32,
    fixture: Arc<server::ControlTestGate>,
}

impl Drop for IdleCleanup {
    fn drop(&mut self) {
        self.fixture.release.add_permits(64);
        self.daemon.kill(self.session).ok();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn idle_waits_retain_admission_and_release_it_on_disconnect() {
    let home = Home::new();
    let (addr, _state, daemon) = common::start_daemon_without_mail_loop().await;
    let session = daemon
        .create_session(houston_core::daemon::CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: home._dir.path().to_path_buf(),
            cmd: Some(vec![
                "/bin/sh".into(),
                "-c".into(),
                "while :; do printf 'busy\\n'; sleep 0.05; done".into(),
            ]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap();
    let fixture = Arc::new(server::ControlTestGate::default());
    server::set_control_test(&daemon, fixture.clone());
    let _cleanup = IdleCleanup {
        daemon: daemon.clone(),
        session: session.id,
        fixture: fixture.clone(),
    };
    let mut observer = daemon.observe();
    common::collect_broadcast_until(&mut observer, session.id, "busy").await;
    drop(observer);

    for connections in [1, 6, 12, 1, 6, 12] {
        let before = fixture.started.load(Ordering::SeqCst);
        let admitted = (connections * 16).min(64);
        let mut sockets = Vec::new();
        for connection in 0..connections {
            let mut socket = common::connect_and_hello(addr, common::TOKEN).await;
            let _ = common::next_control(&mut socket).await;
            for request in 0..16 {
                socket
                    .send(Message::text(
                        serde_json::to_string(&proto::ClientMsg::WaitForIdle {
                            request: (connection * 16 + request) as u32,
                            session: session.id,
                            timeout_ms: Some(120_000),
                            idle_quiet_ms: Some(30_000),
                        })
                        .unwrap(),
                    ))
                    .await
                    .unwrap();
            }
            sockets.push(socket);
            let expected = before + ((connection + 1) * 16).min(64);
            tokio::time::timeout(Duration::from_secs(15), async {
                while fixture.started.load(Ordering::SeqCst) != expected {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("idle waits must reach the admission barrier");
        }
        fixture.release.add_permits(admitted);
        tokio::time::timeout(Duration::from_secs(15), async {
            while fixture.finished.load(Ordering::SeqCst) != before + admitted {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("every admitted wait must enter its real quiet-window check");
        assert_eq!(
            server::active_control_handlers_for_test(),
            admitted,
            "{connections} connections: real idle waits must retain control admission"
        );
        for (connection, socket) in sockets.iter_mut().enumerate() {
            socket
                .send(Message::text(r#"{"type":"session_list"}"#))
                .await
                .unwrap();
            // Drain every refused wait and the trailing SessionList before Close.
            // Otherwise a later connection can admit its unread requests after an
            // earlier disconnect frees permits, then park on this fixture's gate.
            let expected_refusals = 1 + 16 - admitted.saturating_sub(connection * 16).min(16);
            tokio::time::timeout(Duration::from_secs(15), async {
                let mut refusals = 0;
                while refusals < expected_refusals {
                    if let proto::ServerMsg::Error { message, context } =
                        common::next_control(socket).await
                    {
                        if context.as_deref() == Some("control_admission") {
                            assert!(message.contains("connection 16, process 64"));
                            refusals += 1;
                        }
                    }
                }
            })
            .await
            .expect("pending idle waits must refuse excess control work");
        }
        let disconnect_started = tokio::time::Instant::now();
        for socket in &mut sockets {
            socket.close(None).await.unwrap();
        }
        drop(sockets);
        tokio::time::timeout(Duration::from_secs(15), async {
            while daemon.manage_status().clients_connected != 0
                || server::active_control_handlers_for_test() != 0
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "disconnect must reclaim idle waits before their 120s timeout: {error}; clients {}, active {}, started {}, finished {}",
                daemon.manage_status().clients_connected,
                server::active_control_handlers_for_test(),
                fixture.started.load(Ordering::SeqCst),
                fixture.finished.load(Ordering::SeqCst),
            )
        });
        assert_eq!(fixture.started.load(Ordering::SeqCst), before + admitted);
        eprintln!(
            "idle wait ownership: profile=dev-test, workload=1 PTY at 20 lines/s, \
             connections={connections}, limits=16/connection+64/process, admitted={admitted}, \
             active_after_disconnect=0, disconnect_ms={}, deadline_ms=15000; \
             resource-count check, host load uncontrolled",
            disconnect_started.elapsed().as_millis()
        );
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
    // Sending Close does not mean the server has consumed the preceding burst.
    // Hold admission saturated until every connection actually detaches.
    tokio::time::timeout(Duration::from_secs(15), async {
        while daemon.manage_status().clients_connected != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("all burst connections must detach before releasing admitted work");
    assert_eq!(fixture.started.load(Ordering::SeqCst), 64);
    assert_eq!(fixture.finished.load(Ordering::SeqCst), 0);
    fixture.release.add_permits(64);
    tokio::time::timeout(Duration::from_secs(15), async {
        while fixture.finished.load(Ordering::SeqCst) != 64
            || server::active_control_handlers_for_test() != 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "admitted work did not settle after detach: {error}; started {}, finished {}, active {}",
            fixture.started.load(Ordering::SeqCst),
            fixture.finished.load(Ordering::SeqCst),
            server::active_control_handlers_for_test(),
        )
    });
}

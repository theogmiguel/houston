mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::collections::HashMap;
use tokio_tungstenite::tungstenite::Message;

fn sample_overrides() -> proto::KeymapOverrides {
    let mut bindings = HashMap::new();
    bindings.insert(
        "toggle-sidebar".to_string(),
        proto::KeyChord {
            code: "KeyJ".to_string(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        },
    );
    proto::KeymapOverrides {
        bindings,
        shortcuts_enabled: true,
    }
}

#[tokio::test]
async fn keymap_get_defaults_to_empty() {
    let (addr, _state_dir) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
            break;
        }
    }
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapGet).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Keymap { overrides } = next_control(&mut ws).await {
            assert!(
                overrides.bindings.is_empty(),
                "fresh daemon must start with no overrides"
            );
            assert!(
                overrides.shortcuts_enabled,
                "fresh daemon must start with shortcuts enabled"
            );
            break;
        }
    }
}

#[tokio::test]
async fn keymap_set_broadcasts_and_get_reflects_it_on_the_same_connection() {
    let (addr, _state_dir) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
            break;
        }
    }

    let overrides = sample_overrides();
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapSet {
            overrides: overrides.clone(),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws).await {
            assert_eq!(got, overrides);
            break;
        }
    }

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapGet).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws).await {
            assert_eq!(
                got, overrides,
                "a fresh keymap_get must reflect the just-set overrides"
            );
            break;
        }
    }
}

#[tokio::test]
async fn keymap_overrides_survive_a_reconnect_and_a_full_daemon_restart() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());

    let overrides = sample_overrides();
    {
        let mut ws = connect_and_hello(addr, TOKEN).await;
        loop {
            if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
                break;
            }
        }
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::KeymapSet {
                overrides: overrides.clone(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        loop {
            if let proto::ServerMsg::Keymap { .. } = next_control(&mut ws).await {
                break;
            }
        }
    }

    {
        let mut ws = connect_and_hello(addr, TOKEN).await;
        loop {
            if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
                break;
            }
        }
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::KeymapGet).unwrap(),
        ))
        .await
        .unwrap();
        loop {
            if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws).await {
                assert_eq!(
                    got, overrides,
                    "a fresh connection must see the persisted overrides"
                );
                break;
            }
        }
    }

    let daemon2 = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();
    let (addr2, _handle2) = server::start(daemon2.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon2.set_port(addr2.port());

    let mut ws2 = connect_and_hello(addr2, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws2).await {
            break;
        }
    }
    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapGet).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws2).await {
            assert_eq!(
                got, overrides,
                "overrides must survive a full daemon restart over the same db"
            );
            break;
        }
    }
}

#[tokio::test]
async fn keymap_overrides_set_rejects_too_many_bindings() {
    let (addr, _state_dir) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
            break;
        }
    }

    let mut bindings = HashMap::new();
    for i in 0..65 {
        bindings.insert(
            format!("id-{i}"),
            proto::KeyChord {
                code: "KeyJ".to_string(),
                ctrl: true,
                alt: false,
                shift: false,
                meta: false,
            },
        );
    }
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapSet {
            overrides: proto::KeymapOverrides {
                bindings,
                shortcuts_enabled: true,
            },
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("65"),
                    "error should name the offending count: {message}"
                );
                break;
            }
            proto::ServerMsg::Keymap { .. } => panic!("oversized map must not be accepted"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn keymap_overrides_set_rejects_oversized_code() {
    let (addr, _state_dir) = start_daemon().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
            break;
        }
    }

    let mut bindings = HashMap::new();
    bindings.insert(
        "toggle-sidebar".to_string(),
        proto::KeyChord {
            code: "K".repeat(65),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        },
    );
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapSet {
            overrides: proto::KeymapOverrides {
                bindings,
                shortcuts_enabled: true,
            },
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => {
                assert!(
                    message.contains("toggle-sidebar") && message.contains("65"),
                    "error should name the offending id and length: {message}"
                );
                break;
            }
            proto::ServerMsg::Keymap { .. } => panic!("oversized code must not be accepted"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn shortcuts_enabled_false_survives_a_daemon_restart() {
    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());

    let mut overrides = sample_overrides();
    overrides.shortcuts_enabled = false;
    {
        let mut ws = connect_and_hello(addr, TOKEN).await;
        loop {
            if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws).await {
                break;
            }
        }
        ws.send(Message::text(
            serde_json::to_string(&proto::ClientMsg::KeymapSet {
                overrides: overrides.clone(),
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        loop {
            if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws).await {
                assert!(!got.shortcuts_enabled);
                break;
            }
        }
    }

    let daemon2 = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();
    let (addr2, _handle2) = server::start(daemon2.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon2.set_port(addr2.port());

    let mut ws2 = connect_and_hello(addr2, TOKEN).await;
    loop {
        if let proto::ServerMsg::HelloOk { .. } = next_control(&mut ws2).await {
            break;
        }
    }
    ws2.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::KeymapGet).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::Keymap { overrides: got } = next_control(&mut ws2).await {
            assert_eq!(
                got, overrides,
                "shortcuts_enabled=false and its bindings must both survive a daemon restart"
            );
            break;
        }
    }
}

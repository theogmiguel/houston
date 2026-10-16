use crate::common;

use common::{connect_and_hello, next_control, TOKEN};
use houston_protocol as proto;

async fn start_daemon_with_handle() -> (
    std::net::SocketAddr,
    tempfile::TempDir,
    std::sync::Arc<houston_core::daemon::Daemon>,
) {
    // Voice settings broadcasts consult the credential store even for model-only
    // requests. Install the shared mock before any fixture can serve requests.
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
        keyring_core::set_default_store(
            keyring_core::mock::Store::new().expect("building the mock credential store"),
        );
    });
    common::start_daemon_with_handle().await
}

async fn send(ws: &mut common::WsStream, msg: proto::ClientMsg) {
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(&msg).unwrap(),
    ))
    .await
    .unwrap();
}

async fn next_matching<T>(
    ws: &mut common::WsStream,
    mut f: impl FnMut(proto::ServerMsg) -> Option<T>,
) -> T {
    loop {
        if let Some(v) = f(next_control(ws).await) {
            return v;
        }
    }
}

fn voice_settings_msg(
    msg: proto::ServerMsg,
) -> Option<(proto::VoiceSettings, bool, Vec<proto::VoiceModelState>)> {
    match msg {
        proto::ServerMsg::VoiceSettings {
            settings,
            cloud_key_present,
            keyring_error: _,
            models,
        } => Some((settings, cloud_key_present, models)),
        _ => None,
    }
}

fn voice_state_msg(msg: proto::ServerMsg) -> Option<proto::VoiceState> {
    match msg {
        proto::ServerMsg::VoiceState { state } => Some(state),
        _ => None,
    }
}

fn voice_model_msg(msg: proto::ServerMsg) -> Option<proto::VoiceModelState> {
    match msg {
        proto::ServerMsg::VoiceModelState { model } => Some(model),
        _ => None,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn selecting_an_installed_catalogue_model_round_trips_and_active_delete_clears_selection() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let external = tempfile::tempdir().unwrap();
    let source = external.path().join("fixture.bin");
    let payload = b"whisper fixture weights";
    std::fs::write(&source, payload).unwrap();
    let fixture = houston_core::voice::models::ModelSpec {
        id: "ggml-tiny",
        display_name: "Tiny fixture",
        url: "http://127.0.0.1/fixture",
        sha256: "ada54ec2596d3737fcd230da1197417cd9f9d4db419d66e19e7cf104f73ed329",
        size_bytes: payload.len() as u64,
        memory_gib: 1,
    };
    houston_core::voice::reuse::reuse_file(&daemon.voice_models_dir(), &source, &fixture, false)
        .unwrap();
    let mut settings = daemon.voice_settings();
    settings.engine = proto::VoiceEngine::Local {
        model_id: "ggml-tiny".into(),
    };
    send(
        &mut ws,
        proto::ClientMsg::VoiceSettingsSet {
            settings: settings.clone(),
        },
    )
    .await;
    let (selected, _, models) = next_matching(&mut ws, voice_settings_msg).await;
    assert_eq!(selected, settings);
    assert!(models.iter().find(|m| m.id == "ggml-tiny").unwrap().linked);
    send(
        &mut ws,
        proto::ClientMsg::VoiceModelDelete {
            model_id: "ggml-tiny".into(),
        },
    )
    .await;
    let (cleared, _, models) = next_matching(&mut ws, voice_settings_msg).await;
    assert_eq!(
        cleared.engine,
        proto::VoiceEngine::Local {
            model_id: String::new()
        }
    );
    assert_eq!(
        models.iter().find(|m| m.id == "ggml-tiny").unwrap().status,
        proto::VoiceModelStatus::NotDownloaded
    );
    assert_eq!(std::fs::read(&source).unwrap(), payload);
    assert!(!daemon.voice.download_in_flight("ggml-tiny"));
    settings.engine = proto::VoiceEngine::Local {
        model_id: "ggml-base".into(),
    };
    assert!(daemon
        .voice_settings_set(&settings)
        .unwrap_err()
        .to_string()
        .contains("not installed"));
}

#[cfg(windows)]
#[tokio::test]
async fn windows_refuses_local_download_and_reuse_without_touching_model_storage() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        proto::ClientMsg::VoiceModelDownload {
            model_id: "ggml-tiny".into(),
        },
    )
    .await;
    let error = next_matching(&mut ws, |msg| match msg {
        proto::ServerMsg::Error { message, .. } => Some(message),
        _ => None,
    })
    .await;
    assert!(error.contains("local whisper engine"), "{error}");
    assert!(!daemon.voice.download_in_flight("ggml-tiny"));
    assert!(!daemon.voice_models_dir().exists());
    assert!(daemon
        .voice_model_reuse("ggml-tiny".into(), "C:\\missing-model.bin".into(), false)
        .await
        .unwrap_err()
        .to_string()
        .contains("local whisper engine"));
}

#[tokio::test]
async fn voice_settings_get_replies_with_the_defaults_and_the_whole_catalog() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, proto::ClientMsg::VoiceSettingsGet).await;
    let (settings, _key_present, models) = next_matching(&mut ws, voice_settings_msg).await;

    assert!(!settings.enabled, "dictation must default to off");
    assert_eq!(settings.output_mode, proto::VoiceOutputMode::Original);
    assert_eq!(settings.capture_mode, proto::CaptureMode::Hold);
    assert_eq!(settings.insert_mode, proto::InsertMode::Direct);
    assert_eq!(settings.mic_policy, proto::MicPolicy::Persistent);
    assert!(settings.agent_preamble);
    assert_eq!(
        settings.engine,
        proto::VoiceEngine::Local {
            model_id: "ggml-small".to_string()
        }
    );

    assert_eq!(models.len(), 5, "{models:?}");
    assert_eq!(models[0].id, "ggml-tiny");
    assert!(
        models[0].size_bytes > 0,
        "the page must be able to show what a download costs"
    );
    assert_eq!(models[0].status, proto::VoiceModelStatus::NotDownloaded);
    assert_eq!(models[0].cooldown_remaining_ms, None);
}

#[tokio::test]
async fn voice_settings_set_round_trips_and_reaches_a_second_window() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut a = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut a).await;
    let mut b = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut b).await;

    let mut next = proto::VoiceSettings {
        output_mode: proto::VoiceOutputMode::English,
        input_language: Some("pt".to_string()),
        vocabulary: "Houston, pane, swarm".to_string(),
        capture_mode: proto::CaptureMode::Toggle,
        insert_mode: proto::InsertMode::ConfirmFirst,
        ..proto::VoiceSettings::default()
    };
    next.enabled = true;
    next.mic_policy = proto::MicPolicy::OnKeypress;

    send(
        &mut a,
        proto::ClientMsg::VoiceSettingsSet {
            settings: next.clone(),
        },
    )
    .await;

    let (on_a, _, _) = next_matching(&mut a, voice_settings_msg).await;
    let (on_b, _, _) = next_matching(&mut b, voice_settings_msg).await;
    assert_eq!(on_a, next);
    assert_eq!(on_b, next, "the other window must see the same mic state");

    send(&mut a, proto::ClientMsg::VoiceSettingsGet).await;
    let (reread, _, _) = next_matching(&mut a, voice_settings_msg).await;
    assert_eq!(reread, next);
}

#[tokio::test]
async fn voice_start_while_dictation_is_off_is_a_named_refusal() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, proto::ClientMsg::VoiceStart { session: 1 }).await;
    let state = next_matching(&mut ws, voice_state_msg).await;
    match state {
        proto::VoiceState::Error {
            failure: proto::VoiceFailure::Engine { message },
        } => assert!(
            message.contains("Settings") && message.contains("Voice"),
            "the refusal must point at the setting that fixes it: {message}"
        ),
        other => panic!("expected an Engine refusal naming the setting, got {other:?}"),
    }
}

#[tokio::test]
async fn voice_start_for_a_pane_that_does_not_exist_names_the_session() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    daemon
        .voice_settings_set(&proto::VoiceSettings {
            enabled: true,
            mic_policy: proto::MicPolicy::OnKeypress,
            ..proto::VoiceSettings::default()
        })
        .unwrap();

    send(&mut ws, proto::ClientMsg::VoiceStart { session: 4242 }).await;
    let state = next_matching(&mut ws, voice_state_msg).await;
    assert_eq!(
        state,
        proto::VoiceState::Error {
            failure: proto::VoiceFailure::TargetGone { session: 4242 }
        }
    );
    assert!(
        !daemon.voice.is_open(),
        "a refused start must not have opened a microphone"
    );
}

#[tokio::test]
async fn voice_stop_with_nothing_armed_settles_to_idle() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(&mut ws, proto::ClientMsg::VoiceStop { session: 1 }).await;
    let state = next_matching(&mut ws, voice_state_msg).await;
    assert_eq!(state, proto::VoiceState::Idle);
}

#[tokio::test]
async fn voice_model_download_of_an_unknown_id_names_it_and_the_catalog() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        proto::ClientMsg::VoiceModelDownload {
            model_id: "ggml-enormous".to_string(),
        },
    )
    .await;
    let model = next_matching(&mut ws, voice_model_msg).await;
    assert_eq!(model.id, "ggml-enormous");
    match model.status {
        proto::VoiceModelStatus::Failed { reason } => {
            assert!(reason.contains("ggml-enormous"), "{reason}");
            assert!(
                reason.contains("ggml-small"),
                "the refusal must name what WOULD have worked: {reason}"
            );
        }
        other => panic!("expected a named Failed status, got {other:?}"),
    }
}

#[tokio::test]
async fn deleting_a_model_that_was_never_downloaded_succeeds_and_reports_the_truth() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        proto::ClientMsg::VoiceModelDelete {
            model_id: "ggml-small".to_string(),
        },
    )
    .await;
    let model = next_matching(&mut ws, voice_model_msg).await;
    assert_eq!(model.id, "ggml-small");
    assert_eq!(model.status, proto::VoiceModelStatus::NotDownloaded);
}

#[tokio::test]
async fn an_installed_model_reports_its_size_and_delete_frees_it() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    let dir = daemon.voice_models_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let installed = dir.join("ggml-small.bin");
    std::fs::write(&installed, vec![7u8; 4096]).unwrap();

    send(&mut ws, proto::ClientMsg::VoiceSettingsGet).await;
    let (_, _, models) = next_matching(&mut ws, voice_settings_msg).await;
    assert_eq!(
        models.iter().find(|m| m.id == "ggml-small").unwrap().status,
        proto::VoiceModelStatus::Downloaded { size_bytes: 4096 }
    );

    send(
        &mut ws,
        proto::ClientMsg::VoiceModelDelete {
            model_id: "ggml-small".to_string(),
        },
    )
    .await;
    let model = next_matching(&mut ws, voice_model_msg).await;
    assert_eq!(model.status, proto::VoiceModelStatus::NotDownloaded);
    assert!(!installed.exists(), "delete must actually remove the file");
}

#[tokio::test]
async fn deleting_traversal_and_absolute_model_ids_preserves_external_synthetic_files() {
    let (addr, state_dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    let models_dir = daemon.voice_models_dir();
    std::fs::create_dir_all(&models_dir).unwrap();
    let victim = state_dir.path().join("victim.bin");
    std::fs::write(&victim, b"synthetic protected bytes").unwrap();
    let absolute = victim.with_extension("").to_str().unwrap().to_string();
    for id in ["../victim", absolute.as_str()] {
        send(
            &mut ws,
            proto::ClientMsg::VoiceModelDelete {
                model_id: id.to_string(),
            },
        )
        .await;
        let reason = next_matching(&mut ws, |msg| match msg {
            proto::ServerMsg::Error { message, .. } => Some(message),
            proto::ServerMsg::VoiceModelState { .. } => {
                panic!("a refused deletion must not report a failed model")
            }
            _ => None,
        })
        .await;
        assert!(
            reason.contains(id) || reason.contains(&format!("{id:?}")),
            "{reason}"
        );
        assert!(reason.contains("catalog"), "{reason}");
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"synthetic protected bytes"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn duplicate_download_and_delete_requests_preserve_the_active_download() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut a = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut a).await;
    let mut b = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut b).await;

    // This is the production lease held by a worker awaiting HTTP bytes. Holding
    // it directly lets the authenticated-wire regression avoid outbound HTTP.
    let lease = daemon.voice.claim_download("ggml-small").unwrap();
    lease.progress(0.25);
    send(
        &mut a,
        proto::ClientMsg::VoiceModelDownload {
            model_id: "ggml-small".to_string(),
        },
    )
    .await;
    let on_a = next_matching(&mut a, voice_model_msg).await;
    let on_b = next_matching(&mut b, voice_model_msg).await;
    assert_eq!(on_a, on_b);
    assert_eq!(
        on_a.status,
        proto::VoiceModelStatus::Downloading { progress: 0.25 }
    );

    send(
        &mut b,
        proto::ClientMsg::VoiceModelDelete {
            model_id: "ggml-small".to_string(),
        },
    )
    .await;
    let reason = next_matching(&mut b, |msg| match msg {
        proto::ServerMsg::Error { message, .. } => Some(message),
        proto::ServerMsg::VoiceModelState { model } => {
            panic!("active model state must remain Downloading, got {model:?}")
        }
        _ => None,
    })
    .await;
    assert!(
        reason.contains("ggml-small") && reason.contains("active"),
        "{reason}"
    );
    assert!(daemon.voice.download_in_flight("ggml-small"));
    assert!(daemon.voice.claim_download("ggml-small").is_err());
    assert_eq!(
        daemon.voice_model_state("ggml-small").status,
        proto::VoiceModelStatus::Downloading { progress: 0.25 }
    );

    // Publication while the lease is still held is the state a verified worker
    // produces. A refused deletion must not prevent that worker completing.
    let models_dir = daemon.voice_models_dir();
    std::fs::create_dir_all(&models_dir).unwrap();
    let installed = models_dir.join("ggml-small.bin");
    std::fs::write(&installed, b"verified fixture").unwrap();
    lease.finish(None);
    send(
        &mut a,
        proto::ClientMsg::VoiceModelDelete {
            model_id: "ggml-small".to_string(),
        },
    )
    .await;
    let deleted = next_matching(&mut a, voice_model_msg).await;
    assert_eq!(deleted.status, proto::VoiceModelStatus::NotDownloaded);
    assert!(!installed.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn daemon_download_admission_precedes_the_spawned_workers_first_poll() {
    let (_addr, _dir, daemon) = start_daemon_with_handle().await;
    // No await after admission: the current-thread runtime cannot poll the worker
    // or make a network request before the test runtime cancels it on teardown.
    daemon.voice_model_download("ggml-small".to_string());
    assert!(
        daemon.voice.download_in_flight("ggml-small"),
        "admission must be visible before the worker runs"
    );
    assert!(daemon.voice.claim_download("ggml-small").is_err());
    daemon.voice_model_download("ggml-small".to_string());
    assert!(daemon.voice.download_in_flight("ggml-small"));
}

#[tokio::test]
async fn a_local_engine_with_no_model_refuses_by_name() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    daemon
        .voice_settings_set(&proto::VoiceSettings {
            enabled: true,
            mic_policy: proto::MicPolicy::OnKeypress,
            ..proto::VoiceSettings::default()
        })
        .unwrap();

    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        common::create_custom_msg(
            if cfg!(windows) {
                vec![
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ]
            } else {
                vec!["sh", "-c", "sleep 30"]
            },
            std::path::Path::new(if cfg!(windows) { "C:\\" } else { "/tmp" }),
        ),
    ))
    .await
    .unwrap();
    let info = common::expect_created(&mut ws).await;

    send(&mut ws, proto::ClientMsg::VoiceStart { session: info.id }).await;
    let state = next_matching(&mut ws, voice_state_msg).await;
    assert_eq!(
        state,
        proto::VoiceState::Error {
            failure: proto::VoiceFailure::NoModel {
                model_id: "ggml-small".to_string()
            }
        }
    );
    assert!(
        !daemon.voice.is_open(),
        "a refused start must not have opened a microphone"
    );
}

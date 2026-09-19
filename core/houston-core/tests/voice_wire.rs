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

    assert_eq!(models.len(), 1, "{models:?}");
    assert_eq!(models[0].id, "ggml-small");
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
        models[0].status,
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
            vec!["sh", "-c", "sleep 30"],
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

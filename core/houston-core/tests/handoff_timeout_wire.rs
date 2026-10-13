mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn generate(ws: &mut WsStream, session: u32, cmd: Vec<&str>) {
    let msg = serde_json::to_string(&proto::ClientMsg::HandoffGenerate {
        session,
        provider: proto::AgentKind::Custom,
        cmd: Some(cmd.into_iter().map(String::from).collect()),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
}

async fn expect_started(ws: &mut WsStream) -> u32 {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::HandoffStarted { request, .. } => return request,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn silent_generator_times_out() {
    std::env::set_var("HOUSTON_HANDOFF_TIMEOUT_MS", "1500");
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    #[cfg(unix)]
    let source_cmd = vec!["sh", "-c", "echo src; sleep 600"];
    #[cfg(windows)]
    let source_cmd = vec![
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Write-Output src; Start-Sleep -Seconds 600",
    ];
    ws.send(Message::text(create_custom_msg(source_cmd, project.path())))
        .await
        .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "src").await;

    #[cfg(unix)]
    let generator_cmd = vec!["sh", "-c", "sleep 600", "sh"];
    #[cfg(windows)]
    let script = project.path().join("silent.ps1");
    #[cfg(windows)]
    std::fs::write(&script, "Start-Sleep -Seconds 600\n").unwrap();
    #[cfg(windows)]
    let generator_cmd = vec![
        "powershell.exe",
        "-NoProfile",
        "-File",
        script.to_str().unwrap(),
    ];
    generate(&mut ws, source, generator_cmd).await;
    let request = expect_started(&mut ws).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout error never arrived"
        );
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffError {
                request: r,
                message,
            } if r == request => {
                assert!(
                    message.contains("no output") || message.contains("generator deadline"),
                    "got: {message}"
                );
                break;
            }
            proto::ServerMsg::HandoffDone { .. } => panic!("must not succeed"),
            _ => continue,
        }
    }
    daemon.close(source).unwrap();
}

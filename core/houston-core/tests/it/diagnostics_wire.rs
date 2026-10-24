use crate::common;

use common::{
    collect_output_until, connect_and_hello, create_custom_msg, expect_created, next_control,
    start_daemon_with_handle, TOKEN,
};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

const SECRET: &str = "ghp_0123456789abcdefghijABCDEFGHIJ0123456789";

#[tokio::test]
async fn the_diagnostics_file_is_redacted_capped_and_holds_no_terminal_output() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let logs = state.path().join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let mut log = "INFO filler line that only takes room\n".repeat(60_000);
    log.push_str(&format!("WARN pushing with token {SECRET}\n"));
    log.push_str("INFO NEWEST-LOG-LINE\n");
    std::fs::write(logs.join("houston-core.2026-10-24.log"), log).unwrap();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let project = tempfile::tempdir().unwrap();
    // The marker is split in the command line, so only the pane's output spells it whole.
    #[cfg(unix)]
    let cmd = vec!["sh", "-c", "echo TERM-''MARKER; sleep 30"];
    #[cfg(windows)]
    let cmd = vec![
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Write-Output ('TERM-' + 'MARKER'); Start-Sleep 30",
    ];
    ws.send(Message::text(create_custom_msg(cmd, project.path())))
        .await
        .unwrap();
    let info = expect_created(&mut ws).await;
    collect_output_until(&mut ws, info.id, "TERM-MARKER").await;

    let msg = proto::ClientMsg::DiagnosticsCollect {
        app_version: "9.9.9-test".into(),
    };
    ws.send(Message::text(serde_json::to_string(&msg).unwrap()))
        .await
        .unwrap();
    let (path, bytes) = loop {
        if let proto::ServerMsg::DiagnosticsCollected { path, bytes, error } =
            next_control(&mut ws).await
        {
            assert_eq!(error, None);
            break (
                std::path::PathBuf::from(path.expect("a written file")),
                bytes,
            );
        }
    };
    assert_eq!(
        path.parent(),
        Some(state.path().join("diagnostics").as_path())
    );
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.len() as u64, bytes);
    assert!(text.len() <= houston_core::diagnostics::FILE_MAX_BYTES);
    assert!(text.contains("App: 9.9.9-test"), "{}", &text[..400]);
    assert!(
        text.contains(&format!("#{} agent=custom state=running", info.id)),
        "the roster lists the pane: {}",
        &text[..text.len().min(2000)]
    );
    assert!(text.contains("NEWEST-LOG-LINE"));
    assert!(text.contains("WARN pushing with token"));
    assert!(!text.contains(SECRET), "a seeded secret leaked");
    assert!(!text.contains("TERM-MARKER"), "terminal output leaked");
    let project_dir = project.path().display().to_string();
    assert!(!text.contains(&project_dir), "the working directory leaked");
    daemon.kill(info.id).ok();
}

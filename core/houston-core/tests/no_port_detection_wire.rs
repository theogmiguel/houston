mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig, Outbound};
use houston_protocol as proto;
use tokio::sync::broadcast::error::RecvError;

#[tokio::test]
async fn no_port_broadcast_for_localhost_urls() {
    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let tmp = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();

    #[cfg(unix)]
    let argv: Vec<String> = vec![
        "bash",
        "-lc",
        "echo serving at http://127.0.0.1:8123/; \
         echo bind 0.0.0.0 port 8123 (http://0.0.0.0:8123/); \
         echo vite at http://localhost:5173/; \
         echo listening on 127.0.0.1:3000; \
         echo PORT_TEST_DONE",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    #[cfg(windows)]
    let argv: Vec<String> = vec![
        "powershell",
        "-NoProfile",
        "-Command",
        "Write-Output 'serving at http://127.0.0.1:8123/'; \
         Write-Output 'bind 0.0.0.0 port 8123 (http://0.0.0.0:8123/)'; \
         Write-Output 'vite at http://localhost:5173/'; \
         Write-Output 'listening on 127.0.0.1:3000'; \
         Write-Output 'PORT_TEST_DONE'",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let id = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            cmd: Some(argv),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap()
        .id;

    let mut output = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("timed out waiting for PORT_TEST_DONE with no port broadcast seen");
        let out = match tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("timed out waiting for PORT_TEST_DONE with no port broadcast seen")
        {
            Ok(o) => o,
            Err(RecvError::Lagged(n)) => panic!(
                "broadcast receiver lagged by {n} messages while waiting for PORT_TEST_DONE on \
                 session {id} -- a dropped message could hide a resurrected port broadcast"
            ),
            Err(RecvError::Closed) => panic!("daemon broadcast closed unexpectedly"),
        };
        match out {
            Outbound::Control(json) | Outbound::ControlFor(_, json) => {
                assert!(
                    !json.to_lowercase().contains("port"),
                    "unexpected port-related control message: {json}"
                );
            }
            Outbound::Frame(buf) => {
                if let Some((sid, _offset, payload)) = houston_protocol::decode_output_frame(&buf) {
                    if sid == id {
                        output.push_str(&String::from_utf8_lossy(payload));
                        if output.contains("PORT_TEST_DONE") {
                            break;
                        }
                    }
                }
            }
        }
    }

    daemon.kill(id).ok();
}

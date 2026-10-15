#![cfg(all(unix, feature = "test-barriers"))]

use crate::common;
use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

struct OwnedSource(std::sync::Arc<houston_core::daemon::Daemon>, u32);
impl Drop for OwnedSource {
    fn drop(&mut self) {
        self.0
            .close(self.1)
            .expect("close the owned handoff source");
    }
}

struct Barrier {
    dir: tempfile::TempDir,
    previous: Option<std::ffi::OsString>,
}
impl Drop for Barrier {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.dir.path().join("armed"));
        if let Some(previous) = &self.previous {
            std::env::set_var("HOUSTON_TEST_BARRIER_DIR", previous);
        } else {
            std::env::remove_var("HOUSTON_TEST_BARRIER_DIR");
        }
    }
}

#[tokio::test]
async fn a_fast_handoff_publishes_started_before_output_and_completion() {
    let (addr, _state, daemon) = start_daemon_with_handle().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    ws.send(Message::text(create_custom_msg(
        vec!["/bin/cat"],
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    let _source = OwnedSource(daemon.clone(), source);
    let barrier = Barrier {
        dir: tempfile::tempdir().unwrap(),
        previous: std::env::var_os("HOUSTON_TEST_BARRIER_DIR"),
    };
    std::env::set_var("HOUSTON_TEST_BARRIER_DIR", barrier.dir.path());
    std::fs::write(barrier.dir.path().join("armed"), "handoff-before-started").unwrap();
    let ready = project.path().join("generator-ran");
    let mut observer = daemon.observe();
    let task = tokio::task::spawn_blocking({
        let daemon = daemon.clone();
        let ready = ready.clone();
        move || {
            daemon
                .handoff_generate(
                    source,
                    proto::AgentKind::Custom,
                    Some(vec![
            "/bin/sh".into(), "-c".into(),
            "printf '<<<START>>>\\n## Summary\\nfast-handoff\\n<<<END>>>\\n'; : > \"$1\"".into(),
            "sh".into(), ready.display().to_string(),
        ]),
                )
                .unwrap()
        }
    });
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let reached =
                std::fs::read_to_string(barrier.dir.path().join("reached")).unwrap_or_default();
            if reached.starts_with("handoff-before-started ") && ready.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("physical generator ran at pre-publication barrier");
    assert!(
        tokio::time::timeout(
            Duration::from_millis(500),
            next_broadcast_control(&mut observer)
        )
        .await
        .is_err(),
        "no output/completion may precede HandoffStarted"
    );
    std::fs::remove_file(barrier.dir.path().join("armed")).unwrap();
    let request = task.await.unwrap();
    assert!(matches!(next_broadcast_control(&mut observer).await,
        proto::ServerMsg::HandoffStarted { request: r, session, .. } if r == request && session == source));
    let mut chunks = String::new();
    loop {
        match next_broadcast_control(&mut observer).await {
            proto::ServerMsg::HandoffChunk { request: r, text } if r == request => {
                chunks.push_str(&text)
            }
            proto::ServerMsg::HandoffDone {
                request: r,
                markdown,
                ..
            } if r == request => {
                assert_eq!(markdown, "## Summary\nfast-handoff");
                break;
            }
            other => panic!("unexpected handoff event: {other:?}"),
        }
    }
    assert!(
        chunks.contains("fast-handoff"),
        "actual generator output: {chunks:?}"
    );
}

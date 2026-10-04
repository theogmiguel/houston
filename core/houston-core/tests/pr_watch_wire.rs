#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::{connect_and_hello, start_daemon_with_handle, TOKEN};
use futures_util::{SinkExt, StreamExt};
use houston_core::daemon::CreateParams;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Rig {
    daemon: std::sync::Arc<houston_core::daemon::Daemon>,
    state: tempfile::TempDir,
    addr: std::net::SocketAddr,
    session: u32,
}

async fn rig() -> Rig {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = state.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&workspace)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("git")
        .args([
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git"
        ])
        .current_dir(&workspace)
        .status()
        .unwrap()
        .success());
    daemon
        .workspace_add(&workspace.display().to_string())
        .unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: workspace.clone(),
            cmd: Some(vec!["/bin/sh".into(), "-c".into(), "exec sleep 60".into()]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap();
    Rig {
        daemon,
        state,
        addr,
        session: info.id,
    }
}

fn write_fake_gh(bin: &Path, fixture: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).unwrap();
    let script = format!(
        "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'gh version 2.0.0'; exit 0;;\n  auth) exit 0;;\n  api) echo watcher; exit 0;;\n  pr) cat '{}' ; exit 0;;\nesac\nexit 1\n",
        fixture.display()
    );
    let path = bin.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn pr(state: &str, sha: &str, conclusion: &str) -> String {
    format!(
        r#"{{"number":7,"url":"https://github.com/owner/repo/pull/7","state":"{state}","mergedAt":{},"headRefOid":"{sha}","title":"Change","author":{{"login":"author"}},"baseRefName":"main","headRefName":"feature","mergeable":"MERGEABLE","statusCheckRollup":[{{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"{conclusion}"}}],"comments":[],"reviews":[]}}"#,
        if state == "MERGED" {
            "\"2026-10-04T00:00:00Z\""
        } else {
            "null"
        }
    )
}

#[tokio::test]
async fn fake_gh_wakes_once_per_failed_head_then_merge_ends_persisted_watch() {
    let _guard = SERIAL.lock().await;
    let rig = rig().await;
    let fixture = rig.state.path().join("pr.json");
    std::fs::write(&fixture, pr("OPEN", "abc", "SUCCESS")).unwrap();
    let bin = rig.state.path().join("bin");
    write_fake_gh(&bin, &fixture);
    let previous_path = std::env::var_os("PATH");
    std::env::set_var(
        "PATH",
        format!(
            "{}:{}",
            bin.display(),
            previous_path
                .as_deref()
                .unwrap_or_default()
                .to_string_lossy()
        ),
    );

    rig.daemon.pr_watch_start(rig.session, "7").unwrap();
    assert_eq!(rig.daemon.pr_watch_infos().unwrap()[0].watches[0].number, 7);
    let reopened = houston_core::db::Db::open(&rig.state.path().join("test.db")).unwrap();
    assert_eq!(reopened.pr_watch_list(Some(rig.session)).unwrap().len(), 1);

    std::fs::write(&fixture, pr("OPEN", "abc", "FAILURE")).unwrap();
    rig.daemon.pr_watch_tick();
    rig.daemon.pr_watch_tick();
    let rows = rig.daemon.inbox_rows_for_test(rig.session);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].body.contains("build (failure)"));

    std::fs::write(&fixture, pr("OPEN", "def", "FAILURE")).unwrap();
    rig.daemon.pr_watch_tick();
    assert_eq!(rig.daemon.inbox_rows_for_test(rig.session).len(), 2);

    std::fs::write(&fixture, pr("MERGED", "def", "SUCCESS")).unwrap();
    rig.daemon.pr_watch_tick();
    assert!(rig.daemon.pr_watch_infos().unwrap().is_empty());
    assert_eq!(reopened.pr_watch_list(Some(rig.session)).unwrap().len(), 0);

    std::fs::write(&fixture, pr("OPEN", "def", "SUCCESS")).unwrap();
    rig.daemon
        .pr_watch_start(rig.session, "https://github.com/owner/repo/pull/7")
        .unwrap();
    for second in 1..=10 {
        let mut value: serde_json::Value =
            serde_json::from_str(&pr("OPEN", "def", "SUCCESS")).unwrap();
        value["comments"] = serde_json::json!([{
            "id": format!("comment-{second}"),
            "author": {"login": "reviewer"},
            "body": format!("review note {second}"),
            "createdAt": format!("2030-01-01T00:00:{second:02}Z")
        }]);
        std::fs::write(&fixture, value.to_string()).unwrap();
        rig.daemon.pr_watch_tick();
    }
    assert!(rig.daemon.pr_watch_infos().unwrap().is_empty());

    std::fs::write(&fixture, pr("OPEN", "def", "SUCCESS")).unwrap();
    rig.daemon.pr_watch_start(rig.session, "7").unwrap();
    std::fs::write(&fixture, "{}").unwrap();
    for _ in 0..15 {
        rig.daemon.pr_watch_tick();
    }
    assert!(rig.daemon.pr_watch_infos().unwrap().is_empty());

    std::fs::write(&fixture, pr("OPEN", "def", "SUCCESS")).unwrap();
    rig.daemon.pr_watch_start(rig.session, "7").unwrap();
    let mut ws = connect_and_hello(rig.addr, TOKEN).await;
    ws.send(Message::Text(
        serde_json::to_string(&proto::ClientMsg::PrWatchUnwatch {
            session: rig.session,
            number: 7,
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let message: proto::ServerMsg = serde_json::from_str(event.to_text().unwrap()).unwrap();
        if let proto::ServerMsg::PrWatchChanged { session, watches } = message {
            if session == rig.session {
                assert!(watches.is_empty());
                break;
            }
        }
    }
    assert!(rig.daemon.pr_watch_infos().unwrap().is_empty());

    if let Some(path) = previous_path {
        std::env::set_var("PATH", path);
    }
    let _ = rig.daemon.kill(rig.session);
    let _ = rig.daemon.close(rig.session);
}

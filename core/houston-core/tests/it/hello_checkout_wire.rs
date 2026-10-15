#![allow(clippy::disallowed_methods)]

use crate::common;

use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

use common::{connect_and_hello, next_control, start_daemon_with_handle, WsStream, TOKEN};

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "test@example.invalid"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README.md"), "hello checkout\n").unwrap();
    git(dir, &["add", "README.md"]);
    git(dir, &["commit", "-m", "initial"]);
}

fn long_running_session(daemon: &Arc<Daemon>, dir: &Path) -> proto::SessionInfo {
    #[cfg(unix)]
    let cmd = vec!["sleep".into(), "60".into()];
    #[cfg(windows)]
    let cmd = vec!["ping".into(), "-n".into(), "61".into(), "127.0.0.1".into()];
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(cmd),
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
        .unwrap()
}

async fn wait_for_branch(ws: &mut WsStream, id: u32, expected: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let proto::ServerMsg::SessionCheckout {
                id: event_id,
                checkout,
            } = next_control(ws).await
            {
                if event_id == id
                    && checkout.and_then(|value| value.branch).as_deref() == Some(expected)
                {
                    return;
                }
            }
        }
    })
    .await
    .expect("the HEAD watcher should broadcast the branch switch within five seconds");
}

/// Background work (spawn, the watcher's first refresh) settles before the hello is measured.
async fn settled_git_processes(trace: &Path) -> usize {
    let mut last = common::git_processes_started(trace);
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let now = common::git_processes_started(trace);
        if now == last {
            return now;
        }
        last = now;
    }
    panic!("git kept starting in the background: {last} processes after 30 s");
}

#[tokio::test]
async fn attaching_a_window_lists_current_checkouts_without_running_git() {
    let repos: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    for repo in &repos {
        init_repo(repo.path());
    }
    let folders: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let trace_dir = tempfile::tempdir().unwrap();
    let trace = trace_dir.path().join("git-trace2.json");
    common::trace_git_processes(&trace);

    let (addr, _state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(houston_core::checkout_watch::checkout_watch_loop(
        daemon.clone(),
    ));
    let mut watching = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut watching).await;
    let repo_sessions: Vec<_> = repos
        .iter()
        .map(|repo| long_running_session(&daemon, repo.path()))
        .collect();
    let folder_sessions: Vec<_> = folders
        .iter()
        .map(|folder| long_running_session(&daemon, folder.path()))
        .collect();

    git(repos[0].path(), &["switch", "-c", "x"]);
    wait_for_branch(&mut watching, repo_sessions[0].id, "x").await;

    let before = settled_git_processes(&trace).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let proto::ServerMsg::HelloOk { sessions, .. } = next_control(&mut ws).await else {
        panic!("expected HelloOk first");
    };
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionList).unwrap(),
    ))
    .await
    .unwrap();
    let listed = loop {
        if let proto::ServerMsg::SessionList { sessions } = next_control(&mut ws).await {
            break sessions;
        }
    };
    let started = common::git_processes_started(&trace) - before;
    let count = repo_sessions.len() + folder_sessions.len();
    assert_eq!(
        started,
        0,
        "a hello and a session list over {count} sessions started {started} git processes; \
         expected none (trace {})",
        trace.display()
    );

    for roster in [&sessions, &listed] {
        let find = |id: u32| roster.iter().find(|info| info.id == id).unwrap();
        for (index, created) in repo_sessions.iter().enumerate() {
            let info = find(created.id);
            let checkout = info
                .checkout
                .as_ref()
                .expect("a repository session's checkout");
            assert_eq!(checkout.kind, proto::CheckoutKind::Primary, "{info:?}");
            let branch = if index == 0 { "x" } else { "main" };
            assert_eq!(checkout.branch.as_deref(), Some(branch), "{info:?}");
            assert!(info.checkout_root.is_some(), "{info:?}");
            assert_eq!(info.checkout_root, created.checkout_root, "{info:?}");
        }
        for created in &folder_sessions {
            let info = find(created.id);
            let checkout = info.checkout.as_ref().expect("a folder session's checkout");
            assert_eq!(checkout.kind, proto::CheckoutKind::Folder, "{info:?}");
            assert_eq!(checkout.root, info.project_dir, "{info:?}");
            assert_eq!(info.checkout_root, None, "{info:?}");
        }
    }

    for session in repo_sessions.iter().chain(&folder_sessions) {
        daemon.kill(session.id).ok();
    }
}

fn stored_session(id: u32, dir: &Path) -> proto::SessionInfo {
    proto::SessionInfo {
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id,
        agent: proto::AgentKind::Shell,
        project_dir: dir.display().to_string(),
        cwd: dir.display().to_string(),
        state: proto::SessionState::Running,
        title: format!("Husk-{id}"),
        codename: format!("Husk-{id}"),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by: None,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin: None,
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
    }
}

#[tokio::test]
async fn a_restored_session_gets_its_checkout_from_the_watcher_not_the_listing() {
    use houston_core::daemon::{DaemonConfig, Outbound};
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    {
        let db = houston_core::db::Db::open(&db_path).unwrap();
        db.insert_session(&stored_session(7, repo.path())).unwrap();
        db.acknowledge_uncontained_recovery(7).unwrap();
    }
    let trace_dir = tempfile::tempdir().unwrap();
    let trace = trace_dir.path().join("git-trace2.json");
    common::trace_git_processes(&trace);
    // Auto-restore would respawn the session under a new id before the listing.
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        db_path,
        common::base_env().with("HOUSTON_DISABLE_AUTO_RESTORE", Some("1")),
    ))
    .unwrap();

    let before = common::git_processes_started(&trace);
    let restored = daemon.list().into_iter().find(|info| info.id == 7).unwrap();
    assert_eq!(
        restored.state,
        proto::SessionState::Interrupted,
        "{restored:?}"
    );
    let started = common::git_processes_started(&trace) - before;
    assert_eq!(
        started, 0,
        "listing a restored session started {started} git processes"
    );

    let mut rx = daemon.subscribe();
    tokio::spawn(houston_core::checkout_watch::checkout_watch_loop(
        daemon.clone(),
    ));
    let checkout = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (Outbound::Control(json) | Outbound::ControlFor(_, json)) =
                rx.recv().await.unwrap()
            else {
                continue;
            };
            if let Ok(proto::ServerMsg::SessionCheckout { id: 7, checkout }) =
                serde_json::from_str(&json)
            {
                return checkout;
            }
        }
    })
    .await
    .expect("the watcher should resolve a restored session's checkout within five seconds");
    assert_eq!(
        checkout.as_ref().and_then(|c| c.branch.as_deref()),
        Some("main")
    );

    let listed = daemon.list().into_iter().find(|info| info.id == 7).unwrap();
    assert_eq!(listed.checkout, checkout);
    assert!(listed.checkout_root.is_some(), "{listed:?}");
    assert!(matches!(
        listed.checkout.as_ref().map(|c| &c.kind),
        Some(proto::CheckoutKind::Primary)
    ));
}

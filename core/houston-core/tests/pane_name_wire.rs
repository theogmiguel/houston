#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_core::hook_drop::{self, HookDrop};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;

use common::start_daemon_with_handle;

static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        std::fs::write(
            dir.join("claude"),
            "#!/bin/sh\nstty -echo 2>/dev/null\nexec cat\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("claude"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        dir
    })
    .clone()
}

fn spawn(daemon: &Arc<Daemon>, ws: &Path) -> proto::SessionInfo {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: ws.to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .expect("the pane spawns")
}

fn title_of(daemon: &Arc<Daemon>, id: u32) -> String {
    daemon
        .list()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.title)
        .expect("the pane is on the roster")
}

fn submit(daemon: &Arc<Daemon>, state: &Path, session: u32, prompt: Option<&str>) {
    let d = HookDrop {
        v: hook_drop::DROP_V,
        event: "UserPromptSubmit".into(),
        session,
        cwd: None,
        agent: None,
        prompt: prompt.map(str::to_owned),
        ..Default::default()
    };
    let dir = hook_drop::drop_dir(state);
    hook_drop::write_drop(&dir, &d, hook_drop::now_ms()).unwrap();
    assert_eq!(daemon.hook_drop_tick_for_test(), 1, "the drop applied");
}

#[tokio::test]
async fn the_first_prompt_names_the_pane_and_the_second_does_not() {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();

    let info = spawn(&daemon, &ws);
    assert_eq!(
        title_of(&daemon, info.id),
        info.title,
        "a codename until a prompt"
    );

    submit(
        &daemon,
        state.path(),
        info.id,
        Some("review @acme-api\nmore"),
    );
    assert_eq!(title_of(&daemon, info.id), "Review acme api");

    submit(
        &daemon,
        state.path(),
        info.id,
        Some("now do something else"),
    );
    assert_eq!(
        title_of(&daemon, info.id),
        "Review acme api",
        "only the FIRST prompt names a pane"
    );
    daemon.kill(info.id).ok();
}

#[tokio::test]
async fn a_user_rename_wins_a_taken_name_is_suffixed_and_no_prompt_names_nothing() {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();

    let first = spawn(&daemon, &ws);
    let second = spawn(&daemon, &ws);
    let third = spawn(&daemon, &ws);

    submit(&daemon, state.path(), first.id, Some("lint sweep"));
    submit(&daemon, state.path(), second.id, Some("Lint   sweep"));
    assert_eq!(title_of(&daemon, first.id), "Lint sweep");
    assert_eq!(title_of(&daemon, second.id), "Lint sweep-2");

    daemon.rename(third.id, "Mine").unwrap();
    submit(&daemon, state.path(), third.id, Some("lint sweep"));
    assert_eq!(title_of(&daemon, third.id), "Mine");

    let fourth = spawn(&daemon, &ws);
    submit(&daemon, state.path(), fourth.id, None);
    submit(&daemon, state.path(), fourth.id, Some("@ / ..."));
    assert_eq!(title_of(&daemon, fourth.id), fourth.title);

    for id in [first.id, second.id, third.id, fourth.id] {
        daemon.kill(id).ok();
    }
}

#[tokio::test]
async fn a_hook_marks_the_running_cli_in_a_shell_pane() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws = state.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: ws.clone(),
            cmd: Some(vec![
                "sh".into(),
                "-c".into(),
                "stty -echo; exec cat".into(),
            ]),
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .expect("the shell pane spawns");
    let detected = |d: &Arc<Daemon>| {
        d.list()
            .into_iter()
            .find(|s| s.id == info.id)
            .and_then(|s| s.detected_agent)
    };
    assert_eq!(detected(&daemon), None);

    submit(&daemon, state.path(), info.id, Some("hello"));
    assert_eq!(detected(&daemon), Some(proto::AgentKind::Claude));
    daemon.kill(info.id).ok();
}

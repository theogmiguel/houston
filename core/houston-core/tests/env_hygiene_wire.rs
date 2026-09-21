mod common;

use common::{collect_broadcast_until, TOKEN};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;

#[tokio::test]
async fn a_spawned_session_does_not_inherit_the_launchers_session_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let dump = tmp.path().join("child-env.txt");

    std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
    std::env::set_var("CLAUDECODE", "1");
    std::env::set_var("CLAUDE_CODE_SESSION_ID", "the-launchers-session");
    std::env::set_var("CLAUDE_EFFORT", "xhigh");
    std::env::set_var("NO_COLOR", "1");
    houston_core::env_hygiene::scrub();

    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();

    let mut rx = daemon.observe();

    let dump_sh = dump.display().to_string().replace('\\', "/");
    let cmd = format!("env > {dump_sh} && echo DUMPED && sleep 30");
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
            cmd: Some(vec!["sh".to_string(), "-c".to_string(), cmd]),
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
    collect_broadcast_until(&mut rx, info.id, "DUMPED").await;

    let child_env = std::fs::read_to_string(&dump).expect("the pane dumped its environment");
    let lines: Vec<&str> = child_env.lines().collect();
    let has = |prefix: &str| lines.iter().any(|l| l.starts_with(prefix));

    assert!(
        has("TR_SESSION="),
        "sanity: this really is a daemon-spawned pane: {child_env}"
    );
    for marker in [
        "CLAUDE_CODE_CHILD_SESSION=",
        "CLAUDECODE=",
        "CLAUDE_CODE_SESSION_ID=",
    ] {
        assert!(!has(marker), "pane inherited {marker} — {child_env}");
    }
    assert!(
        has("CLAUDE_EFFORT=xhigh"),
        "a config var must survive the scrub: {child_env}"
    );
    assert!(
        !has("NO_COLOR="),
        "launcher log colours must not disable pane colours"
    );
    assert!(has("COLORTERM=truecolor"));

    daemon.kill(info.id).ok();
}

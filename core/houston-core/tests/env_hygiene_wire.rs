mod common;

use common::{collect_broadcast_until, TOKEN};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;

#[tokio::test]
async fn a_spawned_session_does_not_inherit_the_launchers_session_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let dump = tmp.path().join("child-env.txt");
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("USERPROFILE", tmp.path());

    std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
    std::env::set_var("CLAUDECODE", "1");
    std::env::set_var("CLAUDE_CODE_SESSION_ID", "the-launchers-session");
    std::env::set_var("CLAUDE_EFFORT", "xhigh");
    std::env::set_var("NO_COLOR", "1");
    std::env::set_var("TERM", "dumb");
    std::env::set_var("HOUSTON_SUPERVISOR_FD", "3");
    houston_core::env_hygiene::scrub();
    assert!(std::env::var_os("HOUSTON_SUPERVISOR_FD").is_none());
    std::env::set_var("HOUSTON_SUPERVISOR_FD", "3");

    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();

    let mut rx = daemon.observe();

    let dump_sh = dump.display().to_string().replace('\\', "/");
    #[cfg(unix)]
    let cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        format!("env > '{dump_sh}' && touch '{dump_sh}.ready' && echo DUMPED && sleep 30"),
    ];
    #[cfg(windows)]
    let cmd = vec![
        "powershell.exe".to_string(),
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-Command".to_string(),
        format!(
            "Get-ChildItem Env: | ForEach-Object {{ $_.Name + '=' + $_.Value }} | \
             Set-Content -Encoding utf8 -LiteralPath '{dump_sh}'; \
             [IO.File]::WriteAllText('{dump_sh}.ready', 'ready'); \
             Write-Output DUMPED; Start-Sleep -Seconds 30"
        ),
    ];
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tmp.path().to_path_buf(),
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
        .unwrap();
    collect_broadcast_until(&mut rx, info.id, "DUMPED").await;

    // ConPTY may echo the launch command before its output file is ready.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !tmp.path().join("child-env.txt.ready").is_file() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "environment dump was not created"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

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
        !has("HOUSTON_SUPERVISOR_FD="),
        "pane inherited the private supervisor variable"
    );
    assert!(
        has("CLAUDE_EFFORT=xhigh"),
        "a config var must survive the scrub: {child_env}"
    );
    assert!(
        !has("NO_COLOR="),
        "launcher log colours must not disable pane colours"
    );
    assert!(has("COLORTERM=truecolor"));
    assert!(
        has("TERM=xterm-256color"),
        "a pane must advertise its own terminal capabilities"
    );

    daemon.kill(info.id).ok();
    std::env::remove_var("HOUSTON_SUPERVISOR_FD");
}

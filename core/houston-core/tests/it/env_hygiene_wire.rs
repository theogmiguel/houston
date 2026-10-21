#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
use crate::common;

use common::{escaped_tail, TOKEN};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;

/// Session markers of an enclosing agent, multiplexer or Electron host; a pane must not inherit any.
const LAUNCHER_MARKERS: [(&str, &str); 10] = [
    ("CLAUDE_CODE_CHILD_SESSION", "1"),
    ("CLAUDECODE", "1"),
    ("CLAUDE_CODE_SESSION_ID", "the-launchers-session"),
    ("TMUX", "/tmp/tmux-1000/default,1234,0"),
    ("TMUX_PANE", "%3"),
    ("STY", "1234.pts-0.host"),
    ("ZELLIJ", "0"),
    ("ZELLIJ_SESSION_NAME", "outer"),
    ("ZELLIJ_PANE_ID", "2"),
    ("ELECTRON_RUN_AS_NODE", "1"),
];

#[tokio::test]
async fn a_spawned_session_does_not_inherit_the_launchers_session_markers() {
    let tmp = tempfile::tempdir().unwrap();
    let dump = tmp.path().join("child-env.txt");
    std::env::set_var("HOME", tmp.path());
    std::env::set_var("USERPROFILE", tmp.path());

    for (name, value) in LAUNCHER_MARKERS {
        std::env::set_var(name, value);
    }
    std::env::set_var("CLAUDE_EFFORT", "xhigh");
    std::env::set_var("NO_COLOR", "1");
    std::env::set_var("TERM", "dumb");
    std::env::set_var("HOUSTON_SUPERVISOR_FD", "3");
    houston_core::env_hygiene::scrub();
    assert!(std::env::var_os("HOUSTON_SUPERVISOR_FD").is_none());
    std::env::set_var("HOUSTON_SUPERVISOR_FD", "3");

    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state_dir.path().join("test.db"),
        common::base_env(),
    ))
    .unwrap();

    let dump_sh = dump.display().to_string().replace('\\', "/");
    #[cfg(unix)]
    let cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        format!("env > '{dump_sh}' && touch '{dump_sh}.ready' && sleep 30"),
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
             Start-Sleep -Seconds 30"
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

    // Passing Windows CI runs took up to 14 s to start PowerShell and dump, against a 15 s
    // output budget; this waits on the dump itself, with headroom that still ends a hang.
    const DUMP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
    let ready = tmp.path().join("child-env.txt.ready");
    let deadline = tokio::time::Instant::now() + DUMP_DEADLINE;
    while !ready.is_file() {
        if tokio::time::Instant::now() >= deadline {
            let output = daemon.scrollback(info.id, None).map_or_else(
                |e| format!("<scrollback unavailable: {e}>"),
                |replay| escaped_tail(&replay.data),
            );
            panic!(
                "session {} did not write {} within {DUMP_DEADLINE:?}; its output so far: \"{output}\"",
                info.id,
                ready.display()
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let child_env = std::fs::read_to_string(&dump).expect("the pane dumped its environment");
    let lines: Vec<&str> = child_env.lines().collect();
    let has = |prefix: &str| lines.iter().any(|l| l.starts_with(prefix));

    assert!(
        has("TR_SESSION="),
        "sanity: this really is a daemon-spawned pane: {child_env}"
    );
    for (name, _) in LAUNCHER_MARKERS {
        assert!(
            !has(&format!("{name}=")),
            "pane inherited {name} — {child_env}"
        );
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

#![cfg(windows)]

use crate::common;
use houston_core::{codex_pane, spawn};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

fn fixture(directory: &Path, supported: bool) -> std::path::PathBuf {
    let path = directory.join("codex fixture.cmd");
    let help = if supported { "--no-daemon" } else { "old CLI" };
    std::fs::write(
        &path,
        format!(
            r#"@echo off
if "%~1"=="--help" (
echo {help}
exit /b 0
)
echo ARGV %*
echo IDENTITY %HOUSTON_SESSION% %HOUSTON_MCP_TOKEN%
if defined HOUSTON_LAUNCH_FIXTURE (
echo ARGV %* > "%HOUSTON_LAUNCH_FIXTURE%\receipt-%HOUSTON_SESSION%.txt"
echo IDENTITY %HOUSTON_SESSION% %HOUSTON_MCP_TOKEN% >> "%HOUSTON_LAUNCH_FIXTURE%\receipt-%HOUSTON_SESSION%.txt"
)
if "%FIXTURE_STDIN%"=="1" more
exit /b 23
"#
        )
        .replace('\n', "\r\n"),
    )
    .unwrap();
    path
}

#[test]
fn daemon_direct_custom_and_typed_shell_launches_keep_distinct_credentials() {
    use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
    use houston_protocol::AgentKind;
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path(), true);
    std::fs::copy(&cli, root.path().join("codex.cmd")).unwrap();
    let custom_script = root.path().join("custom.ps1");
    std::fs::write(&custom_script, r#"[IO.File]::WriteAllLines((Join-Path $env:HOUSTON_LAUNCH_FIXTURE ('receipt-'+$env:HOUSTON_SESSION+'.txt')), @("ARGV $args", "IDENTITY $env:HOUSTON_SESSION $env:HOUSTON_MCP_TOKEN"))"#).unwrap();
    struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Environment {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
    let names = [
        "PATH",
        "HOME",
        "USERPROFILE",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "HOUSTON_LAUNCH_FIXTURE",
        "FIXTURE_STDIN",
        "SHELL",
    ];
    let _environment = Environment(
        names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect(),
    );
    let inherited = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{};{inherited}", root.path().display()));
    for name in [
        "HOME",
        "USERPROFILE",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "HOUSTON_LAUNCH_FIXTURE",
    ] {
        std::env::set_var(name, root.path());
    }
    std::env::set_var("FIXTURE_STDIN", "0");
    std::env::set_var(
        "SHELL",
        houston_core::exe_path::resolve("powershell.exe").unwrap(),
    );
    let project = root.path().join("project with spaces");
    std::fs::create_dir(&project).unwrap();
    let daemon = Daemon::new(DaemonConfig::new(
        "fixture".into(),
        root.path().join("test.db"),
        common::base_env(),
    ))
    .unwrap();
    struct Sessions(std::sync::Arc<Daemon>);
    impl Drop for Sessions {
        fn drop(&mut self) {
            for session in self.0.list() {
                let _ = self.0.kill(session.id);
                let _ = self.0.close(session.id);
            }
        }
    }
    let _sessions = Sessions(daemon.clone());
    daemon.set_session_launcher(Some(env!("CARGO_BIN_EXE_houston-core").into()));
    daemon.set_port(4242);
    let params = |agent, cmd| CreateParams {
        agent,
        project_dir: project.clone(),
        cmd,
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
    };
    let direct = daemon
        .create_session(params(AgentKind::Codex, None))
        .unwrap();
    let custom = daemon
        .create_session(params(
            AgentKind::Codex,
            Some(vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-File".into(),
                custom_script.display().to_string(),
                "custom prompt".into(),
            ]),
        ))
        .unwrap();
    let shell = daemon
        .create_session(params(AgentKind::Shell, None))
        .unwrap();
    daemon
        .write_stdin(shell.id, b"codex \"typed prompt & apostrophe's literal\"\r")
        .unwrap();
    let receipt = |id| {
        let path = root.path().join(format!("receipt-{id}.txt"));
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text.contains("IDENTITY") {
                    return text;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "missing launch receipt {id}: {:?}",
                daemon
                    .scrollback(id, None)
                    .map(|replay| String::from_utf8_lossy(&replay.data).into_owned())
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    };
    let a = receipt(direct.id);
    let b = receipt(custom.id);
    let c = receipt(shell.id);
    for (id, text) in [(direct.id, &a), (custom.id, &b), (shell.id, &c)] {
        assert!(text.contains(&format!("IDENTITY {id} ")), "{text}");
    }
    assert_ne!(
        a.lines()
            .find(|line| line.starts_with("IDENTITY"))
            .and_then(|line| line.split_whitespace().last()),
        c.lines()
            .find(|line| line.starts_with("IDENTITY"))
            .and_then(|line| line.split_whitespace().last())
    );
    assert!(a.contains("--no-daemon"), "{a}");
    assert!(
        c.contains("--no-daemon")
            && c.contains("typed prompt")
            && c.contains("mcp_servers.houston"),
        "{c}"
    );
    assert!(
        b.contains("custom prompt") && !b.contains("--no-daemon"),
        "{b}"
    );
    let cmd_path = houston_core::exe_path::resolve("cmd.exe").unwrap();
    std::env::set_var("SHELL", cmd_path);
    let cmd = daemon
        .create_session(params(AgentKind::Shell, None))
        .unwrap();
    daemon
        .write_stdin(cmd.id, b"codex \"cmd prompt & apostrophe's literal\"\r")
        .unwrap();
    let text = receipt(cmd.id);
    assert!(
        text.contains("--no-daemon") && text.contains("cmd prompt & apostrophe's literal"),
        "{text}"
    );
    let bash = std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap())
        .join("Git/bin/bash.exe");
    assert!(
        bash.is_file(),
        "Git Bash fixture requires {}",
        bash.display()
    );
    std::env::set_var("SHELL", bash);
    let git_bash = daemon
        .create_session(params(AgentKind::Shell, None))
        .unwrap();
    daemon
        .write_stdin(git_bash.id, b"codex 'bash prompt & literal'\r")
        .unwrap();
    let text = receipt(git_bash.id);
    assert!(
        text.contains("--no-daemon") && text.contains("bash prompt & literal"),
        "{text}"
    );
    let _ = daemon.kill(git_bash.id);
    let _ = daemon.kill(cmd.id);
    for session in daemon.list() {
        let _ = daemon.close(session.id);
    }
}

fn invoke(path: &Path, args: &[&str], session: &str, input: Option<&str>) -> std::process::Output {
    let mut command = spawn::command(env!("CARGO_BIN_EXE_houston-core"));
    command
        .args(["codex-shell", "--"])
        .arg(path)
        .args(args)
        .env("HOUSTON_SESSION", session)
        .env("HOUSTON_MCP_TOKEN", format!("token-{session}"))
        .env("HOUSTON_MCP_URL", "http://127.0.0.1:4242/mcp")
        .env("FIXTURE_STDIN", if input.is_some() { "1" } else { "0" });
    let stdin = if let Some(input) = input {
        let file = tempfile::tempfile().unwrap();
        let mut writer = file.try_clone().unwrap();
        writer.write_all(input.as_bytes()).unwrap();
        use std::io::{Seek, SeekFrom};
        writer.seek(SeekFrom::Start(0)).unwrap();
        Stdio::from(file)
    } else {
        Stdio::null()
    };
    spawn::output_within_with_stdin(command, Duration::from_secs(15), stdin)
        .unwrap()
        .unwrap()
}

#[test]
fn launches_preserve_pane_identity_argv_stdin_and_exit_status() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path(), true);
    for session in ["41", "42"] {
        let output = invoke(
            &cli,
            &["exec", "-", "-a", "on-request", "-s", "read-only"],
            session,
            Some("piped prompt\r\n"),
        );
        let text = String::from_utf8_lossy(&output.stdout);
        assert_eq!(output.status.code(), Some(23), "{text}");
        assert!(
            text.contains(&format!("IDENTITY {session} token-{session}")),
            "{text}"
        );
        assert!(text.contains("--no-daemon"), "{text}");
        assert!(
            text.contains("mcp_servers.houston.bearer_token_env_var"),
            "{text}"
        );
        assert!(text.contains("exec - -a on-request -s read-only"), "{text}");
        assert!(text.contains("piped prompt"), "{text}");
        assert!(!text.contains("approval_policy="), "{text}");
        assert!(!text.contains("sandbox_mode="), "{text}");
    }
}

#[test]
fn shared_and_informational_launches_remain_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path(), true);
    for args in [
        vec!["agents"],
        vec!["-m", "x", "queue", "id"],
        vec!["--remote=url"],
        vec!["--remote", "url"],
        vec!["remote-control", "status"],
        vec!["--version"],
    ] {
        let output = invoke(&cli, &args, "41", None);
        let text = String::from_utf8_lossy(&output.stdout);
        assert_eq!(output.status.code(), Some(23), "{text}");
        assert!(!text.contains("--no-daemon"), "{text}");
        assert!(!text.contains("mcp_servers"), "{text}");
    }
    let output = invoke(&cli, &["--no-daemon", "resume", "--last"], "41", None);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout)
            .matches("--no-daemon")
            .count(),
        1
    );
}

#[test]
fn old_missing_and_changed_clis_do_not_receive_an_unsupported_flag() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path(), false);
    assert!(
        !String::from_utf8_lossy(&invoke(&cli, &["resume", "--last"], "41", None).stdout)
            .contains("--no-daemon")
    );
    fixture(root.path(), true);
    assert!(String::from_utf8_lossy(&invoke(&cli, &[], "41", None).stdout).contains("--no-daemon"));
    fixture(root.path(), false);
    assert!(
        !String::from_utf8_lossy(&invoke(&cli, &[], "41", None).stdout).contains("--no-daemon")
    );
    let missing = invoke(&root.path().join("missing.exe"), &[], "41", None);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("missing.exe"));
}

#[test]
fn direct_launch_stays_in_a_real_pty_and_preserves_quoted_prompt() {
    let root = tempfile::tempdir().unwrap();
    let cli = fixture(root.path(), true);
    let mut command = CommandBuilder::new(&cli);
    command.arg("a prompt with spaces & an apostrophe's literal");
    command.env("HOUSTON_SESSION", "81");
    command.env("HOUSTON_MCP_TOKEN", "token-81");
    command.env("HOUSTON_MCP_URL", "http://127.0.0.1:4242/mcp");
    command.env("FIXTURE_STDIN", "0");
    codex_pane::wrap_direct(&mut command, Path::new(env!("CARGO_BIN_EXE_houston-core")));
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reading = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = reader.read_to_string(&mut text);
        let _ = send.send(text);
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Codex launch exceeded 15 seconds");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    drop(pair.master);
    let text = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    reading.join().unwrap();
    assert_eq!(status.exit_code(), 23, "{text}");
    assert!(
        text.contains("a prompt with spaces & an apostrophe's literal"),
        "{text}"
    );
    assert!(text.contains("IDENTITY 81 token-81"), "{text}");
    assert!(text.contains("--no-daemon"), "{text}");
}

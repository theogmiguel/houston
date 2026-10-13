#![cfg(target_os = "linux")]

use houston_core::{codex_pane, mcp_launch, session_isolation};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

fn shell_fallback(retain_scope: bool) {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("codex");
    std::fs::write(
        &executable,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'codex-cli 0.162.1'; exit 0; fi\nprintf '%s\\n' \"$@\" > cli-args\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let helper = Path::new(env!("CARGO_BIN_EXE_houston-core"));
    let mut command = CommandBuilder::new(helper);
    command.arg(codex_pane::SHELL_SUBCOMMAND);
    command.arg(directory.path().join("drop"));
    command.arg("--");
    command.arg(&executable);
    command.args(["--", "a task"]);
    command.cwd(directory.path());
    command.env("HOME", directory.path());
    command.env("CODEX_HOME", directory.path().join("empty-codex-home"));
    command.env("HOUSTON_CHANNEL", "mcptest");
    command.env("HOUSTON_SESSION", "41");
    command.env(mcp_launch::URL_ENV, "http://127.0.0.1:41234/mcp");
    command.env(mcp_launch::CODEX_TOKEN_ENV, "fixture-mcp-token");
    if !retain_scope {
        command.env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/missing-bus", directory.path().display()),
        );
    }
    session_isolation::wrap(&mut command, helper, "mcptest", 41);
    let mut gate = session_isolation::ExecGate::new(&mut command, "mcptest", 41).unwrap();
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let receipt = gate.receipt(child.process_id().unwrap()).unwrap();
    assert_eq!(receipt.uncontained_reason().is_none(), retain_scope);
    gate.release().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Codex shell fallback did not finish within 15 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let args = std::fs::read_to_string(directory.path().join("cli-args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert_eq!(args[0], "--no-daemon");
    let delimiter = args.iter().position(|arg| *arg == "--").unwrap();
    assert_eq!(&args[delimiter + 1..], ["a task"]);
    let managed = mcp_launch::launch_for(
        houston_protocol::AgentKind::Codex,
        "http://127.0.0.1:41234/mcp",
        "fixture-mcp-token",
    );
    for argument in managed.args.as_chunks::<2>().0 {
        assert!(
            args[..delimiter].windows(2).any(|pair| pair == argument),
            "missing pane MCP override: {}",
            argument[1]
        );
    }
    assert!(!args.iter().any(|arg| arg.contains("fixture-mcp-token")));
}

#[test]
fn unavailable_manager_fallback_preserves_pane_mcp_before_prompt_delimiter() {
    shell_fallback(false);
}

#[test]
fn committed_scope_fallback_preserves_pane_mcp_before_prompt_delimiter() {
    if !session_isolation::manager_available() {
        eprintln!("SKIPPED: user systemd manager required for committed scope fallback");
        return;
    }
    shell_fallback(true);
}

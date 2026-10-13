#![cfg(target_os = "linux")]

mod common;

use houston_core::{
    pid,
    session_isolation::{self, ExecGate},
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn command(directory: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "printf released > executed; test -t 0 && test -t 1; printf DONE",
    ]);
    command.cwd(directory);
    command.env(
        "DBUS_SESSION_BUS_ADDRESS",
        format!("unix:path={}/absent", directory.display()),
    );
    session_isolation::wrap(
        &mut command,
        Path::new(env!("CARGO_BIN_EXE_houston-core")),
        "execfixture",
        7,
    );
    command
}

#[test]
fn executable_waits_for_receipt_and_explicit_commit_release() {
    let directory = tempfile::tempdir().unwrap();
    let mut command = command(directory.path());
    let mut gate = ExecGate::new(&mut command, "execfixture", 7).unwrap();
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let receipt = gate.receipt(child.process_id().unwrap()).unwrap();
    assert!(receipt.uncontained_reason().is_some());
    assert!(
        !directory.path().join("executed").exists(),
        "output-worker gating must not substitute for executable gating"
    );
    assert!(child.try_wait().unwrap().is_none());
    gate.release().unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("executed")).unwrap(),
        "released"
    );
}

#[test]
fn gate_parent_fixture() {
    let Some(directory) = std::env::var_os("EXEC_GATE_PARENT_FIXTURE") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let mut command = command(&directory);
    let mut gate = ExecGate::new(&mut command, "execfixture", 7).unwrap();
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let process = child.process_id().unwrap();
    gate.receipt(process).unwrap();
    std::fs::write(
        directory.join("gated-root.json"),
        serde_json::to_vec(&(process, pid::process_creation_token(process).unwrap())).unwrap(),
    )
    .unwrap();
    // The test driver kills only this exact private parent after this durable barrier.
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    panic!("fixture parent should have died before commit");
}

#[test]
fn precommit_parent_sigkill_aborts_helper_before_any_cli_execution() {
    use std::process::Stdio;
    let directory = tempfile::tempdir().unwrap();
    let mut parent = houston_core::spawn::command(std::env::current_exe().unwrap())
        .args(["--exact", "gate_parent_fixture", "--nocapture"])
        .env("EXEC_GATE_PARENT_FIXTURE", directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let parent_creation = pid::process_creation_token(parent.id()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(40);
    let (root, creation): (u32, u64) = loop {
        if let Ok(bytes) = std::fs::read(directory.path().join("gated-root.json")) {
            if let Ok(identity) = serde_json::from_slice(&bytes) {
                break identity;
            }
        }
        if Instant::now() >= deadline {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("pre-exec fixture never reached receipt barrier");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!directory.path().join("executed").exists());
    pid::signal_process_checked_identity(parent.id(), pid::Signal::Kill, Some(parent_creation))
        .unwrap();
    parent.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while pid::process_creation_token(root) == Some(creation)
        && std::fs::read_to_string(format!("/proc/{root}/stat")).is_ok_and(|stat| {
            stat[stat.rfind(')').unwrap() + 2..]
                .split_whitespace()
                .next()
                != Some("Z")
        })
    {
        if Instant::now() >= deadline {
            let _ = pid::signal_process_checked_identity(root, pid::Signal::Kill, Some(creation));
            panic!("helper survived precommit parent death");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !directory.path().join("executed").exists(),
        "CLI executed without a committed ownership receipt"
    );
}

#[test]
fn failed_session_startup_transaction_cannot_release_executable() {
    use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
    use houston_protocol::AgentKind;
    if std::env::var_os("EXEC_GATE_DB_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let result = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
            .args([
                "--exact",
                "failed_session_startup_transaction_cannot_release_executable",
                "--nocapture",
            ])
            .env("EXEC_GATE_DB_FIXTURE", "1")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/missing", home.path().display()),
            )
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("test.db");
    let daemon = Daemon::new(DaemonConfig {
        token: "fixture-token".into(),
        db_path: database.clone(),
    })
    .unwrap();
    daemon.set_session_launcher(Some(env!("CARGO_BIN_EXE_houston-core").into()));
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch("CREATE TRIGGER startup_failure BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture refuses commit'); END").unwrap();
    let result = daemon.create_session(CreateParams {
        agent: AgentKind::Custom,
        project_dir: directory.path().into(),
        cmd: Some(vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf escaped > executed".into(),
        ]),
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
    });
    assert!(result.is_err());
    assert!(!directory.path().join("executed").exists());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sessions", [], |row| row
            .get::<_, u32>(0))
            .unwrap(),
        0
    );
    assert!(daemon.list().is_empty());
}

#[test]
fn typed_codex_keeps_its_contained_shell_scope_and_uses_hooks() {
    use std::os::unix::fs::PermissionsExt;
    if !session_isolation::manager_available() {
        eprintln!("SKIPPED: user systemd required for contained shell Codex regression");
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let cli = directory.path().join("fake-codex");
    std::fs::write(&cli, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.160.0; exit 0; fi\nprintf '%s\\n' \"$@\" > actual.argv\ncat /proc/self/cgroup > actual.cgroup\ntest -t 0 && test -t 1\n").unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let launcher = Path::new(env!("CARGO_BIN_EXE_houston-core"));
    let mut command = CommandBuilder::new(launcher);
    command.arg(houston_core::codex_pane::SHELL_SUBCOMMAND);
    command.arg(directory.path().join("drop"));
    command.arg("--");
    command.arg(&cli);
    command.cwd(directory.path());
    command.env("HOUSTON_CHANNEL", "execfixture");
    command.env("HOUSTON_SESSION", "7");
    session_isolation::wrap(&mut command, launcher, "execfixture", 7);
    let mut gate = ExecGate::new(&mut command, "execfixture", 7).unwrap();
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let receipt = gate.receipt(child.process_id().unwrap()).unwrap();
    let receipt = serde_json::to_value(receipt).unwrap();
    assert_eq!(receipt["ownership"]["kind"], "linux_scope");
    gate.release().unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("actual.argv")).unwrap(),
        "--no-daemon\n"
    );
    assert!(
        std::fs::read_to_string(directory.path().join("actual.cgroup"))
            .unwrap()
            .lines()
            .any(|line| line.strip_prefix("0::") == receipt["ownership"]["cgroup"].as_str())
    );
}

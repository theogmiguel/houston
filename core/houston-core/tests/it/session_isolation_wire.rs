#![cfg(target_os = "linux")]

use crate::common;

use futures_util::SinkExt;
use houston_core::daemon::Daemon;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

struct PaneGuard(Arc<Daemon>, Vec<u32>);

impl Drop for PaneGuard {
    fn drop(&mut self) {
        for id in &self.1 {
            let _ = self.0.kill(*id);
        }
    }
}

fn cgroup(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap()
}

async fn create_pane(
    ws: &mut common::WsStream,
    project: &Path,
    pid_file: &Path,
    guard: &mut PaneGuard,
) -> proto::SessionInfo {
    let script = "test -t 0 && test -t 1 || exit 80; sleep 100 & echo $! > \"$1.descendant\"; echo $$ > \"$1\"; echo READY; while IFS= read -r line; do printf 'RECEIVED:%s\\n' \"$line\"; done";
    ws.send(Message::text(common::create_custom_msg(
        vec!["/bin/sh", "-c", script, "pane", pid_file.to_str().unwrap()],
        project,
    )))
    .await
    .unwrap();
    let info = common::expect_created(ws).await;
    guard.1.push(info.id);
    common::attach_and_collect_output_until(ws, info.id, "READY").await;
    info
}

#[tokio::test]
async fn killing_one_session_scope_preserves_the_daemon_and_other_real_pty() {
    if !houston_core::session_isolation::manager_available() {
        eprintln!("SKIPPED: user systemd manager unavailable for session scope isolation");
        return;
    }
    let (addr, _state, daemon) = common::start_daemon_with_handle().await;
    daemon.set_session_launcher(Some(PathBuf::from(env!("CARGO_BIN_EXE_houston-core"))));
    let mut guard = PaneGuard(daemon, Vec::new());
    let project = tempfile::tempdir().unwrap();
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let first_file = project.path().join("first.pid");
    let second_file = project.path().join("second.pid");
    let first = create_pane(&mut ws, project.path(), &first_file, &mut guard).await;
    let second = create_pane(&mut ws, project.path(), &second_file, &mut guard).await;
    let pid = |path: &Path| {
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap()
    };
    let first_pid = pid(&first_file);
    let second_pid = pid(&second_file);
    let first_group = cgroup(first_pid);
    let second_group = cgroup(second_pid);
    assert_ne!(
        first_group,
        cgroup(std::process::id()),
        "pane must leave daemon cgroup"
    );
    assert_ne!(first_group, second_group, "panes require distinct scopes");
    assert_eq!(
        first_group,
        cgroup(pid(&first_file.with_extension("pid.descendant")))
    );
    assert_eq!(
        second_group,
        cgroup(pid(&second_file.with_extension("pid.descendant")))
    );
    // The same PID remains the PTY session leader after the helper execs the CLI.
    let raw_pid = houston_core::pid::checked_pid(first_pid).unwrap();
    assert_eq!(unsafe { libc::getsid(raw_pid) }, raw_pid);
    let status = std::fs::read_to_string(format!("/proc/{first_pid}/status")).unwrap();
    let parent = status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))
        .unwrap();
    assert_eq!(parent.trim().parse::<u32>().unwrap(), std::process::id());
    let unit = first_group
        .lines()
        .find_map(|line| {
            line.splitn(3, ':')
                .nth(2)
                .and_then(|path| Path::new(path).file_name())
                .and_then(|name| name.to_str())
        })
        .unwrap();
    assert!(unit.starts_with("houston-session-") && unit.ends_with(".scope"));
    let connection = zbus::blocking::Connection::session().unwrap();
    let manager = zbus::blocking::Proxy::new(
        &connection,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    )
    .unwrap();
    manager
        .call::<_, _, ()>("KillUnit", &(unit, "all", 9i32))
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while guard
        .0
        .list()
        .iter()
        .any(|info| info.id == first.id && info.state.is_live())
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "killed scope must report an exited session"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    ws.send(Message::Binary(
        proto::encode_stdin_frame(second.id, b"still-alive\n").into(),
    ))
    .await
    .unwrap();
    common::collect_output_until(&mut ws, second.id, "RECEIVED:still-alive").await;
    assert_eq!(second_group, cgroup(second_pid));
}

#[test]
fn unavailable_user_bus_keeps_the_original_argv_cwd_and_real_pty() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    let project = tempfile::tempdir().unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "test -t 0 && test -t 1 || exit 80; printf '%s|%s' \"$PWD\" \"$1\"",
        "pane",
        "literal $HOME %h",
    ]);
    command.cwd(project.path());
    command.env(
        "DBUS_SESSION_BUS_ADDRESS",
        format!("unix:path={}/missing-bus", project.path().display()),
    );
    houston_core::session_isolation::wrap(
        &mut command,
        Path::new(env!("CARGO_BIN_EXE_houston-core")),
        "test-isolation",
        1,
    );
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let status = child.wait().unwrap();
    let mut output = String::new();
    pair.master
        .try_clone_reader()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(status.success(), "fallback CLI failed: {output}");
    assert!(output.contains("cgroup isolation unavailable"));
    assert!(output.contains(&format!("{}|literal $HOME %h", project.path().display())));
}

struct EscapedPane {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    _project: tempfile::TempDir,
    pane: proto::SessionInfo,
    child: (u32, u64),
}

impl Drop for EscapedPane {
    fn drop(&mut self) {
        let _ = houston_core::pid::signal_process_checked_identity(
            self.child.0,
            houston_core::pid::Signal::Kill,
            Some(self.child.1),
        );
    }
}

impl EscapedPane {
    fn child_alive(&self) -> bool {
        houston_core::pid::process_creation_token(self.child.0) == Some(self.child.1)
            && !std::fs::read_to_string(format!("/proc/{}/stat", self.child.0))
                .is_ok_and(|stat| stat[stat.rfind(')').unwrap() + 2..].starts_with('Z'))
    }
}

// A pane whose root leaves a setsid descendant in its scope, which no process group reaches.
async fn escaped_pane(root_exits: bool) -> EscapedPane {
    use houston_core::pid;
    let (_addr, state, daemon) = common::start_daemon_with_handle().await;
    daemon.set_session_launcher(Some(env!("CARGO_BIN_EXE_houston-core").into()));
    let project = tempfile::tempdir().unwrap();
    let script = format!("setsid /bin/sh -c 'trap \"\" HUP TERM; echo $$ > child.pid; exec sleep 100' </dev/null >/dev/null 2>&1 & while [ ! -f child.pid ]; do sleep 0.01; done; echo $$ > root.pid; {}", if root_exits {"exit 0"} else {"read ignored"});
    let pane = daemon
        .create_session(houston_core::daemon::CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: project.path().into(),
            cmd: Some(vec!["/bin/sh".into(), "-c".into(), script]),
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
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while !project.path().join("root.pid").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let child: u32 = std::fs::read_to_string(project.path().join("child.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child = (child, pid::process_creation_token(child).unwrap());
    if root_exits {
        while daemon
            .list()
            .iter()
            .any(|info| info.id == pane.id && info.state.is_live())
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "root was not reaped after redirected child detached"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    EscapedPane {
        daemon,
        state,
        _project: project,
        pane,
        child,
    }
}

#[tokio::test]
async fn teardown_after_root_exit_stops_descendants_left_in_the_scope() {
    use houston_core::daemon::RespawnConversation;
    if !houston_core::session_isolation::manager_available() {
        eprintln!("SKIPPED: user manager required for contained teardown regression");
        return;
    }
    for action in ["respawn", "close", "kill"] {
        let fixture = escaped_pane(true).await;
        assert!(fixture.child_alive());
        let id = fixture.pane.id;
        match action {
            "respawn" => {
                let replacement = fixture
                    .daemon
                    .respawn_with(id, false, None, None, true, RespawnConversation::Fresh)
                    .unwrap();
                fixture.daemon.close(replacement.id).unwrap();
            }
            "close" => fixture.daemon.close(id).unwrap(),
            _ => {
                fixture.daemon.kill(id).unwrap();
                fixture.daemon.close(id).unwrap();
            }
        }
        assert!(
            !fixture.child_alive(),
            "{action} left an escaped descendant running in the pane scope"
        );
    }
}

#[tokio::test]
async fn an_unusable_manager_never_blocks_replacement() {
    use houston_core::daemon::RespawnConversation;
    if !houston_core::session_isolation::manager_available() {
        eprintln!("SKIPPED: user manager required for contained replacement regression");
        return;
    }
    struct ScopeReset;
    impl Drop for ScopeReset {
        fn drop(&mut self) {
            houston_core::session_isolation::fail_scope_termination_for_test(false);
        }
    }
    for root_exits in [false, true] {
        let fixture = escaped_pane(root_exits).await;
        houston_core::session_isolation::fail_scope_termination_for_test(true);
        let _reset = ScopeReset;
        let replacement = fixture
            .daemon
            .respawn_with(
                fixture.pane.id,
                false,
                None,
                None,
                true,
                RespawnConversation::Fresh,
            )
            .unwrap();
        // Without the manager only the root's process groups are reachable.
        assert!(fixture.child_alive());
        let conn = rusqlite::Connection::open(fixture.state.path().join("test.db")).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM sessions", [], |row| row
                .get::<_, u32>(0))
                .unwrap(),
            2
        );
        houston_core::session_isolation::fail_scope_termination_for_test(false);
        fixture.daemon.close(replacement.id).unwrap();
    }
}

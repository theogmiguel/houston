#![allow(clippy::disallowed_methods)]
#![cfg(unix)]

use houston_core::pid::{signal_process, Signal};
use houston_core::supervisor::SupervisorFile;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn supervisor_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-supervisor")
}

fn stand_in_daemon_bin() -> &'static str {
    env!("CARGO_BIN_EXE_supervisor-test-daemon")
}

const POLL_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

fn poll_until<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(start.elapsed() < timeout, "timed out waiting for condition");
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn read_to_string(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

struct SupervisorGuard(Child);
impl Drop for SupervisorGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_supervisor(channel_dir: &std::path::Path, daemon_args: &[&str]) -> SupervisorGuard {
    let mut cmd = Command::new(supervisor_bin());
    cmd.arg("--channel-dir")
        .arg(channel_dir)
        .arg("--daemon")
        .arg(stand_in_daemon_bin())
        .arg("--")
        .args(daemon_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    SupervisorGuard(cmd.spawn().expect("spawn houston-supervisor"))
}

#[test]
fn supervisor_json_shape_and_permissions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pidfile = dir.path().join("orphan.pid");
    let result_file = dir.path().join("result.txt");
    let mut guard = spawn_supervisor(
        dir.path(),
        &[
            "gen1",
            pidfile.to_str().unwrap(),
            "no-handoff",
            result_file.to_str().unwrap(),
        ],
    );

    let sup_json_path = dir.path().join("supervisor.json");
    let contents = poll_until(POLL_TIMEOUT, || read_to_string(&sup_json_path));
    let parsed = SupervisorFile::from_json(&contents)
        .unwrap_or_else(|| panic!("supervisor.json did not parse: {contents:?}"));
    assert_eq!(parsed.generation, 1);
    assert_eq!(parsed.pid, guard.0.id());

    let perms = std::fs::metadata(&sup_json_path)
        .expect("stat supervisor.json")
        .permissions();
    assert_eq!(perms.mode() & 0o777, 0o600, "supervisor.json must be 0600");

    let orphan_pid: u32 = poll_until(POLL_TIMEOUT, || read_to_string(&pidfile))
        .trim()
        .parse()
        .expect("pidfile holds a pid");
    signal_process(orphan_pid, Signal::Kill).expect("SIGKILL the orphan");
    poll_until(POLL_TIMEOUT, || guard.0.try_wait().ok().flatten());
}

#[test]
fn orphan_normal_exit_is_relayed_with_real_code() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pidfile = dir.path().join("orphan.pid");
    let result_file = dir.path().join("result.txt");
    let mut guard = spawn_supervisor(
        dir.path(),
        &[
            "gen1",
            pidfile.to_str().unwrap(),
            "normal-exit",
            result_file.to_str().unwrap(),
        ],
    );

    let status = poll_until(POLL_TIMEOUT, || guard.0.try_wait().ok().flatten());
    assert!(
        status.success(),
        "supervisor must exit 0 once idle: {status:?}"
    );

    let result =
        std::fs::read_to_string(&result_file).expect("the completed daemon wrote its report");
    let mut lines = result.lines();
    let _reported_pid: i32 = lines.next().unwrap().parse().unwrap();
    let code = lines.next().unwrap();
    let signal = lines.next().unwrap();
    assert_eq!(
        code, "Some(42)",
        "real exit code must survive the handoff: {result:?}"
    );
    assert_eq!(signal, "None");
}

#[test]
fn orphan_signal_kill_is_relayed_with_real_signal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pidfile = dir.path().join("orphan.pid");
    let result_file = dir.path().join("result.txt");
    let mut guard = spawn_supervisor(
        dir.path(),
        &[
            "gen1",
            pidfile.to_str().unwrap(),
            "slow",
            result_file.to_str().unwrap(),
        ],
    );

    let pid_str = poll_until(POLL_TIMEOUT, || read_to_string(&pidfile));
    let orphan_pid: u32 = pid_str.trim().parse().expect("pidfile holds a pid");

    let ready_marker = dir.path().join("result.txt.ready");
    poll_until(POLL_TIMEOUT, || read_to_string(&ready_marker));

    assert!(
        guard.0.try_wait().expect("try_wait").is_none(),
        "supervisor must stay alive while the orphan is still alive"
    );

    signal_process(orphan_pid, Signal::Kill).expect("SIGKILL the orphan");

    let status = poll_until(POLL_TIMEOUT, || guard.0.try_wait().ok().flatten());
    assert!(
        status.success(),
        "supervisor must exit 0 once idle: {status:?}"
    );

    let result =
        std::fs::read_to_string(&result_file).expect("the completed daemon wrote its report");
    let mut lines = result.lines();
    let _reported_pid: i32 = lines.next().unwrap().parse().unwrap();
    let code = lines.next().unwrap();
    let signal = lines.next().unwrap();
    assert_eq!(code, "None", "a killed orphan has no exit code: {result:?}");
    assert_eq!(
        signal, "Some(9)",
        "the real signal (SIGKILL=9) must survive: {result:?}"
    );
}

#[test]
fn spawn_next_wire_round_trip_matches_supervisor_module() {
    use houston_core::supervisor::{read_to_supervisor, write_spawn_next, SpawnNext, ToSupervisor};
    let req = SpawnNext {
        daemon_path: stand_in_daemon_bin().to_string(),
        args: vec!["gen2".to_string(), "/tmp/result".to_string()],
    };
    let mut buf = Vec::new();
    write_spawn_next(&mut buf, &req).unwrap();
    let mut cur = std::io::Cursor::new(buf);
    match read_to_supervisor(&mut cur).unwrap() {
        ToSupervisor::SpawnNext(got) => assert_eq!(got, req),
    }
}

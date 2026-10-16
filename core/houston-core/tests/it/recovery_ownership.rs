#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
use houston_core::{
    db::{Db, MessageReceipt},
    recovery_process::ProcessIdentity,
};
use houston_protocol as proto;

struct Fixture {
    state: tempfile::TempDir,
    db: Db,
}

impl Fixture {
    fn new(receipt: Option<serde_json::Value>) -> Self {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("fixture.db");
        let db = Db::open(&path).unwrap();
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute("INSERT INTO sessions(id,agent,project_dir,cwd,state,title,codename,created_at,process_identity) VALUES(7,'claude',?1,?1,'interrupted','Retained pane','fixture',1,?2)",
            rusqlite::params![state.path().to_str().unwrap(), receipt.map(|value| value.to_string())]).unwrap();
        db.set_session_resume_handle(7, Some(("retained-conversation", None)))
            .unwrap();
        Self { state, db }
    }

    fn reclaim(&self) -> anyhow::Result<()> {
        match self.db.previous_process_identity(7)? {
            Some(identity) => identity.reclaim("fixture", 7),
            None => Ok(()),
        }
    }
}

fn receipt_of(pid: u32) -> serde_json::Value {
    serde_json::to_value(ProcessIdentity::capture(Some(pid)).unwrap().unwrap()).unwrap()
}

fn current_receipt() -> serde_json::Value {
    receipt_of(std::process::id())
}

fn recycled_receipt() -> serde_json::Value {
    let mut receipt = current_receipt();
    receipt["creation"] = serde_json::json!(receipt["creation"].as_u64().unwrap() + 1);
    receipt
}

#[test]
fn legacy_reclaim_needs_no_acknowledgement_and_keeps_conversation_and_held_mission() {
    let fixture = Fixture::new(None);
    let receipt = MessageReceipt::new(1, None, "pane_prompt", &serde_json::json!({})).unwrap();
    let context = serde_json::json!({
        "target":7,"origin":7,"provider":"claude",
        "workspace":fixture.state.path(),"cwd":fixture.state.path(),
        "profile":null,"profile_dir":null,"conversation":["retained-conversation",null],
        "ancestry":[1],
    })
    .to_string();
    let instruction = fixture
        .db
        .instruction_accept(
            7,
            &context,
            proto::InstructionMode::Queue,
            "Retained mission",
            &receipt,
            1,
        )
        .unwrap();
    fixture.db.instruction_recover(2).unwrap();
    fixture.reclaim().unwrap();
    let instruction = fixture
        .db
        .instruction_row(&instruction.info.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        instruction.info.state,
        proto::InstructionState::HeldAfterRecovery
    );
    assert_eq!(instruction.body, "Retained mission");
    assert_eq!(
        fixture.db.session_resume_handle(7).unwrap().unwrap().0,
        "retained-conversation"
    );
    assert_eq!(
        fixture.db.list_interrupted().unwrap()[0].title,
        "Retained pane"
    );
}

#[test]
fn dead_or_recycled_roots_are_reclaimed_without_signals() {
    Fixture::new(Some(recycled_receipt())).reclaim().unwrap();
    let mut legacy = recycled_receipt();
    legacy.as_object_mut().unwrap().remove("ownership");
    legacy["version"] = serde_json::json!(1);
    Fixture::new(Some(legacy.clone())).reclaim().unwrap();
    legacy["version"] = serde_json::json!(2);
    assert!(
        Fixture::new(Some(legacy)).reclaim().is_err(),
        "a version 2 receipt without an ownership boundary is corrupt"
    );
}

#[cfg(unix)]
fn spawn_root(script: &str) -> std::process::Child {
    use std::os::unix::process::CommandExt;
    let mut command = houston_core::spawn::command("/bin/sh");
    command.args(["-c", script]);
    // SAFETY: setsid is async-signal-safe; a PTY root also leads its own session.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().unwrap()
}

#[cfg(unix)]
#[test]
fn a_live_uncontained_root_is_stopped_by_its_verified_identity() {
    use std::os::unix::process::ExitStatusExt;
    for (script, signal) in [
        ("exec sleep 600", libc::SIGTERM),
        ("trap '' TERM; exec sleep 600", libc::SIGKILL),
    ] {
        let mut root = spawn_root(script);
        // Wait for exec so a TERM-ignoring root has installed its disposition.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while houston_core::pid::process_comm(root.id()).as_deref() != Some("sleep") {
            assert!(std::time::Instant::now() < deadline, "root never exec'd");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let fixture = Fixture::new(Some(receipt_of(root.id())));
        let started = std::time::Instant::now();
        fixture.reclaim().unwrap();
        let status = root.wait().unwrap();
        assert_eq!(status.signal(), Some(signal), "{script}: {status:?}");
        if signal == libc::SIGKILL {
            assert!(
                started.elapsed() >= std::time::Duration::from_secs(2),
                "SIGKILL must follow the SIGTERM grace"
            );
        }
        assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
    }
}

#[cfg(windows)]
#[test]
fn windows_uncontained_receipts_need_no_acknowledgement() {
    Fixture::new(Some(recycled_receipt())).reclaim().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn verified_different_boot_permits_recovery_without_signals() {
    let mut receipt = current_receipt();
    receipt["system"] = serde_json::json!(format!("linux:{}", uuid::Uuid::new_v4()));
    let fixture = Fixture::new(Some(receipt));
    fixture.reclaim().unwrap();
    assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
}

#[cfg(target_os = "linux")]
fn scope_receipt(channel: &str, id: u32) -> serde_json::Value {
    let mut receipt = recycled_receipt();
    let unit = format!(
        "houston-session-{channel}-{id}-{}.scope",
        uuid::Uuid::new_v4().simple()
    );
    receipt["ownership"] = serde_json::json!({"kind":"linux_scope","unit":unit,"cgroup":format!("/user.slice/{unit}")});
    receipt
}

#[cfg(target_os = "linux")]
#[test]
fn foreign_or_malformed_scope_receipts_are_never_signalled() {
    for receipt in [scope_receipt("other", 7), scope_receipt("fixture", 8)] {
        let error = Fixture::new(Some(receipt))
            .reclaim()
            .unwrap_err()
            .to_string();
        assert!(error.contains("refusing to stop it"), "{error}");
    }
    let mut receipt = scope_receipt("fixture", 7);
    receipt["ownership"]["unit"] = serde_json::json!("houston-session-fixture-7-wrong.scope");
    assert!(Fixture::new(Some(receipt)).reclaim().is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn unavailable_manager_falls_back_to_the_recorded_root() {
    if std::env::var_os("OWNERSHIP_MANAGER_FIXTURE").is_none() {
        let state = tempfile::tempdir().unwrap();
        let result = houston_core::spawn::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &crate::common::exact_path(
                    module_path!(),
                    "unavailable_manager_falls_back_to_the_recorded_root",
                ),
                "--nocapture",
            ])
            .env("OWNERSHIP_MANAGER_FIXTURE", "1")
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/missing", state.path().display()),
            )
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let fixture = Fixture::new(Some(scope_receipt("fixture", 7)));
    fixture.reclaim().unwrap();
    assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
}

#[cfg(target_os = "linux")]
struct FixtureManager {
    mode: &'static str,
}

#[cfg(target_os = "linux")]
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl FixtureManager {
    #[zbus(property)]
    fn version(&self) -> String {
        "fixture".into()
    }

    fn get_unit(&self, _unit: &str) -> zbus::fdo::Result<zbus::zvariant::OwnedObjectPath> {
        match self.mode {
            "timeout" => std::thread::sleep(std::time::Duration::from_secs(7)),
            "mismatch" => {
                return Ok(zbus::zvariant::ObjectPath::try_from(
                    "/org/freedesktop/systemd1/unit/fixture",
                )
                .unwrap()
                .into())
            }
            _ => {}
        }
        Err(zbus::fdo::Error::AccessDenied(
            "fixture denies population lookup".into(),
        ))
    }

    fn kill_unit(&self, unit: &str, _whom: &str, _signal: i32) -> zbus::fdo::Result<()> {
        Err(zbus::fdo::Error::Failed(format!(
            "fixture never kills {unit}"
        )))
    }
}

#[cfg(target_os = "linux")]
struct ForeignScope;

#[cfg(target_os = "linux")]
#[zbus::interface(name = "org.freedesktop.systemd1.Scope")]
impl ForeignScope {
    #[zbus(property)]
    fn control_group(&self) -> String {
        "/user.slice/app.slice/foreign.scope".into()
    }
}

#[cfg(target_os = "linux")]
#[test]
fn manager_failures_fall_back_and_a_moved_cgroup_is_refused() {
    use std::io::BufRead;
    if let Some(mode) = std::env::var_os("OWNERSHIP_FAKE_MANAGER") {
        let fixture = Fixture::new(Some(scope_receipt("fixture", 7)));
        let result = fixture.reclaim();
        if mode == "mismatch" {
            let error = result.unwrap_err().to_string();
            assert!(error.contains("membership changed"), "{error}");
        } else {
            result.unwrap_or_else(|error| panic!("{mode:?}: {error:#}"));
        }
        assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
        return;
    }
    if !std::path::Path::new("/run/systemd/system").is_dir() {
        eprintln!("SKIPPED: systemd host required to reach mocked ownership manager");
        return;
    }
    struct Bus(std::process::Child);
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for mode in ["denied", "timeout", "mismatch"] {
        let directory = tempfile::tempdir().unwrap();
        let address = format!("unix:path={}/bus", directory.path().display());
        let mut bus = Bus(houston_core::spawn::command("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .arg(format!("--address={address}"))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap());
        let mut announced = String::new();
        std::io::BufReader::new(bus.0.stdout.take().unwrap())
            .read_line(&mut announced)
            .unwrap();
        let service = zbus::blocking::connection::Builder::address(announced.trim())
            .unwrap()
            .name("org.freedesktop.systemd1")
            .unwrap()
            .serve_at("/org/freedesktop/systemd1", FixtureManager { mode })
            .unwrap()
            .serve_at("/org/freedesktop/systemd1/unit/fixture", ForeignScope)
            .unwrap()
            .build()
            .unwrap();
        let result = houston_core::spawn::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &crate::common::exact_path(
                    module_path!(),
                    "manager_failures_fall_back_and_a_moved_cgroup_is_refused",
                ),
                "--nocapture",
            ])
            .env("OWNERSHIP_FAKE_MANAGER", mode)
            .env("DBUS_SESSION_BUS_ADDRESS", announced.trim())
            .status()
            .unwrap();
        assert!(result.success(), "{mode}");
        drop(service);
    }
    let directory = tempfile::tempdir().unwrap();
    let socket = directory.path().join("stalled-bus");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    // Hold the accepted socket without answering authentication, then close it.
                    std::thread::sleep(std::time::Duration::from_secs(7));
                    drop(stream);
                    break;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("mock bus did not accept ownership query: {error}"),
            }
        }
    });
    let result = houston_core::spawn::command(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &crate::common::exact_path(
                module_path!(),
                "manager_failures_fall_back_and_a_moved_cgroup_is_refused",
            ),
            "--nocapture",
        ])
        .env("OWNERSHIP_FAKE_MANAGER", "authentication")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", socket.display()),
        )
        .status()
        .unwrap();
    server.join().unwrap();
    assert!(result.success());
}

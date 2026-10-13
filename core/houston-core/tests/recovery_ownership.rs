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
}

fn current_receipt() -> serde_json::Value {
    serde_json::to_value(
        ProcessIdentity::capture(Some(std::process::id()))
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn legacy_acknowledgement_preserves_conversation_and_held_mission() {
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
    assert!(fixture
        .db
        .check_previous_process_stopped(7)
        .unwrap_err()
        .to_string()
        .contains("legacy"));
    fixture.db.acknowledge_uncontained_recovery(7).unwrap();
    fixture.db.check_previous_process_stopped(7).unwrap();
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
    drop(fixture.db);
    let reopened = Db::open(&fixture.state.path().join("fixture.db")).unwrap();
    reopened.check_previous_process_stopped(7).unwrap();
    assert_eq!(
        reopened
            .instruction_row(&instruction.info.id)
            .unwrap()
            .unwrap()
            .info
            .state,
        proto::InstructionState::HeldAfterRecovery
    );
}

#[test]
fn live_root_cannot_be_acknowledged_and_recycled_root_is_not_tree_proof() {
    let fixture = Fixture::new(Some(current_receipt()));
    assert!(fixture.db.acknowledge_uncontained_recovery(7).is_err());
    let mut recycled = current_receipt();
    recycled["creation"] = serde_json::json!(recycled["creation"].as_u64().unwrap() + 1);
    let fixture = Fixture::new(Some(recycled));
    assert!(
        fixture.db.check_previous_process_stopped(7).is_err(),
        "a recycled root must not certify detached descendants stopped"
    );
    fixture.db.acknowledge_uncontained_recovery(7).unwrap();
    fixture.db.check_previous_process_stopped(7).unwrap();
}

#[test]
fn legacy_root_receipt_requires_ack_and_corrupt_new_receipt_cannot_be_acknowledged() {
    let mut receipt = current_receipt();
    receipt["creation"] = serde_json::json!(receipt["creation"].as_u64().unwrap() + 1);
    receipt.as_object_mut().unwrap().remove("ownership");
    let corrupt = Fixture::new(Some(receipt.clone()));
    assert!(corrupt.db.check_previous_process_stopped(7).is_err());
    assert!(corrupt.db.acknowledge_uncontained_recovery(7).is_err());
    receipt["version"] = serde_json::json!(1);
    let legacy = Fixture::new(Some(receipt));
    assert!(legacy.db.check_previous_process_stopped(7).is_err());
    legacy.db.acknowledge_uncontained_recovery(7).unwrap();
    legacy.db.check_previous_process_stopped(7).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_refusal_names_missing_job_ownership_and_retains_data() {
    let mut receipt = current_receipt();
    receipt["creation"] = serde_json::json!(receipt["creation"].as_u64().unwrap() + 1);
    let fixture = Fixture::new(Some(receipt));
    let error = fixture
        .db
        .check_previous_process_stopped(7)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("Windows ConPTY") && error.contains("Job ownership"),
        "{error}"
    );
    assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
}

#[cfg(target_os = "linux")]
#[test]
fn verified_different_boot_permits_recovery_without_signals() {
    let mut receipt = current_receipt();
    receipt["system"] = serde_json::json!(format!("linux:{}", uuid::Uuid::new_v4()));
    let fixture = Fixture::new(Some(receipt));
    fixture.db.check_previous_process_stopped(7).unwrap();
    assert!(fixture.db.session_resume_handle(7).unwrap().is_some());
}

#[cfg(target_os = "linux")]
#[test]
fn unavailable_manager_and_wrong_scope_nonce_remain_unknown() {
    if std::env::var_os("OWNERSHIP_MANAGER_FIXTURE").is_none() {
        let state = tempfile::tempdir().unwrap();
        let result = houston_core::spawn::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "unavailable_manager_and_wrong_scope_nonce_remain_unknown",
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
    let mut receipt = current_receipt();
    receipt["creation"] = serde_json::json!(receipt["creation"].as_u64().unwrap() + 1);
    let unit = "houston-session-fixture-7-0123456789abcdef0123456789abcdef.scope";
    receipt["ownership"] = serde_json::json!({"kind":"linux_scope","unit":unit,"cgroup":format!("/user.slice/{unit}")});
    let fixture = Fixture::new(Some(receipt.clone()));
    assert!(fixture.db.check_previous_process_stopped(7).is_err());
    assert!(fixture.db.acknowledge_uncontained_recovery(7).is_err());
    receipt["ownership"]["unit"] = serde_json::json!("houston-session-fixture-7-wrong.scope");
    receipt["system"] = serde_json::json!(format!("linux:{}", uuid::Uuid::new_v4()));
    assert!(
        Fixture::new(Some(receipt))
            .db
            .check_previous_process_stopped(7)
            .is_err(),
        "invalid nonce is corrupt evidence even after reboot"
    );
}

#[cfg(target_os = "linux")]
struct RefusingManager {
    timeout: bool,
}

#[cfg(target_os = "linux")]
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl RefusingManager {
    #[zbus(property)]
    fn version(&self) -> String {
        "fixture".into()
    }

    fn get_unit(&self, _unit: &str) -> zbus::fdo::Result<zbus::zvariant::OwnedObjectPath> {
        if self.timeout {
            std::thread::sleep(std::time::Duration::from_secs(7));
        }
        Err(zbus::fdo::Error::AccessDenied(
            "fixture denies population lookup".into(),
        ))
    }
}

#[cfg(target_os = "linux")]
#[test]
fn manager_permission_errors_and_timeouts_do_not_certify_empty_scopes() {
    use std::io::BufRead;
    if let Some(mode) = std::env::var_os("OWNERSHIP_FAKE_MANAGER") {
        let mut receipt = current_receipt();
        receipt["creation"] = serde_json::json!(receipt["creation"].as_u64().unwrap() + 1);
        let unit = format!(
            "houston-session-fixture-7-{}.scope",
            uuid::Uuid::new_v4().simple()
        );
        receipt["ownership"] = serde_json::json!({"kind":"linux_scope","unit":unit,"cgroup":format!("/user.slice/{unit}")});
        let fixture = Fixture::new(Some(receipt));
        let error = fixture
            .db
            .check_previous_process_stopped(7)
            .unwrap_err()
            .to_string();
        assert!(error.contains("ownership unknown"), "{mode:?}: {error}");
        assert!(fixture.db.acknowledge_uncontained_recovery(7).is_err());
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
    for timeout in [false, true] {
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
            .serve_at("/org/freedesktop/systemd1", RefusingManager { timeout })
            .unwrap()
            .build()
            .unwrap();
        let result = houston_core::spawn::command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "manager_permission_errors_and_timeouts_do_not_certify_empty_scopes",
                "--nocapture",
            ])
            .env(
                "OWNERSHIP_FAKE_MANAGER",
                if timeout { "timeout" } else { "denied" },
            )
            .env("DBUS_SESSION_BUS_ADDRESS", announced.trim())
            .status()
            .unwrap();
        assert!(result.success());
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
            "manager_permission_errors_and_timeouts_do_not_certify_empty_scopes",
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

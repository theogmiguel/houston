#![cfg(all(target_os = "linux", feature = "test-barriers"))]

mod common;

use houston_core::daemon::{Daemon, DaemonConfig, RespawnConversation, SafeModeFlags};
use houston_core::db::{Db, MessageReceipt, NewInboxRow};
use houston_protocol as proto;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CONVERSATION: &str = "00000000-0000-4000-8000-000000000249";

fn isolated(test: &str) -> bool {
    if std::env::var_os("HOUSTON_REPLACEMENT_FIXTURE").is_some() {
        return false;
    }
    let home = tempfile::tempdir().unwrap();
    let status = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
        .args(["--exact", test, "--nocapture"])
        .env("HOUSTON_REPLACEMENT_FIXTURE", "1")
        .status()
        .unwrap();
    assert!(status.success());
    true
}

fn provider() {
    use std::os::unix::fs::PermissionsExt;
    let path = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
        .join("provider-shims/claude");
    std::fs::write(
        &path,
        "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$PWD/receipt-$HOUSTON_SESSION\"\nprintf 'replacement-ready\\n'\nwhile IFS= read -r ignored; do :; done\n",
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn info(id: u32, project: &Path, parent: Option<u32>) -> proto::SessionInfo {
    proto::SessionInfo {
        checkout: None,
        activity: None,
        id,
        agent: proto::AgentKind::Claude,
        project_dir: project.display().to_string(),
        cwd: project.display().to_string(),
        state: proto::SessionState::Interrupted,
        title: format!("Replacement-{id}"),
        codename: format!("Replacement-{id}"),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by: parent,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        delegation: None,
        inbox_unread: 0,
        tags: vec![],
        session_origin: Some(id),
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: None,
        last_agent_message: None,
        slept_at_ms: None,
    }
}

fn boot(database: &Path) -> Arc<Daemon> {
    Daemon::new_with_safe_mode_flags_for_test(
        DaemonConfig {
            token: common::TOKEN.into(),
            db_path: database.to_path_buf(),
        },
        SafeModeFlags {
            disable_auto_restore: true,
            disable_swarm_autolaunch: true,
        },
    )
    .unwrap()
}

fn seed(database: &Path, project: &Path, sleeping: bool) -> Db {
    let db = Db::open(database).unwrap();
    let mut parent = info(1, project, None);
    if sleeping {
        parent.state = proto::SessionState::Sleeping;
        parent.latest_prompt = Some("Preserve the Wake prompt".into());
        parent.last_agent_message = Some("Preserve the Wake response".into());
        parent.slept_at_ms = Some(1234);
        parent.context = Some(proto::SessionContext::unknown());
    }
    db.insert_session(&parent).unwrap();
    let transcript = project.join("conversation.jsonl");
    std::fs::write(&transcript, b"{}\n").unwrap();
    db.set_session_resume_handle(1, Some((CONVERSATION, transcript.to_str())))
        .unwrap();
    db.insert_session(&info(2, project, Some(1))).unwrap();
    db.delegation_create(1, 2, Some("retained-child"), "fixture mission", 1)
        .unwrap();
    // A session's parent identity also survives if its delegation record is absent.
    db.insert_session(&info(3, project, Some(1))).unwrap();
    db
}

fn observe(daemon: &Arc<Daemon>, project: &Path) -> Arc<Mutex<Vec<(u32, u32)>>> {
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&receipts);
    let project = project.to_path_buf();
    daemon.set_startup_test(
        None,
        Box::new(move |id, pid| {
            observed.lock().unwrap().push((id, pid));
            let receipt = project.join(format!("receipt-{id}"));
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(value) = std::fs::read_to_string(&receipt) {
                    assert_eq!(value.trim().parse::<u32>().unwrap(), pid);
                    break;
                }
                assert!(Instant::now() < deadline, "fixture did not start");
                std::thread::sleep(Duration::from_millis(5));
            }
        }),
    );
    receipts
}

fn assert_reaped(pid: u32) {
    use nix::sys::wait::{waitpid, WaitPidFlag};
    use nix::unistd::Pid;
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert_eq!(
        waitpid(
            Pid::from_raw(i32::try_from(pid).unwrap()),
            Some(WaitPidFlag::WNOHANG),
        ),
        Err(nix::errno::Errno::ECHILD),
    );
}

fn inbox(db: &Db, project: &Path, to: u32, from: u32) -> i64 {
    db.inbox_insert(
        &NewInboxRow {
            to_session: to,
            workspace: project.display().to_string(),
            from_session: Some(from),
            request_id: None,
            kind: "mail".into(),
            urgent: false,
            summary: "Preserved mail".into(),
            body: "Preserved mail body".into(),
            artifacts: vec![],
            provisional: false,
            corrects: None,
            reason: None,
            ready: false,
        },
        1,
    )
    .unwrap()
}

#[test]
fn replacement_storage_failures_preserve_the_original_and_owned_processes() {
    if isolated("replacement_storage_failures_preserve_the_original_and_owned_processes") {
        return;
    }
    provider();
    for trigger in [
        "BEFORE UPDATE OF launch_selections ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF approval_mode ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF resume_session_id ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF resume_agent ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF resume_cwd ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF transcript_path ON sessions WHEN NEW.id != 1",
        "BEFORE UPDATE OF parent_session ON delegations",
        "BEFORE UPDATE OF to_session ON pane_inbox",
        "BEFORE UPDATE OF state ON sessions WHEN OLD.id = 1 AND NEW.state = 'closed'",
    ] {
        let state = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = state.path().join("test.db");
        let db = seed(&database, project.path(), false);
        let daemon = boot(&database);
        let message = inbox(&db, project.path(), 1, 2);
        let conn = rusqlite::Connection::open(&database).unwrap();
        let before = db.delegation_for_child(2).unwrap().unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER replacement_failure {trigger} BEGIN SELECT RAISE(ABORT, 'replacement storage failure'); END;"
        ))
        .unwrap();
        let observed = observe(&daemon, project.path());
        let mut events = daemon.subscribe();
        let result = daemon.respawn(1, false, None, None, false);
        assert!(result.is_err(), "storage failure was swallowed: {trigger}");
        let (new, pid) = observed.lock().unwrap()[0];
        assert_reaped(pid);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sessions WHERE id = ?1", [new], |r| {
                r.get::<_, u32>(0)
            })
            .unwrap(),
            0,
        );
        assert_eq!(db.session_resume_handle(1).unwrap().unwrap().0, CONVERSATION);
        assert_eq!(db.session_final(1).unwrap().unwrap().0, proto::SessionState::Interrupted);
        assert!(daemon.list().iter().any(|session| session.id == 1));
        assert_eq!(db.delegation_parent_of(2).unwrap(), Some(1));
        assert_eq!(db.delegation_for_child(2).unwrap().unwrap().state, before.state);
        assert_eq!(db.session_orchestration_identity(3).unwrap().0, Some(1));
        assert_eq!(db.inbox_get(message).unwrap().unwrap().to_session, 1);
        while let Ok(event) = events.try_recv() {
            if let houston_core::daemon::Outbound::Control(body) = event {
                assert!(!matches!(
                    serde_json::from_str::<proto::ServerMsg>(&body).unwrap(),
                    proto::ServerMsg::SessionCreated { .. } | proto::ServerMsg::SessionRemoved { .. }
                ));
            }
        }
        conn.execute_batch("DROP TRIGGER replacement_failure").unwrap();
        let reopened = boot(&database);
        assert!(reopened.list().iter().any(|session| session.id == 1));
        assert!(!reopened.list().iter().any(|session| session.id == new));
        reopened.close(1).unwrap();
        reopened.close(3).unwrap();
    }
}

#[test]
fn replacement_commits_identity_ancestry_inbox_and_wake_cues_together() {
    if isolated("replacement_commits_identity_ancestry_inbox_and_wake_cues_together") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let db = seed(&database, project.path(), true);
    let daemon = boot(&database);
    let before = daemon.list().into_iter().find(|info| info.id == 1).unwrap();
    let incoming = inbox(&db, project.path(), 1, 2);
    let outgoing = inbox(&db, project.path(), 2, 1);
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute("UPDATE pane_inbox SET to_session = 0, original_to = 1 WHERE id = ?1", [incoming])
        .unwrap();
    let context = serde_json::json!({
        "target": 1, "origin": 1, "provider": "claude", "workspace": project.path(),
        "cwd": project.path(), "profile": null, "profile_dir": null,
        "conversation": db.session_resume_handle(1).unwrap(), "ancestry": []
    })
    .to_string();
    let instruction = db.instruction_accept(
        1, &context, proto::InstructionMode::Queue, "Never replay this automatically",
        &MessageReceipt::new(1, Some("replacement-held".into()), "pane_prompt", &serde_json::json!({})),
        1,
    ).unwrap();
    db.instruction_recover(2).unwrap();
    let observed = observe(&daemon, project.path());
    let mut events = daemon.subscribe();
    let replacement = daemon.wake_session(1).unwrap();
    let (_, pid) = observed.lock().unwrap()[0];
    assert_eq!(replacement.session_origin, Some(1));
    assert_eq!(replacement.latest_prompt, before.latest_prompt);
    assert_eq!(replacement.last_agent_message, before.last_agent_message);
    assert_eq!(replacement.context, before.context);
    assert_eq!(replacement.slept_at_ms, before.slept_at_ms);
    assert_eq!(db.session_resume_handle(replacement.id).unwrap().unwrap().0, CONVERSATION);
    assert!(db.session_is_closed(1).unwrap());
    assert_eq!(db.session_resume_handle(1).unwrap(), None);
    assert_eq!(db.delegation_parent_of(2).unwrap(), Some(replacement.id));
    assert_eq!(db.session_orchestration_identity(3).unwrap().0, Some(replacement.id));
    let mail = db.inbox_get(incoming).unwrap().unwrap();
    assert_eq!(mail.to_session, replacement.id);
    assert_eq!(mail.original_to, Some(replacement.id));
    assert_eq!(db.inbox_get(outgoing).unwrap().unwrap().from_session, Some(replacement.id));
    let held = db.instruction_row(&instruction.info.id).unwrap().unwrap();
    assert_eq!(held.target, 1);
    assert_eq!(held.context, context);
    assert_eq!(held.info.state, proto::InstructionState::HeldAfterRecovery);
    let mut created = false;
    while let Ok(event) = events.try_recv() {
        if let houston_core::daemon::Outbound::Control(body) = event {
            if let proto::ServerMsg::SessionCreated { info } = serde_json::from_str(&body).unwrap() {
                if info.id == replacement.id {
                    created = true;
                    assert_eq!(info.latest_prompt, before.latest_prompt);
                    assert_eq!(info.context, before.context);
                }
            }
        }
    }
    assert!(created);
    let restored = Db::open(&database).unwrap().list_interrupted().unwrap();
    assert!(!restored.iter().any(|info| info.id == 1));
    daemon.close(replacement.id).unwrap();
    assert_reaped(pid);
    daemon.close(3).unwrap();
}

#[test]
fn failed_wake_keeps_the_exact_sleeping_conversation_retryable() {
    if isolated("failed_wake_keeps_the_exact_sleeping_conversation_retryable") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let db = seed(&database, project.path(), true);
    let daemon = boot(&database);
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER replacement_failure BEFORE INSERT ON sessions
         WHEN NEW.latest_prompt IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Wake cue failure'); END;"
    ).unwrap();
    let observed = observe(&daemon, project.path());
    assert!(daemon.wake_session(1).is_err());
    assert_reaped(observed.lock().unwrap()[0].1);
    assert_eq!(db.session_final(1).unwrap().unwrap().0, proto::SessionState::Sleeping);
    assert_eq!(db.session_resume_handle(1).unwrap().unwrap().0, CONVERSATION);
    conn.execute_batch("DROP TRIGGER replacement_failure").unwrap();
    let replacement = daemon.wake_session(1).unwrap();
    assert_eq!(replacement.latest_prompt.as_deref(), Some("Preserve the Wake prompt"));
    daemon.close(replacement.id).unwrap();
    daemon.close(3).unwrap();
}

#[test]
fn failed_forced_restart_preserves_the_original_resume_handle() {
    if isolated("failed_forced_restart_preserves_the_original_resume_handle") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let db = seed(&database, project.path(), false);
    let daemon = boot(&database);
    observe(&daemon, project.path());
    let original = daemon.respawn(1, false, None, None, false).unwrap();
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(&format!(
        "CREATE TRIGGER replacement_failure BEFORE UPDATE OF state ON sessions
         WHEN OLD.id = {} AND NEW.state = 'closed'
         BEGIN SELECT RAISE(ABORT, 'forced restart storage failure'); END;",
        original.id,
    ))
    .unwrap();
    let observed = observe(&daemon, project.path());
    assert!(daemon.respawn(original.id, false, None, None, true).is_err());
    assert_reaped(observed.lock().unwrap()[0].1);
    assert_eq!(db.session_resume_handle(original.id).unwrap().unwrap().0, CONVERSATION);
    assert_eq!(db.session_final(original.id).unwrap().unwrap().0, proto::SessionState::Interrupted);
    assert!(db.list_interrupted().unwrap().iter().any(|info| info.id == original.id));
    assert!(daemon.list().iter().any(|info| info.id == original.id));
    conn.execute_batch("DROP TRIGGER replacement_failure").unwrap();
    let replacement = daemon.respawn(original.id, false, None, None, false).unwrap();
    assert_eq!(db.session_resume_handle(replacement.id).unwrap().unwrap().0, CONVERSATION);
    daemon.close(replacement.id).unwrap();
    daemon.close(3).unwrap();
}

#[test]
fn failed_forced_child_replacement_preserves_boot_eligibility_and_its_mission() {
    if isolated("failed_forced_child_replacement_preserves_boot_eligibility_and_its_mission") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let db = seed(&database, project.path(), false);
    let child_conversation = "00000000-0000-4000-8000-000000000250";
    let transcript = project.path().join("child-conversation.jsonl");
    std::fs::write(&transcript, b"child turn\n").unwrap();
    db.set_session_resume_handle(2, Some((child_conversation, transcript.to_str()))).unwrap();
    let daemon = boot(&database);
    observe(&daemon, project.path());
    let parent = daemon.respawn(1, false, None, None, false).unwrap();
    let child = daemon.list().into_iter()
        .find(|info| info.session_origin == Some(2) && info.spawned_by == Some(parent.id))
        .unwrap();
    let before = db.delegation_for_child(child.id).unwrap().unwrap();
    assert_eq!(before.state, "working");
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(&format!(
        "CREATE TRIGGER replacement_failure BEFORE UPDATE OF state ON sessions
         WHEN OLD.id = {} AND NEW.state = 'closed'
         BEGIN SELECT RAISE(ABORT, 'forced child retirement failure'); END;",
        child.id,
    )).unwrap();
    let observed = observe(&daemon, project.path());
    assert!(daemon.respawn(child.id, false, None, None, true).is_err());
    assert_reaped(observed.lock().unwrap()[0].1);
    assert_eq!(db.session_final(child.id).unwrap().unwrap().0, proto::SessionState::Interrupted);
    assert!(db.list_interrupted().unwrap().iter().any(|info| info.id == child.id));
    assert_eq!(db.session_resume_handle(child.id).unwrap().unwrap().0, child_conversation);
    let after = db.delegation_for_child(child.id).unwrap().unwrap();
    assert_eq!(after.state, before.state);
    assert_eq!(after.round, before.round);
    assert_eq!(after.settled_at, before.settled_at);
    assert_eq!(after.stop_reason, before.stop_reason);
    conn.execute_batch("DROP TRIGGER replacement_failure").unwrap();
    let replacement = daemon.respawn(child.id, false, None, None, false).unwrap();
    daemon.close(replacement.id).unwrap();
    daemon.close(parent.id).unwrap();
    daemon.close(3).unwrap();
}

fn seed_scrollback(state: &Path) {
    let path = state.join("scrollback/1.bin");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut ring = houston_core::scrollback::Scrollback::default();
    ring.push(b"saved-before-stop\r\n");
    ring.persist(&path).unwrap();
}

fn assert_saved_scrollback(daemon: &Daemon, id: u32) {
    let replay = daemon.scrollback(id, None).unwrap();
    assert!(String::from_utf8_lossy(&replay.data).contains("saved-before-stop"));
}

#[test]
fn root_restore_carries_saved_scrollback_before_retiring_the_old_row() {
    if isolated("root_restore_carries_saved_scrollback_before_retiring_the_old_row") {
        return;
    }
    provider();
    for clean in [false, true] {
        let state = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = state.path().join("test.db");
        let db = seed(&database, project.path(), false);
        seed_scrollback(state.path());
        if clean {
            std::fs::write(state.path().join("clean-shutdown"), b"").unwrap();
        }
        let daemon = Daemon::new(DaemonConfig {
            token: common::TOKEN.into(),
            db_path: database.clone(),
        })
        .unwrap();
        let replacement = daemon.list().into_iter().find(|info| info.spawned_by.is_none()).unwrap();
        assert_ne!(replacement.id, 1);
        assert_saved_scrollback(&daemon, replacement.id);
        let saved = houston_core::scrollback::Scrollback::load(
            &state.path().join(format!("scrollback/{}.bin", replacement.id)),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&saved.replay(None).data).contains("saved-before-stop"));
        assert!(!state.path().join("scrollback/1.bin").exists());
        // Simulate the next boot classifier without another ring checkpoint.
        db.mark_live_as_interrupted().unwrap();
        let reopened = boot(&database);
        assert_saved_scrollback(&reopened, replacement.id);
        reopened.close(replacement.id).unwrap();
        reopened.close(3).unwrap();
        daemon.close(replacement.id).unwrap();
        daemon.close(3).unwrap();
    }
}

#[test]
fn a_failed_snapshot_transfer_keeps_the_old_ring_and_retryable_pane() {
    if isolated("a_failed_snapshot_transfer_keeps_the_old_ring_and_retryable_pane") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let db = seed(&database, project.path(), false);
    seed_scrollback(state.path());
    let daemon = boot(&database);
    let blocked = state.path().join("scrollback/4.bin.tmp");
    std::fs::create_dir(&blocked).unwrap();
    let observed = observe(&daemon, project.path());
    assert!(daemon.respawn_with(1, false, None, None, false, RespawnConversation::Restore).is_err());
    let (new, pid) = observed.lock().unwrap()[0];
    assert_eq!(new, 4);
    assert_reaped(pid);
    assert!(daemon.list().iter().any(|info| info.id == 1));
    assert_saved_scrollback(&daemon, 1);
    assert!(!state.path().join("scrollback/4.bin").exists());
    assert_eq!(db.session_resume_handle(1).unwrap().unwrap().0, CONVERSATION);
    std::fs::remove_dir(blocked).unwrap();
    let replacement = daemon.respawn_with(1, false, None, None, false, RespawnConversation::Restore).unwrap();
    assert_saved_scrollback(&daemon, replacement.id);
    daemon.close(replacement.id).unwrap();
    daemon.close(3).unwrap();
}

#[test]
fn a_failed_replacement_removes_its_staged_ring_only() {
    if isolated("a_failed_replacement_removes_its_staged_ring_only") {
        return;
    }
    provider();
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let database = state.path().join("test.db");
    let _db = seed(&database, project.path(), false);
    seed_scrollback(state.path());
    let daemon = boot(&database);
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER replacement_failure BEFORE UPDATE OF state ON sessions
         WHEN OLD.id = 1 AND NEW.state = 'closed'
         BEGIN SELECT RAISE(ABORT, 'retirement failure after ring preparation'); END;",
    ).unwrap();
    let observed = observe(&daemon, project.path());
    assert!(daemon.respawn_with(1, false, None, None, false, RespawnConversation::Restore).is_err());
    let (new, pid) = observed.lock().unwrap()[0];
    assert_reaped(pid);
    assert_saved_scrollback(&daemon, 1);
    assert!(!state.path().join(format!("scrollback/{new}.bin")).exists());
    conn.execute_batch("DROP TRIGGER replacement_failure").unwrap();
    daemon.close(1).unwrap();
    daemon.close(3).unwrap();
}

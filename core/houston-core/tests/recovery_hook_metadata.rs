use houston_core::{db::Db, hook_drop::{self, DropName, HookDrop}};
use houston_protocol::AgentKind;

struct Fixture {
    state: tempfile::TempDir,
    db: Db,
    now: u64,
}

impl Fixture {
    fn new(agent: &str, detected: Option<&str>) -> Self {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("test.db");
        let db = Db::open(&path).unwrap();
        let conn = rusqlite::Connection::open(path).unwrap();
        let now = hook_drop::now_ms();
        conn.execute("INSERT INTO sessions (id, agent, detected_agent, project_dir, cwd, state, title, codename, created_at) VALUES (7, ?1, ?2, ?3, ?3, 'running', 'fixture', 'fixture', ?4)", rusqlite::params![agent, detected, state.path().to_str().unwrap(), now / 1000]).unwrap();
        Self { state, db, now }
    }

    fn drop(&self, event: &str, conversation: &str) -> HookDrop {
        HookDrop {
            session: 7, event: event.into(), session_id: Some(conversation.into()),
            cwd: Some(self.state.path().display().to_string()),
            transcript_path: Some(self.state.path().join("transcript.jsonl").display().to_string()),
            ..HookDrop::default()
        }
    }

    fn order(&self, seq: u32) -> DropName {
        DropName { ms: self.now, seq, session: 7 }
    }
}

#[test]
fn changing_effective_provider_preserves_the_handle_with_a_named_refusal() {
    let fixture = Fixture::new("shell", Some("codex"));
    fixture.db.set_session_resume_handle(7, Some(("codex-conversation", None))).unwrap();
    fixture.db.update_session_detected(7, AgentKind::Claude).unwrap();
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "codex-conversation");
    assert!(!fixture.db.session_has_bound_resume_handle(7).unwrap());
    let error = fixture.db.check_session_resume_binding(7, AgentKind::Claude, fixture.state.path()).unwrap_err();
    assert!(error.contains("belongs to codex"), "{error}");
}

#[test]
fn legacy_shell_handle_is_preserved_but_requires_new_root_binding() {
    let fixture = Fixture::new("shell", Some("claude"));
    let conn = rusqlite::Connection::open(fixture.state.path().join("test.db")).unwrap();
    conn.execute("UPDATE sessions SET resume_session_id = 'unknown-owner' WHERE id = 7", []).unwrap();
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "unknown-owner");
    let error = fixture.db.check_session_resume_binding(7, AgentKind::Claude, fixture.state.path()).unwrap_err();
    assert!(error.contains("no validated provider and folder binding"), "{error}");
    assert!(!fixture.db.session_has_bound_resume_handle(7).unwrap());
}

#[test]
fn fixed_provider_legacy_handles_gain_their_recorded_namespace_only_once() {
    let state = tempfile::tempdir().unwrap();
    let path = state.path().join("legacy.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE sessions (id INTEGER PRIMARY KEY, agent TEXT NOT NULL,
        project_dir TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER,
        created_at INTEGER NOT NULL, ended_at INTEGER, resume_session_id TEXT,
        resume_transcript_path TEXT, detected_agent TEXT);
        INSERT INTO sessions VALUES (7, 'claude', '/tmp', '/tmp', 'interrupted', NULL, 1, NULL,
            'claude-legacy', NULL, NULL);
        INSERT INTO sessions VALUES (8, 'shell', '/tmp', '/tmp', 'interrupted', NULL, 1, NULL,
            'shell-legacy', NULL, 'claude');").unwrap();
    let db = Db::open(&path).unwrap();
    assert_eq!(db.session_resume_binding(7).unwrap(), Some(("claude".into(), "/tmp".into())));
    assert_eq!(db.session_resume_binding(8).unwrap(), None);
    assert_eq!(db.session_resume_handle(8).unwrap().unwrap().0, "shell-legacy");
    conn.execute("UPDATE sessions SET resume_agent = NULL, resume_cwd = NULL WHERE id = 7", []).unwrap();
    drop(db);
    let reopened = Db::open(&path).unwrap();
    assert_eq!(reopened.session_resume_binding(7).unwrap(), None,
        "a deliberately invalidated binding must not be reconstructed on every open");
}

#[test]
fn a_new_conversation_without_a_path_cannot_inherit_another_transcript() {
    let fixture = Fixture::new("claude", None);
    fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "root-a"), AgentKind::Claude, fixture.order(1), false).unwrap().unwrap();
    let mut next = fixture.drop("UserPromptSubmit", "root-b");
    next.transcript_path = None;
    fixture.db.record_root_hook_metadata(&next, AgentKind::Claude, fixture.order(2), false).unwrap().unwrap();
    assert_eq!(fixture.db.session_resume_handle(7).unwrap(), Some(("root-b".into(), None)));
}

#[test]
fn failed_unlink_cannot_rewind_durable_metadata_at_next_boot() {
    let fixture = Fixture::new("claude", None);
    fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "root-a"), AgentKind::Claude, fixture.order(1), false).unwrap().unwrap();
    fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "root-b"), AgentKind::Claude, fixture.order(2), false).unwrap().unwrap();
    fixture.db.mark_live_as_interrupted().unwrap();
    assert!(fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "root-a"), AgentKind::Claude, fixture.order(1), true).unwrap().is_none());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "root-b");
}

#[test]
fn recovery_ignores_subagent_input_tool_and_mismatched_provider_metadata() {
    let fixture = Fixture::new("claude", None);
    fixture.db.mark_live_as_interrupted().unwrap();
    for (event, provider) in [("SubagentStop", AgentKind::Claude), ("PermissionRequest", AgentKind::Claude), ("PreToolUse", AgentKind::Claude), ("UserPromptSubmit", AgentKind::Codex)] {
        assert!(fixture.db.record_root_hook_metadata(&fixture.drop(event, "other-root"), provider, fixture.order(1), true).unwrap().is_none());
    }
    let mut subagent = fixture.drop("Stop", "child-root");
    subagent.agent_id = Some("agent-child".into());
    assert!(fixture.db.record_root_hook_metadata(&subagent, AgentKind::Claude, fixture.order(1), true).unwrap().is_none());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap(), None);
}

#[test]
fn shell_cwd_change_invalidates_binding_and_supersedes_a_delayed_hook() {
    let fixture = Fixture::new("shell", Some("claude"));
    let drop = fixture.drop("UserPromptSubmit", "root-a");
    fixture.db.record_root_hook_metadata(&drop, AgentKind::Claude, fixture.order(1), false).unwrap().unwrap();
    let changed = fixture.state.path().join("other");
    std::fs::create_dir(&changed).unwrap();
    assert!(fixture.db.record_shell_cwd(7, changed.to_str().unwrap(), fixture.now + 1).unwrap());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "root-a");
    assert!(!fixture.db.session_has_bound_resume_handle(7).unwrap());
    let error = fixture.db.check_session_resume_binding(7, AgentKind::Claude, &changed).unwrap_err();
    assert!(error.contains("selected folder"), "{error}");
    assert!(fixture.db.record_root_hook_metadata(&drop, AgentKind::Claude, fixture.order(2), false).unwrap().is_none());
    let conn = rusqlite::Connection::open(fixture.state.path().join("test.db")).unwrap();
    let cwd: String = conn.query_row("SELECT cwd FROM sessions WHERE id = 7", [], |row| row.get(0)).unwrap();
    assert_eq!(cwd, changed.to_str().unwrap());
}

#[test]
fn recovery_refuses_filename_payload_session_mismatch() {
    let fixture = Fixture::new("claude", None);
    let dir = hook_drop::drop_dir(fixture.state.path());
    let path = hook_drop::write_drop(&dir, &fixture.drop("Stop", "root-a"), fixture.now).unwrap();
    let mut mismatched = fixture.drop("Stop", "root-a");
    mismatched.session = 8;
    std::fs::write(&path, serde_json::to_vec(&mismatched).unwrap()).unwrap();
    let out = hook_drop::run_pass(&dir, &mut hook_drop::DropDirState::new(), fixture.now + 1, hook_drop::Pass::RecoveryMetadata, |_| panic!("mismatched payload applied"));
    assert_eq!(out.applied, 0);
    assert!(path.exists());
}

#[test]
fn root_metadata_write_failure_rolls_back_the_entire_namespace() {
    let fixture = Fixture::new("claude", None);
    let conn = rusqlite::Connection::open(fixture.state.path().join("test.db")).unwrap();
    conn.execute_batch("CREATE TRIGGER root_metadata_failure BEFORE UPDATE OF resume_session_id ON sessions BEGIN SELECT RAISE(ABORT, 'injected root metadata failure'); END").unwrap();
    assert!(fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "root-a"), AgentKind::Claude, fixture.order(1), false).is_err());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap(), None);
    assert_eq!(fixture.db.session_transcript_link(7).unwrap(), (None, None));
    assert_eq!(fixture.db.session_resume_binding(7).unwrap(), None);
    let clock: Option<u64> = conn.query_row("SELECT root_hook_ms FROM sessions WHERE id = 7", [], |row| row.get(0)).unwrap();
    assert_eq!(clock, None);
}

#[test]
fn a_bounded_recovery_scan_refuses_partial_application() {
    let fixture = Fixture::new("claude", None);
    let dir = hook_drop::drop_dir(fixture.state.path());
    std::fs::create_dir_all(&dir).unwrap();
    for seq in 1..=4097 {
        let name = format!("{:013}-{seq:06}-s7.json", fixture.now);
        std::fs::write(dir.join(name), b"{}").unwrap();
    }
    let out = hook_drop::run_pass(&dir, &mut hook_drop::DropDirState::new(), fixture.now + 1, hook_drop::Pass::RecoveryMetadata, |_| panic!("partial recovery applied"));
    assert!(!out.listed_ok);
    assert_eq!(out.applied, 0);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 4097);
}

#[test]
fn an_early_native_hook_is_not_rejected_by_the_later_row_creation_timestamp() {
    let fixture = Fixture::new("claude", None);
    let conn = rusqlite::Connection::open(fixture.state.path().join("test.db")).unwrap();
    // A process starts and writes its hook while its startup transaction is delayed.
    conn.execute("UPDATE sessions SET created_at = ?1 WHERE id = 7", [fixture.now / 1000 + 2]).unwrap();
    let update = fixture.db.record_root_hook_metadata(&fixture.drop("UserPromptSubmit", "early-root"), AgentKind::Claude, fixture.order(1), false).unwrap();
    assert!(update.is_some());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "early-root");
}

#[test]
fn a_natural_exit_accepts_final_root_metadata_but_kill_and_close_do_not() {
    let fixture = Fixture::new("claude", None);
    fixture.db.update_session_state(7, houston_protocol::SessionState::Exited, Some(0)).unwrap();
    assert!(fixture.db.record_root_hook_metadata(&fixture.drop("Stop", "final-root"), AgentKind::Claude, fixture.order(1), false).unwrap().is_some());
    assert_eq!(fixture.db.session_resume_handle(7).unwrap().unwrap().0, "final-root");
    assert!(fixture.db.root_hook_recovery_session_ids().unwrap().contains(&7));
    fixture.db.update_session_state(7, houston_protocol::SessionState::Killed, None).unwrap();
    assert!(!fixture.db.root_hook_recovery_session_ids().unwrap().contains(&7));
    assert!(fixture.db.record_root_hook_metadata(&fixture.drop("Stop", "must-not-return"), AgentKind::Claude, fixture.order(2), true).unwrap().is_none());
    fixture.db.mark_closed(7).unwrap();
    assert!(!fixture.db.root_hook_recovery_session_ids().unwrap().contains(&7));
}

#[test]
fn blocked_recovery_metadata_survives_the_ordinary_seed_age_limit() {
    let fixture = Fixture::new("claude", None);
    let sampled = fixture.now - 2 * hook_drop::MAX_AGE_MS;
    let dir = hook_drop::drop_dir(fixture.state.path());
    let path = hook_drop::write_drop(&dir, &fixture.drop("Stop", "final-root"), sampled).unwrap();
    let mut state = hook_drop::DropDirState::new();
    state.protect_sessions([7]);
    let out = hook_drop::run_pass(&dir, &mut state, fixture.now, hook_drop::Pass::Seed, |_| panic!("blocked metadata applied as lifecycle"));
    assert_eq!(out.collected, 0);
    assert_eq!(out.kept, 1);
    assert!(path.exists());
}

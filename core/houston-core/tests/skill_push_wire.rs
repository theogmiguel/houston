mod common;

use houston_protocol as proto;
use std::path::Path;

use common::start_daemon_with_handle;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn set_test_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    home
}

fn write_skill(home: &Path, tool_dir: &str, name: &str, body: &str) {
    let dir = home.join(tool_dir).join("skills").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), body).unwrap();
}

fn skill_sync(
    msg: proto::ServerMsg,
) -> (
    Vec<proto::SkillToolState>,
    Vec<proto::SkillPushRecord>,
    bool,
) {
    match msg {
        proto::ServerMsg::SkillSync {
            tools,
            pushes,
            auto_push_enabled,
        } => (tools, pushes, auto_push_enabled),
        other => panic!("expected SkillSync, got {other:?}"),
    }
}

#[tokio::test]
async fn auto_push_defaults_off_and_a_plain_read_leaves_drift_alone() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    write_skill(home.path(), ".claude", "triage", "canonical body\n");

    let (_tools, pushes, auto_push_enabled) = skill_sync(daemon.skill_sync_state());
    assert!(
        !auto_push_enabled,
        "the 2026-08-18 overturn authorised push, never a silent default"
    );
    assert!(
        pushes.is_empty(),
        "auto-push is off; a plain read must not have pushed anything: {pushes:?}"
    );
    assert!(
        !home.path().join(".cursor/skills/triage/SKILL.md").exists(),
        "a plain read with auto-push off must not touch Cursor's directory"
    );
}

#[tokio::test]
async fn explicit_push_writes_the_missing_copy_and_is_visible_in_the_ledger() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    write_skill(home.path(), ".claude", "triage", "canonical body\n");

    let (tools, pushes, _) =
        skill_sync(daemon.skill_push(Some(proto::AgentKind::Cursor), Some("triage".to_string())));
    assert_eq!(pushes.len(), 1, "{pushes:?}");
    let record = &pushes[0];
    assert_eq!(record.tool, proto::AgentKind::Cursor);
    assert_eq!(record.skill, "triage");
    assert!(
        !record.had_existing,
        "no pre-existing Cursor copy — undo must remove, not restore"
    );

    let cursor_col = tools
        .iter()
        .find(|c| c.tool == proto::AgentKind::Cursor)
        .expect("cursor column");
    assert_eq!(cursor_col.skills.len(), 1);
    assert_eq!(
        std::fs::read_to_string(home.path().join(".cursor/skills/triage/SKILL.md")).unwrap(),
        "canonical body\n"
    );

    let codex_col = tools
        .iter()
        .find(|c| c.tool == proto::AgentKind::Codex)
        .expect("codex column");
    assert!(codex_col.skills.is_empty(), "{codex_col:?}");
}

#[tokio::test]
async fn undo_restores_a_drifted_copy_that_push_overwrote() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    write_skill(home.path(), ".claude", "triage", "canonical body\n");
    write_skill(home.path(), ".cursor", "triage", "the user's own edit\n");

    let (_, pushes, _) = skill_sync(daemon.skill_push(Some(proto::AgentKind::Cursor), None));
    assert_eq!(pushes.len(), 1);
    assert!(pushes[0].had_existing, "a drifted copy existed to back up");
    assert_eq!(
        std::fs::read_to_string(home.path().join(".cursor/skills/triage/SKILL.md")).unwrap(),
        "canonical body\n",
        "push overwrote the drifted copy"
    );

    let (_, pushes_after_undo, _) =
        skill_sync(daemon.skill_push_undo(proto::AgentKind::Cursor, "triage".to_string()));
    assert!(
        pushes_after_undo.is_empty(),
        "the ledger drops the record once undone: {pushes_after_undo:?}"
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join(".cursor/skills/triage/SKILL.md")).unwrap(),
        "the user's own edit\n",
        "undo restored the user's pre-push content, not Houston's"
    );
}

#[tokio::test]
async fn undo_of_a_tr_created_file_removes_it() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    write_skill(home.path(), ".claude", "triage", "canonical body\n");
    skill_sync(daemon.skill_push(Some(proto::AgentKind::Cursor), None));
    assert!(home.path().join(".cursor/skills/triage/SKILL.md").exists());

    skill_sync(daemon.skill_push_undo(proto::AgentKind::Cursor, "triage".to_string()));
    assert!(
        !home.path().join(".cursor/skills/triage").exists(),
        "undo of a Houston-created file removes the file and its now-empty directory"
    );
}

#[tokio::test]
async fn turning_auto_push_on_makes_the_very_next_read_push_the_drift() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    write_skill(home.path(), ".claude", "triage", "canonical body\n");

    let (_, _, enabled) = skill_sync(daemon.skill_auto_push_set(true));
    assert!(enabled, "the setting itself must report back on");

    let (tools, pushes, auto_push_enabled) = skill_sync(daemon.skill_sync_state());
    assert!(auto_push_enabled);
    assert!(
        !pushes.is_empty(),
        "drift-triggered auto-push must have run on this read: {pushes:?}"
    );
    let cursor_col = tools
        .iter()
        .find(|c| c.tool == proto::AgentKind::Cursor)
        .expect("cursor column");
    assert_eq!(cursor_col.skills.len(), 1);

    let (_, _, enabled) = skill_sync(daemon.skill_auto_push_set(false));
    assert!(!enabled);
}

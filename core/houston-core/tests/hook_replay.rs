use hook_drop::{DropDirState, DropVerdict, HookDrop, Pass};
use houston_core::{db::Db, hook_drop};

#[test]
fn failed_reap_and_restart_do_not_recount_a_compaction() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("test.db");
    let db = Db::open(&database).unwrap();
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute("INSERT INTO sessions (id, agent, project_dir, cwd, state, title, codename, created_at) VALUES (7, 'claude', '/tmp', '/tmp', 'running', 'test', 'test', unixepoch())", []).unwrap();
    let event: HookDrop = serde_json::from_value(serde_json::json!({
        "v": 1, "session": 7, "event": "PreCompact"
    }))
    .unwrap();
    let now = hook_drop::now_ms();
    let dir = hook_drop::drop_dir(temp.path());
    let path = hook_drop::write_drop(&dir, &event, now).unwrap();
    let mut state = DropDirState::new();
    let mut removals = 0;
    let mut effects = 0;
    for _ in 0..2 {
        hook_drop::run_pass_with_io(
            &dir,
            &mut state,
            now + 1,
            Pass::Steady,
            |drop, identity, ms| {
                if db
                    .session_note_compaction_once(drop.session, identity, ms, now + 1)
                    .unwrap()
                    .is_some()
                {
                    effects += 1;
                }
                DropVerdict::Applied
            },
            |_| {
                removals += 1;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "controlled failed unlink",
                ))
            },
        );
    }
    assert_eq!(
        (effects, removals, db.session_compactions(7).unwrap()),
        (1, 2, 1)
    );
    assert!(path.exists());
    drop(db);
    let db = Db::open(&database).unwrap();
    hook_drop::run_pass_with_io(
        &dir,
        &mut DropDirState::new(),
        now + 2,
        Pass::Steady,
        |drop, identity, ms| {
            assert_eq!(
                db.session_note_compaction_once(drop.session, identity, ms, now + 2)
                    .unwrap(),
                None
            );
            DropVerdict::Applied
        },
        |path| std::fs::remove_file(path),
    );
    assert_eq!(db.session_compactions(7).unwrap(), 1);
    assert!(!path.exists());
}

#[test]
fn failed_counter_update_does_not_commit_a_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("test.db");
    let db = Db::open(&database).unwrap();
    let now = hook_drop::now_ms();
    assert!(db
        .session_note_compaction_once(7, "fixture", now, now)
        .is_err());
    let conn = rusqlite::Connection::open(database).unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM hook_compaction_receipts", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        0
    );
}

use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::db::Db;
use houston_core::paths::{LEGACY_PROJECT_DIR, PROJECT_DIR};

fn boot(db_path: &std::path::Path) -> std::sync::Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: "test-token".to_string(),
        db_path: db_path.to_path_buf(),
    })
    .unwrap()
}

#[test]
fn boot_moves_a_known_workspace_legacy_project_dir_and_keeps_its_contents() {
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");

    let handoffs = project.path().join(LEGACY_PROJECT_DIR).join("handoffs");
    std::fs::create_dir_all(&handoffs).unwrap();
    std::fs::write(handoffs.join("1786385642.md"), b"a finished handoff").unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.add_workspace(&project.path().to_string_lossy(), "proj")
            .unwrap();
    }

    let daemon = boot(&db_path);

    assert!(
        !project.path().join(LEGACY_PROJECT_DIR).exists(),
        "the legacy directory survived boot"
    );
    assert_eq!(
        std::fs::read(
            project
                .path()
                .join(PROJECT_DIR)
                .join("handoffs")
                .join("1786385642.md")
        )
        .unwrap(),
        b"a finished handoff",
        "the handoff document did not come along"
    );
    drop(daemon);
}

#[test]
fn boot_leaves_both_alone_when_the_new_directory_already_exists() {
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");

    let legacy = project.path().join(LEGACY_PROJECT_DIR);
    let current = project.path().join(PROJECT_DIR);
    std::fs::create_dir_all(legacy.join("handoffs")).unwrap();
    std::fs::write(legacy.join("handoffs").join("old.md"), b"old").unwrap();
    std::fs::create_dir_all(current.join("handoffs")).unwrap();
    std::fs::write(current.join("handoffs").join("new.md"), b"new").unwrap();
    {
        let db = Db::open(&db_path).unwrap();
        db.add_workspace(&project.path().to_string_lossy(), "proj")
            .unwrap();
    }

    let daemon = boot(&db_path);

    assert_eq!(
        std::fs::read(legacy.join("handoffs").join("old.md")).unwrap(),
        b"old"
    );
    assert_eq!(
        std::fs::read(current.join("handoffs").join("new.md")).unwrap(),
        b"new"
    );
    drop(daemon);
}

#[test]
fn boot_ignores_a_workspace_that_no_longer_exists_on_disk() {
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    {
        let db = Db::open(&db_path).unwrap();
        db.add_workspace("/definitely/not/here", "gone").unwrap();
    }
    let daemon = boot(&db_path);
    drop(daemon);
}

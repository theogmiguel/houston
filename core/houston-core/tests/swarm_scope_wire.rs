#![allow(clippy::disallowed_methods)]

use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;

static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn set_test_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    home
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

fn daemon(state_dir: &Path) -> std::sync::Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: "test-token".to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn roster(label: &str) -> Vec<proto::SwarmRosterEntry> {
    vec![proto::SwarmRosterEntry {
        label: label.to_string(),
        role: proto::SwarmRole::Coordinator,
        agent: proto::AgentKind::Claude,
        auto_approve: false,
        plan_mode: false,
        model: None,
        custom_prompt: None,
        cmd: None,
    }]
}

#[test]
fn swarm_scope_lands_in_the_project_dir_with_no_worktree_or_branch() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let home = set_test_home();
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());

    let id = d
        .swarm_create(
            "Scope Swarm",
            &repo.path().display().to_string(),
            "ship it",
            &roster("Coordinator"),
            &[],
        )
        .unwrap();

    let info = d
        .swarm_list()
        .unwrap()
        .into_iter()
        .find(|s| s.id == id)
        .unwrap();
    assert_eq!(
        info.root_dir,
        repo.path().display().to_string(),
        "the swarm's root_dir must be the project directory itself"
    );

    let scope = repo
        .path()
        .join(".houston")
        .join("swarm")
        .join(id.to_string());
    assert!(
        scope.is_dir(),
        "expected the scope to land at {}, but it does not exist",
        scope.display()
    );
    assert!(
        scope
            .join(if cfg!(windows) {
                "bin/hs-swarm.cmd"
            } else {
                "bin/hs-swarm"
            })
            .exists(),
        "the hs-swarm wrapper must be scaffolded under the project-dir scope: {}",
        scope.display()
    );
    assert!(
        !scope.join("agents.json").exists(),
        "D10: agents.json was hs-mail's roster file — nothing scaffolds it any more: {}",
        scope.display()
    );

    let worktree_list = git(repo.path(), &["worktree", "list"]);
    assert_eq!(
        worktree_list.lines().count(),
        1,
        "expected only the main worktree, got: {worktree_list:?}"
    );
    let old_worktree_root = home.path().join(".houston/swarms").join(id.to_string());
    assert!(
        !old_worktree_root.exists(),
        "no per-swarm dir must exist under the old worktree location: {}",
        old_worktree_root.display()
    );

    let branches = git(repo.path(), &["branch", "--list", "swarm/*"]);
    assert!(
        branches.is_empty(),
        "no swarm/* branch must be created: {branches:?}"
    );
}

#[test]
fn swarm_create_rolls_back_the_row_on_scaffold_failure() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _home = set_test_home();
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let root = tempfile::tempdir().unwrap();

    std::fs::write(root.path().join(".houston"), "not a directory\n").unwrap();

    let err = d
        .swarm_create(
            "Poisoned",
            &root.path().display().to_string(),
            "goal",
            &roster("Coordinator"),
            &[],
        )
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("scaffolding") || err.contains(".houston"),
        "unexpected: {err}"
    );

    assert!(
        d.swarm_list().unwrap().is_empty(),
        "swarm row must be rolled back after a scaffold failure"
    );
}

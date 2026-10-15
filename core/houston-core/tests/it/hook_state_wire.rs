#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::hook_state;
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

fn fixture_roster(label: &str, dir: &Path, name: &str, body: &str) -> proto::SwarmRosterEntry {
    let script = dir.join(name);
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    proto::SwarmRosterEntry {
        label: label.to_string(),
        role: proto::SwarmRole::Coordinator,
        agent: proto::AgentKind::Custom,
        auto_approve: false,
        plan_mode: false,
        model: None,
        custom_prompt: None,
        cmd: Some(vec![script.display().to_string()]),
    }
}

#[test]
fn a_created_swarm_is_resolvable_from_cwd_with_no_daemon() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _home = set_test_home();
    let state = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());

    let (id, work_root) = {
        let d = daemon(state.path());
        let entry = fixture_roster("Coordinator", repo.path(), "sleeper.sh", "sleep 5");
        let id = d
            .swarm_create(
                "Registry Swarm",
                &repo.path().display().to_string(),
                "ship it",
                &[entry],
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
            "the work root must be the project directory"
        );
        (id, info.root_dir)
    };

    let scopes = hook_state::read_scopes(state.path());
    let cwd = Path::new(&work_root).join("src");
    let got = hook_state::resolve_scope(&scopes, &cwd)
        .unwrap()
        .expect("a live swarm's work root must resolve");
    assert_eq!(got.swarm, id);
    assert_eq!(got.work_root, work_root);
    assert_eq!(
        got.scope,
        Path::new(&work_root)
            .join(".houston")
            .join("swarm")
            .join(id.to_string())
            .display()
            .to_string()
    );
    assert_eq!(
        got.root_dir,
        repo.path().display().to_string(),
        "the base repo is carried so a reader need not re-derive it"
    );

    let at_root = hook_state::resolve_scope(&scopes, repo.path())
        .unwrap()
        .expect("the project root itself is under its own swarm's work root");
    assert_eq!(at_root.swarm, id);
}

#[test]
fn destroy_removes_the_entry_and_boot_rebuilds_wholesale() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _home = set_test_home();
    let state = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());

    let live_root = {
        let d = daemon(state.path());
        let keep = fixture_roster("Coordinator", repo.path(), "keep.sh", "sleep 5");
        let kept = d
            .swarm_create(
                "Kept",
                &repo.path().display().to_string(),
                "g",
                &[keep],
                &[],
            )
            .unwrap();
        let doomed_entry = fixture_roster("Coordinator", repo.path(), "doom.sh", "sleep 5");
        let doomed = d
            .swarm_create(
                "Doomed",
                &repo.path().display().to_string(),
                "g",
                &[doomed_entry],
                &[],
            )
            .unwrap();
        assert_eq!(hook_state::read_scopes(state.path()).len(), 2);

        d.swarm_remove(doomed).unwrap();
        let after = hook_state::read_scopes(state.path());
        assert_eq!(
            after.len(),
            1,
            "destroy must take the entry back: {after:?}"
        );
        assert_eq!(after[0].swarm, kept);
        after[0].work_root.clone()
    };

    std::fs::write(hook_state::scopes_path(state.path()), b"{ not json").unwrap();
    assert!(
        hook_state::read_scopes(state.path()).is_empty(),
        "a corrupted registry must degrade to no live scopes, not error"
    );

    let _d2 = daemon(state.path());
    let healed = hook_state::read_scopes(state.path());
    assert_eq!(healed.len(), 1, "boot must rebuild from SQLite: {healed:?}");
    assert_eq!(healed[0].work_root, live_root);
}

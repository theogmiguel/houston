//! A daemon built from the harness environment must never write the account's real user
//! config. The fixture re-executes itself with a stand-in "real" `HOME` that it owns, so a
//! regression is caught without the failing run touching the developer's home.
#![allow(clippy::disallowed_methods)]

use crate::common;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol::AgentKind;
use std::path::Path;

const CHILD: &str = "HOUSTON_HERMETIC_ENV_CHILD";

/// Runs test `name` in a child whose inherited `HOME` stands in for the account's, then
/// checks that none of the `untouched` config directories appeared there.
fn run_with_a_stand_in_account_home(name: &str, untouched: &[&str]) {
    let account_home = tempfile::tempdir().unwrap();
    // A temp dir distinct from the one holding `account_home`, so the child treats its
    // inherited home as the account's rather than as a test-owned one.
    let child_tmp = tempfile::tempdir().unwrap();
    let out = common::hermetic_command(std::env::current_exe().unwrap(), account_home.path())
        .args([
            "--exact",
            &common::exact_path(module_path!(), name),
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("TMPDIR", child_tmp.path())
        .env("TMP", child_tmp.path())
        .env("TEMP", child_tmp.path())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for untouched in untouched {
        let path = account_home.path().join(untouched);
        let mut listing = Vec::new();
        let mut stack = vec![path.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                listing.push(entry.path());
                stack.push(entry.path());
            }
        }
        assert!(
            !path.exists(),
            "{untouched} appeared under the inherited home {}: {listing:?}",
            account_home.path().display()
        );
    }
}

#[tokio::test]
async fn workspace_hooks_land_in_the_hermetic_home_not_the_inherited_one() {
    if common::process_var_os(CHILD).is_some() {
        return child().await;
    }
    run_with_a_stand_in_account_home(
        "workspace_hooks_land_in_the_hermetic_home_not_the_inherited_one",
        &[".claude", ".codex", ".config"],
    );
}

async fn child() {
    let inherited = common::process_var_os("HOME").expect("the fixture sets HOME");
    let env = common::base_env();
    let hermetic = std::path::PathBuf::from(env.var_os("HOME").expect("base_env keeps a HOME"));
    assert_ne!(
        hermetic,
        Path::new(&inherited),
        "base_env must not hand a daemon the inherited HOME"
    );
    let (_addr, _state, daemon) = common::start_daemon_with_handle_in(env.clone()).await;
    let workspace = tempfile::tempdir().unwrap();
    daemon
        .workspace_add(&workspace.path().display().to_string())
        .unwrap();

    let inherited_settings = Path::new(&inherited).join(".claude/settings.json");
    assert!(
        !inherited_settings.exists(),
        "workspace_add wrote {} under the inherited home",
        inherited_settings.display()
    );
    let written = std::fs::read_to_string(hermetic.join(".claude/settings.json"))
        .expect("workspace_add installs Claude hooks under the hermetic home");
    assert!(written.contains("houston-managed"), "{written}");
}

#[tokio::test]
async fn a_daemon_handed_the_inherited_home_refuses_to_write_it() {
    if common::process_var_os(CHILD).is_some() {
        return refusing_child().await;
    }
    // Only Houston's own writes are confined: a real CLI the daemon probes for its version
    // still sees the inherited HOME and may create its own directory there.
    run_with_a_stand_in_account_home(
        "a_daemon_handed_the_inherited_home_refuses_to_write_it",
        &[".claude", ".codex"],
    );
}

/// The daemon gets the raw process environment, the shape that leaked before `base_env`
/// isolated it; only the confinement the harness installs keeps it out of `HOME`.
async fn refusing_child() {
    let _ = common::base_env();
    let state = houston_core::fixture_dirs::tempdir_outside_git();
    let daemon = Daemon::new(DaemonConfig::new(
        common::TOKEN.into(),
        state.path().join("test.db"),
        houston_core::host_env::HostEnv::capture(),
    ))
    .unwrap();
    let workspace = houston_core::fixture_dirs::tempdir_outside_git();
    daemon
        .workspace_add(&workspace.path().display().to_string())
        .unwrap();
    let rows = daemon.agent_hooks_set(AgentKind::Codex, true);
    let codex = rows
        .iter()
        .find(|row| row.provider == AgentKind::Codex)
        .expect("a Codex row");
    assert!(
        codex
            .error
            .as_deref()
            .is_some_and(|error| error.contains("refusing agent CLI config")),
        "enabling Codex hooks must name the refused home: {codex:?}"
    );
}

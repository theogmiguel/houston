//! A daemon built from the harness environment must never write the account's real user
//! config. The fixture re-executes itself with a stand-in "real" `HOME` that it owns, so a
//! regression is caught without the failing run touching the developer's home.
#![allow(clippy::disallowed_methods)]

use crate::common;
use std::path::Path;

const CHILD: &str = "HOUSTON_HERMETIC_ENV_CHILD";

#[tokio::test]
async fn workspace_hooks_land_in_the_hermetic_home_not_the_inherited_one() {
    if common::process_var_os(CHILD).is_some() {
        return child().await;
    }
    let account_home = tempfile::tempdir().unwrap();
    // A temp dir distinct from the one holding `account_home`, so the child treats its
    // inherited home as the account's rather than as a test-owned one.
    let child_tmp = tempfile::tempdir().unwrap();
    let out = common::hermetic_command(std::env::current_exe().unwrap(), account_home.path())
        .args([
            "--exact",
            &common::exact_path(
                module_path!(),
                "workspace_hooks_land_in_the_hermetic_home_not_the_inherited_one",
            ),
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
    for untouched in [".claude", ".codex", ".config"] {
        assert!(
            !account_home.path().join(untouched).exists(),
            "{untouched} appeared under the inherited home {}",
            account_home.path().display()
        );
    }
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

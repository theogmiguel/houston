use std::path::Path;
use std::process::Command;

// Override config roots on commands, never the parallel test runner's environment.
pub fn isolate(command: &mut Command, home: &Path) {
    command.env("HOME", home).env("USERPROFILE", home);
    for key in [
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "XDG_CONFIG_HOME",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ] {
        command.env_remove(key);
    }
}

pub fn run_isolated_test(test: &str) -> bool {
    if std::env::var("HOUSTON_ISOLATED_TEST").as_deref() == Ok(test) {
        return false;
    }
    let home = tempfile::tempdir().expect("throwaway home");
    let mut command = houston_core::spawn::command(std::env::current_exe().expect("test binary"));
    isolate(&mut command, home.path());
    let output = command
        .env("HOUSTON_ISOLATED_TEST", test)
        .args(["--exact", test, "--nocapture"])
        .output()
        .expect("run isolated test");
    assert!(
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "isolated test {test} failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[test]
fn daemon_command_overrides_inherited_config_homes() {
    let home = tempfile::tempdir().expect("throwaway home");
    let mut command = houston_core::spawn::command("unused-daemon");
    for key in [
        "HOME",
        "USERPROFILE",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "XDG_CONFIG_HOME",
    ] {
        command.env(key, "sentinel-developer-config");
    }
    isolate(&mut command, home.path());
    let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
    for key in ["HOME", "USERPROFILE"] {
        assert_eq!(
            env.get(std::ffi::OsStr::new(key)),
            Some(&Some(home.path().as_os_str())),
            "{key} must use the throwaway home"
        );
    }
    for key in ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] {
        assert_eq!(
            env.get(std::ffi::OsStr::new(key)),
            Some(&None),
            "{key} must not inherit developer configuration"
        );
    }
}

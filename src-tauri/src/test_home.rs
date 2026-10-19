use std::path::Path;
use std::process::Command;

/// Every variable through which an agent CLI's configuration is located, with its
/// location under the home: the same set `tests/common`'s `isolate_config` confines
/// for in-process core daemons.
pub const CONFIG_HOMES: [(&str, &str); 3] = [
    ("CLAUDE_CONFIG_DIR", ".claude"),
    ("CODEX_HOME", ".codex"),
    ("XDG_CONFIG_HOME", ".config"),
];

// Override config roots on commands, never the parallel test runner's environment.
pub fn isolate(command: &mut Command, home: &Path) {
    command.env("HOME", home).env("USERPROFILE", home);
    for (key, relative) in CONFIG_HOMES {
        command.env(key, home.join(relative));
    }
    for key in ["CARGO_HOME", "RUSTUP_HOME"] {
        command.env_remove(key);
    }
}

/// The variables of `environment` (a process's `NAME=value` pairs) that locate
/// configuration anywhere but under `home`, as `NAME=value` for the failure message.
pub fn config_outside_home(
    environment: &std::collections::BTreeMap<String, String>,
    home: &Path,
) -> Vec<String> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .chain(CONFIG_HOMES.map(|(key, _)| key))
        .filter_map(|key| {
            let value = environment.get(key)?;
            (!Path::new(value).starts_with(home)).then(|| format!("{key}={value}"))
        })
        .collect()
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
    for (key, relative) in CONFIG_HOMES {
        assert_eq!(
            env.get(std::ffi::OsStr::new(key)),
            Some(&Some(home.path().join(relative).as_os_str())),
            "{key} must point into the throwaway home, not inherit developer configuration"
        );
    }
}

#[test]
fn config_outside_home_names_every_variable_that_reaches_the_real_home() {
    let home = tempfile::tempdir().expect("throwaway home");
    let inside: std::collections::BTreeMap<String, String> = [
        ("HOME", home.path().to_path_buf()),
        ("USERPROFILE", home.path().to_path_buf()),
        ("CODEX_HOME", home.path().join(".codex")),
        ("XDG_CONFIG_HOME", home.path().join(".config")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.display().to_string()))
    .collect();
    assert_eq!(
        config_outside_home(&inside, home.path()),
        Vec::<String>::new()
    );

    let mut leaking = inside;
    leaking.insert("HOME".into(), "/home/developer".into());
    leaking.insert("CODEX_HOME".into(), "/home/developer/.codex".into());
    assert_eq!(
        config_outside_home(&leaking, home.path()),
        ["HOME=/home/developer", "CODEX_HOME=/home/developer/.codex"]
    );
}

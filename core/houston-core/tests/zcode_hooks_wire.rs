#![allow(clippy::disallowed_methods)]

//! The ZCode hook entry the toggle writes, run as ZCode runs it: `command` through `sh -c`,
//! `process` (Windows) as `command` plus `args` without a shell. It must reach the
//! channel's hook drop directory, and do nothing outside a Houston pane.

mod common;

use common::TOKEN;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::hook_drop::HookDrop;
use houston_protocol as proto;
use std::io::Write as _;
use std::path::{Path, PathBuf};

const CHANNEL: &str = "zchooks";

#[cfg(unix)]
#[test]
fn zcode_settings_edits_preserve_chained_symlinks_and_target_permissions() {
    use houston_core::agent_hooks::{self, ConfigHome};
    use std::os::unix::fs::{symlink, PermissionsExt};

    for filename in houston_core::zcode_config::SETTINGS_FILES {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".zcode/cli");
        let dotfiles = home.path().join("dotfiles");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&dotfiles).unwrap();
        let target = dotfiles.join("settings.json");
        let original = serde_json::json!({
            "theme": "user-theme",
            "hooks": {"enabled": true, "events": {
                "Stop": [{"hooks": [{"type": "command", "command": "echo user-hook"}]}]
            }}
        });
        std::fs::write(&target, serde_json::to_vec(&original).unwrap()).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        let alias = home.path().join("settings-link.json");
        let path = dir.join(filename);
        symlink("dotfiles/settings.json", &alias).unwrap();
        symlink("../../settings-link.json", &path).unwrap();
        let config_home = ConfigHome {
            home: home.path().to_path_buf(),
            xdg_config: None,
        };
        let sentinel = houston_core::claude_hooks::sentinel_for(Some("symlink-test"));
        let launcher = home.path().join(".houston-symlink-test/hooks/launcher");
        agent_hooks::install(proto::AgentKind::Zcode, &config_home, &launcher, &sentinel).unwrap();
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink(),
            "install replaced the user's {filename} symlink"
        );
        assert_eq!(
            std::fs::read_link(&path).unwrap(),
            Path::new("../../settings-link.json")
        );
        assert_eq!(
            std::fs::read_link(&alias).unwrap(),
            Path::new("dotfiles/settings.json")
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(agent_hooks::is_installed(
            proto::AgentKind::Zcode,
            &config_home,
            &sentinel
        ));
        let installed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(installed["theme"], original["theme"]);
        assert_eq!(
            installed["hooks"]["events"]["Stop"][0],
            original["hooks"]["events"]["Stop"][0]
        );
        assert_eq!(
            installed["hooks"]["events"]["Stop"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(agent_hooks::uninstall(proto::AgentKind::Zcode, &config_home, &sentinel).unwrap());
        let restored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(restored, original);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/hooks/zcode")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

/// Starts one installed entry with `stdin`, as ZCode would; it must exit 0.
fn run_entry(entry: &serde_json::Value, home: &Path, session: Option<u32>, stdin: &str) {
    let mut cmd = match entry["type"].as_str() {
        Some("process") => {
            let mut cmd = std::process::Command::new(entry["command"].as_str().unwrap());
            for arg in entry["args"].as_array().expect("a process entry has args") {
                cmd.arg(arg.as_str().unwrap());
            }
            cmd
        }
        Some("command") => {
            let mut cmd = std::process::Command::new("sh");
            cmd.args(["-c", entry["command"].as_str().unwrap()]);
            cmd
        }
        other => panic!("unexpected ZCode hook type {other:?}: {entry}"),
    };
    cmd.env("HOME", home)
        .env("USERPROFILE", home)
        .env("HOUSTON_CHANNEL", CHANNEL)
        .env_remove("TR_SESSION");
    if let Some(session) = session {
        cmd.env("TR_SESSION", session.to_string());
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!("starting the installed entry {entry}: {e}"));
    let _ = child.stdin.take().unwrap().write_all(stdin.as_bytes());
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "the entry failed ({}): {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn drops(state_dir: &Path) -> Vec<PathBuf> {
    let dir = houston_core::hook_drop::drop_dir(state_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| houston_core::hook_drop::parse_drop_name(n).is_some())
        })
        .collect()
}

#[tokio::test]
async fn the_installed_zcode_stop_entry_reaches_the_channels_drop_dir() {
    let home = tempfile::tempdir().unwrap();
    let state_dir = home.path().join(format!(".houston-{CHANNEL}"));
    std::fs::create_dir_all(&state_dir).unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("USERPROFILE", home.path());
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap();

    let rows = daemon.agent_hooks_set(proto::AgentKind::Zcode, true);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(row.installed && row.error.is_none(), "{row:?}");
    // The daemon points the launcher at its own helper; a test binary has none beside it.
    houston_core::claude_hooks::point_launcher(
        &state_dir,
        Path::new(env!("CARGO_BIN_EXE_tr-helper")),
    )
    .unwrap();

    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(home.path().join(".zcode/cli/config.json")).unwrap(),
    )
    .unwrap();
    let entry = config["hooks"]["events"]["Stop"][0]["hooks"][0].clone();
    if cfg!(windows) {
        assert_eq!(entry["type"], "process", "{entry}");
        assert!(
            entry["command"]
                .as_str()
                .unwrap()
                .ends_with("claude-hook.exe"),
            "Windows starts only a file with an extension: {entry}"
        );
    } else {
        assert_eq!(entry["type"], "command", "{entry}");
    }

    let mut payload: serde_json::Value =
        serde_json::from_str(&fixture("zcode-3.14.3-src-03-Stop.json")).unwrap();
    payload["cwd"] = home.path().display().to_string().into();
    let stdin = payload.to_string();

    run_entry(&entry, home.path(), None, &stdin);
    assert!(
        drops(&state_dir).is_empty(),
        "outside a Houston pane the entry writes nothing"
    );

    run_entry(&entry, home.path(), Some(7), &stdin);
    let found = drops(&state_dir);
    assert_eq!(found.len(), 1, "one drop for the event: {found:?}");
    let drop: HookDrop = serde_json::from_slice(&std::fs::read(&found[0]).unwrap()).unwrap();
    assert_eq!(
        (drop.event.as_str(), drop.session, drop.agent.as_deref()),
        ("Stop", 7, Some("zcode"))
    );

    let rows = daemon.agent_hooks_set(proto::AgentKind::Zcode, false);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Zcode)
        .expect("a ZCode row");
    assert!(!row.installed && row.error.is_none(), "{row:?}");
}

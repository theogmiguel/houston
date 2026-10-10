#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use houston_core::{
    claude_hooks,
    daemon::{CreateParams, Daemon, DaemonConfig},
    hook_drop,
};
use houston_protocol as proto;
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Arc};

fn isolated(name: &str) -> bool {
    if std::env::var_os("HOUSTON_CLAUDE_GLOBAL_FIXTURE").is_some() {
        return false;
    }
    let home = tempfile::tempdir().unwrap();
    let result = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
        .env("HOUSTON_CLAUDE_GLOBAL_FIXTURE", "1")
        .current_dir(home.path())
        .args(["--exact", name, "--nocapture"])
        .status()
        .unwrap();
    assert!(result.success(), "isolated fixture {name} failed");
    true
}

fn daemon(state: &Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: "fixture".into(),
        db_path: state.join("test.db"),
    })
    .unwrap()
}

fn settings() -> std::path::PathBuf {
    Path::new(&std::env::var("HOME").unwrap()).join(".claude/settings.json")
}
fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn commands(root: &Value) -> Vec<&str> {
    root["hooks"]
        .as_object()
        .unwrap()
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .flat_map(|group| group["hooks"].as_array().unwrap())
        .filter_map(|hook| hook["command"].as_str())
        .collect()
}
fn user_settings(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, json!({"model":"user-model","hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}],"UserEvent":[]}}).to_string()).unwrap();
}

#[test]
fn installs_guarded_global_entries_preserving_user_settings() {
    if isolated("installs_guarded_global_entries_preserving_user_settings") {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    user_settings(&settings());
    d.install_all_workspace_hooks();
    let root = read(&settings());
    assert_eq!(root["model"], "user-model");
    assert_eq!(root["hooks"]["UserEvent"], json!([]));
    let cmds = commands(&root);
    assert!(cmds.contains(&"user-hook"));
    let managed: Vec<_> = cmds
        .iter()
        .filter(|c| c.contains("--houston-managed"))
        .collect();
    assert_eq!(managed.len(), claude_hooks::hook_events().len());
    assert!(managed
        .iter()
        .all(|c| c.starts_with("if [ -z \"${TR_SESSION:-}\" ]; then exit 0; fi; ")));
    let row = d
        .agent_hooks_state()
        .into_iter()
        .find(|r| r.provider == proto::AgentKind::Claude)
        .unwrap();
    assert_eq!(row.scope, proto::AgentHookScope::Global);
    assert_eq!(row.path, settings().display().to_string());
}

#[test]
fn migrates_workspace_entries_preserving_user_commands_and_other_channel() {
    if isolated("migrates_workspace_entries_preserving_user_commands_and_other_channel") {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let ws = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    let path = claude_hooks::settings_path(ws.path());
    user_settings(&path);
    let install = claude_hooks::install(&path, "/tmp/old-helper", "--houston-managed").unwrap();
    claude_hooks::install(&path, "/tmp/dev-helper", "--houston-managed=dev").unwrap();
    let mut root = read(&path);
    root["hooks"]["Stop"][1]["hooks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"command","command":"mixed-user-hook"}));
    std::fs::write(&path, root.to_string()).unwrap();
    let db = houston_core::db::Db::open(&state.path().join("test.db")).unwrap();
    db.record_workspace_hooks(
        ws.path().to_str().unwrap(),
        install.created_file,
        install.created_hooks,
    )
    .unwrap();
    d.install_all_workspace_hooks();
    let root = read(&path);
    assert_eq!(root["model"], "user-model");
    assert_eq!(root["hooks"]["UserEvent"], json!([]));
    let cmds = commands(&root);
    assert!(cmds.contains(&"user-hook") && cmds.contains(&"mixed-user-hook"));
    assert!(!cmds.iter().any(|c| c.contains("old-helper")));
    assert!(cmds.iter().any(|c| c.contains("--houston-managed=dev")));
    assert!(db
        .workspace_hooks_ownership(ws.path().to_str().unwrap())
        .unwrap()
        .is_none());
    assert!(settings().exists());
}

#[test]
fn consent_off_removes_global_entries_and_stays_off_after_restart() {
    if isolated("consent_off_removes_global_entries_and_stays_off_after_restart") {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    user_settings(&settings());
    d.install_all_workspace_hooks();
    assert!(commands(&read(&settings()))
        .iter()
        .any(|c| c.contains("houston-managed")));
    let rows = d.agent_hooks_set(proto::AgentKind::Claude, false);
    let row = rows
        .iter()
        .find(|r| r.provider == proto::AgentKind::Claude)
        .unwrap();
    assert!(
        !row.enabled && !row.installed && row.error.is_none(),
        "{row:?}"
    );
    drop(d);
    let restarted = daemon(state.path());
    restarted.install_all_workspace_hooks();
    restarted.install_consented_agent_hooks();
    assert!(!restarted.hook_consent(proto::AgentKind::Claude));
    assert_eq!(commands(&read(&settings())), vec!["user-hook"]);
}

#[test]
fn command_without_pane_identity_is_silent_and_does_not_execute_helper() {
    if isolated("command_without_pane_identity_is_silent_and_does_not_execute_helper") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let helper = temp.path().join("helper");
    let marker = temp.path().join("executed");
    std::fs::write(
        &helper,
        format!("#!/bin/sh\necho executed\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = temp.path().join("settings.json");
    claude_hooks::install(&path, helper.to_str().unwrap(), "--houston-managed").unwrap();
    for cmd in commands(&read(&path)) {
        for identity in [None, Some("")] {
            let mut command = Command::new("/bin/sh");
            command.env_clear().args(["-c", cmd]);
            if let Some(value) = identity {
                command.env("TR_SESSION", value);
            }
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert!(output.stdout.is_empty() && output.stderr.is_empty());
            assert!(!marker.exists());
        }
    }
}

#[test]
fn config_override_and_account_profiles_get_hooks_and_consent_cleanup() {
    if isolated("config_override_and_account_profiles_get_hooks_and_consent_cleanup") {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", custom.path());
    let d = daemon(state.path());
    d.install_all_workspace_hooks();
    assert!(custom.path().join("settings.json").exists());
    assert!(!settings().exists());
    let home = std::env::var("HOME").unwrap();
    let profile = Path::new(&home).join("profile");
    std::fs::create_dir_all(&profile).unwrap();
    let proto::ServerMsg::AgentProfileState { profiles, .. } = d
        .agent_profile_upsert(None, proto::AgentKind::Claude, "Alternate", "~/profile")
        .unwrap()
    else {
        panic!("profile state");
    };
    assert!(profile.join("settings.json").exists());
    let replacement = Path::new(&home).join("replacement");
    std::fs::create_dir_all(&replacement).unwrap();
    d.agent_profile_upsert(
        Some(profiles[0].id),
        proto::AgentKind::Claude,
        "Alternate",
        "~/replacement",
    )
    .unwrap();
    assert!(commands(&read(&profile.join("settings.json"))).is_empty());
    assert!(!commands(&read(&replacement.join("settings.json"))).is_empty());
    d.agent_profile_delete(profiles[0].id).unwrap();
    assert!(commands(&read(&replacement.join("settings.json"))).is_empty());
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    d.agent_hooks_set(proto::AgentKind::Claude, false);
    for path in [
        custom.path().join("settings.json"),
        profile.join("settings.json"),
    ] {
        assert!(commands(&read(&path)).is_empty());
    }
}

#[test]
fn relative_profile_paths_never_install_or_remove_hooks_under_daemon_cwd() {
    if isolated("relative_profile_paths_never_install_or_remove_hooks_under_daemon_cwd") {
        return;
    }
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    d.agent_profile_upsert(None, proto::AgentKind::Claude, "Relative", "work-dir")
        .unwrap();
    assert!(!Path::new("work-dir/settings.json").exists());
    let row = d
        .agent_hooks_state()
        .into_iter()
        .find(|r| r.provider == proto::AgentKind::Claude)
        .unwrap();
    let error = row.error.unwrap();
    assert!(
        error.contains("work-dir") && error.contains("absolute"),
        "{error}"
    );
    assert!(settings().exists());

    let relative = Path::new("old-profile/settings.json");
    claude_hooks::install(relative, "/tmp/old-helper", "--houston-managed").unwrap();
    let workspace = Path::new("old-workspace");
    let workspace_settings = claude_hooks::settings_path(workspace);
    claude_hooks::install(&workspace_settings, "/tmp/old-helper", "--houston-managed").unwrap();
    let original = std::fs::read(relative).unwrap();
    let original_workspace = std::fs::read(&workspace_settings).unwrap();
    let db = houston_core::db::Db::open(&state.path().join("test.db")).unwrap();
    for enabled in [true, false] {
        db.set_setting(
            "agent_hooks.claude.paths",
            r#"["old-profile/settings.json"]"#,
        )
        .unwrap();
        db.record_workspace_hooks("old-workspace", false, false)
            .unwrap();
        d.agent_hooks_set(proto::AgentKind::Claude, enabled);
        assert!(!Path::new("work-dir/settings.json").exists());
        assert_eq!(std::fs::read(relative).unwrap(), original);
        assert_eq!(
            std::fs::read(&workspace_settings).unwrap(),
            original_workspace
        );
        assert_eq!(d.hook_consent(proto::AgentKind::Claude), enabled);
    }
}

#[test]
fn fake_claude_outside_workspace_is_attributed_to_its_pane() {
    if isolated("fake_claude_outside_workspace_is_attributed_to_its_pane") {
        return;
    }
    let state = Path::new(&std::env::var("HOME").unwrap()).join(".houston");
    std::fs::create_dir_all(&state).unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let d = daemon(&state);
    d.workspace_add(workspace.path().to_str().unwrap()).unwrap();
    d.install_all_workspace_hooks();
    let launcher = claude_hooks::launcher_path(&state);
    claude_hooks::point_launcher(&state, Path::new(env!("CARGO_BIN_EXE_houston-core"))).unwrap();
    // The fake CLI loads user-scope settings after moving outside the workspace.
    let command = read(&settings())["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_owned();
    let script = outside.path().join("claude");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '{{\"session_id\":\"fake-claude\",\"cwd\":\"{}\"}}' | /bin/sh -c '{}'\nexec sleep 30\n", outside.path().display(), command.replace('\'', "'\\''"))).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let pane = d
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: workspace.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap();
    d.write_stdin(
        pane.id,
        format!(
            "cd '{}' && exec '{}'\r",
            outside.path().display(),
            script.display()
        )
        .as_bytes(),
    )
    .unwrap();
    let drops = hook_drop::drop_dir(&state);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let drop = loop {
        if let Ok(entries) = std::fs::read_dir(&drops) {
            if let Some(entry) = entries
                .flatten()
                .find(|e| hook_drop::parse_drop_name(&e.file_name().to_string_lossy()).is_some())
            {
                break serde_json::from_slice::<hook_drop::HookDrop>(
                    &std::fs::read(entry.path()).unwrap(),
                )
                .unwrap();
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fake CLI did not deliver a global hook via {}",
            launcher.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(drop.session, pane.id);
    assert_eq!(drop.cwd.as_deref(), outside.path().to_str());
    d.hook_drop_boot_for_test();
    d.hook_drop_tick_for_test();
    assert_eq!(
        d.list()
            .into_iter()
            .find(|s| s.id == pane.id)
            .unwrap()
            .detected_agent,
        Some(proto::AgentKind::Claude)
    );
    assert_eq!(
        d.session_status(pane.id).unwrap(),
        Some(proto::AgentStatus::Idle)
    );
    d.close(pane.id).unwrap();
}

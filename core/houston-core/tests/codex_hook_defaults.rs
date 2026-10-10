#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use houston_core::agent_hooks::{self, CodexHookTrust, ConfigHome};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::{Arc, Mutex};

static SERIAL: Mutex<()> = Mutex::new(());

struct Rig {
    home: tempfile::TempDir,
    state: tempfile::TempDir,
    daemon: Option<Arc<Daemon>>,
    original_home: Option<std::ffi::OsString>,
    original_codex_home: Option<std::ffi::OsString>,
}

impl Rig {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let original_home = std::env::var_os("HOME");
        let original_codex_home = std::env::var_os("CODEX_HOME");
        std::env::remove_var("CODEX_HOME");
        std::env::set_var("HOME", home.path());
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "codex-hooks-test".into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        Self {
            home,
            state,
            daemon: Some(daemon),
            original_home,
            original_codex_home,
        }
    }

    fn daemon(&self) -> &Arc<Daemon> {
        self.daemon.as_ref().unwrap()
    }

    fn config_home(&self) -> ConfigHome {
        ConfigHome {
            home: self.home.path().to_path_buf(),
            xdg_config: None,
        }
    }

    fn spawn(&self) -> proto::SessionInfo {
        self.daemon()
            .create_session(CreateParams {
                agent: proto::AgentKind::Codex,
                project_dir: self.state.path().to_path_buf(),
                cmd: Some(vec!["sh".into(), "-c".into(), "exec sleep 30".into()]),
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
            .unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(daemon) = &self.daemon {
            for session in daemon.list() {
                daemon.close(session.id).ok();
            }
        }
        if let Some(home) = &self.original_codex_home {
            std::env::set_var("CODEX_HOME", home);
        } else {
            std::env::remove_var("CODEX_HOME");
        }
        if let Some(home) = &self.original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}

#[test]
fn default_consent_installs_codex_hooks_with_trust() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    assert!(r.daemon().hook_consent(proto::AgentKind::Codex));
    r.daemon().install_consented_agent_hooks();
    let row = r
        .daemon()
        .agent_hooks_state()
        .into_iter()
        .find(|row| row.provider == proto::AgentKind::Codex)
        .unwrap();
    assert!(row.enabled && row.installed, "{row:?}");
    assert_eq!(row.trust, Some(proto::HookTrust::SomeTrusted));
    let pane = r.spawn();
    assert_eq!(pane.status, Some(proto::AgentStatus::Spawning));
}

#[test]
fn explicit_off_stays_off_and_uninstalls_hooks_and_trust() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut r = Rig::new();
    let config = r.home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    let original = "# user config\nnotify = [\"my-notifier\"]\n[hooks.state.\"user-hook\"]\ntrusted_hash = \"user-hash\"\n";
    std::fs::write(&config, original).unwrap();
    let rows = r.daemon().agent_hooks_set(proto::AgentKind::Codex, true);
    assert_eq!(
        rows.iter()
            .find(|row| row.provider == proto::AgentKind::Codex)
            .unwrap()
            .trust,
        Some(proto::HookTrust::SomeTrusted)
    );
    assert!(std::fs::read_to_string(&config)
        .unwrap()
        .contains("# BEGIN Houston Codex hook trust"));
    let rows = r.daemon().agent_hooks_set(proto::AgentKind::Codex, false);
    let row = rows
        .iter()
        .find(|row| row.provider == proto::AgentKind::Codex)
        .unwrap();
    assert!(
        !row.enabled && !row.installed && row.error.is_none(),
        "{row:?}"
    );
    assert_eq!(std::fs::read_to_string(config).unwrap(), original);
    r.daemon().install_consented_agent_hooks();
    assert!(!r.daemon().hook_consent(proto::AgentKind::Codex));
    assert!(!agent_hooks::is_installed(
        proto::AgentKind::Codex,
        &r.config_home(),
        &houston_core::claude_hooks::sentinel_for(None)
    ));
    drop(r.daemon.take());
    let restarted = Daemon::new(DaemonConfig {
        token: "restarted".into(),
        db_path: r.state.path().join("test.db"),
    })
    .unwrap();
    assert!(!restarted.hook_consent(proto::AgentKind::Codex));
    r.daemon = Some(restarted);
}

#[test]
fn absent_codex_hooks_make_spawn_unavailable_with_cause_immediately() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    let pane = r.spawn();
    assert_eq!(pane.status, Some(proto::AgentStatus::Unavailable));
    let notes = r.daemon().inbox_rows_for_test(pane.id);
    let note = notes
        .iter()
        .find(|row| row.reason.as_deref() == Some("hooks_not_installed"))
        .expect("immediate operator note naming missing hooks");
    assert!(note.body.contains("not installed"));
    assert!(note.body.contains("Settings → Agent status → Codex"));
    r.daemon().expire_spawn_grace_for_test(pane.id);
    assert_eq!(r.daemon().inbox_rows_for_test(pane.id).len(), notes.len());
}

#[test]
fn unrelated_trust_is_not_confirmation_for_houston() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    let config = r.home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
        config,
        "[hooks.state.user]\ntrusted_hash = \"sha256:anything\"\n",
    )
    .unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::NotConfirmed
    );
}

#[test]
fn explicit_off_spawn_names_the_setting_and_fix() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    r.daemon().agent_hooks_set(proto::AgentKind::Codex, false);
    let pane = r.spawn();
    assert_eq!(pane.status, Some(proto::AgentStatus::Unavailable));
    let notes = r.daemon().inbox_rows_for_test(pane.id);
    let note = notes
        .iter()
        .find(|row| row.reason.as_deref() == Some("hooks_off"))
        .expect("hooks-off cause");
    assert!(note.body.contains("hooks are off"));
    assert!(note.body.contains("Settings → Agent status → Codex"));
    let warnings = r.daemon().spawn_warnings(&pane, false);
    assert!(warnings.iter().any(|warning| warning.code == "hooks_off"
        && warning.message.contains("Settings → Agent status → Codex")));
}

#[test]
fn a_mismatched_hash_or_disabled_hook_is_not_trusted_at_spawn() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    r.daemon().install_consented_agent_hooks();
    let config = r.home.path().join(".codex/config.toml");
    let original = std::fs::read_to_string(&config).unwrap();
    let mut root: toml::Value = original.parse().unwrap();
    let state = root["hooks"]["state"].as_table_mut().unwrap();
    let key = state.keys().next().unwrap().clone();
    state.get_mut(&key).unwrap()["trusted_hash"] = toml::Value::String("sha256:wrong".into());
    std::fs::write(&config, toml::to_string(&root).unwrap()).unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::NotConfirmed
    );
    let pane = r.spawn();
    assert_eq!(pane.status, Some(proto::AgentStatus::Unavailable));
    assert!(r
        .daemon()
        .inbox_rows_for_test(pane.id)
        .iter()
        .any(|row| row.reason.as_deref() == Some("hooks_trust_unconfirmed")));
    let mut root: toml::Value = original.parse().unwrap();
    root["hooks"]["state"][&key]["enabled"] = toml::Value::Boolean(false);
    std::fs::write(&config, toml::to_string(&root).unwrap()).unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::NotConfirmed
    );
    root["hooks"]["state"][&key]["enabled"] = toml::Value::String("true".into());
    std::fs::write(&config, toml::to_string(&root).unwrap()).unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::NotConfirmed
    );
}

#[test]
fn failed_trust_setup_removes_only_houstons_hooks_and_restores_notify() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    let config = r.home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    let original = "notify = [\"my-notifier\"]\n[hooks]\nstate = false\n";
    std::fs::write(&config, original).unwrap();
    let hooks = r.home.path().join(".codex/hooks.json");
    std::fs::write(
        &hooks,
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#,
    )
    .unwrap();
    let rows = r.daemon().agent_hooks_set(proto::AgentKind::Codex, true);
    let row = rows
        .iter()
        .find(|row| row.provider == proto::AgentKind::Codex)
        .unwrap();
    assert!(
        row.error.is_some(),
        "trust setup must report the invalid state: {row:?}"
    );
    assert!(!row.installed, "untrusted Houston hooks must be removed");
    assert_eq!(std::fs::read_to_string(config).unwrap(), original);
    let text = std::fs::read_to_string(hooks).unwrap();
    assert!(text.contains("user-hook") && !text.contains("--houston-managed"));
}

#[test]
fn managed_trust_is_reversible_without_a_final_newline() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    let config = r.home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    let original = "model = \"gpt-5\"";
    std::fs::write(&config, original).unwrap();
    r.daemon().install_consented_agent_hooks();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::SomeTrusted
    );
    let installed = std::fs::read_to_string(&config).unwrap();
    r.daemon().install_consented_agent_hooks();
    assert_eq!(std::fs::read_to_string(&config).unwrap(), installed);
    r.daemon().agent_hooks_set(proto::AgentKind::Codex, false);
    assert_eq!(std::fs::read_to_string(config).unwrap(), original);
}

#[test]
fn uninstall_keeps_later_user_tables_separate_from_an_original_unterminated_line() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    let config = r.home.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "model = \"gpt-5\"").unwrap();
    r.daemon().install_consented_agent_hooks();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::SomeTrusted
    );
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&config)
        .unwrap();
    file.write_all(b"[features]\nmy_feature = true\n").unwrap();
    r.daemon().agent_hooks_set(proto::AgentKind::Codex, false);
    let clean = std::fs::read_to_string(config).unwrap();
    assert_eq!(clean, "model = \"gpt-5\"\n[features]\nmy_feature = true\n");
    assert!(clean.parse::<toml::Value>().is_ok());
}

#[test]
fn malformed_owned_trust_markers_still_remove_untrusted_hook_commands() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    r.daemon().install_consented_agent_hooks();
    let config = r.home.path().join(".codex/config.toml");
    let text = std::fs::read_to_string(&config).unwrap();
    let malformed = text
        .lines()
        .filter(|line| !line.starts_with("# END Houston Codex hook trust"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(config, malformed).unwrap();
    let rows = r.daemon().agent_hooks_set(proto::AgentKind::Codex, true);
    let row = rows
        .iter()
        .find(|row| row.provider == proto::AgentKind::Codex)
        .unwrap();
    assert!(
        row.error
            .as_deref()
            .is_some_and(|error| error.contains("end marker")),
        "{row:?}"
    );
    assert!(
        !row.installed,
        "failed trust setup must remove Houston's commands even when marker cleanup fails"
    );
}

#[test]
fn a_profile_without_hooks_is_unavailable_even_when_default_hooks_are_trusted() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = Rig::new();
    r.daemon().install_consented_agent_hooks();
    assert_eq!(
        agent_hooks::codex_trust_status(&r.config_home()),
        CodexHookTrust::SomeTrusted
    );
    let profile = r.home.path().join("alternate-codex");
    std::fs::create_dir_all(&profile).unwrap();
    let proto::ServerMsg::AgentProfileState { profiles, .. } = r
        .daemon()
        .agent_profile_upsert(
            None,
            proto::AgentKind::Codex,
            "Alternate",
            profile.to_str().unwrap(),
        )
        .unwrap()
    else {
        panic!("profile state");
    };
    r.daemon()
        .agent_profile_set_active(proto::AgentKind::Codex, Some(profiles[0].id))
        .unwrap();
    let pane = r.spawn();
    assert_eq!(pane.status, Some(proto::AgentStatus::Unavailable));
    assert!(r
        .daemon()
        .inbox_rows_for_test(pane.id)
        .iter()
        .any(|row| row.reason.as_deref() == Some("hooks_not_installed")
            && row.body.contains("active Codex config")));
}

#[test]
#[ignore = "writes a throwaway installer fixture for an independent Codex hooks/list probe"]
fn installed_hooks_fixture_for_native_codex_probe() {
    use std::os::unix::fs::PermissionsExt;
    let home = std::path::PathBuf::from(
        std::env::var("HOUSTON_CODEX_HOOK_PROBE_HOME").expect("explicit throwaway probe HOME"),
    );
    assert!(
        home.starts_with(std::env::temp_dir())
            && home
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("houston-100-")
    );
    let config_home = ConfigHome {
        home: home.clone(),
        xdg_config: None,
    };
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::write(
        home.join(".codex/config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )
    .unwrap();
    let launcher = home.join("fixture-launcher");
    std::fs::write(&launcher, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    agent_hooks::install(
        proto::AgentKind::Codex,
        &config_home,
        &launcher,
        &houston_core::claude_hooks::sentinel_for(None),
    )
    .unwrap();
    assert_eq!(
        agent_hooks::codex_trust_status(&config_home),
        CodexHookTrust::SomeTrusted
    );
}

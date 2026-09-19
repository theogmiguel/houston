mod common;

use houston_protocol as proto;

use common::start_daemon_with_handle;

#[tokio::test]
async fn a_fresh_channel_has_no_profiles_and_no_active_override() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let proto::ServerMsg::AgentProfileState { profiles, active } = daemon.agent_profile_state()
    else {
        panic!("agent_profile_state must answer with AgentProfileState");
    };
    assert!(
        profiles.is_empty(),
        "nobody created a profile yet: {profiles:?}"
    );
    assert!(
        active.is_empty(),
        "no agent has an override yet: {active:?}"
    );
}

#[tokio::test]
async fn creating_a_profile_does_not_activate_it() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let proto::ServerMsg::AgentProfileState { profiles, active } = daemon
        .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
        .expect("upsert")
    else {
        panic!("agent_profile_upsert must answer with AgentProfileState");
    };
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].agent, proto::AgentKind::Claude);
    assert_eq!(profiles[0].name, "work");
    assert_eq!(profiles[0].config_dir, "/tmp/claude-work");
    assert!(
        active.is_empty(),
        "creating a profile is not the same as making it active: {active:?}"
    );
}

#[tokio::test]
async fn setting_active_and_reading_it_back_round_trips() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let created = daemon
        .agent_profile_upsert(
            None,
            proto::AgentKind::Codex,
            "personal",
            "/tmp/codex-personal",
        )
        .expect("upsert");
    let proto::ServerMsg::AgentProfileState { profiles, .. } = created else {
        unreachable!()
    };
    let id = profiles[0].id;

    let proto::ServerMsg::AgentProfileState { active, .. } = daemon
        .agent_profile_set_active(proto::AgentKind::Codex, Some(id))
        .expect("set_active")
    else {
        panic!("agent_profile_set_active must answer with AgentProfileState");
    };
    assert_eq!(
        active,
        vec![proto::AgentProfileActive {
            agent: proto::AgentKind::Codex,
            id
        }]
    );

    let proto::ServerMsg::AgentProfileState { active, .. } = daemon.agent_profile_state() else {
        unreachable!()
    };
    assert_eq!(active.len(), 1, "Claude has no override, only Codex does");
}

#[tokio::test]
async fn deleting_the_active_profile_clears_the_override_too() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let created = daemon
        .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
        .expect("upsert");
    let proto::ServerMsg::AgentProfileState { profiles, .. } = created else {
        unreachable!()
    };
    let id = profiles[0].id;
    daemon
        .agent_profile_set_active(proto::AgentKind::Claude, Some(id))
        .expect("set_active");

    let proto::ServerMsg::AgentProfileState { profiles, active } =
        daemon.agent_profile_delete(id).expect("delete")
    else {
        panic!("agent_profile_delete must answer with AgentProfileState");
    };
    assert!(profiles.is_empty());
    assert!(
        active.is_empty(),
        "the active pointer must clear along with its profile: {active:?}"
    );
}

#[tokio::test]
async fn only_claude_and_codex_get_a_profile() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let err = daemon
        .agent_profile_upsert(None, proto::AgentKind::Antigravity, "x", "/tmp/x")
        .expect_err("Antigravity honors neither CLAUDE_CONFIG_DIR nor CODEX_HOME");
    assert!(
        format!("{err:#}").contains("Antigravity"),
        "the refusal must name the offending kind: {err:#}"
    );

    let err = daemon
        .agent_profile_set_active(proto::AgentKind::Shell, Some(1))
        .expect_err("a shell has no CLI-specific config dir to isolate");
    assert!(format!("{err:#}").contains("Shell"), "{err:#}");
}

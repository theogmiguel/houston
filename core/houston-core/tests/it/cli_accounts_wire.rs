use crate::common;

use base64::Engine;
use houston_protocol as proto;
use proto::AgentSignIn;

fn jwt(payload: &str) -> String {
    let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!(
        "{}.{}.sig",
        enc.encode(r#"{"alg":"none"}"#),
        enc.encode(payload)
    )
}

fn fixture_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let write = |relative: &str, body: &str| {
        let path = home.path().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    };
    write(
        ".claude.json",
        r#"{"oauthAccount":{"emailAddress":"claude@example.com","organizationName":"Acme"}}"#,
    );
    write(
        "claude-work/.claude.json",
        r#"{"oauthAccount":{"emailAddress":"work@example.com"}}"#,
    );
    let token = jwt(r#"{"email":"codex@example.com"}"#);
    write(
        ".codex/auth.json",
        &format!(r#"{{"auth_mode":"chatgpt","tokens":{{"id_token":"{token}"}}}}"#),
    );
    write(
        ".local/share/opencode/auth.json",
        r#"{"openai":{"type":"oauth"},"anthropic":{"type":"api","key":"sk-synthetic"}}"#,
    );
    home
}

async fn accounts_after_hooks_check(ws: &mut common::WsStream) -> Vec<proto::AgentAccountIdentity> {
    use futures_util::SinkExt;
    let msg = serde_json::to_string(&proto::ClientMsg::AgentHooks).unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::text(msg))
        .await
        .unwrap();
    let mut saw_hooks = false;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::AgentHooks { .. } => saw_hooks = true,
            proto::ServerMsg::AgentAccounts { accounts } => {
                assert!(saw_hooks, "agent_accounts must follow agent_hooks");
                return accounts;
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn the_cli_check_carries_identities_read_from_the_home_directory() {
    let home = fixture_home();
    let env = common::base_env()
        .with("HOME", Some(home.path()))
        .without("CLAUDE_CONFIG_DIR")
        .without("CODEX_HOME")
        .without("XDG_DATA_HOME");
    let (addr, _state, daemon) = common::start_daemon_with_handle_in(env).await;
    daemon
        .agent_profile_upsert(
            None,
            proto::AgentKind::Claude,
            "work",
            home.path().join("claude-work").to_str().unwrap(),
        )
        .unwrap();
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let accounts = accounts_after_hooks_check(&mut ws).await;

    let find = |agent, profile: Option<u32>| {
        accounts
            .iter()
            .find(|a| a.agent == agent && a.profile_id == profile)
            .unwrap_or_else(|| panic!("no {agent:?} row for profile {profile:?}: {accounts:?}"))
    };
    let claude = find(proto::AgentKind::Claude, None);
    assert_eq!(claude.identity.as_deref(), Some("claude@example.com"));
    assert_eq!(claude.detail.as_deref(), Some("Acme"));
    let profile_id = accounts
        .iter()
        .find_map(|a| a.profile_id)
        .expect("the work profile has its own row");
    assert_eq!(
        find(proto::AgentKind::Claude, Some(profile_id))
            .identity
            .as_deref(),
        Some("work@example.com")
    );
    assert_eq!(
        find(proto::AgentKind::Codex, None).identity.as_deref(),
        Some("codex@example.com")
    );
    assert_eq!(
        find(proto::AgentKind::Opencode, None).providers,
        vec!["anthropic", "openai"]
    );
    assert_eq!(
        find(proto::AgentKind::Antigravity, None).sign_in,
        AgentSignIn::Unknown
    );
    let wire = serde_json::to_string(&accounts).unwrap();
    assert!(
        !wire.contains("sk-synthetic"),
        "no credential may ride the wire: {wire}"
    );
}

#[tokio::test]
async fn a_home_without_cli_files_reports_not_signed_in_with_reasons() {
    let home = tempfile::tempdir().unwrap();
    let env = common::base_env()
        .with("HOME", Some(home.path()))
        .without("CLAUDE_CONFIG_DIR")
        .without("CODEX_HOME")
        .without("XDG_DATA_HOME");
    let (addr, _state) = common::start_daemon_in(env).await;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;
    let accounts = accounts_after_hooks_check(&mut ws).await;
    for agent in [proto::AgentKind::Claude, proto::AgentKind::Codex] {
        let row = accounts.iter().find(|a| a.agent == agent).unwrap();
        assert_eq!(row.sign_in, AgentSignIn::SignedOut, "{agent:?}");
        assert!(row.reason.as_deref().unwrap().contains("does not exist"));
    }
}

//! Boot cleanup of the Cursor and Grok configuration Houston used to write. Every case
//! runs against a fixture home; nothing here reads the account's real `~/.cursor` or `~/.grok`.
use houston_core::agent_hooks::ConfigHome;
use houston_core::retired_providers::cleanup;
use std::path::Path;

const SENTINEL: &str = "--houston-managed=dev";
const TRUST_OPEN: &str = "# >>> houston managed worktree trust >>>";
const TRUST_CLOSE: &str = "# <<< houston managed worktree trust <<<";

fn home_of(dir: &tempfile::TempDir) -> ConfigHome {
    ConfigHome {
        home: dir.path().to_path_buf(),
        xdg_config: None,
    }
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn read(root: &Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative)).unwrap()
}

fn json(root: &Path, relative: &str) -> serde_json::Value {
    serde_json::from_str(&read(root, relative)).unwrap()
}

fn cursor_hooks() -> String {
    serde_json::json!({
        "version": 1,
        "hooks": {
            "stop": [
                {"command": "'/h/claude-hook' hook stop --agent cursor --houston-managed=dev"},
                {"command": "my-own-stop-hook"}
            ],
            "sessionStart": [
                {"command": "'/h/claude-hook' hook sessionStart --agent cursor --houston-managed=dev"}
            ]
        }
    })
    .to_string()
}

fn grok_hooks() -> String {
    serde_json::json!({
        "hooks": {
            "Stop": [
                {"hooks": [{"type": "command",
                    "command": "'/h/claude-hook' hook Stop --agent grok --houston-managed=dev"}]}
            ]
        }
    })
    .to_string()
}

fn cursor_mcp() -> String {
    serde_json::json!({
        "mcpServers": {
            "houston": {"url": "http://127.0.0.1:1/mcp", "_houston": "managed"},
            "docs": {"command": "npx", "args": ["-y", "docs-mcp"]},
            "mine": {"command": "my-server"}
        }
    })
    .to_string()
}

fn grok_config(url: &str, authorization: &str) -> String {
    format!(
        "model = \"grok-4\"\n\n[mcp_servers.houston]\nurl = \"{url}\"\n\n\
         [mcp_servers.houston.headers]\nAuthorization = \"{authorization}\"\n\n\
         [mcp_servers.other]\nurl = \"https://example.invalid/mcp\"\n"
    )
}

fn trust_file() -> String {
    format!(
        "[folders.\"/mine\"]\ntrusted = true\n\n{TRUST_OPEN}\n[folders.\"/wt/a\"]\ntrusted = true\n{TRUST_CLOSE}\n\n\
         {TRUST_OPEN}\n[folders.\"/wt/b\"]\ntrusted = true\n{TRUST_CLOSE}\n"
    )
}

fn seed(root: &Path) {
    write(root, ".cursor/hooks.json", &cursor_hooks());
    write(root, ".grok/hooks/houston.json", &grok_hooks());
    write(root, ".cursor/mcp.json", &cursor_mcp());
    write(
        root,
        ".grok/config.toml",
        &grok_config("${HOUSTON_MCP_URL}", "Bearer ${HOUSTON_MCP_TOKEN}"),
    );
    write(root, ".grok/trusted_folders.toml", &trust_file());
}

#[test]
fn removes_what_houston_wrote_and_keeps_what_the_user_wrote() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());

    let outcome = cleanup(&home_of(&dir), SENTINEL, &["docs".to_string()]);

    assert!(outcome.left.is_empty(), "{:?}", outcome.left);
    assert!(outcome.cursor_mcp_settled);
    assert_eq!(outcome.removed.len(), 6, "{:?}", outcome.removed);

    let hooks = json(dir.path(), ".cursor/hooks.json");
    assert_eq!(
        hooks["hooks"]["stop"],
        serde_json::json!([{"command": "my-own-stop-hook"}]),
        "the user's own hook survives"
    );
    assert!(hooks["hooks"].get("sessionStart").is_none());
    assert!(
        !dir.path().join(".grok/hooks/houston.json").exists(),
        "a hook file holding only Houston's entries is deleted"
    );

    let mcp = json(dir.path(), ".cursor/mcp.json");
    let servers = mcp["mcpServers"].as_object().unwrap();
    assert!(!servers.contains_key("houston"), "{servers:?}");
    assert!(
        !servers.contains_key("docs"),
        "MCP manager entry is retracted"
    );
    assert!(servers.contains_key("mine"), "the user's server survives");

    let config = read(dir.path(), ".grok/config.toml");
    assert!(!config.contains("mcp_servers.houston"), "{config}");
    assert!(config.contains("model = \"grok-4\""), "{config}");
    assert!(config.contains("[mcp_servers.other]"), "{config}");

    let trust = read(dir.path(), ".grok/trusted_folders.toml");
    assert!(
        !trust.contains(TRUST_OPEN) && !trust.contains("/wt/"),
        "{trust}"
    );
    assert!(trust.contains("[folders.\"/mine\"]"), "{trust}");
    trust
        .parse::<toml::Table>()
        .expect("the trust file still parses");
}

#[test]
fn a_grok_entry_the_user_edited_is_left_and_named() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    let edited = grok_config(
        "https://example.invalid/houston",
        "Bearer ${HOUSTON_MCP_TOKEN}",
    );
    write(dir.path(), ".grok/config.toml", &edited);

    let outcome = cleanup(&home_of(&dir), SENTINEL, &[]);

    assert_eq!(read(dir.path(), ".grok/config.toml"), edited);
    let left = outcome.left.join("\n");
    assert!(
        left.contains("[mcp_servers.houston]")
            && left.contains("https://example.invalid/houston")
            && left.contains("${HOUSTON_MCP_URL}"),
        "the log names the entry, what it holds and what was expected: {left}"
    );
}

#[test]
fn a_grok_entry_with_a_different_authorization_is_left() {
    let dir = tempfile::tempdir().unwrap();
    let edited = grok_config("${HOUSTON_MCP_URL}", "Bearer something-else");
    write(dir.path(), ".grok/config.toml", &edited);

    let outcome = cleanup(&home_of(&dir), SENTINEL, &[]);

    assert_eq!(read(dir.path(), ".grok/config.toml"), edited);
    assert_eq!(outcome.left.len(), 1, "{:?}", outcome.left);
    assert!(outcome.removed.is_empty(), "{:?}", outcome.removed);
}

#[test]
fn a_cursor_entry_without_the_marker_is_left() {
    let dir = tempfile::tempdir().unwrap();
    let unmarked =
        serde_json::json!({"mcpServers": {"houston": {"url": "http://elsewhere/mcp"}}}).to_string();
    write(dir.path(), ".cursor/mcp.json", &unmarked);

    let outcome = cleanup(&home_of(&dir), SENTINEL, &[]);

    assert_eq!(read(dir.path(), ".cursor/mcp.json"), unmarked);
    assert!(
        outcome.left.join("\n").contains("_houston"),
        "{:?}",
        outcome.left
    );
}

#[test]
fn a_second_run_removes_nothing_and_changes_no_file() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path());
    cleanup(&home_of(&dir), SENTINEL, &["docs".to_string()]);
    let files = [
        ".cursor/hooks.json",
        ".cursor/mcp.json",
        ".grok/config.toml",
        ".grok/trusted_folders.toml",
    ];
    let before: Vec<String> = files.iter().map(|f| read(dir.path(), f)).collect();

    let again = cleanup(&home_of(&dir), SENTINEL, &["docs".to_string()]);

    assert!(again.removed.is_empty(), "{:?}", again.removed);
    assert!(again.left.is_empty(), "{:?}", again.left);
    let after: Vec<String> = files.iter().map(|f| read(dir.path(), f)).collect();
    assert_eq!(before, after);
}

#[test]
fn a_home_without_either_provider_is_untouched() {
    let dir = tempfile::tempdir().unwrap();

    let outcome = cleanup(&home_of(&dir), SENTINEL, &[]);

    assert!(outcome.removed.is_empty() && outcome.left.is_empty());
    assert!(outcome.cursor_mcp_settled);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_trust_file_holding_only_houston_blocks_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        ".grok/trusted_folders.toml",
        &format!("{TRUST_OPEN}\n[folders.\"/wt/a\"]\ntrusted = true\n{TRUST_CLOSE}\n"),
    );

    let outcome = cleanup(&home_of(&dir), SENTINEL, &[]);

    assert!(!dir.path().join(".grok/trusted_folders.toml").exists());
    assert_eq!(outcome.removed.len(), 1, "{:?}", outcome.removed);
}

#[test]
fn an_unterminated_trust_block_and_unparseable_config_are_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let open_block = format!("{TRUST_OPEN}\n[folders.\"/wt/a\"]\ntrusted = true\n");
    write(dir.path(), ".grok/trusted_folders.toml", &open_block);
    write(dir.path(), ".grok/config.toml", "this = [is not toml");
    write(dir.path(), ".cursor/mcp.json", "{ not json");

    let outcome = cleanup(&home_of(&dir), SENTINEL, &["docs".to_string()]);

    assert_eq!(read(dir.path(), ".grok/trusted_folders.toml"), open_block);
    assert_eq!(read(dir.path(), ".grok/config.toml"), "this = [is not toml");
    assert_eq!(read(dir.path(), ".cursor/mcp.json"), "{ not json");
    assert_eq!(outcome.left.len(), 3, "{:?}", outcome.left);
    assert!(
        !outcome.cursor_mcp_settled,
        "the MCP manager record is kept while Cursor's file could not be settled"
    );
}

mod refusal {
    use crate::common::start_daemon_with_handle;
    use houston_core::daemon::CreateParams;
    use houston_protocol as proto;

    fn expected(name: &str) -> String {
        format!(
            "{name} is no longer a supported provider: Houston recognises it but cannot launch \
             it; close this pane or choose claude, codex, antigravity, opencode or zcode"
        )
    }

    #[tokio::test]
    async fn session_create_refuses_each_retired_provider_by_name() {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        for (agent, name) in [
            (proto::AgentKind::Grok, "grok"),
            (proto::AgentKind::Cursor, "cursor"),
        ] {
            let err = daemon
                .create_session(CreateParams {
                    agent,
                    project_dir: state.path().to_path_buf(),
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
                .expect_err("a retired provider must not launch");
            assert!(
                format!("{err:#}").contains(&expected(name)),
                "{name}: {err:#}"
            );
        }
        assert!(daemon.list().is_empty(), "a refusal leaves no pane behind");
    }
}

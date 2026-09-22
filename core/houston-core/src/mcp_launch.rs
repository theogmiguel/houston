use houston_protocol as proto;

pub const CODEX_TOKEN_ENV: &str = "HOUSTON_MCP_TOKEN";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub endpoint: String,
    pub token: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Launch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub credential: Option<Credential>,
}

impl Launch {
    pub fn is_empty(&self) -> bool {
        self.args.is_empty() && self.env.is_empty()
    }
}

pub fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub const URL_ENV: &str = "HOUSTON_MCP_URL";

pub const CONFIG_ENV: &str = "HOUSTON_MCP_CONFIG";

const CODEX_TOOL_TIMEOUT_MARGIN_SEC: u64 = 30;
/// Leaves a transport margin after Houston's 600s `pane_wait` default.
pub(crate) const CODEX_TOOL_TIMEOUT_SEC: u64 =
    crate::orchestrate::DEFAULT_WAIT_TIMEOUT_MS / 1_000 + CODEX_TOOL_TIMEOUT_MARGIN_SEC;

fn config_json(endpoint: &str, token: &str) -> String {
    serde_json::json!({
        "mcpServers": {
            crate::mcp_server::SERVER_NAME: {
                "type": "http",
                "url": endpoint,
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    })
    .to_string()
}

pub const OPENCODE_CONFIG_ENV: &str = "OPENCODE_CONFIG_CONTENT";

fn opencode_config_content(endpoint: &str, token: &str) -> String {
    serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            crate::mcp_server::SERVER_NAME: {
                "type": "remote",
                "url": endpoint,
                "headers": { "Authorization": format!("Bearer {token}") },
                "enabled": true,
            }
        }
    })
    .to_string()
}

fn base_env(endpoint: &str, token: &str) -> Vec<(String, String)> {
    vec![
        (URL_ENV.to_string(), endpoint.to_string()),
        (CODEX_TOKEN_ENV.to_string(), token.to_string()),
        (CONFIG_ENV.to_string(), config_json(endpoint, token)),
    ]
}

pub fn launch_for(agent: proto::AgentKind, endpoint: &str, token: &str) -> Launch {
    // a plain shell/SSH pane has no agent CLI behind it to configure
    if matches!(agent, proto::AgentKind::Ssh) {
        return Launch::default();
    }

    let env = base_env(endpoint, token);
    let credential = Some(Credential {
        endpoint: endpoint.to_string(),
        token: token.to_string(),
    });
    match agent {
        proto::AgentKind::Claude => Launch {
            args: vec!["--mcp-config".into(), config_json(endpoint, token)],
            env,
            credential,
        },
        proto::AgentKind::Codex => {
            // token stays out of argv and goes through an env var instead — argv is
            // world-readable via /proc, env is not
            let name = crate::mcp_server::SERVER_NAME;
            Launch {
                args: vec![
                    "-c".into(),
                    format!("mcp_servers.{name}.url={endpoint}"),
                    "-c".into(),
                    format!("mcp_servers.{name}.bearer_token_env_var=\"{CODEX_TOKEN_ENV}\""),
                    "-c".into(),
                    format!("mcp_servers.{name}.tool_timeout_sec={CODEX_TOOL_TIMEOUT_SEC}"),
                ],
                env,
                credential,
            }
        }
        proto::AgentKind::Opencode => {
            let mut env = env;
            env.push((
                OPENCODE_CONFIG_ENV.to_string(),
                opencode_config_content(endpoint, token),
            ));
            Launch {
                args: Vec::new(),
                env,
                credential,
            }
        }
        _ => Launch {
            args: Vec::new(),
            env,
            credential,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: &str = "http://127.0.0.1:4242/mcp";
    const TOKEN: &str = "tok-abc";

    #[test]
    fn claude_gets_inline_config_and_keeps_the_user_s_own_servers() {
        let launch = launch_for(proto::AgentKind::Claude, ENDPOINT, TOKEN);
        assert_eq!(launch.args[0], "--mcp-config");
        assert!(
            !launch.args.contains(&"--strict-mcp-config".to_string()),
            "a pane is the user's own CLI: the flag makes the argv config the \
             only source and suppresses their own servers, their project's \
             .mcp.json, their plugins and their connectors: {:?}",
            launch.args
        );
        let config: serde_json::Value = serde_json::from_str(&launch.args[1]).unwrap();
        let server = &config["mcpServers"]["houston"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], ENDPOINT);
        assert_eq!(server["headers"]["Authorization"], "Bearer tok-abc");
        assert!(launch.env.iter().any(|(k, _)| k == CONFIG_ENV));
    }

    #[test]
    fn opencode_gets_the_config_content_env_and_no_argv() {
        let launch = launch_for(proto::AgentKind::Opencode, ENDPOINT, TOKEN);
        assert!(
            launch.args.is_empty(),
            "OpenCode takes its config through env, not argv: {:?}",
            launch.args
        );
        let content = launch
            .env
            .iter()
            .find(|(k, _)| k == OPENCODE_CONFIG_ENV)
            .map(|(_, v)| v.clone())
            .expect("OPENCODE_CONFIG_CONTENT must be set");
        let config: serde_json::Value = serde_json::from_str(&content).unwrap();
        let server = &config["mcp"]["houston"];
        assert_eq!(server["type"], "remote");
        assert_eq!(server["url"], ENDPOINT);
        assert_eq!(server["headers"]["Authorization"], "Bearer tok-abc");
        assert_eq!(server["enabled"], true);
    }

    #[test]
    fn codex_keeps_the_token_out_of_argv() {
        let launch = launch_for(proto::AgentKind::Codex, ENDPOINT, TOKEN);
        assert!(
            !launch.args.iter().any(|a| a.contains(TOKEN)),
            "Codex reads the token from the environment; argv is world-readable \
             through /proc: {:?}",
            launch.args
        );
        assert!(launch
            .env
            .iter()
            .any(|(k, v)| k == CODEX_TOKEN_ENV && v == TOKEN));
        assert!(launch
            .args
            .iter()
            .any(|a| a == "mcp_servers.houston.url=http://127.0.0.1:4242/mcp"));
        assert!(launch
            .args
            .iter()
            .any(|a| a.contains("bearer_token_env_var") && a.contains(CODEX_TOKEN_ENV)));
    }

    #[test]
    fn the_codex_override_names_the_env_var_it_ships() {
        let launch = launch_for(proto::AgentKind::Codex, ENDPOINT, TOKEN);
        let override_arg = launch
            .args
            .iter()
            .find(|a| a.contains("bearer_token_env_var"))
            .unwrap();
        let exported = launch
            .env
            .iter()
            .map(|(k, _)| k.as_str())
            .find(|k| *k == CODEX_TOKEN_ENV)
            .expect("Codex must export the variable its own override names");
        assert!(override_arg.contains(exported));
    }

    #[test]
    fn codex_tool_timeout_covers_the_default_wait_with_a_transport_margin() {
        let launch = launch_for(proto::AgentKind::Codex, ENDPOINT, TOKEN);
        let expected = format!("mcp_servers.houston.tool_timeout_sec={CODEX_TOOL_TIMEOUT_SEC}");
        assert!(launch.args.iter().any(|arg| arg == &expected), "{launch:?}");
        let timeout_sec = launch
            .args
            .iter()
            .find_map(|arg| {
                arg.strip_prefix("mcp_servers.houston.tool_timeout_sec=")
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .expect("Codex launch must carry a numeric Houston tool timeout");
        assert!(
            timeout_sec * 1_000 > crate::orchestrate::DEFAULT_WAIT_TIMEOUT_MS,
            "Codex's tool timeout must exceed pane_wait's default"
        );
        assert_eq!(
            timeout_sec * 1_000 - crate::orchestrate::DEFAULT_WAIT_TIMEOUT_MS,
            CODEX_TOOL_TIMEOUT_MARGIN_SEC * 1_000
        );
        assert!(
            !launch.args.iter().any(|arg| arg.contains(TOKEN)),
            "the Codex launch must keep the bearer token out of argv: {launch:?}"
        );
    }

    #[test]
    fn kinds_without_a_flag_based_mcp_config_still_get_the_environment() {
        for agent in [
            proto::AgentKind::Antigravity,
            proto::AgentKind::Shell,
            proto::AgentKind::Custom,
        ] {
            let launch = launch_for(agent, ENDPOINT, TOKEN);
            assert!(
                launch.args.is_empty(),
                "{agent:?} cannot be configured by flag and must not be handed any"
            );
            let names: Vec<&str> = launch.env.iter().map(|(k, _)| k.as_str()).collect();
            assert!(names.contains(&URL_ENV), "{agent:?}: {names:?}");
            assert!(names.contains(&CODEX_TOKEN_ENV), "{agent:?}: {names:?}");
            assert!(names.contains(&CONFIG_ENV), "{agent:?}: {names:?}");
        }
    }

    #[test]
    fn an_ssh_pane_gets_nothing_at_all() {
        let launch = launch_for(proto::AgentKind::Ssh, ENDPOINT, TOKEN);
        assert!(launch.is_empty(), "{launch:?}");
        assert!(
            !format!("{launch:?}").contains(TOKEN),
            "the token must never be built into an SSH pane's launch"
        );
    }

    #[test]
    fn the_exported_config_is_the_same_json_a_claude_pane_is_launched_with() {
        let shell = launch_for(proto::AgentKind::Shell, ENDPOINT, TOKEN);
        let exported = shell
            .env
            .iter()
            .find(|(k, _)| k == CONFIG_ENV)
            .map(|(_, v)| v.clone())
            .unwrap();

        let claude = launch_for(proto::AgentKind::Claude, ENDPOINT, TOKEN);
        let idx = claude
            .args
            .iter()
            .position(|a| a == "--mcp-config")
            .unwrap();
        assert_eq!(exported, claude.args[idx + 1]);

        let parsed: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(parsed["mcpServers"]["houston"]["url"], ENDPOINT);
    }

    #[test]
    fn the_endpoint_is_loopback_only() {
        assert_eq!(endpoint(9), "http://127.0.0.1:9/mcp");
    }
}

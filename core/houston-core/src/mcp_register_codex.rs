use std::path::{Path, PathBuf};
use std::time::Duration;

/// 15s covers a cold start on a loaded box without letting a hung child hold a
/// boot-time task open forever.
const ADD_TIMEOUT: Duration = Duration::from_secs(15);

pub fn registration_args(port: u16) -> Vec<String> {
    vec![
        "mcp".to_string(),
        "add".to_string(),
        crate::mcp_server::SERVER_NAME.to_string(),
        "--url".to_string(),
        crate::mcp_launch::endpoint(port),
        "--bearer-token-env-var".to_string(),
        crate::mcp_launch::CODEX_TOKEN_ENV.to_string(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Current,
    Register,
    Skip(String),
}

fn is_houston_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some((port_str, suffix)) = rest.split_once('/') else {
        return false;
    };
    suffix == "mcp" && !port_str.is_empty() && port_str.chars().all(|c| c.is_ascii_digit())
}

fn parse_houston_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let (port_str, suffix) = rest.split_once('/')?;
    if suffix != "mcp" {
        return None;
    }
    port_str.parse::<u16>().ok()
}

pub fn decide(contents: Option<&str>, port: u16) -> Decision {
    let Some(text) = contents else {
        return Decision::Register;
    };
    let parsed: toml::Value = match text.parse() {
        Ok(v) => v,
        Err(e) => {
            return Decision::Skip(format!(
                "Codex config.toml is not valid TOML ({e}); expected a table with \
                 an optional `mcp_servers` table — leaving it alone"
            ));
        }
    };
    let Some(root_table) = parsed.as_table() else {
        return Decision::Skip(
            "Codex config.toml root is not a table — leaving it alone".to_string(),
        );
    };
    match root_table.get("mcp_servers") {
        None => Decision::Register,
        Some(toml::Value::Table(servers)) => {
            let server_name = crate::mcp_server::SERVER_NAME;
            let Some(houston_entry) = servers.get(server_name) else {
                return Decision::Register;
            };
            let Some(table) = houston_entry.as_table() else {
                return Decision::Skip(format!(
                    "codex `mcp_servers.{server_name}` exists and is not Houston's (not a table) — leaving it alone"
                ));
            };
            let url = table.get("url").and_then(|v| v.as_str());
            let bearer_env = table.get("bearer_token_env_var").and_then(|v| v.as_str());

            let is_ours = url.map(is_houston_url).unwrap_or(false)
                && bearer_env == Some(crate::mcp_launch::CODEX_TOKEN_ENV);

            if is_ours {
                let existing_port = url.and_then(parse_houston_port);
                if existing_port == Some(port) {
                    Decision::Current
                } else {
                    Decision::Register
                }
            } else {
                let keys = table.keys().cloned().collect::<Vec<_>>().join(", ");
                Decision::Skip(format!(
                    "codex `mcp_servers.{server_name}` exists and is not Houston's (url={url:?}, keys=[{keys}]) — leaving it alone"
                ))
            }
        }
        Some(other) => Decision::Skip(format!(
            "Codex config `mcp_servers` is {}, expected a table — leaving it alone",
            kind_of(other)
        )),
    }
}

fn kind_of(v: &toml::Value) -> &'static str {
    match v {
        toml::Value::String(_) => "a string",
        toml::Value::Integer(_) => "an integer",
        toml::Value::Float(_) => "a float",
        toml::Value::Boolean(_) => "a boolean",
        toml::Value::Datetime(_) => "a datetime",
        toml::Value::Array(_) => "an array",
        toml::Value::Table(_) => "a table",
    }
}

pub async fn run(codex_home: &Path, codex_bin: &Path, port: u16) -> Result<String, String> {
    let config_path = codex_home.join("config.toml");
    let contents = match std::fs::read_to_string(&config_path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "could not read {}: {e} — skipping Codex MCP self-registration",
                config_path.display()
            ));
        }
    };
    match decide(contents.as_deref(), port) {
        Decision::Current => Ok(format!(
            "codex user-scope MCP entry `{}` already current; not touched",
            crate::mcp_server::SERVER_NAME
        )),
        Decision::Skip(reason) => Err(reason),
        Decision::Register => {
            let output = tokio::time::timeout(
                ADD_TIMEOUT,
                crate::spawn::tokio_command(codex_bin)
                    .args(registration_args(port))
                    .env("CODEX_HOME", codex_home)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| {
                format!(
                    "`codex mcp add` did not finish within {}s — killed; \
                     registration will retry next boot",
                    ADD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("could not run `{}`: {e}", codex_bin.display()))?;
            if output.status.success() {
                Ok(format!(
                    "registered `{}` in codex user scope (flagless `codex` in Houston \
                     panes now connects)",
                    crate::mcp_server::SERVER_NAME
                ))
            } else {
                Err(format!(
                    "`codex mcp add` exited {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        }
    }
}

// The entry holds a literal port, so it must be refreshed every boot — but only
// on the release channel: a dev daemon writing the same file would fight the
// installed app over one `[mcp_servers.houston]`.
pub fn spawn_at_boot(port: Option<u16>) {
    match crate::paths::channel() {
        Ok(Some(name)) => {
            tracing::info!(
                "codex mcp self-registration: skipped on channel {name}: the entry \
                 holds a literal port and belongs to the release daemon"
            );
            return;
        }
        Err(e) => {
            tracing::warn!("codex mcp self-registration: channel resolution failed ({e}); skipped");
            return;
        }
        Ok(None) => {}
    }

    let Some(port) = port else {
        tracing::warn!("codex mcp self-registration: no bound port; skipped");
        return;
    };

    tokio::spawn(async move {
        let codex_home = match std::env::var_os("CODEX_HOME") {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => match crate::agent_hooks::ConfigHome::from_env() {
                Ok(h) => h.home.join(".codex"),
                Err(e) => {
                    tracing::warn!("codex mcp self-registration: no home dir ({e}); skipped");
                    return;
                }
            },
        };

        let Some(codex_bin) = crate::exe_path::resolve("codex") else {
            tracing::info!("codex mcp self-registration: `codex` not found on PATH; skipped");
            return;
        };

        match run(&codex_home, &codex_bin, port).await {
            Ok(outcome) => tracing::info!("codex mcp self-registration: {outcome}"),
            Err(reason) => tracing::warn!("codex mcp self-registration: {reason}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    async fn run_stub(codex_home: &Path, stub: &Path, port: u16) -> Result<String, String> {
        let mut last = Err(String::from("unreached"));
        for _ in 0..20 {
            last = run(codex_home, stub, port).await;
            match &last {
                Err(e) if e.contains("Text file busy") => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                _ => break,
            }
        }
        last
    }

    #[test]
    fn no_file_means_register() {
        assert_eq!(decide(None, 4242), Decision::Register);
    }

    #[test]
    fn toml_without_mcp_servers_means_register() {
        let text = "model = \"o3\"\n";
        assert_eq!(decide(Some(text), 4242), Decision::Register);
    }

    #[test]
    fn other_servers_only_means_register() {
        let text = r#"
[mcp_servers.ai_memory]
url = "http://127.0.0.1:9000/mcp"
"#;
        assert_eq!(decide(Some(text), 4242), Decision::Register);
    }

    #[test]
    fn ours_current_port_means_current() {
        let text = format!(
            r#"
[mcp_servers.houston]
url = "http://127.0.0.1:4242/mcp"
bearer_token_env_var = "{}"
"#,
            crate::mcp_launch::CODEX_TOKEN_ENV
        );
        assert_eq!(decide(Some(&text), 4242), Decision::Current);
    }

    #[test]
    fn ours_other_port_means_register() {
        let text = format!(
            r#"
[mcp_servers.houston]
url = "http://127.0.0.1:5555/mcp"
bearer_token_env_var = "{}"
"#,
            crate::mcp_launch::CODEX_TOKEN_ENV
        );
        assert_eq!(decide(Some(&text), 4242), Decision::Register);
    }

    #[test]
    fn foreign_houston_skips_naming_it() {
        let text = r#"
[mcp_servers.houston]
command = "x"
args = ["--stdio"]
"#;
        match decide(Some(text), 4242) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not Houston's"), "{reason}");
                assert!(reason.contains("keys=["), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_toml_skips_naming_the_problem() {
        match decide(Some("not toml = [["), 4242) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not valid TOML"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn registration_args_holds_literal_endpoint_and_env_var_name_never_token() {
        let args = registration_args(4242);
        assert_eq!(
            args,
            vec![
                "mcp",
                "add",
                "houston",
                "--url",
                "http://127.0.0.1:4242/mcp",
                "--bearer-token-env-var",
                "HOUSTON_MCP_TOKEN"
            ]
        );
        assert!(
            !args
                .iter()
                .any(|a| a.contains("tok-") || a.contains("secret")),
            "arguments must never contain a secret token"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_registers_via_stub_binary_and_second_run_is_current() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let stub = home.join("codex-stub.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}/argv.txt\n\
                 printf '%s\\n' '[mcp_servers.houston]' 'url = \"http://127.0.0.1:4242/mcp\"' 'bearer_token_env_var = \"HOUSTON_MCP_TOKEN\"' > {}/config.toml\n",
                home.display(),
                home.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let first = run_stub(home, &stub, 4242).await.unwrap();
        assert!(first.contains("registered"), "{first}");
        let argv = std::fs::read_to_string(home.join("argv.txt")).unwrap();
        assert!(argv.contains("http://127.0.0.1:4242/mcp"), "{argv}");
        assert!(argv.contains("HOUSTON_MCP_TOKEN"), "{argv}");

        let second = run_stub(home, &stub, 4242).await.unwrap();
        assert!(second.contains("already current"), "{second}");
    }
}

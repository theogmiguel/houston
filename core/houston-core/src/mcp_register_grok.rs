use std::path::{Path, PathBuf};
use std::time::Duration;

/// Grok expands `${VAR}` in both `url` and `headers` (unlike Codex), so the
/// entry holds the literal placeholders rather than a port that goes stale
/// every boot — it never has to be refreshed once written.
pub const URL_PLACEHOLDER: &str = "${HOUSTON_MCP_URL}";

pub const TOKEN_PLACEHOLDER: &str = "${HOUSTON_MCP_TOKEN}";

const ADD_TIMEOUT: Duration = Duration::from_secs(15);

pub fn registration_args() -> Vec<String> {
    [
        "mcp",
        "add",
        "--transport",
        "http",
        crate::mcp_server::SERVER_NAME,
        URL_PLACEHOLDER,
        "--header",
    ]
    .into_iter()
    .map(str::to_string)
    .chain([format!("Authorization: Bearer {TOKEN_PLACEHOLDER}")])
    .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    AlreadyRegistered,
    Register,
    Skip(String),
}

pub fn decide(contents: Option<&str>) -> Decision {
    let Some(text) = contents else {
        return Decision::Register;
    };
    let parsed: toml::Value = match text.parse() {
        Ok(v) => v,
        Err(e) => {
            return Decision::Skip(format!(
                "Grok config.toml is not valid TOML ({e}); expected a table with \
                 an optional `mcp_servers` table — leaving it alone"
            ));
        }
    };
    let Some(root_table) = parsed.as_table() else {
        return Decision::Skip(
            "Grok config.toml root is not a table — leaving it alone".to_string(),
        );
    };
    match root_table.get("mcp_servers") {
        None => Decision::Register,
        Some(toml::Value::Table(servers)) => {
            if servers.contains_key(crate::mcp_server::SERVER_NAME) {
                Decision::AlreadyRegistered
            } else {
                Decision::Register
            }
        }
        Some(other) => Decision::Skip(format!(
            "Grok config `mcp_servers` is {}, expected a table — leaving it alone",
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

pub async fn run(home: &Path, grok_bin: &Path) -> Result<String, String> {
    let config_path = home.join(".grok").join("config.toml");
    let contents = match std::fs::read_to_string(&config_path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "could not read {}: {e} — skipping Grok MCP self-registration",
                config_path.display()
            ));
        }
    };
    match decide(contents.as_deref()) {
        Decision::AlreadyRegistered => Ok(format!(
            "grok user-scope MCP entry `{}` already present; not touched",
            crate::mcp_server::SERVER_NAME
        )),
        Decision::Skip(reason) => Err(reason),
        Decision::Register => {
            let output = tokio::time::timeout(
                ADD_TIMEOUT,
                crate::spawn::tokio_command(grok_bin)
                    .args(registration_args())
                    .env("HOME", home)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| {
                format!(
                    "`grok mcp add` did not finish within {}s — killed; \
                     registration will retry next boot",
                    ADD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("could not run `{}`: {e}", grok_bin.display()))?;
            if output.status.success() {
                Ok(format!(
                    "registered `{}` in grok user scope (flagless `grok` in Houston \
                     panes now connects)",
                    crate::mcp_server::SERVER_NAME
                ))
            } else {
                Err(format!(
                    "`grok mcp add` exited {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        }
    }
}

/// No channel gating: the entry holds only placeholders and never goes stale,
/// unlike Codex's literal-port entry.
pub fn spawn_at_boot() {
    tokio::spawn(async {
        let home = match crate::agent_hooks::ConfigHome::from_env() {
            Ok(h) => h.home,
            Err(e) => {
                tracing::warn!("grok mcp self-registration: no home dir ({e}); skipped");
                return;
            }
        };
        let Some(grok_bin) = crate::exe_path::resolve("grok") else {
            tracing::info!("grok mcp self-registration: `grok` not found on PATH; skipped");
            return;
        };
        match run(&home, &grok_bin).await {
            Ok(outcome) => tracing::info!("grok mcp self-registration: {outcome}"),
            Err(reason) => tracing::warn!("grok mcp self-registration: {reason}"),
        }
    });
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".grok").join("config.toml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    async fn run_stub(grok_home: &Path, stub: &Path) -> Result<String, String> {
        let mut last = Err(String::from("unreached"));
        for _ in 0..20 {
            last = run(grok_home, stub).await;
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
        assert_eq!(decide(None), Decision::Register);
    }

    #[test]
    fn toml_without_mcp_servers_means_register() {
        let text = "model = \"grok-4\"\n";
        assert_eq!(decide(Some(text)), Decision::Register);
    }

    #[test]
    fn other_servers_only_means_register() {
        let text = r#"
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
"#;
        assert_eq!(decide(Some(text)), Decision::Register);
    }

    #[test]
    fn an_existing_entry_of_any_shape_is_never_touched() {
        let text = r#"
[mcp_servers.houston]
url = "http://127.0.0.1:9999/mcp"
"#;
        assert_eq!(decide(Some(text)), Decision::AlreadyRegistered);
    }

    #[test]
    fn unparseable_toml_skips_naming_the_problem() {
        match decide(Some("not toml = [[")) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not valid TOML"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn a_non_table_mcp_servers_key_skips_and_names_the_shape() {
        match decide(Some("mcp_servers = [1, 2]\n")) {
            Decision::Skip(reason) => {
                assert!(reason.contains("an array"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn registration_argv_holds_placeholders_not_values() {
        let args = registration_args();
        assert!(args.contains(&URL_PLACEHOLDER.to_string()), "{args:?}");
        assert!(
            args.iter()
                .any(|a| a == &format!("Authorization: Bearer {TOKEN_PLACEHOLDER}")),
            "{args:?}"
        );
        assert!(
            !args.iter().any(|a| a.contains("127.0.0.1")),
            "a literal address in the persisted entry would pin one boot's port: {args:?}"
        );
        assert_eq!(args[..2], ["mcp".to_string(), "add".to_string()]);
        assert!(args.contains(&"--transport".to_string()) && args.contains(&"http".to_string()));
    }

    #[test]
    fn placeholders_name_the_variables_panes_actually_export() {
        assert_eq!(
            URL_PLACEHOLDER,
            format!("${{{}}}", crate::mcp_launch::URL_ENV)
        );
        assert_eq!(
            TOKEN_PLACEHOLDER,
            format!("${{{}}}", crate::mcp_launch::CODEX_TOKEN_ENV)
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_registers_via_stub_binary_and_second_run_is_already_registered() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let stub = home.join("grok-stub.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}/argv.txt\n\
                 mkdir -p {0}/.grok\n\
                 printf '%s\\n' '[mcp_servers.houston]' \
                 'url = \"${{HOUSTON_MCP_URL}}\"' \
                 'headers = {{ Authorization = \"Bearer ${{HOUSTON_MCP_TOKEN}}\" }}' \
                 > {0}/.grok/config.toml\n",
                home.display(),
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let first = run_stub(home, &stub).await.unwrap();
        assert!(first.contains("registered"), "{first}");
        let argv = std::fs::read_to_string(home.join("argv.txt")).unwrap();
        assert!(argv.contains(URL_PLACEHOLDER), "{argv}");
        assert!(argv.contains(TOKEN_PLACEHOLDER), "{argv}");

        let second = run_stub(home, &stub).await.unwrap();
        assert!(second.contains("already present"), "{second}");
    }

    #[tokio::test]
    async fn run_reports_a_missing_binary_without_touching_anything() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(dir.path(), Path::new("/nonexistent/grok-bin"))
            .await
            .unwrap_err();
        assert!(err.contains("/nonexistent/grok-bin"), "{err}");
        assert!(!dir.path().join(".grok").join("config.toml").exists());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_reports_a_failing_add_with_its_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("grok-stub.sh");
        std::fs::write(&stub, "#!/bin/sh\necho 'boom: no auth' >&2\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = run_stub(dir.path(), &stub).await.unwrap_err();
        assert!(err.contains("exited Some(3)"), "{err}");
        assert!(err.contains("boom: no auth"), "{err}");
    }
}

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The entry holds no port and no secret: `url` and `Authorization` are the
/// literal `${HOUSTON_MCP_URL}` / `Bearer ${HOUSTON_MCP_TOKEN}`, which Claude
/// expands from the pane environment. On disk that names a variable, not a value.
pub const URL_PLACEHOLDER: &str = "${HOUSTON_MCP_URL}";

pub const TOKEN_PLACEHOLDER: &str = "${HOUSTON_MCP_TOKEN}";

/// Covers a cold node start on a loaded box without letting a hung child hold a
/// boot-time task open forever.
const ADD_TIMEOUT: Duration = Duration::from_secs(15);

pub fn registration_args() -> Vec<String> {
    [
        "mcp",
        "add",
        "--scope",
        "user",
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
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return Decision::Skip(format!(
                "~/.claude.json is not valid JSON ({e}); expected an object with \
                 an optional `mcpServers` map — leaving it alone"
            ))
        }
    };
    match parsed.get("mcpServers") {
        None => Decision::Register,
        Some(serde_json::Value::Object(map)) => {
            if map.contains_key(crate::mcp_server::SERVER_NAME) {
                Decision::AlreadyRegistered
            } else {
                Decision::Register
            }
        }
        Some(other) => Decision::Skip(format!(
            "~/.claude.json `mcpServers` is {}, expected an object — leaving it alone",
            kind_of(other)
        )),
    }
}

fn kind_of(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a bool",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

pub async fn run(config_dir: &Path, claude_bin: &Path) -> Result<String, String> {
    let config_path = config_dir.join(".claude.json");
    let contents = match std::fs::read_to_string(&config_path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "could not read {}: {e} — skipping MCP self-registration",
                config_path.display()
            ))
        }
    };
    match decide(contents.as_deref()) {
        Decision::AlreadyRegistered => Ok(format!(
            "claude user-scope MCP entry `{}` already present; not touched",
            crate::mcp_server::SERVER_NAME
        )),
        Decision::Skip(reason) => Err(reason),
        Decision::Register => {
            let output = tokio::time::timeout(
                ADD_TIMEOUT,
                crate::spawn::tokio_command(claude_bin)
                    .args(registration_args())
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| {
                format!(
                    "`claude mcp add` did not finish within {}s — killed; \
                     registration will retry next boot",
                    ADD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("could not run `{}`: {e}", claude_bin.display()))?;
            if output.status.success() {
                Ok(format!(
                    "registered `{}` in claude user scope (flagless `claude` in Houston \
                     panes now connects)",
                    crate::mcp_server::SERVER_NAME
                ))
            } else {
                Err(format!(
                    "`claude mcp add` exited {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        }
    }
}

/// Called explicitly by both production hosts, NOT `boot::spawn_background_loops`:
/// the integration harness spawns that shared list too, and a test must never
/// write the real `~/.claude.json`.
pub fn spawn_at_boot() {
    tokio::spawn(async {
        let config_dir = match std::env::var_os("CLAUDE_CONFIG_DIR") {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => match crate::agent_hooks::ConfigHome::from_env() {
                Ok(home) => home.home,
                Err(e) => {
                    tracing::warn!("mcp self-registration: no home dir ({e}); skipped");
                    return;
                }
            },
        };
        let claude_bin =
            crate::exe_path::resolve("claude").unwrap_or_else(|| PathBuf::from("claude"));
        match run(&config_dir, &claude_bin).await {
            Ok(outcome) => tracing::info!("mcp self-registration: {outcome}"),
            Err(reason) => tracing::warn!("mcp self-registration: {reason}"),
        }
    });
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    async fn run_stub(home: &Path, stub: &Path) -> Result<String, String> {
        let mut last = Err(String::from("unreached"));
        for _ in 0..20 {
            last = run(home, stub).await;
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
    fn no_mcp_servers_key_means_register() {
        assert_eq!(decide(Some(r#"{"userID":"x"}"#)), Decision::Register);
    }

    #[test]
    fn other_servers_but_not_ours_means_register() {
        let text = r#"{"mcpServers":{"ai-memory":{"type":"http","url":"http://x/"}}}"#;
        assert_eq!(decide(Some(text)), Decision::Register);
    }

    #[test]
    fn an_existing_entry_of_any_shape_is_never_touched() {
        let text =
            r#"{"mcpServers":{"houston":{"type":"http","url":"http://127.0.0.1:9999/mcp"}}}"#;
        assert_eq!(decide(Some(text)), Decision::AlreadyRegistered);
    }

    #[test]
    fn invalid_json_skips_and_names_the_problem() {
        match decide(Some("{not json")) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not valid JSON"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn a_non_object_mcp_servers_key_skips_and_names_the_shape() {
        match decide(Some(r#"{"mcpServers":[1,2]}"#)) {
            Decision::Skip(reason) => {
                assert!(reason.contains("an array"), "{reason}");
                assert!(reason.contains("expected an object"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn the_registration_argv_holds_placeholders_not_values() {
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
        assert!(args.contains(&"--scope".to_string()) && args.contains(&"user".to_string()));
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
    async fn run_registers_via_a_stub_binary_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let stub = home.join("claude-stub.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}/argv.txt\n\
                 printf '%s' '{{\"mcpServers\":{{\"houston\":{{}}}}}}' > {}/.claude.json\n",
                home.display(),
                home.display()
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
        let err = run(dir.path(), Path::new("/nonexistent/claude-bin"))
            .await
            .unwrap_err();
        assert!(err.contains("/nonexistent/claude-bin"), "{err}");
        assert!(!dir.path().join(".claude.json").exists());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_reports_a_failing_add_with_its_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("claude-stub.sh");
        std::fs::write(&stub, "#!/bin/sh\necho 'boom: no auth' >&2\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = run_stub(dir.path(), &stub).await.unwrap_err();
        assert!(err.contains("exited Some(3)"), "{err}");
        assert!(err.contains("boom: no auth"), "{err}");
    }
}

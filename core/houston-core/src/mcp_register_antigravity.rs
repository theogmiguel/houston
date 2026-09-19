use std::path::Path;

// written to disk verbatim, never resolved: the daemon's port and a pane's token
// are only known at boot, so a literal value here would pin one boot's port
pub const URL_PLACEHOLDER: &str = "${HOUSTON_MCP_URL}";

pub const TOKEN_PLACEHOLDER: &str = "${HOUSTON_MCP_TOKEN}";

// marks this entry as ours, so a later run can tell "already registered" apart from
// "the user has their own houston entry" — an unmarked one is never overwritten
const MARKER_KEY: &str = "_houston";
const MARKER_VALUE: &str = "managed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    AlreadyRegistered,
    Register,
    Skip(String),
}

fn houston_entry() -> serde_json::Value {
    serde_json::json!({
        "serverUrl": URL_PLACEHOLDER,
        "headers": { "Authorization": format!("Bearer {TOKEN_PLACEHOLDER}") },
        MARKER_KEY: MARKER_VALUE,
    })
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

pub fn decide(contents: Option<&str>) -> Decision {
    let Some(text) = contents else {
        return Decision::Register;
    };
    if text.trim().is_empty() {
        return Decision::Register;
    }
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            return Decision::Skip(format!(
                "~/.gemini/config/mcp_config.json is not valid JSON ({e}); expected an object \
                 with an optional `mcpServers` object — leaving it alone"
            ));
        }
    };
    match parsed.get("mcpServers") {
        None => Decision::Register,
        Some(serde_json::Value::Object(map)) => match map.get(crate::mcp_server::SERVER_NAME) {
            None => Decision::Register,
            Some(entry) => {
                if entry.get(MARKER_KEY).and_then(|v| v.as_str()) == Some(MARKER_VALUE) {
                    Decision::AlreadyRegistered
                } else {
                    Decision::Skip(format!(
                        "~/.gemini/config/mcp_config.json already has a `{}` entry with no \
                         Houston marker — leaving it alone",
                        crate::mcp_server::SERVER_NAME
                    ))
                }
            }
        },
        Some(other) => Decision::Skip(format!(
            "~/.gemini/config/mcp_config.json `mcpServers` is {}, expected an object — leaving \
             it alone",
            kind_of(other)
        )),
    }
}

pub fn run(home: &Path) -> Result<String, String> {
    let path = home.join(".gemini").join("config").join("mcp_config.json");
    let contents = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "could not read {}: {e} — skipping Antigravity MCP self-registration",
                path.display()
            ));
        }
    };
    match decide(contents.as_deref()) {
        Decision::AlreadyRegistered => Ok(format!(
            "antigravity user-scope MCP entry `{}` already present; not touched",
            crate::mcp_server::SERVER_NAME
        )),
        Decision::Skip(reason) => Err(reason),
        Decision::Register => {
            let mut root: serde_json::Value = match &contents {
                Some(text) if !text.trim().is_empty() => serde_json::from_str(text)
                    .map_err(|e| format!("re-parsing {}: {e}", path.display()))?,
                _ => serde_json::json!({}),
            };
            let obj = root.as_object_mut().ok_or_else(|| {
                format!(
                    "{}: expected a JSON object at the top level",
                    path.display()
                )
            })?;
            let servers = obj
                .entry("mcpServers")
                .or_insert_with(|| serde_json::json!({}));
            let map = servers
                .as_object_mut()
                .ok_or_else(|| format!("{}: \"mcpServers\" is not an object", path.display()))?;
            map.insert(crate::mcp_server::SERVER_NAME.to_string(), houston_entry());
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("creating {}: {e}", dir.display()))?;
            }
            let mut out = serde_json::to_string_pretty(&root)
                .map_err(|e| format!("serializing {}: {e}", path.display()))?;
            out.push('\n');
            std::fs::write(&path, out).map_err(|e| format!("writing {}: {e}", path.display()))?;
            Ok(format!(
                "registered `{}` in antigravity user scope (flagless `agy` in Houston panes now \
                 connects) — smoke-test pending, see google-antigravity/antigravity-cli#25",
                crate::mcp_server::SERVER_NAME
            ))
        }
    }
}

pub fn spawn_at_boot() {
    tokio::task::spawn_blocking(|| {
        let home = match crate::agent_hooks::ConfigHome::from_env() {
            Ok(h) => h.home,
            Err(e) => {
                tracing::warn!("antigravity mcp self-registration: no home dir ({e}); skipped");
                return;
            }
        };
        match run(&home) {
            Ok(outcome) => tracing::info!("antigravity mcp self-registration: {outcome}"),
            Err(reason) => tracing::warn!("antigravity mcp self-registration: {reason}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_file_means_register() {
        assert_eq!(decide(None), Decision::Register);
    }

    #[test]
    fn empty_file_means_register() {
        assert_eq!(decide(Some("")), Decision::Register);
    }

    #[test]
    fn json_without_mcp_servers_means_register() {
        assert_eq!(decide(Some(r#"{"otherKey":1}"#)), Decision::Register);
    }

    #[test]
    fn other_servers_only_means_register() {
        let text = r#"{"mcpServers":{"github":{"serverUrl":"https://api.github.com/mcp/"}}}"#;
        assert_eq!(decide(Some(text)), Decision::Register);
    }

    #[test]
    fn our_marked_entry_is_already_registered() {
        let text = format!(
            r#"{{"mcpServers":{{"houston":{{"serverUrl":"x","headers":{{}},"{MARKER_KEY}":"{MARKER_VALUE}"}}}}}}"#
        );
        assert_eq!(decide(Some(&text)), Decision::AlreadyRegistered);
    }

    #[test]
    fn a_houston_entry_with_no_marker_is_skipped_and_named() {
        let text = r#"{"mcpServers":{"houston":{"serverUrl":"https://example.com/mcp"}}}"#;
        match decide(Some(text)) {
            Decision::Skip(reason) => assert!(reason.contains("no Houston marker"), "{reason}"),
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_json_is_skipped_and_named() {
        match decide(Some("{ not json")) {
            Decision::Skip(reason) => assert!(reason.contains("not valid JSON"), "{reason}"),
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn a_non_object_mcp_servers_key_is_skipped_and_named() {
        match decide(Some(r#"{"mcpServers":[1,2]}"#)) {
            Decision::Skip(reason) => assert!(reason.contains("an array"), "{reason}"),
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn run_writes_the_entry_and_keeps_other_servers_and_top_level_keys() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let config_dir = home.join(".gemini").join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("mcp_config.json"),
            r#"{"mcpServers":{"github":{"serverUrl":"https://api.github.com/mcp/"}},"userNote":"keep me"}"#,
        )
        .unwrap();

        let outcome = run(home).unwrap();
        assert!(outcome.contains("registered"), "{outcome}");

        let text = std::fs::read_to_string(config_dir.join("mcp_config.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["userNote"], "keep me");
        assert_eq!(
            parsed["mcpServers"]["github"]["serverUrl"],
            "https://api.github.com/mcp/"
        );
        let houston = &parsed["mcpServers"]["houston"];
        assert_eq!(houston["serverUrl"], URL_PLACEHOLDER);
        assert_eq!(
            houston["headers"]["Authorization"],
            format!("Bearer {TOKEN_PLACEHOLDER}")
        );
        assert_eq!(houston[MARKER_KEY], MARKER_VALUE);
        assert!(
            !text.contains("127.0.0.1"),
            "a literal address in the persisted entry would pin one boot's port: {text}"
        );

        let second = run(home).unwrap();
        assert!(second.contains("already present"), "{second}");
    }

    #[test]
    fn run_creates_the_directory_and_file_when_neither_exists() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = run(dir.path()).unwrap();
        assert!(outcome.contains("registered"), "{outcome}");
        assert!(dir
            .path()
            .join(".gemini")
            .join("config")
            .join("mcp_config.json")
            .exists());
    }

    #[test]
    fn run_never_writes_behind_a_foreign_houston_entry() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let config_dir = home.join(".gemini").join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let original = r#"{"mcpServers":{"houston":{"serverUrl":"my-own-thing"}}}"#;
        std::fs::write(config_dir.join("mcp_config.json"), original).unwrap();

        let err = run(home).unwrap_err();
        assert!(err.contains("no Houston marker"), "{err}");
        assert_eq!(
            std::fs::read_to_string(config_dir.join("mcp_config.json")).unwrap(),
            original,
            "a refusal writes nothing"
        );
    }
}

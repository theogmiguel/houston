//! Boot-time removal of the configuration Houston wrote for Cursor and Grok, which are
//! recognised-only now. Only Houston-owned entries go; anything the user wrote or
//! changed stays and is reported by name.
use crate::agent_hooks::{atomic_config_write, ConfigHome};
use std::path::Path;

/// What Grok's `mcp add` stored: placeholders, so the entry never carried a port.
const GROK_URL_PLACEHOLDER: &str = "${HOUSTON_MCP_URL}";
const GROK_AUTHORIZATION: &str = "Bearer ${HOUSTON_MCP_TOKEN}";

/// Cursor's `mcp.json` is strict JSON, so Houston marked its entry with a sibling key.
const CURSOR_MARKER_KEY: &str = "_houston";
const CURSOR_MARKER_VALUE: &str = "managed";

const TRUST_OPEN: &str = "# >>> houston managed worktree trust >>>";
const TRUST_CLOSE: &str = "# <<< houston managed worktree trust <<<";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// One line per Houston-owned entry taken out.
    pub removed: Vec<String>,
    /// One line per entry left in place, with the reason.
    pub left: Vec<String>,
    /// False when the Cursor MCP manager entries could not be settled, so the daemon keeps
    /// its record of them for the next boot.
    pub cursor_mcp_settled: bool,
}

/// Removes Houston's Cursor and Grok configuration under `home`. `sentinel` is this
/// channel's hook marker; `cursor_managed_servers` are the names the MCP manager synced
/// into Cursor. Idempotent: a second run finds nothing to remove.
pub fn cleanup(home: &ConfigHome, sentinel: &str, cursor_managed_servers: &[String]) -> Outcome {
    let root = home.home.as_path();
    let mut outcome = Outcome {
        cursor_mcp_settled: true,
        ..Outcome::default()
    };
    let cursor_hooks = root.join(".cursor").join("hooks.json");
    hook_entries(
        &mut outcome,
        &cursor_hooks,
        crate::agent_hooks::cursor_uninstall(&cursor_hooks, sentinel),
    );
    let grok_hooks = root.join(".grok").join("hooks").join("houston.json");
    hook_entries(
        &mut outcome,
        &grok_hooks,
        crate::agent_hooks::nested_hooks_uninstall(&grok_hooks, sentinel),
    );
    cursor_mcp(&mut outcome, root, cursor_managed_servers);
    grok_mcp(&mut outcome, root);
    grok_trust(&mut outcome, root);
    outcome
}

/// The boot pass: reads the MCP manager's record for Cursor, cleans, logs, and clears that
/// record once the entries it named are gone.
pub fn sweep(db: &crate::db::Db, env: &crate::host_env::HostEnv, sentinel: &str) {
    let home = match ConfigHome::from_env(env) {
        Ok(home) => home,
        Err(error) => {
            tracing::warn!("retired provider cleanup skipped: {error:#}");
            return;
        }
    };
    let owned = db.mcp_managed_names("cursor").unwrap_or_default();
    let outcome = cleanup(&home, sentinel, &owned);
    for line in &outcome.removed {
        tracing::info!("retired provider cleanup: removed {line}");
    }
    for line in &outcome.left {
        tracing::warn!("retired provider cleanup: left {line}");
    }
    if outcome.cursor_mcp_settled && !owned.is_empty() {
        if let Err(error) = db.set_mcp_managed("cursor", &[]) {
            tracing::warn!("clearing the MCP manager's Cursor record: {error}");
        }
    }
}

fn hook_entries(outcome: &mut Outcome, path: &Path, result: anyhow::Result<bool>) {
    match result {
        Ok(true) => outcome
            .removed
            .push(format!("Houston hook entries from {}", path.display())),
        Ok(false) => {}
        Err(error) => outcome.left.push(format!(
            "{}: Houston hook entries not removed: {error:#}",
            path.display()
        )),
    }
}

fn read(path: &Path, outcome: &mut Outcome) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            outcome
                .left
                .push(format!("{}: cannot read it: {error}", path.display()));
            None
        }
    }
}

fn cursor_mcp(outcome: &mut Outcome, root: &Path, managed_servers: &[String]) {
    let path = root.join(".cursor").join("mcp.json");
    let Some(text) = read(&path, outcome) else {
        outcome.cursor_mcp_settled = !path.exists();
        return;
    };
    let mut parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            outcome.left.push(format!(
                "{}: not valid JSON ({error}); Houston's entry, if any, stays",
                path.display()
            ));
            outcome.cursor_mcp_settled = false;
            return;
        }
    };
    let Some(servers) = parsed
        .get_mut("mcpServers")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let mut changed = false;
    let name = crate::mcp_server::SERVER_NAME;
    match servers.get(name) {
        Some(entry)
            if entry
                .get(CURSOR_MARKER_KEY)
                .and_then(serde_json::Value::as_str)
                == Some(CURSOR_MARKER_VALUE) =>
        {
            servers.remove(name);
            changed = true;
            outcome
                .removed
                .push(format!("`{name}` MCP entry from {}", path.display()));
        }
        Some(_) => outcome.left.push(format!(
            "{}: `{name}` has no Houston marker ({CURSOR_MARKER_KEY}: {CURSOR_MARKER_VALUE:?})",
            path.display()
        )),
        None => {}
    }
    for managed in managed_servers {
        if managed != name && servers.remove(managed).is_some() {
            changed = true;
            outcome.removed.push(format!(
                "MCP manager entry `{managed}` from {}",
                path.display()
            ));
        }
    }
    if !changed {
        return;
    }
    let mut out = serde_json::to_string_pretty(&parsed).expect("a parsed JSON value serialises");
    out.push('\n');
    if let Err(error) = atomic_config_write(&path, out) {
        outcome
            .left
            .push(format!("{}: write failed: {error:#}", path.display()));
        outcome.cursor_mcp_settled = false;
    }
}

fn grok_mcp(outcome: &mut Outcome, root: &Path) {
    let path = root.join(".grok").join("config.toml");
    let Some(text) = read(&path, outcome) else {
        return;
    };
    let mut document = match text.parse::<toml_edit::DocumentMut>() {
        Ok(document) => document,
        Err(error) => {
            outcome.left.push(format!(
                "{}: not valid TOML ({error}); Houston's entry, if any, stays",
                path.display()
            ));
            return;
        }
    };
    let name = crate::mcp_server::SERVER_NAME;
    let Some(servers) = document
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_like_mut)
    else {
        return;
    };
    let Some(entry) = servers.get(name) else {
        return;
    };
    let text_of =
        |item: Option<&toml_edit::Item>| item.and_then(|i| i.as_str()).map(str::to_string);
    let url = text_of(entry.get("url"));
    let authorization = text_of(
        entry
            .get("headers")
            .and_then(|headers| headers.get("Authorization")),
    );
    if url.as_deref() != Some(GROK_URL_PLACEHOLDER)
        || authorization.as_deref() != Some(GROK_AUTHORIZATION)
    {
        outcome.left.push(format!(
            "{}: [mcp_servers.{name}] is not the entry Houston wrote (url {url:?}, Authorization {}); expected url {GROK_URL_PLACEHOLDER:?} and Authorization {GROK_AUTHORIZATION:?}",
            path.display(),
            if authorization.is_some() { "differs" } else { "absent" },
        ));
        return;
    }
    servers.remove(name);
    if servers.is_empty() {
        document.remove("mcp_servers");
    }
    match atomic_config_write(&path, document.to_string()) {
        Ok(()) => outcome
            .removed
            .push(format!("[mcp_servers.{name}] from {}", path.display())),
        Err(error) => outcome
            .left
            .push(format!("{}: write failed: {error:#}", path.display())),
    }
}

fn grok_trust(outcome: &mut Outcome, root: &Path) {
    let path = root.join(".grok").join("trusted_folders.toml");
    let Some(text) = read(&path, outcome) else {
        return;
    };
    if !text.contains(TRUST_OPEN) {
        return;
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut blocks = 0usize;
    let mut inside = false;
    for line in text.lines() {
        if !inside && line.trim() == TRUST_OPEN {
            inside = true;
            blocks += 1;
            // Houston wrote each block after a blank separator line.
            if kept.last().is_some_and(|l| l.trim().is_empty()) {
                kept.pop();
            }
        } else if inside {
            inside = line.trim() != TRUST_CLOSE;
        } else {
            kept.push(line);
        }
    }
    if inside {
        outcome.left.push(format!(
            "{}: a Houston trust block opens without a closing marker; expected {TRUST_CLOSE:?}",
            path.display()
        ));
        return;
    }
    let mut cleaned = kept.join("\n");
    if !cleaned.is_empty() {
        cleaned.push('\n');
    }
    if let Err(error) = cleaned.parse::<toml_edit::DocumentMut>() {
        outcome.left.push(format!(
            "{}: not rewritten, the result would not parse as TOML: {error}",
            path.display()
        ));
        return;
    }
    let written = if cleaned.trim().is_empty() {
        std::fs::remove_file(&path).map_err(anyhow::Error::from)
    } else {
        atomic_config_write(&path, cleaned)
    };
    match written {
        Ok(()) => outcome.removed.push(format!(
            "{blocks} worktree trust block(s) from {}",
            path.display()
        )),
        Err(error) => outcome
            .left
            .push(format!("{}: write failed: {error:#}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_grok_placeholders_are_the_variables_panes_exported() {
        assert_eq!(
            super::GROK_URL_PLACEHOLDER,
            format!("${{{}}}", crate::mcp_launch::URL_ENV)
        );
        assert_eq!(
            super::GROK_AUTHORIZATION,
            format!("Bearer ${{{}}}", crate::mcp_launch::CODEX_TOKEN_ENV)
        );
    }
}

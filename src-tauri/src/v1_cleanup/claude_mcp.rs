//! v1 registered a user-scope Claude MCP server named `houston` whose URL and token are
//! placeholders a v1 pane filled. It is removed only through `claude mcp remove`:
//! `~/.claude.json` is Claude's own state and Houston never writes it.

use crate::sys::host_env::HostEnv;
use std::path::Path;
use std::time::Duration;

const SERVER_NAME: &str = "houston";
const URL_PLACEHOLDER: &str = "${HOUSTON_MCP_URL}";
const TOKEN_PLACEHOLDER: &str = "${HOUSTON_MCP_TOKEN}";
// Bounds one CLI start on a loaded machine; the cleanup thread waits for nothing else.
const REMOVE_TIMEOUT: Duration = Duration::from_secs(15);

/// Only the exact entry v1 wrote; any other shape under that name is the user's.
fn is_v1_entry(text: &str) -> bool {
    let Ok(config) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(server) = config["mcpServers"][SERVER_NAME].as_object() else {
        return false;
    };
    let Some(headers) = server.get("headers").and_then(serde_json::Value::as_object) else {
        return false;
    };
    server.len() == 3
        && server.get("type").and_then(serde_json::Value::as_str) == Some("http")
        && server.get("url").and_then(serde_json::Value::as_str) == Some(URL_PLACEHOLDER)
        && headers.len() == 1
        && headers
            .get("Authorization")
            .and_then(serde_json::Value::as_str)
            == Some(format!("Bearer {TOKEN_PLACEHOLDER}").as_str())
}

/// The log line for what happened, `None` when there was nothing to do.
pub fn remove(claude_json: &Path, env: &HostEnv) -> Option<String> {
    let text = std::fs::read_to_string(claude_json).ok()?;
    if !is_v1_entry(&text) {
        return None;
    }
    let Some(claude) = crate::sys::exe_path::resolve_in(env, "claude") else {
        return Some(format!(
            "left the v1 Claude MCP entry `{SERVER_NAME}` in {}: the `claude` CLI is not on \
             PATH, and Houston removes the entry only through `claude mcp remove`",
            claude_json.display()
        ));
    };
    let mut cmd = crate::sys::spawn::command(&claude);
    cmd.args(["mcp", "remove", "--scope", "user", SERVER_NAME]);
    Some(
        match crate::sys::spawn::output_within(cmd, REMOVE_TIMEOUT) {
            Ok(Some(out)) if out.status.success() => format!(
                "removed the v1 Claude MCP entry `{SERVER_NAME}` through `claude mcp remove`"
            ),
            Ok(Some(out)) => format!(
                "`{} mcp remove --scope user {SERVER_NAME}` exited {:?}: {}",
                claude.display(),
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Ok(None) => format!(
                "`{} mcp remove` did not finish within {} s and was stopped",
                claude.display(),
                REMOVE_TIMEOUT.as_secs()
            ),
            Err(e) => format!("could not run `{}`: {e}", claude.display()),
        },
    )
}

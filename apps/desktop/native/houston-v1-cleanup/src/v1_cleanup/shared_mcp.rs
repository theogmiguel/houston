//! v1's Codex and Antigravity MCP entries named `houston`. Like Claude's they carry no
//! channel marker, so `run` removes them only while no other channel's v1 daemon is live.

use super::files;
use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::path::Path;

const NAME: &str = "houston";
const CODEX_TOKEN_ENV: &str = "HOUSTON_MCP_TOKEN";
const CODEX_TIMEOUT_OPEN: &str = "# >>> houston managed (codex timeout) >>>";
const CODEX_TIMEOUT_CLOSE: &str = "# <<< houston managed (codex timeout) <<<";
/// The keys `codex mcp add` and v1's timeout block wrote.
const CODEX_KEYS: [&str; 3] = ["url", "bearer_token_env_var", "tool_timeout_sec"];

fn is_loopback_endpoint(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/mcp"))
        .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// `mcp_servers.houston` when it points at v1's loopback endpoint with v1's token variable.
fn codex_entry(root: &toml::Value) -> Option<&toml::Table> {
    let entry = root.get("mcp_servers")?.get(NAME)?.as_table()?;
    let url = entry.get("url")?.as_str()?;
    let token = entry.get("bearer_token_env_var")?.as_str()?;
    (is_loopback_endpoint(url) && token == CODEX_TOKEN_ENV).then_some(entry)
}

pub fn codex_present(path: &Path) -> bool {
    let Ok(Some(text)) = files::read(path) else {
        return false;
    };
    text.parse::<toml::Value>()
        .is_ok_and(|root| codex_entry(&root).is_some())
}

/// The `[mcp_servers.houston]` table leaves as text, so the file keeps its other bytes and
/// its line endings; the result must parse to the original minus that entry.
pub fn codex(path: &Path) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let root: toml::Value = text.parse().map_err(|e| anyhow!("not valid TOML: {e}"))?;
    let Some(entry) = codex_entry(&root) else {
        return Ok(false);
    };
    let foreign: Vec<&str> = entry
        .keys()
        .map(String::as_str)
        .filter(|k| !CODEX_KEYS.contains(k))
        .collect();
    if !foreign.is_empty() {
        bail!(
            "its v1 `mcp_servers.{NAME}` entry also holds keys v1 did not write ({}); left as is",
            foreign.join(", ")
        );
    }
    let out = without_codex_table(&text);
    let mut expected = root.clone();
    if let Some(servers) = expected
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
    {
        servers.remove(NAME);
    }
    let mut result: toml::Value = out.parse().map_err(|e| {
        anyhow!("removing `mcp_servers.{NAME}` would leave invalid TOML ({e}); left as is")
    })?;
    drop_empty_servers(&mut expected);
    drop_empty_servers(&mut result);
    if result != expected {
        bail!("`[mcp_servers.{NAME}]` is not a table of its own lines; left as is");
    }
    files::atomic_write(path, out.as_bytes())?;
    Ok(true)
}

fn drop_empty_servers(root: &mut toml::Value) {
    let Some(table) = root.as_table_mut() else {
        return;
    };
    if table
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .is_some_and(toml::Table::is_empty)
    {
        table.remove("mcp_servers");
    }
}

fn header(line: &str) -> Option<String> {
    let line = line.trim();
    let inner = line.strip_prefix('[')?;
    let end = inner.find(']')?;
    Some(
        inner[..end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect(),
    )
}

/// Drops the header line through the table's last key or marker line, and the blank line
/// before it when one would otherwise be doubled.
fn without_codex_table(text: &str) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let wanted = format!("mcp_servers.{NAME}");
    let Some(start) = lines
        .iter()
        .position(|l| header(l).as_deref() == Some(wanted.as_str()))
    else {
        return text.to_string();
    };
    let end = lines[start + 1..]
        .iter()
        .position(|l| l.trim_start().starts_with('['))
        .map_or(lines.len(), |i| start + 1 + i);
    let last = (start + 1..end)
        .rev()
        .find(|&i| {
            let t = lines[i].trim();
            t == CODEX_TIMEOUT_OPEN
                || t == CODEX_TIMEOUT_CLOSE
                || (!t.is_empty() && !t.starts_with('#'))
        })
        .unwrap_or(start);
    let blank = |i: usize| lines.get(i).is_none_or(|l| l.trim().is_empty());
    let first = if start > 0 && blank(start - 1) && blank(last + 1) {
        start - 1
    } else {
        start
    };
    lines[..first]
        .iter()
        .chain(&lines[last + 1..])
        .copied()
        .collect()
}

fn antigravity_entry_is_ours(root: &Value) -> bool {
    root.get("mcpServers")
        .and_then(|s| s.get(NAME))
        .and_then(|e| e.get("_houston"))
        .and_then(Value::as_str)
        == Some("managed")
}

pub fn antigravity_present(path: &Path) -> bool {
    let Ok(Some(text)) = files::read(path) else {
        return false;
    };
    files::parse_json(&text).is_ok_and(|root| antigravity_entry_is_ours(&root))
}

/// The entry v1 marked `"_houston": "managed"` leaves, then an emptied `mcpServers`.
pub fn antigravity(path: &Path) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let mut root = files::parse_json(&text)?;
    if !antigravity_entry_is_ours(&root) {
        return Ok(false);
    }
    let obj = root
        .as_object_mut()
        .expect("an object holds the marked entry");
    let servers = obj
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .expect("an object holds the marked entry");
    servers.remove(NAME);
    if servers.is_empty() {
        obj.remove("mcpServers");
    }
    super::providers::write_or_remove(path, &root)
}

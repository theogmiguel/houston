//! ZCode reads hooks and plugin directories from one strict JSON file. Houston's
//! hook entries carry the channel sentinel and its plugin directory lives in the
//! channel's state dir, so each channel installs and removes only its own entries.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".zcode").join("cli").join("config.json")
}

/// The plugin directory below a channel's state dir that carries Houston's MCP server.
pub const PLUGIN_DIR: &str = "zcode-plugin";

// ZCode runs no hook unless `hooks.enabled` is true. The value Houston replaced is
// parked at the top level (ZCode keeps unknown top-level keys), shared by every
// channel, and restored once no channel's entry remains. `null` records "absent".
pub const PARKED_ENABLED_KEY: &str = "houstonParkedHooksEnabled";

// A PreToolUse hook spawns a process per tool call; only this tool asks the operator.
const PRE_TOOL_USE_MATCHER: &str = "AskUserQuestion";

// ZCode applies `timeoutMs` to each tool call. Houston's 600s `pane_wait` default
// plus the transport margin Codex and OpenCode receive.
const MCP_TOOL_TIMEOUT_MS: u64 = crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC * 1_000;

pub fn plugin_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(PLUGIN_DIR)
}

/// ZCode expands only `${ZCODE_*}` variables in an MCP URL, and any variable in its
/// headers. The name carries the channel so another channel's plugin stays unresolved
/// (and therefore unregistered) in this channel's panes.
pub fn url_env(channel: Option<&str>) -> String {
    match channel {
        None => "ZCODE_HOUSTON_MCP_URL".to_string(),
        Some(c) => format!(
            "ZCODE_HOUSTON_MCP_URL_{}",
            c.to_ascii_uppercase().replace('-', "_")
        ),
    }
}

pub fn plugin_name(channel: Option<&str>) -> String {
    match channel {
        None => crate::mcp_server::SERVER_NAME.to_string(),
        Some(c) => format!("{}-{c}", crate::mcp_server::SERVER_NAME),
    }
}

/// Writes the Houston-owned plugin: a manifest and one HTTP MCP server whose URL and
/// bearer token are placeholders the pane's environment fills, so no credential or
/// port is ever written to disk and the files never go stale.
pub fn write_plugin(state_dir: &Path, channel: Option<&str>) -> Result<PathBuf> {
    let root = plugin_dir(state_dir);
    let manifest_dir = root.join(".zcode-plugin");
    std::fs::create_dir_all(&manifest_dir)
        .with_context(|| format!("creating {}", manifest_dir.display()))?;
    let manifest = json!({
        "name": plugin_name(channel),
        "description": "Houston pane orchestration tools; resolves only inside a Houston pane",
    });
    let servers = json!({
        "mcpServers": {
            crate::mcp_server::SERVER_NAME: {
                "type": "http",
                "url": format!("${{{}}}", url_env(channel)),
                "headers": {
                    "Authorization": format!("Bearer ${{{}}}", crate::mcp_launch::CODEX_TOKEN_ENV),
                },
                "timeoutMs": MCP_TOOL_TIMEOUT_MS,
            }
        }
    });
    write_json(&manifest_dir.join("plugin.json"), &manifest)?;
    write_json(&root.join(".mcp.json"), &servers)?;
    Ok(root)
}

pub fn remove_plugin(state_dir: &Path) -> Result<()> {
    let root = plugin_dir(state_dir);
    match std::fs::remove_dir_all(&root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", root.display())),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut out = serde_json::to_string_pretty(value)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))
}

fn read_root(path: &Path) -> Result<Option<Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root: Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "{} is not valid JSON (ZCode accepts strict JSON only) — refusing to rewrite it",
            path.display()
        )
    })?;
    if !root.is_object() {
        bail!(
            "{}: expected a JSON object at the top level, found {}",
            path.display(),
            shape(&root)
        );
    }
    Ok(Some(root))
}

fn shape(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn child_object<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
    path: &Path,
    label: &str,
) -> Result<&'a mut Map<String, Value>> {
    let value = parent.entry(key.to_string()).or_insert_with(|| json!({}));
    let found = shape(value);
    value.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{}: \"{label}\" is {found}, expected an object",
            path.display()
        )
    })
}

fn group_commands(group: &Value) -> impl Iterator<Item = &str> {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .into_iter()
        .flatten()
        .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
}

fn group_is_ours(group: &Value, sentinel: &str) -> bool {
    group_commands(group).any(|c| crate::agent_hooks::has_sentinel(c, sentinel))
}

fn group_is_any_houston(group: &Value) -> bool {
    group_commands(group).any(crate::agent_hooks::has_any_sentinel)
}

/// The state-dir name a sentinel belongs to: `.houston` or `.houston-<channel>`.
fn state_dir_name(sentinel: &str) -> Option<String> {
    let rest = sentinel.strip_prefix(crate::claude_hooks::SENTINEL)?;
    match rest.strip_prefix('=') {
        None if rest.is_empty() => Some(crate::paths::BASE_DIR.to_string()),
        Some(channel) if !channel.is_empty() => {
            Some(format!("{}-{channel}", crate::paths::BASE_DIR))
        }
        _ => None,
    }
}

fn plugin_entry_is_ours(entry: &Value, sentinel: &str) -> bool {
    let Some(dir) = entry.as_str().map(Path::new) else {
        return false;
    };
    dir.file_name().is_some_and(|n| n == PLUGIN_DIR)
        && dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .zip(state_dir_name(sentinel))
            .is_some_and(|(found, want)| found == want)
}

fn remove_our_groups(events: &mut Map<String, Value>, sentinel: &str) -> bool {
    let mut removed = false;
    let mut emptied = Vec::new();
    for (event, value) in events.iter_mut() {
        let Some(arr) = value.as_array_mut() else {
            continue;
        };
        let before = arr.len();
        arr.retain(|g| !group_is_ours(g, sentinel));
        removed |= arr.len() != before;
        if arr.is_empty() && before > 0 {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        events.remove(&event);
    }
    removed
}

pub fn install(
    path: &Path,
    commands: &[(&str, String)],
    sentinel: &str,
    plugin_dir: Option<&Path>,
) -> Result<()> {
    let mut root = read_root(path)?.unwrap_or_else(|| json!({}));
    let obj = root.as_object_mut().expect("read_root returns an object");
    let enabled_before = match obj.get("hooks").and_then(|h| h.get("enabled")) {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(other) => bail!(
            "{}: \"hooks.enabled\" is {}, expected a boolean",
            path.display(),
            shape(other)
        ),
    };
    let hooks = child_object(obj, "hooks", path, "hooks")?;
    let events = child_object(hooks, "events", path, "hooks.events")?;
    if let Some((event, _)) = events.iter().find(|(_, v)| !v.is_array()) {
        bail!(
            "{}: \"hooks.events.{event}\" is {}, expected an array",
            path.display(),
            shape(&events[event])
        );
    }
    remove_our_groups(events, sentinel);
    for (event, command) in commands {
        let mut group = json!({ "hooks": [{ "type": "command", "command": command }] });
        if *event == "PreToolUse" {
            group["matcher"] = json!(PRE_TOOL_USE_MATCHER);
        }
        events
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("checked above")
            .push(group);
    }
    hooks.insert("enabled".to_string(), json!(true));
    if enabled_before != Some(true) && !obj.contains_key(PARKED_ENABLED_KEY) {
        obj.insert(
            PARKED_ENABLED_KEY.to_string(),
            enabled_before.map_or(Value::Null, Value::Bool),
        );
    }
    if let Some(dir) = plugin_dir {
        let plugins = child_object(obj, "plugins", path, "plugins")?;
        let dirs = plugins
            .entry("dirs".to_string())
            .or_insert_with(|| json!([]));
        let found = shape(dirs);
        let dirs = dirs.as_array_mut().ok_or_else(|| {
            anyhow!(
                "{}: \"plugins.dirs\" is {found}, expected an array",
                path.display()
            )
        })?;
        let dir = dir.display().to_string();
        dirs.retain(|d| !plugin_entry_is_ours(d, sentinel) || d.as_str() == Some(dir.as_str()));
        if !dirs.iter().any(|d| d.as_str() == Some(dir.as_str())) {
            dirs.push(json!(dir));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {} for a hook install", parent.display()))?;
    }
    write_json(path, &root)
}

pub fn uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let Some(mut root) = read_root(path)? else {
        return Ok(false);
    };
    let obj = root.as_object_mut().expect("read_root returns an object");
    let mut changed = false;
    let mut houston_left = false;
    if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        if let Some(events) = hooks.get_mut("events").and_then(|e| e.as_object_mut()) {
            changed |= remove_our_groups(events, sentinel);
            houston_left = events
                .values()
                .filter_map(|v| v.as_array())
                .flatten()
                .any(group_is_any_houston);
            if events.is_empty() {
                hooks.remove("events");
            }
        }
    }
    if let Some(plugins) = obj.get_mut("plugins").and_then(|p| p.as_object_mut()) {
        if let Some(dirs) = plugins.get_mut("dirs").and_then(|d| d.as_array_mut()) {
            let before = dirs.len();
            dirs.retain(|d| !plugin_entry_is_ours(d, sentinel));
            if dirs.len() != before {
                changed = true;
                if dirs.is_empty() {
                    plugins.remove("dirs");
                }
            }
        }
        if plugins.is_empty() {
            obj.remove("plugins");
        }
    }
    if !houston_left {
        if let Some(parked) = obj.remove(PARKED_ENABLED_KEY) {
            changed = true;
            if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
                match parked {
                    Value::Bool(b) => {
                        hooks.insert("enabled".to_string(), Value::Bool(b));
                    }
                    _ => {
                        hooks.remove("enabled");
                    }
                }
                if hooks.is_empty() {
                    obj.remove("hooks");
                }
            }
        }
    }
    if !changed {
        return Ok(false);
    }
    write_json(path, &root)?;
    Ok(true)
}

pub fn is_installed(path: &Path, sentinel: &str) -> bool {
    let Ok(Some(root)) = read_root(path) else {
        return false;
    };
    root.get("hooks")
        .and_then(|h| h.get("events"))
        .and_then(|e| e.as_object())
        .is_some_and(|events| {
            events
                .values()
                .filter_map(|v| v.as_array())
                .flatten()
                .any(|g| group_is_ours(g, sentinel))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_hooks::{self, ConfigHome};
    use houston_protocol::AgentKind::Zcode;

    const DEV: &str = "--houston-managed=dev";
    const RELEASE: &str = "--houston-managed";

    fn home(dir: &tempfile::TempDir) -> ConfigHome {
        ConfigHome {
            home: dir.path().to_path_buf(),
            xdg_config: None,
        }
    }

    fn launcher(state: &str) -> PathBuf {
        PathBuf::from(format!("/home/dev/{state}/bin/claude-hook"))
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).expect("config exists"))
            .expect("config stays valid JSON")
    }

    fn houston_groups(root: &Value, sentinel: &str) -> usize {
        root["hooks"]["events"]
            .as_object()
            .map(|events| {
                events
                    .values()
                    .filter_map(|v| v.as_array())
                    .flatten()
                    .filter(|g| group_is_ours(g, sentinel))
                    .count()
            })
            .unwrap_or(0)
    }

    const USER_CONFIG: &str = r#"{
  "mcp": { "servers": { "docs": { "type": "http", "url": "https://example.test/mcp" } } },
  "plugins": { "dirs": ["/home/u/my-plugin"] },
  "hooks": {
    "enabled": false,
    "events": { "Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }] }
  }
}
"#;

    #[test]
    fn install_keeps_user_entries_and_uninstall_restores_hooks_enabled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = agent_hooks::config_path(Zcode, &h).expect("path");
        assert!(
            path.ends_with(".zcode/cli/config.json"),
            "{}",
            path.display()
        );
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, USER_CONFIG).expect("write");

        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        let root = read(&path);
        assert_eq!(root["hooks"]["enabled"], json!(true));
        assert_eq!(root[PARKED_ENABLED_KEY], json!(false));
        let events = crate::agent_events::events_for(Zcode).len()
            + crate::agent_events::ZCODE_CORRELATION_EVENTS.len();
        assert_eq!(houston_groups(&root, DEV), events, "{root}");
        assert_eq!(
            root["hooks"]["events"]["PreToolUse"][0]["matcher"],
            json!("AskUserQuestion")
        );
        assert_eq!(
            root["hooks"]["events"]["Stop"][0]["hooks"][0]["command"],
            json!("notify-send done"),
            "the user's own Stop hook stays first"
        );
        assert_eq!(
            root["plugins"]["dirs"],
            json!(["/home/u/my-plugin", "/home/dev/.houston-dev/zcode-plugin"])
        );
        assert_eq!(root["mcp"]["servers"]["docs"]["type"], json!("http"));
        assert!(agent_hooks::is_installed(Zcode, &h, DEV));
        assert!(!agent_hooks::is_installed(Zcode, &h, RELEASE));

        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("reinstall");
        let again = read(&path);
        assert_eq!(
            houston_groups(&again, DEV),
            events,
            "a reinstall replaces, never adds"
        );
        assert_eq!(
            again[PARKED_ENABLED_KEY],
            json!(false),
            "the original value stays parked"
        );
        assert_eq!(again["plugins"]["dirs"].as_array().map(Vec::len), Some(2));

        assert!(agent_hooks::uninstall(Zcode, &h, DEV).expect("uninstall"));
        let original: Value = serde_json::from_str(USER_CONFIG).expect("fixture parses");
        assert_eq!(
            read(&path),
            original,
            "uninstall returns the file to the user's own"
        );
        assert!(!agent_hooks::is_installed(Zcode, &h, DEV));
        assert!(
            !agent_hooks::uninstall(Zcode, &h, DEV).expect("second uninstall"),
            "a second uninstall removes nothing and says so"
        );
    }

    #[test]
    fn an_absent_enabled_key_is_removed_again_and_an_enabled_one_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path =
            agent_hooks::install(Zcode, &h, &launcher(".houston"), RELEASE).expect("install");
        assert_eq!(read(&path)[PARKED_ENABLED_KEY], Value::Null);
        assert!(agent_hooks::uninstall(Zcode, &h, RELEASE).expect("uninstall"));
        assert_eq!(
            read(&path),
            json!({}),
            "nothing of Houston's is left behind"
        );

        std::fs::write(&path, r#"{"hooks":{"enabled":true}}"#).expect("write");
        agent_hooks::install(Zcode, &h, &launcher(".houston"), RELEASE).expect("install");
        assert!(read(&path).get(PARKED_ENABLED_KEY).is_none());
        assert!(agent_hooks::uninstall(Zcode, &h, RELEASE).expect("uninstall"));
        assert_eq!(read(&path), json!({"hooks": {"enabled": true}}));
    }

    #[test]
    fn hooks_stay_enabled_until_the_last_channel_uninstalls() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = agent_hooks::config_path(Zcode, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, r#"{"hooks":{"enabled":false}}"#).expect("write");
        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("dev");
        agent_hooks::install(Zcode, &h, &launcher(".houston"), RELEASE).expect("release");
        let both = read(&path);
        assert!(houston_groups(&both, DEV) > 0 && houston_groups(&both, RELEASE) > 0);
        assert_eq!(both["plugins"]["dirs"].as_array().map(Vec::len), Some(2));

        assert!(agent_hooks::uninstall(Zcode, &h, DEV).expect("dev uninstall"));
        let release_only = read(&path);
        assert_eq!(houston_groups(&release_only, DEV), 0);
        assert!(
            houston_groups(&release_only, RELEASE) > 0,
            "release keeps its entries"
        );
        assert_eq!(release_only["hooks"]["enabled"], json!(true));
        assert_eq!(
            release_only["plugins"]["dirs"],
            json!(["/home/dev/.houston/zcode-plugin"])
        );

        assert!(agent_hooks::uninstall(Zcode, &h, RELEASE).expect("release uninstall"));
        assert_eq!(read(&path), json!({"hooks": {"enabled": false}}));
    }

    #[test]
    fn a_config_zcode_would_reject_is_refused_and_left_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = agent_hooks::config_path(Zcode, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        for (original, named) in [
            (
                "{ \"hooks\": { // comments are not JSON\n } }",
                "not valid JSON",
            ),
            ("[]", "expected a JSON object"),
            (
                r#"{"hooks":{"enabled":"yes"}}"#,
                "\"hooks.enabled\" is a string",
            ),
            (
                r#"{"hooks":{"events":{"Stop":{}}}}"#,
                "\"hooks.events.Stop\" is an object",
            ),
            (
                r#"{"plugins":{"dirs":"/x"}}"#,
                "\"plugins.dirs\" is a string",
            ),
        ] {
            std::fs::write(&path, original).expect("write");
            let err = agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV)
                .expect_err("must refuse");
            assert!(format!("{err:#}").contains(named), "{named}: {err:#}");
            assert_eq!(std::fs::read_to_string(&path).expect("read"), original);
        }
        std::fs::write(&path, "{ not json").expect("write");
        let err = agent_hooks::uninstall(Zcode, &h, DEV).expect_err("uninstall refuses too");
        assert!(format!("{err:#}").contains("not valid JSON"), "{err:#}");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "{ not json");
    }

    #[test]
    fn the_plugin_holds_placeholders_never_a_port_or_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = write_plugin(dir.path(), Some("dev")).expect("write plugin");
        assert_eq!(root, dir.path().join(PLUGIN_DIR));
        let manifest = read(&root.join(".zcode-plugin").join("plugin.json"));
        assert_eq!(manifest["name"], json!("houston-dev"));
        let server = &read(&root.join(".mcp.json"))["mcpServers"]["houston"];
        assert_eq!(server["url"], json!("${ZCODE_HOUSTON_MCP_URL_DEV}"));
        assert_eq!(
            server["headers"]["Authorization"],
            json!("Bearer ${HOUSTON_MCP_TOKEN}")
        );
        assert_eq!(server["type"], json!("http"));
        assert_eq!(url_env(None), "ZCODE_HOUSTON_MCP_URL");
        assert_eq!(url_env(Some("m9-bench")), "ZCODE_HOUSTON_MCP_URL_M9_BENCH");
        assert_eq!(plugin_name(None), "houston");
        remove_plugin(dir.path()).expect("remove");
        assert!(!root.exists());
        remove_plugin(dir.path()).expect("removing an absent plugin is not an error");
    }
}

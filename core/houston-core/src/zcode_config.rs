//! ZCode reads hooks and plugin directories from one strict JSON file. Houston's
//! hook entries carry the channel sentinel and its plugin directory lives in the
//! channel's state dir, so each channel installs and removes only its own entries.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// The settings files ZCode builds read: the community `zcode-app-cli` package reads
/// `setting.json` (and copies `config.json` into it once, on its first start); the
/// upstream CLI reads `config.json`.
pub const SETTINGS_FILES: [&str; 2] = ["setting.json", "config.json"];

/// The file shown for ZCode: the first settings file present, else `config.json`.
pub fn config_path(home: &Path) -> PathBuf {
    let dir = home.join(".zcode").join("cli");
    SETTINGS_FILES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| dir.join("config.json"))
}

/// Every settings file present beside `path`, or `path` alone when none is: Houston
/// cannot tell which build is installed, so it keeps each existing file in step.
fn managed_files(path: &Path) -> Vec<PathBuf> {
    let found: Vec<PathBuf> = path
        .parent()
        .map(|dir| {
            SETTINGS_FILES
                .iter()
                .map(|name| dir.join(name))
                .filter(|p| p.exists())
                .collect()
        })
        .unwrap_or_default();
    if found.is_empty() {
        vec![path.to_path_buf()]
    } else {
        found
    }
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
        None => URL_ENV_PREFIX.to_string(),
        Some(c) => format!(
            "{URL_ENV_PREFIX}_{}",
            c.to_ascii_uppercase().replace('-', "_")
        ),
    }
}

pub const URL_ENV_PREFIX: &str = "ZCODE_HOUSTON_MCP_URL";

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

// Through a temporary file and a rename: a ZCode starting mid-write would otherwise
// read truncated JSON and reject the whole config, the user's own settings included.
fn write_json(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write as _;
    let mut out = serde_json::to_string_pretty(value)?;
    out.push('\n');
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("creating a temporary file in {}", dir.display()))?;
    tmp.write_all(out.as_bytes())
        .with_context(|| format!("writing a temporary file for {}", path.display()))?;
    if let Ok(meta) = std::fs::metadata(path) {
        tmp.as_file()
            .set_permissions(meta.permissions())
            .with_context(|| format!("keeping the permissions of {}", path.display()))?;
    }
    tmp.persist(path)
        .map_err(|e| e.error)
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

fn read_text(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

fn parse_root(path: &Path, text: Option<&str>) -> Result<Option<Value>> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Ok(None);
    };
    let root: Value = serde_json::from_str(text).with_context(|| {
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

fn read_root(path: &Path) -> Result<Option<Value>> {
    parse_root(path, read_text(path)?.as_deref())
}

/// Next to the config: every channel's daemon edits the same file, and a dev and a
/// release toggle racing would otherwise each write back a copy without the other's entries.
pub const LOCK_FILE: &str = "config.json.houston-lock";

// A toggle holds the lock for one read-modify-write; longer means a stuck holder.
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(25);

// ZCode or an editor may write the file while Houston edits it; each retry rereads it.
const EDIT_ATTEMPTS: u32 = 3;

fn lock_config(path: &Path, wait: std::time::Duration) -> Result<std::fs::File> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let lock_path = dir.join(LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("opening {}", lock_path.display()))?;
    let deadline = std::time::Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(LOCK_POLL);
            }
            Err(std::fs::TryLockError::WouldBlock) => bail!(
                "another Houston channel is editing {} (lock {} held for over {} ms); nothing                  was written, try again",
                path.display(),
                lock_path.display(),
                wait.as_millis()
            ),
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(e).with_context(|| format!("locking {}", lock_path.display()))
            }
        }
    }
}

/// One read-modify-write of the shared config under the cross-channel lock. `change`
/// returns whether it changed anything; the file is replaced only if its bytes are
/// still the ones read, so a concurrent edit by ZCode or the user is reread, never lost.
fn edit(
    path: &Path,
    wait: std::time::Duration,
    mut change: impl FnMut(Option<Value>) -> Result<Option<Value>>,
    mut before_write: impl FnMut(),
) -> Result<bool> {
    let _lock = lock_config(path, wait)?;
    for _ in 0..EDIT_ATTEMPTS {
        let text = read_text(path)?;
        let Some(next) = change(parse_root(path, text.as_deref())?)? else {
            return Ok(false);
        };
        before_write();
        if read_text(path)? != text {
            continue;
        }
        write_json(path, &next)?;
        return Ok(true);
    }
    bail!(
        "{} changed while Houston was editing it, {EDIT_ATTEMPTS} times in a row; nothing was          written, try again once it is no longer being modified",
        path.display()
    )
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

fn hook_is_ours(hook: &Value, sentinel: &str) -> bool {
    hook.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| crate::agent_hooks::has_sentinel(c, sentinel))
}

/// Removes this channel's hook entries only. A user command sharing a group with one
/// of them stays; a group goes when Houston's removal leaves it with no hooks.
fn remove_our_entries(events: &mut Map<String, Value>, sentinel: &str) -> bool {
    let mut removed = false;
    let mut emptied = Vec::new();
    for (event, value) in events.iter_mut() {
        let Some(groups) = value.as_array_mut() else {
            continue;
        };
        let before = groups.len();
        groups.retain_mut(|group| {
            let Some(hooks) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
                return true;
            };
            let had = hooks.len();
            hooks.retain(|hook| !hook_is_ours(hook, sentinel));
            removed |= hooks.len() != had;
            !(hooks.is_empty() && had > 0)
        });
        if groups.is_empty() && before > 0 {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        events.remove(&event);
    }
    removed
}

/// `keep_disabled` is the boot refresh: a `hooks.enabled: false` found next to entries
/// already installed was the user's own choice and stays, and `is_installed` reports it.
pub fn install(
    path: &Path,
    commands: &[(&str, String)],
    sentinel: &str,
    plugin_dir: Option<&Path>,
    keep_disabled: bool,
) -> Result<()> {
    let install = Install {
        commands,
        sentinel,
        plugin_dir,
        keep_disabled,
    };
    for file in managed_files(path) {
        install_with(&file, &install, LOCK_WAIT, || {})?;
    }
    Ok(())
}

struct Install<'a> {
    commands: &'a [(&'a str, String)],
    sentinel: &'a str,
    plugin_dir: Option<&'a Path>,
    keep_disabled: bool,
}

fn install_with(
    path: &Path,
    install: &Install<'_>,
    wait: std::time::Duration,
    before_write: impl FnMut(),
) -> Result<()> {
    if cfg!(windows) {
        bail!(
            "ZCode hooks are not installed on Windows: Houston's hook command needs a POSIX \
             shell and ZCode runs command hooks through the platform shell; ZCode panes still \
             run, without status or pane tools"
        );
    }
    edit(
        path,
        wait,
        |root| {
            let mut root = root.unwrap_or_else(|| json!({}));
            apply_install(&mut root, path, install)?;
            Ok(Some(root))
        },
        before_write,
    )?;
    Ok(())
}

fn apply_install(root: &mut Value, path: &Path, install: &Install<'_>) -> Result<()> {
    let obj = root.as_object_mut().expect("parse_root returns an object");
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
    let user_disabled = install.keep_disabled
        && enabled_before == Some(false)
        && events
            .values()
            .filter_map(|v| v.as_array())
            .flatten()
            .any(group_is_any_houston);
    remove_our_entries(events, install.sentinel);
    for (event, command) in install.commands {
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
    if !user_disabled {
        hooks.insert("enabled".to_string(), json!(true));
    }
    if enabled_before != Some(true) && !user_disabled && !obj.contains_key(PARKED_ENABLED_KEY) {
        obj.insert(
            PARKED_ENABLED_KEY.to_string(),
            enabled_before.map_or(Value::Null, Value::Bool),
        );
    }
    if let Some(dir) = install.plugin_dir {
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
        let sentinel = install.sentinel;
        dirs.retain(|d| !plugin_entry_is_ours(d, sentinel) || d.as_str() == Some(dir.as_str()));
        if !dirs.iter().any(|d| d.as_str() == Some(dir.as_str())) {
            dirs.push(json!(dir));
        }
    }
    Ok(())
}

pub fn uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let mut changed = false;
    for file in managed_files(path) {
        changed |= uninstall_with(&file, sentinel, LOCK_WAIT)?;
    }
    Ok(changed)
}

fn uninstall_with(path: &Path, sentinel: &str, wait: std::time::Duration) -> Result<bool> {
    if read_text(path)?.is_none() {
        return Ok(false);
    }
    edit(
        path,
        wait,
        |root| {
            let Some(mut root) = root else {
                return Ok(None);
            };
            Ok(apply_uninstall(&mut root, sentinel).then_some(root))
        },
        || {},
    )
}

fn apply_uninstall(root: &mut Value, sentinel: &str) -> bool {
    let obj = root.as_object_mut().expect("parse_root returns an object");
    let mut changed = false;
    let mut houston_left = false;
    if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        if let Some(events) = hooks.get_mut("events").and_then(|e| e.as_object_mut()) {
            changed |= remove_our_entries(events, sentinel);
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
                // Only the `true` Houston wrote is given back; a later `false` is the user's.
                let still_ours = hooks.get("enabled") == Some(&Value::Bool(true));
                match parked {
                    Value::Bool(b) if still_ours => {
                        hooks.insert("enabled".to_string(), Value::Bool(b));
                    }
                    _ if still_ours => {
                        hooks.remove("enabled");
                    }
                    _ => {}
                }
                if hooks.is_empty() {
                    obj.remove("hooks");
                }
            }
        }
    }
    changed
}

/// Installed means ZCode will run the entries: they are present and `hooks.enabled` is on.
pub fn is_installed(path: &Path, sentinel: &str) -> bool {
    managed_files(path)
        .iter()
        .all(|file| is_installed_in(file, sentinel))
}

fn is_installed_in(path: &Path, sentinel: &str) -> bool {
    let Ok(Some(root)) = read_root(path) else {
        return false;
    };
    let hooks = root.get("hooks");
    hooks.and_then(|h| h.get("enabled")) == Some(&Value::Bool(true))
        && hooks
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

#[cfg(all(test, windows))]
mod windows_tests {
    #[test]
    fn the_zcode_toggle_is_refused_on_windows_by_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        let err =
            super::install(&path, &[], "--houston-managed", None, false).expect_err("refused");
        assert!(
            format!("{err:#}").contains("not installed on Windows"),
            "{err:#}"
        );
        assert!(!path.exists());
    }
}

#[cfg(all(test, unix))]
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
    fn a_switch_the_user_turned_off_survives_the_boot_refresh_and_reads_as_not_installed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path =
            agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        let mut root = read(&path);
        root["hooks"]["enabled"] = json!(false);
        std::fs::write(&path, root.to_string()).expect("the user turns ZCode hooks off");
        assert!(
            !agent_hooks::is_installed(Zcode, &h, DEV),
            "ZCode would run none of them"
        );

        agent_hooks::refresh(Zcode, &h, &launcher(".houston-dev"), DEV).expect("boot refresh");
        assert_eq!(
            read(&path)["hooks"]["enabled"],
            json!(false),
            "the refresh keeps it off"
        );
        assert!(!agent_hooks::is_installed(Zcode, &h, DEV));

        assert!(agent_hooks::uninstall(Zcode, &h, DEV).expect("uninstall"));
        assert_eq!(
            read(&path),
            json!({"hooks": {"enabled": false}}),
            "a false the user set is not overwritten by the parked value"
        );

        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("explicit install");
        assert_eq!(
            read(&path)["hooks"]["enabled"],
            json!(true),
            "turning it on is explicit"
        );
        assert!(agent_hooks::is_installed(Zcode, &h, DEV));
        agent_hooks::refresh(Zcode, &h, &launcher(".houston-dev"), DEV).expect("refresh");
        assert_eq!(read(&path)["hooks"]["enabled"], json!(true));
    }

    #[test]
    fn the_config_is_replaced_whole_and_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = agent_hooks::config_path(Zcode, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("list")
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n != "config.json" && n != LOCK_FILE)
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temporary file is left: {leftovers:?}"
        );
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

    fn dev_commands() -> Vec<(&'static str, String)> {
        vec![(
            "Stop",
            format!("/home/dev/.houston-dev/bin/claude-hook Stop {DEV}"),
        )]
    }

    fn dev_install<'a>(commands: &'a [(&'static str, String)]) -> Install<'a> {
        Install {
            commands,
            sentinel: DEV,
            plugin_dir: None,
            keep_disabled: false,
        }
    }

    #[test]
    fn a_user_command_sharing_a_group_with_houstons_entry_survives_reinstall_and_uninstall() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path =
            agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        let mut root = read(&path);
        root["hooks"]["events"]["Stop"][0]["hooks"]
            .as_array_mut()
            .expect("Houston's Stop group")
            .push(json!({ "type": "command", "command": "notify-send done" }));
        std::fs::write(&path, root.to_string()).expect("the user adds a command to the group");

        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("reinstall");
        let user_kept = |root: &Value| {
            root["hooks"]["events"]["Stop"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
                .any(|h| h["command"] == json!("notify-send done"))
        };
        assert!(
            user_kept(&read(&path)),
            "a reinstall keeps the user's command"
        );

        assert!(agent_hooks::uninstall(Zcode, &h, DEV).expect("uninstall"));
        let after = read(&path);
        assert_eq!(
            after["hooks"]["events"]["Stop"],
            json!([{ "hooks": [{ "type": "command", "command": "notify-send done" }] }]),
            "only Houston's entry goes; the group stays for the user's command: {after}"
        );
        assert_eq!(houston_groups(&after, DEV), 0);
    }

    #[test]
    fn an_edit_made_between_houstons_read_and_write_is_reread_and_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = config_path(dir.path());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}").expect("write");
        let mut external = Some(r#"{"theme":"dark"}"#);
        let commands = dev_commands();
        install_with(&path, &dev_install(&commands), LOCK_WAIT, || {
            if let Some(text) = external.take() {
                std::fs::write(&path, text).expect("ZCode writes its config meanwhile");
            }
        })
        .expect("the install retries on the new content");
        let root = read(&path);
        assert_eq!(
            root["theme"],
            json!("dark"),
            "the concurrent edit is kept: {root}"
        );
        assert_eq!(houston_groups(&root, DEV), 1, "{root}");
    }

    #[test]
    fn a_config_that_keeps_changing_is_refused_and_left_as_last_written() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = config_path(dir.path());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}").expect("write");
        let mut n = 0;
        let commands = dev_commands();
        let err = install_with(&path, &dev_install(&commands), LOCK_WAIT, || {
            n += 1;
            std::fs::write(&path, format!(r#"{{"edit":{n}}}"#)).expect("write");
        })
        .expect_err("refused");
        assert!(
            format!("{err:#}").contains("changed while Houston was editing it, 3 times"),
            "{err:#}"
        );
        assert_eq!(read(&path), json!({ "edit": EDIT_ATTEMPTS }));
    }

    #[test]
    fn a_channel_waits_for_another_channels_edit_and_refuses_a_stuck_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = config_path(dir.path());
        let held = lock_config(&path, LOCK_WAIT).expect("release holds the lock");
        let commands = dev_commands();
        let err = install_with(
            &path,
            &dev_install(&commands),
            std::time::Duration::from_millis(100),
            || {},
        )
        .expect_err("refused while the lock is held");
        let err = format!("{err:#}");
        assert!(
            err.contains("another Houston channel is editing") && err.contains(LOCK_FILE),
            "{err}"
        );
        assert!(!path.exists(), "nothing was written");

        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(held);
        });
        install_with(&path, &dev_install(&commands), LOCK_WAIT, || {})
            .expect("the edit goes in once the lock is free");
        release.join().expect("join");
        assert_eq!(houston_groups(&read(&path), DEV), 1);
    }
    #[test]
    fn the_community_builds_setting_json_gets_the_entries_beside_config_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let cli = dir.path().join(".zcode").join("cli");
        std::fs::create_dir_all(&cli).expect("mkdir");
        std::fs::write(
            cli.join("setting.json"),
            r#"{"permission":{"mode":"build"}}"#,
        )
        .expect("the community launcher created setting.json");
        let shown = agent_hooks::config_path(Zcode, &h).expect("path");
        assert_eq!(shown, cli.join("setting.json"));
        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        let setting = read(&cli.join("setting.json"));
        assert!(houston_groups(&setting, DEV) > 0, "{setting}");
        assert_eq!(setting["permission"]["mode"], json!("build"));
        assert!(
            !cli.join("config.json").exists(),
            "a file the installed build does not read is not created"
        );
        assert!(agent_hooks::is_installed(Zcode, &h, DEV));

        std::fs::write(cli.join("config.json"), "{}").expect("an upstream build's file too");
        assert!(
            !agent_hooks::is_installed(Zcode, &h, DEV),
            "every present file must carry the entries"
        );
        agent_hooks::install(Zcode, &h, &launcher(".houston-dev"), DEV).expect("install");
        assert!(houston_groups(&read(&cli.join("config.json")), DEV) > 0);
        assert!(agent_hooks::is_installed(Zcode, &h, DEV));
        assert!(agent_hooks::uninstall(Zcode, &h, DEV).expect("uninstall"));
        assert_eq!(read(&cli.join("config.json")), json!({}));
        assert_eq!(
            read(&cli.join("setting.json")),
            json!({"permission": {"mode": "build"}})
        );
    }
}

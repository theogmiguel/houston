//! ZCode reads one strict JSON settings file (`setting.json` or `config.json`, each kept
//! in step by v1). v1 added hook entries, its plugin directory and the parked
//! `hooks.enabled` value; this channel's entries leave, the parked value when none remain.

use super::files::{self, has_any_sentinel, has_sentinel};
use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

const SETTINGS_FILES: [&str; 2] = ["setting.json", "config.json"];
const PLUGIN_DIR: &str = "zcode-plugin";
const PARKED_ENABLED_KEY: &str = "houstonParkedHooksEnabled";
/// Shared with every v1 channel's daemon, which takes it for each edit of the file.
const LOCK_FILE: &str = "config.json.houston-lock";
const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
const LOCK_POLL: std::time::Duration = std::time::Duration::from_millis(25);
// ZCode or an editor may write the file meanwhile; each attempt rereads it.
const EDIT_ATTEMPTS: u32 = 3;

pub fn settings_files(home: &Path) -> Vec<PathBuf> {
    let dir = home.join(".zcode").join("cli");
    SETTINGS_FILES.iter().map(|name| dir.join(name)).collect()
}

/// `channel_dir_name` is `.houston` or `.houston-<channel>`: v1's plugin directory is
/// `<channel dir>/zcode-plugin`.
pub fn uninstall(path: &Path, sentinel: &str, channel_dir_name: &str) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let Some(mut root) = parse_root(&text)? else {
        return Ok(false);
    };
    if !apply(&mut root, sentinel, channel_dir_name) {
        return Ok(false);
    }
    let _lock = lock(path)?;
    for _ in 0..EDIT_ATTEMPTS {
        let text = files::read(path)?;
        let Some(mut root) = text.as_deref().map(parse_root).transpose()?.flatten() else {
            return Ok(false);
        };
        if !apply(&mut root, sentinel, channel_dir_name) {
            return Ok(false);
        }
        if files::read(path)? != text {
            continue;
        }
        files::write_json(path, &root)?;
        return Ok(true);
    }
    bail!("it changed while Houston was editing it, {EDIT_ATTEMPTS} times in a row")
}

fn parse_root(text: &str) -> Result<Option<Value>> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root = files::parse_json(text)?;
    if !root.is_object() {
        bail!("expected a JSON object at the top level");
    }
    Ok(Some(root))
}

fn lock(path: &Path) -> Result<std::fs::File> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("it has no parent directory"))?;
    let lock_path = dir.join(LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| anyhow!("cannot open {}: {e}", lock_path.display()))?;
    let deadline = std::time::Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(LOCK_POLL);
            }
            Err(std::fs::TryLockError::WouldBlock) => bail!(
                "another Houston process held {} for over {} ms",
                lock_path.display(),
                LOCK_WAIT.as_millis()
            ),
            Err(std::fs::TryLockError::Error(e)) => {
                bail!("cannot lock {}: {e}", lock_path.display())
            }
        }
    }
}

/// A hook's command and, for a `process` hook, each of its arguments.
fn hook_words(hook: &Value) -> impl Iterator<Item = &str> {
    let command = hook.get("command").and_then(Value::as_str);
    let args = hook
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    command.into_iter().chain(args)
}

fn group_is_any_houston(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(hook_words)
        .any(has_any_sentinel)
}

/// A user command sharing a group with one of ours stays; a group emptied by the removal
/// leaves, and so does an event emptied by it.
fn remove_entries(events: &mut Map<String, Value>, sentinel: &str) -> bool {
    let mut removed = false;
    let mut emptied = Vec::new();
    for (event, value) in events.iter_mut() {
        let Some(groups) = value.as_array_mut() else {
            continue;
        };
        let before = groups.len();
        groups.retain_mut(|group| {
            let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let had = hooks.len();
            hooks.retain(|hook| !hook_words(hook).any(|w| has_sentinel(w, sentinel)));
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

fn plugin_entry_is_ours(entry: &Value, channel_dir_name: &str) -> bool {
    let Some(dir) = entry.as_str().map(Path::new) else {
        return false;
    };
    dir.file_name().is_some_and(|n| n == PLUGIN_DIR)
        && dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == channel_dir_name)
}

fn apply(root: &mut Value, sentinel: &str, channel_dir_name: &str) -> bool {
    let obj = root.as_object_mut().expect("parse_root returns an object");
    let mut changed = false;
    let mut houston_left = false;
    if let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) {
        if let Some(events) = hooks.get_mut("events").and_then(Value::as_object_mut) {
            changed |= remove_entries(events, sentinel);
            houston_left = events
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(group_is_any_houston);
            if events.is_empty() {
                hooks.remove("events");
            }
        }
    }
    if let Some(plugins) = obj.get_mut("plugins").and_then(Value::as_object_mut) {
        if let Some(dirs) = plugins.get_mut("dirs").and_then(Value::as_array_mut) {
            let before = dirs.len();
            dirs.retain(|d| !plugin_entry_is_ours(d, channel_dir_name));
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
            if let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) {
                // Only the `true` v1 wrote is given back; a later `false` is the user's.
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

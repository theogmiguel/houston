//! Claude, Codex, OpenCode and Antigravity: v1's uninstall rules for one channel's
//! sentinel. Each function returns whether it changed the file; an error leaves it as is.

use super::files::{self, has_sentinel};
use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use std::path::Path;

fn command_is_ours(value: &Value, sentinel: &str) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| has_sentinel(c, sentinel))
}

/// A hook group is ours when it, or one of its nested hooks, runs a marked command.
fn group_is_ours(group: &Value, sentinel: &str) -> bool {
    command_is_ours(group, sentinel)
        || group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| hooks.iter().any(|h| command_is_ours(h, sentinel)))
}

fn parse_object(text: &str) -> Result<Option<Value>> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root = files::parse_json(text)?;
    Ok(root.is_object().then_some(root))
}

/// Claude's settings: marked hook commands (a user's command sharing a group stays) and
/// this channel's `statusLine`. An emptied `hooks` object stays, as v1's removal left it.
pub fn claude_settings(path: &Path, sentinel: &str) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let Some(mut root) = parse_object(&text)? else {
        return Ok(false);
    };
    let original = root.clone();
    let obj = root
        .as_object_mut()
        .expect("parse_object returns an object");
    if let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) {
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
                continue;
            };
            if !groups.iter().any(|g| group_is_ours(g, sentinel)) {
                continue;
            }
            groups.retain_mut(|group| {
                if !group_is_ours(group, sentinel) {
                    return true;
                }
                let Some(inner) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                    return false;
                };
                inner.retain(|hook| !command_is_ours(hook, sentinel));
                !inner.is_empty()
            });
            if groups.is_empty() {
                hooks.remove(&event);
            }
        }
    }
    if obj
        .get("statusLine")
        .is_some_and(|s| command_is_ours(s, sentinel))
    {
        obj.remove("statusLine");
    }
    if root == original {
        return Ok(false);
    }
    files::write_json(path, &root)?;
    Ok(true)
}

/// Codex's `hooks.json` (and Claude-shaped nested hook files): marked groups leave, then
/// emptied events, an emptied `hooks`, and the file itself if nothing else is left.
pub fn nested_hooks(path: &Path, sentinel: &str) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let Some(mut root) = parse_object(&text)? else {
        return Ok(false);
    };
    let obj = root
        .as_object_mut()
        .expect("parse_object returns an object");
    let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    if !remove_groups(hooks, sentinel) {
        return Ok(false);
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
    write_or_remove(path, &root)
}

/// Antigravity keeps Houston's entries under its own top-level `houston` group.
pub fn antigravity(path: &Path, sentinel: &str) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    let Some(mut root) = parse_object(&text)? else {
        return Ok(false);
    };
    let obj = root
        .as_object_mut()
        .expect("parse_object returns an object");
    let Some(group) = obj.get_mut("houston").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    if !remove_groups(group, sentinel) {
        return Ok(false);
    }
    if group.is_empty() {
        obj.remove("houston");
    }
    write_or_remove(path, &root)
}

fn remove_groups(events: &mut serde_json::Map<String, Value>, sentinel: &str) -> bool {
    let mut removed = false;
    let mut emptied = Vec::new();
    for (event, value) in events.iter_mut() {
        let Some(groups) = value.as_array_mut() else {
            continue;
        };
        let before = groups.len();
        groups.retain(|g| !group_is_ours(g, sentinel));
        removed |= groups.len() != before;
        if groups.is_empty() {
            emptied.push(event.clone());
        }
    }
    if removed {
        for event in emptied {
            events.remove(&event);
        }
    }
    removed
}

fn write_or_remove(path: &Path, root: &Value) -> Result<bool> {
    if root.as_object().is_some_and(serde_json::Map::is_empty) {
        files::remove(path)?;
    } else {
        files::write_json(path, root)?;
    }
    Ok(true)
}

/// v1's OpenCode plugin file is Houston's alone; it leaves only when it carries this
/// channel's marker.
pub fn opencode(path: &Path, sentinel: &str) -> Result<bool> {
    match files::read(path)? {
        Some(text) if has_sentinel(&text, sentinel) => {
            files::remove(path)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Codex `config.toml`: this channel's hook-trust block leaves and the `notify` line it
/// parked is restored, unless the user has since set a new one.
pub fn codex_config(path: &Path, sentinel: &str) -> Result<bool> {
    let Some(text) = files::read(path)? else {
        return Ok(false);
    };
    text.parse::<toml::Value>()
        .map_err(|e| anyhow!("not valid TOML: {e}"))?;
    let without_trust = without_trust_block(&text, sentinel)?;
    let restored = wake_notify(&without_trust, sentinel)?;
    if restored == text {
        return Ok(false);
    }
    restored.parse::<toml::Value>().map_err(|e| {
        anyhow!("removing Houston's entries would leave invalid TOML ({e}); left as is")
    })?;
    files::atomic_write(path, restored.as_bytes())?;
    Ok(true)
}

fn without_trust_block(text: &str, sentinel: &str) -> Result<String> {
    let begin = format!("# BEGIN Houston Codex hook trust {sentinel}\n");
    let end = format!("# END Houston Codex hook trust {sentinel}\n");
    let inserted_newline =
        format!("\n# BEGIN Houston Codex hook trust {sentinel} (inserted newline)\n");
    let marker = if text.contains(&inserted_newline) {
        &inserted_newline
    } else {
        &begin
    };
    let Some(start) = text.find(marker.as_str()) else {
        if text.contains(&end) {
            bail!("an unmatched Houston Codex trust end marker for {sentinel}");
        }
        return Ok(text.to_string());
    };
    let tail = &text[start + marker.len()..];
    let stop = tail
        .find(&end)
        .ok_or_else(|| anyhow!("a Houston Codex trust block for {sentinel} has no end marker"))?;
    if tail.contains(&begin)
        || tail.contains(&inserted_newline)
        || tail[stop + end.len()..].contains(&end)
    {
        bail!("duplicate Houston Codex trust markers for {sentinel}");
    }
    let remainder = &tail[stop + end.len()..];
    let separator = if marker == &inserted_newline && !remainder.is_empty() {
        "\n"
    } else {
        ""
    };
    Ok(format!("{}{separator}{remainder}", &text[..start]))
}

fn parked_marker(sentinel: &str) -> String {
    format!("# {sentinel} parked-user-notify")
}

fn is_parked(line: &str, sentinel: &str) -> bool {
    line.trim_start().starts_with('#') && line.contains(&parked_marker(sentinel))
}

fn wake_notify(text: &str, sentinel: &str) -> Result<String> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let Some(index) = lines.iter().position(|l| is_parked(l, sentinel)) else {
        return Ok(text.to_string());
    };
    let current = text
        .parse::<toml::Value>()
        .map_err(|e| anyhow!("not valid TOML: {e}"))?;
    if current.get("notify").is_some() {
        bail!("its parked `notify` cannot be restored: the user has set a new `notify` since; both were kept");
    }
    let marker = parked_marker(sentinel);
    lines[index] = lines[index]
        .trim_start()
        .trim_start_matches('#')
        .trim_start()
        .trim_end()
        .trim_end_matches(marker.as_str())
        .trim_end()
        .to_string();
    let mut out = lines.join("\n");
    out.push('\n');
    Ok(out)
}

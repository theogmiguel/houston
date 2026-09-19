//! Boot-time removal of hook entries left by a superseded name of this app: a
//! rename changes both the marker every managed entry carries and the state dir
//! the launcher lives in, so an old entry is invisible to installers and not found.
use houston_protocol as proto;
use std::path::{Path, PathBuf};

pub fn sweep(db: &crate::db::Db) {
    let Ok(cfg) = crate::agent_hooks::ConfigHome::from_env() else {
        return;
    };
    sweep_with(db, &cfg);
}

fn sweep_with(db: &crate::db::Db, cfg: &crate::agent_hooks::ConfigHome) {
    match db.list_workspaces() {
        Ok(rows) => {
            for w in rows {
                prune_hook_json(
                    &crate::claude_hooks::settings_path(Path::new(&w.path)),
                    "hooks",
                    DeleteWhenEmpty::No,
                );
            }
        }
        Err(e) => tracing::warn!("legacy hook sweep: listing workspaces: {e}"),
    }
    for provider in crate::agent_hooks::PROVIDERS {
        let Ok(path) = crate::agent_hooks::config_path(provider, cfg) else {
            continue;
        };
        match provider {
            proto::AgentKind::Cursor => prune_hook_json(&path, "hooks", DeleteWhenEmpty::No),
            proto::AgentKind::Antigravity => prune_hook_json(&path, "houston", DeleteWhenEmpty::No),
            proto::AgentKind::Codex => {
                prune_hook_json(&path, "hooks", DeleteWhenEmpty::No);
                if let Some(dir) = path.parent() {
                    prune_codex_notify(&dir.join("config.toml"));
                }
            }
            proto::AgentKind::Grok => {
                for p in siblings_of(&path, "json") {
                    prune_hook_json(&p, "hooks", DeleteWhenEmpty::Yes);
                }
            }
            proto::AgentKind::Opencode => {
                for p in siblings_of(&path, "js") {
                    delete_if_legacy(&p);
                }
            }
            other => tracing::warn!(
                "legacy hook sweep: {other:?} has an installer but no sweep rule — \
                 residue from a superseded name would outlive every boot there"
            ),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum DeleteWhenEmpty {
    Yes,
    No,
}

fn prune_hook_json(path: &Path, group_key: &str, delete_when_empty: DeleteWhenEmpty) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    let Some(hooks) = obj.get_mut(group_key).and_then(|h| h.as_object_mut()) else {
        return;
    };
    let mut removed = 0usize;
    let mut emptied = Vec::new();
    for (event, value) in hooks.iter_mut() {
        let Some(arr) = value.as_array_mut() else {
            continue;
        };
        let before = arr.len();
        arr.retain(|e| !entry_is_legacy(e));
        removed += before - arr.len();
        if arr.is_empty() {
            emptied.push(event.clone());
        }
    }
    if removed == 0 {
        return;
    }
    for event in emptied {
        hooks.remove(&event);
    }
    if hooks.is_empty() {
        obj.remove(group_key);
    }
    if delete_when_empty == DeleteWhenEmpty::Yes && obj.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => tracing::info!("legacy hook sweep: removed {}", path.display()),
            Err(e) => tracing::warn!("legacy hook sweep: removing {}: {e}", path.display()),
        }
        return;
    }
    write_json(path, &root, removed);
}

fn entry_is_legacy(entry: &serde_json::Value) -> bool {
    let direct = entry
        .get("command")
        .and_then(|c| c.as_str())
        .is_some_and(crate::claude_hooks::command_is_legacy_managed);
    direct
        || entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|nested| {
                nested
                    .iter()
                    .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
                    .any(crate::claude_hooks::command_is_legacy_managed)
            })
}

/// Houston may delete a hooks file only where it writes the whole file — a
/// provider's own plugin or hooks file. A file that is the user's survives even
/// after its last entry of ours is pruned out of it.
fn delete_if_legacy(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if !crate::claude_hooks::command_is_legacy_managed(&text) {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => tracing::info!("legacy hook sweep: removed {}", path.display()),
        Err(e) => tracing::warn!("legacy hook sweep: removing {}: {e}", path.display()),
    }
}

/// Codex's seam is a single TOML key, so only a live superseded `notify` line is
/// removed. A commented one is a parked user line: waking it would collide with
/// the current channel's key, and deleting it would throw away the user's command.
fn prune_codex_notify(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let mut lines: Vec<&str> = text.lines().collect();
    let before = lines.len();
    lines.retain(|l| {
        let t = l.trim_start();
        !(t.starts_with("notify")
            && !t.starts_with('#')
            && crate::claude_hooks::command_is_legacy_managed(l))
    });
    if lines.len() == before {
        return;
    }
    let removed = before - lines.len();
    let mut out = lines.join("\n");
    out.push('\n');
    match std::fs::write(path, out) {
        Ok(()) => tracing::info!(
            "legacy hook sweep: removed {removed} superseded notify line(s) from {}",
            path.display()
        ),
        Err(e) => tracing::warn!("legacy hook sweep: rewriting {}: {e}", path.display()),
    }
}

fn write_json(path: &Path, root: &serde_json::Value, removed: usize) {
    let Ok(mut out) = serde_json::to_string_pretty(root) else {
        return;
    };
    out.push('\n');
    match std::fs::write(path, out) {
        Ok(()) => tracing::info!(
            "legacy hook sweep: removed {removed} superseded hook(s) from {}",
            path.display()
        ),
        Err(e) => tracing::warn!("legacy hook sweep: rewriting {}: {e}", path.display()),
    }
}

fn siblings_of(path: &Path, ext: &str) -> Vec<PathBuf> {
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == ext))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &str = "'/home/t/.old-name/bin/claude-hook' hook Stop --old-name-managed";
    const LEGACY_DEV: &str =
        "'/home/t/.old-name-dev/bin/claude-hook' hook Stop --old-name-managed=dev";
    const CURRENT: &str = "'/home/t/.houston/bin/claude-hook' hook Stop --houston-managed";
    const CURRENT_DEV: &str =
        "'/home/t/.houston-dev/bin/claude-hook' hook Stop --houston-managed=dev";

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn nested(cmd: &str) -> String {
        format!(
            r#"{{"hooks": [{{"type": "command", "command": {}}}]}}"#,
            serde_json::Value::from(cmd)
        )
    }

    fn flat(cmd: &str) -> String {
        format!(r#"{{"command": {}}}"#, serde_json::Value::from(cmd))
    }

    #[test]
    fn prunes_only_superseded_groups() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.local.json");
        write(
            &path,
            &format!(
                r#"{{"permissions": {{"allow": ["Bash"]}}, "hooks": {{"Stop": [{}, {}, {}, {}, {{"hooks": [{{"command": "my-own.sh"}}]}}]}}}}"#,
                nested(LEGACY),
                nested(LEGACY_DEV),
                nested(CURRENT),
                nested(CURRENT_DEV),
            ),
        );

        prune_hook_json(&path, "hooks", DeleteWhenEmpty::No);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("old-name"),
            "superseded groups must go: {text}"
        );
        assert!(
            text.contains("/.houston/bin/claude-hook"),
            "the release channel's group stays: {text}"
        );
        assert!(
            text.contains("/.houston-dev/bin/claude-hook"),
            "dev's group stays: {text}"
        );
        assert!(
            text.contains("my-own.sh"),
            "the user's own hook stays: {text}"
        );
        assert!(text.contains("Bash"), "unrelated settings stay: {text}");
    }

    #[test]
    fn prunes_the_flat_entry_dialect_too() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("hooks.json");
        write(
            &path,
            &format!(
                r#"{{"version": 1, "hooks": {{"stop": [{{"command": "other-tool.sh"}}, {}]}}}}"#,
                flat(LEGACY)
            ),
        );

        prune_hook_json(&path, "hooks", DeleteWhenEmpty::No);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("old-name"), "{text}");
        assert!(text.contains("other-tool.sh"), "{text}");
    }

    #[test]
    fn deletes_a_hooks_file_only_when_nothing_but_ours_was_in_it() {
        let tmp = tempfile::tempdir().unwrap();
        let ours = tmp.path().join("ours.json");
        write(
            &ours,
            &format!(r#"{{"hooks": {{"Stop": [{}]}}}}"#, nested(LEGACY)),
        );
        prune_hook_json(&ours, "hooks", DeleteWhenEmpty::Yes);
        assert!(
            !ours.exists(),
            "a file holding nothing but our residue goes"
        );

        let shared = tmp.path().join("shared.json");
        write(
            &shared,
            &format!(
                r#"{{"version": 1, "hooks": {{"Stop": [{}]}}}}"#,
                nested(LEGACY)
            ),
        );
        prune_hook_json(&shared, "hooks", DeleteWhenEmpty::Yes);
        assert!(shared.exists(), "a file carrying the user's keys survives");
        assert!(!std::fs::read_to_string(&shared)
            .unwrap()
            .contains("old-name"));
    }

    #[test]
    fn never_touches_a_foreign_tool_or_an_unparseable_config() {
        let tmp = tempfile::tempdir().unwrap();
        let foreign = tmp.path().join("foreign.json");
        let body = r#"{"hooks": {"Stop": [{"command": "/opt/other/bin/other-hook run --other-managed"}]}}"#;
        write(&foreign, body);
        prune_hook_json(&foreign, "hooks", DeleteWhenEmpty::Yes);
        assert_eq!(std::fs::read_to_string(&foreign).unwrap(), body);

        let garbage = tmp.path().join("garbage.json");
        write(&garbage, "{ not json");
        prune_hook_json(&garbage, "hooks", DeleteWhenEmpty::Yes);
        assert_eq!(std::fs::read_to_string(&garbage).unwrap(), "{ not json");
    }

    #[test]
    fn deletes_a_superseded_plugin_and_leaves_a_foreign_one() {
        let tmp = tempfile::tempdir().unwrap();
        let ours = tmp.path().join("old-name-notify.js");
        write(
            &ours,
            &format!("export const N = async () => {{ await $`sh -c \"{LEGACY}\"` }}\n"),
        );
        let theirs = tmp.path().join("other-notify.js");
        write(&theirs, "export const N = async () => {}\n");

        delete_if_legacy(&ours);
        delete_if_legacy(&theirs);

        assert!(!ours.exists());
        assert!(theirs.exists());
    }

    #[test]
    fn codex_drops_a_live_superseded_notify_and_keeps_a_parked_one() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.toml");
        write(
            &path,
            &format!(
                "model = \"gpt\"\n\
                 notify = [\"bash\", \"-c\", \"{LEGACY}\", \"--\"]\n\
                 # notify = [\"mine\"] # --old-name-managed parked-user-notify\n"
            ),
        );

        prune_codex_notify(&path);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("bash"),
            "the live superseded line goes: {text}"
        );
        assert!(
            text.contains("parked-user-notify"),
            "a parked line stays: {text}"
        );
        assert!(text.contains("model = \"gpt\""), "{text}");
    }

    #[test]
    fn sweep_reaches_every_surface() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let workspace = home.join("proj");
        let cfg = crate::agent_hooks::ConfigHome {
            home: home.clone(),
            xdg_config: Some(home.join("xdg")),
        };
        let db = crate::db::Db::open(&tmp.path().join("t.db")).unwrap();
        db.add_workspace(workspace.to_str().unwrap(), "proj")
            .unwrap();

        let ws_settings = crate::claude_hooks::settings_path(&workspace);
        write(
            &ws_settings,
            &format!(r#"{{"hooks": {{"Stop": [{}]}}}}"#, nested(LEGACY)),
        );
        let cursor = home.join(".cursor").join("hooks.json");
        write(
            &cursor,
            &format!(
                r#"{{"version": 1, "hooks": {{"stop": [{}]}}}}"#,
                flat(LEGACY)
            ),
        );
        let grok = home.join(".grok").join("hooks").join("old-name.json");
        write(
            &grok,
            &format!(r#"{{"hooks": {{"Stop": [{}]}}}}"#, nested(LEGACY)),
        );
        let plugin = home
            .join("xdg")
            .join("opencode")
            .join("plugins")
            .join("old-name-notify.js");
        write(&plugin, &format!("// {LEGACY}\n"));
        let codex = home.join(".codex").join("config.toml");
        write(
            &codex,
            &format!("notify = [\"bash\", \"-c\", \"{LEGACY}\", \"--\"]\n"),
        );
        let antigravity = home.join(".gemini").join("config").join("hooks.json");
        write(
            &antigravity,
            &format!(
                r#"{{"houston": {{"Stop": [{}]}}, "other-tool": {{"Stop": [{{"command": "their-hook"}}]}}}}"#,
                nested(LEGACY)
            ),
        );

        sweep_with(&db, &cfg);

        assert!(!std::fs::read_to_string(&ws_settings)
            .unwrap()
            .contains("old-name"));
        assert!(!std::fs::read_to_string(&cursor)
            .unwrap()
            .contains("old-name"));
        assert!(
            !grok.exists(),
            "a hooks file that was entirely ours goes whole"
        );
        assert!(!plugin.exists(), "a generated plugin goes whole");
        assert!(!std::fs::read_to_string(&codex)
            .unwrap()
            .contains("old-name"));
        let antigravity_text = std::fs::read_to_string(&antigravity).unwrap();
        assert!(!antigravity_text.contains("old-name"), "{antigravity_text}");
        assert!(
            antigravity_text.contains("their-hook"),
            "a foreign group in the same file survives: {antigravity_text}"
        );
    }
}

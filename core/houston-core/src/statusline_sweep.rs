use std::path::Path;

pub fn sweep(db: &crate::db::Db) {
    let Ok(cfg) = crate::agent_hooks::ConfigHome::from_env() else {
        return;
    };
    let stem = crate::claude_hooks::sentinel_for(None);
    let prefix = format!("{stem}=");
    let mut dirs = vec![cfg.home.join(".claude")];
    if let Ok(rows) = db.list_agent_profiles("claude") {
        for row in rows {
            let dir = crate::agent_accounts::expand_tilde(&row.config_dir, &cfg.home);
            if dir.is_absolute() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    for dir in dirs {
        remove_ours(&dir.join("settings.json"), &stem, &prefix);
    }
}

fn remove_ours(path: &Path, stem: &str, prefix: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(obj) = root.as_object_mut() else {
        return false;
    };
    let ours = obj
        .get("statusLine")
        .and_then(|v| v.get("command"))
        .and_then(|c| c.as_str())
        .is_some_and(|cmd| {
            cmd.split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .any(|t| t == stem || t.starts_with(prefix))
        });
    if !ours {
        return false;
    }
    obj.remove("statusLine");
    match serde_json::to_string_pretty(&root) {
        Ok(mut out) => {
            out.push('\n');
            if let Err(e) = std::fs::write(path, out) {
                tracing::warn!("statusline sweep: rewriting {}: {e}", path.display());
                return false;
            }
            tracing::info!(
                "statusline sweep: removed the retired quota feature's statusLine from {}",
                path.display()
            );
            true
        }
        Err(e) => {
            tracing::warn!("statusline sweep: re-serializing {}: {e}", path.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    const DEV_CMD: &str = r#"{"type": "command", "command": "'/home/dev/.houston-dev/bin/claude-hook' quota-statusline --houston-managed=dev"}"#;
    const RELEASE_CMD: &str = r#"{"type": "command", "command": "'/home/dev/.houston/bin/claude-hook' quota-statusline --houston-managed"}"#;

    #[test]
    fn removes_our_entry_from_any_channel_and_keeps_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        write(
            &path,
            &format!(r#"{{"model": "opus", "statusLine": {DEV_CMD}}}"#),
        );

        assert!(remove_ours(
            &path,
            "--houston-managed",
            "--houston-managed="
        ));
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(root.get("statusLine").is_none(), "{root}");
        assert_eq!(root["model"], "opus", "unrelated keys untouched");

        assert!(!remove_ours(
            &path,
            "--houston-managed",
            "--houston-managed="
        ));
    }

    #[test]
    fn release_stem_matches_without_claiming_a_prefix_of_something_else() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        write(&path, &format!(r#"{{"statusLine": {RELEASE_CMD}}}"#));
        assert!(remove_ours(
            &path,
            "--houston-managed",
            "--houston-managed="
        ));

        let foreign = r#"{"type": "command", "command": "my-statusline --houston-manager"}"#;
        let path2 = tmp.path().join("other.json");
        write(&path2, &format!(r#"{{"statusLine": {foreign}}}"#));
        assert!(!remove_ours(
            &path2,
            "--houston-managed",
            "--houston-managed="
        ));
        assert!(std::fs::read_to_string(&path2)
            .unwrap()
            .contains("my-statusline"));
    }

    #[test]
    fn a_foreign_or_unparseable_config_is_never_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let foreign = tmp.path().join("a.json");
        let original = r#"{"statusLine": {"type": "command", "command": "mine.sh"}}"#;
        write(&foreign, original);
        assert!(!remove_ours(
            &foreign,
            "--houston-managed",
            "--houston-managed="
        ));
        assert_eq!(std::fs::read_to_string(&foreign).unwrap(), original);

        let garbage = tmp.path().join("b.json");
        write(&garbage, "{ not json");
        assert!(!remove_ours(
            &garbage,
            "--houston-managed",
            "--houston-managed="
        ));
        assert_eq!(std::fs::read_to_string(&garbage).unwrap(), "{ not json");
    }

    #[test]
    fn sweep_covers_default_and_profile_dirs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let default_dir = home.join(".claude");
        let personal_dir = home.join(".claude-personal");
        let undeclared = home.join(".claude-backup");
        for dir in [&default_dir, &personal_dir, &undeclared] {
            write(
                &dir.join("settings.json"),
                &format!(r#"{{"statusLine": {DEV_CMD}}}"#),
            );
        }
        let db = crate::db::Db::open(&tmp.path().join("t.db")).unwrap();
        db.upsert_agent_profile(None, "claude", "personal", "~/.claude-personal")
            .unwrap();

        let guard = test_home_guard(&home);
        sweep(&db);
        drop(guard);

        assert!(
            !default_dir.join("settings.json").exists()
                || !std::fs::read_to_string(default_dir.join("settings.json"))
                    .unwrap()
                    .contains("statusLine"),
            "the default account's retired entry must go"
        );
        for dir in [&default_dir, &personal_dir] {
            let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
            assert!(!text.contains("quota-statusline"), "{text}");
        }
        let untouched = std::fs::read_to_string(undeclared.join("settings.json")).unwrap();
        assert!(
            untouched.contains("quota-statusline"),
            "an undeclared directory is nobody Houston knows about — never swept: {untouched}"
        );
    }

    struct Guard(Option<std::ffi::OsString>);
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(v) = self.0.take() {
                // SAFETY: test-only restore of the value this guard saved; the
                // crate's env-var tests run sequentially, so no other thread is
                // reading `HOME` concurrently.
                unsafe {
                    std::env::set_var("HOME", v);
                }
            }
        }
    }

    fn test_home_guard(home: &Path) -> Guard {
        let prev = std::env::var_os("HOME");
        // SAFETY: test-only; the caller holds the guard for the whole test, and
        // the crate's env-var tests run sequentially by contract.
        unsafe {
            std::env::set_var("HOME", home);
        }
        Guard(prev)
    }
}

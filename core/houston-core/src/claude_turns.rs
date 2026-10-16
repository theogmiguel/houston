use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub const START: &str = "ModTurnStart";
pub const INTERRUPTED: &str = "ModTurnInterrupted";
// Native identifiers are short opaque strings; leave room while bounding per-pane state.
pub const ID_MAX_BYTES: usize = 256;

// The documented mods contract is available in the 2.1.290 reference. Older or
// unknown versions keep their classic hooks without an inferred interrupt.
pub fn supported(version: Option<&str>) -> bool {
    version
        .and_then(|version| {
            let parts = version
                .split('.')
                .map(str::parse::<u32>)
                .collect::<std::result::Result<Vec<_>, _>>()
                .ok()?;
            (parts.len() == 3).then(|| (parts[0], parts[1], parts[2]))
        })
        .is_some_and(|version| version >= (2, 1, 290))
}

pub fn prepare(state: &Path, launcher: &Path, channel: Option<&str>) -> Result<PathBuf> {
    let root = state.join("hooks/claude-turns");
    std::fs::create_dir_all(root.join(".claude-plugin"))?;
    std::fs::create_dir_all(root.join("hooks"))?;
    write_changed(
        root.join(".claude-plugin/plugin.json"),
        r#"{"name":"houston-turns","description":"Houston managed turn lifecycle","version":"1.0.0"}"#,
    )?;
    write_changed(
        root.join("hooks/hooks.json"),
        r#"{"modules":["./register.js"]}"#,
    )?;
    let source = include_str!("claude_turns.js")
        .replace(
            "__SENTINEL__",
            &serde_json::to_string(&crate::claude_hooks::sentinel_for(channel))?,
        )
        .replace(
            "__LAUNCHER__",
            &serde_json::to_string(&crate::exe_path::command_spelling(launcher))?,
        );
    write_changed(root.join("hooks/register.js"), source.as_bytes())
        .with_context(|| format!("writing Houston's Claude turn mod in {}", root.display()))?;
    Ok(root)
}

fn write_changed(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let path = path.as_ref();
    let contents = contents.as_ref();
    // Launching another pane must not hot-reload the mod in existing panes.
    if std::fs::read(path).ok().as_deref() != Some(contents) {
        std::fs::write(path, contents)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn helper_bound_outlasts_a_slow_start_and_stays_under_the_host_cap() {
        let source = include_str!("claude_turns.js");
        let value = source
            .lines()
            .find_map(|line| line.strip_prefix("const HELPER_TIMEOUT_MS = "))
            .and_then(|rest| rest.trim_end_matches(';').parse::<u64>().ok())
            .expect("claude_turns.js defines `const HELPER_TIMEOUT_MS = <ms>;`");
        assert!(
            source.contains("timeoutMs: HELPER_TIMEOUT_MS"),
            "the helper run must use HELPER_TIMEOUT_MS"
        );
        // 1.3 s is the slowest helper start measured on a loaded Windows machine.
        assert!(
            value >= 30_000,
            "HELPER_TIMEOUT_MS is {value}; expected >= 30000"
        );
        // The mods host rejects a longer bound than ten minutes.
        assert!(
            value <= 600_000,
            "HELPER_TIMEOUT_MS is {value}; expected <= 600000"
        );
    }

    #[test]
    fn versions_without_the_documented_contract_are_not_enabled() {
        for version in [
            None,
            Some("2.1.289"),
            Some("unknown"),
            Some("2.1.290.extra"),
        ] {
            assert!(!super::supported(version));
        }
        for version in ["2.1.290", "2.1.296", "2.2.0", "3.0.0"] {
            assert!(super::supported(Some(version)));
        }
    }
}

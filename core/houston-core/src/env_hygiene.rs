//! Inheritance of agent-session markers, and why the daemon must drop them: a
//! daemon started inside an agent session would hand every process it spawns that
//! session's identity. Identity only — `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` survive.
const SESSION_MARKERS: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
];

pub fn markers_in(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut hits: Vec<String> = keys
        .filter(|k| SESSION_MARKERS.contains(&k.as_str()))
        .collect();
    hits.sort();
    hits.dedup();
    hits
}

/// Remove inherited agent-session markers so every later spawn gets a clean
/// identity. Call once during startup, **before** any spawn (rc files can branch
/// on `$CLAUDECODE`) and before the server is up: env mutation is single-threaded only.
pub fn scrub() {
    let hits = markers_in(std::env::vars().map(|(k, _)| k));
    if hits.is_empty() {
        return;
    }
    for k in &hits {
        std::env::remove_var(k);
    }
    tracing::info!(
        "dropped inherited agent-session marker(s) {} — this daemon was started from inside an \
         agent session; spawned panes get their own identity",
        hits.join(", ")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_are_picked_and_settings_are_left_alone() {
        let env = [
            "PATH",
            "CLAUDECODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_EFFORT",
            "ANTHROPIC_API_KEY",
            "HOUSTON_CHANNEL",
        ];
        let hits = markers_in(env.iter().map(|s| s.to_string()));
        assert_eq!(
            hits,
            vec![
                "CLAUDECODE",
                "CLAUDE_CODE_CHILD_SESSION",
                "CLAUDE_CODE_SESSION_ID"
            ]
        );
    }

    #[test]
    fn a_clean_environment_yields_nothing_to_drop() {
        let hits = markers_in(["PATH", "HOME", "SHELL"].iter().map(|s| s.to_string()));
        assert!(hits.is_empty(), "{hits:?}");
    }
}

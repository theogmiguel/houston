//! Drop inherited session identities and private supervisor startup state before
//! the daemon spawns children. Agent settings such as `CLAUDE_CONFIG_DIR` and
//! `ANTHROPIC_*` remain available.
const SESSION_MARKERS: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    crate::supervisor::SUPERVISOR_FD_ENV,
];

pub fn markers_in(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut hits: Vec<String> = keys
        .filter(|k| SESSION_MARKERS.contains(&k.as_str()))
        .collect();
    hits.sort();
    hits.dedup();
    hits
}

/// Remove inherited session markers and the private supervisor variable before
/// any runtime thread or child starts; rc files can branch on `$CLAUDECODE`.
pub fn scrub() {
    let hits = markers_in(std::env::vars().map(|(k, _)| k));
    if hits.is_empty() {
        return;
    }
    for k in &hits {
        std::env::remove_var(k);
    }
    tracing::info!(
        "dropped inherited private marker(s) {} — this daemon was started from inside an \
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

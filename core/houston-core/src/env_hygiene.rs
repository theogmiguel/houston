//! Drop inherited agent-session and multiplexer identities and private supervisor
//! startup state before the daemon spawns children. Agent settings such as `CLAUDE_CONFIG_DIR` and
//! `ANTHROPIC_*` remain available.
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
const SESSION_MARKERS: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "HOUSTON_EXEC_GATE",
    "HOUSTON_EXEC_NONCE",
    "HOUSTON_COMMITTED_SCOPE",
    crate::supervisor::SUPERVISOR_FD_ENV,
    // A pane is not inside the launcher's multiplexer: tmux commands would target its server.
    "TMUX",
    "TMUX_PANE",
    "STY",
    "ZELLIJ",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
    // Set by an Electron-based editor's terminal; Electron tools in a pane would run as node.
    "ELECTRON_RUN_AS_NODE",
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
        "dropped inherited launcher variable(s) {} so spawned panes get their own session \
         identity",
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
    fn multiplexer_and_electron_launcher_markers_are_picked() {
        let env = [
            "TMUX",
            "TMUX_PANE",
            "STY",
            "ZELLIJ",
            "ZELLIJ_SESSION_NAME",
            "ZELLIJ_PANE_ID",
            "ELECTRON_RUN_AS_NODE",
            "TERM",
        ];
        let hits = markers_in(env.iter().map(|s| s.to_string()));
        assert_eq!(
            hits,
            vec![
                "ELECTRON_RUN_AS_NODE",
                "STY",
                "TMUX",
                "TMUX_PANE",
                "ZELLIJ",
                "ZELLIJ_PANE_ID",
                "ZELLIJ_SESSION_NAME"
            ]
        );
    }

    #[test]
    fn a_clean_environment_yields_nothing_to_drop() {
        let hits = markers_in(["PATH", "HOME", "SHELL"].iter().map(|s| s.to_string()));
        assert!(hits.is_empty(), "{hits:?}");
    }
}

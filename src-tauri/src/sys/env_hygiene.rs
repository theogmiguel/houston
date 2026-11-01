//! Drop inherited agent-session and multiplexer identities, variables Houston injects
//! into panes, and supervisor startup state before the daemon spawns children. Agent
//! settings such as `CLAUDE_CONFIG_DIR` and `ANTHROPIC_*` remain available.
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
const WORKSPACE_ENV: &str = "HOUSTON_WORKSPACE";
const WORKTREE_SLUG_ENV: &str = "HOUSTON_WORKTREE_SLUG";
const SUPERVISOR_FD_ENV: &str = "HOUSTON_SUPERVISOR_FD";
const URL_ENV_PREFIX: &str = "ZCODE_HOUSTON_MCP_URL";
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
    // Each pane is given its own; a daemon started from a pane must not pass that pane's on.
    WORKSPACE_ENV,
    WORKTREE_SLUG_ENV,
    SUPERVISOR_FD_ENV,
    // Set only for some providers, so panes without their own would inherit the hosting
    // channel's endpoint and credential. `HOUSTON_SESSION`/`TR_SESSION` stay: every pane
    // sets them, and the app reads `HOUSTON_SESSION` for `--fresh`.
    "HOUSTON_MCP_URL",
    "HOUSTON_MCP_TOKEN",
    "HOUSTON_MCP_CONFIG",
    "HOUSTON_TOOL_BOUNDARY_CONTEXT",
    "HOUSTON_CODEX_LAUNCHER",
    "HOUSTON_CODEX_CLI",
    "HOUSTON_CODEX_HOOK_DROP_DIR",
    "HOUSTON_USER_ZDOTDIR",
    "HOUSTON_SHELL_INTEGRATION_TOKEN_FILE",
    "HOUSTON_TASK",
    "HOUSTON_ROUTINE_RUN",
    "HOUSTON_NIGHT_RUN_DIR",
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

/// Whether `name` is one of the launcher variables the daemon drops. ZCode's MCP URL
/// carries the channel in its name (`ZCODE_HOUSTON_MCP_URL[_<CHANNEL>]`), so it matches
/// by prefix.
pub fn is_marker(name: &str) -> bool {
    SESSION_MARKERS.contains(&name) || name.starts_with(URL_ENV_PREFIX)
}

pub fn markers_in(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut hits: Vec<String> = keys.filter(|k| is_marker(k)).collect();
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
            "HOUSTON_WORKSPACE",
            "HOUSTON_WORKTREE_SLUG",
        ];
        let hits = markers_in(env.iter().map(|s| s.to_string()));
        assert_eq!(
            hits,
            vec![
                "CLAUDECODE",
                "CLAUDE_CODE_CHILD_SESSION",
                "CLAUDE_CODE_SESSION_ID",
                "HOUSTON_WORKSPACE",
                "HOUSTON_WORKTREE_SLUG"
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
    fn variables_houston_injects_into_a_pane_are_picked_even_when_the_pane_inherits_them() {
        let env = [
            "HOUSTON_MCP_URL",
            "HOUSTON_MCP_TOKEN",
            "HOUSTON_MCP_CONFIG",
            "HOUSTON_TOOL_BOUNDARY_CONTEXT",
            "HOUSTON_CODEX_LAUNCHER",
            "HOUSTON_CODEX_CLI",
            "HOUSTON_CODEX_HOOK_DROP_DIR",
            "HOUSTON_USER_ZDOTDIR",
            "HOUSTON_SHELL_INTEGRATION_TOKEN_FILE",
            "HOUSTON_TASK",
            "HOUSTON_ROUTINE_RUN",
            "HOUSTON_NIGHT_RUN_DIR",
            "ZCODE_HOUSTON_MCP_URL",
            "ZCODE_HOUSTON_MCP_URL_DEV",
            "HOUSTON_CHANNEL",
            "HOUSTON_SESSION",
            "ZCODE_DISABLE_UPDATE_CHECK",
        ];
        let hits = markers_in(env.iter().map(|s| s.to_string()));
        assert_eq!(hits.len(), 14, "{hits:?}");
        for kept in [
            "HOUSTON_CHANNEL",
            "HOUSTON_SESSION",
            "ZCODE_DISABLE_UPDATE_CHECK",
        ] {
            assert!(
                !hits.iter().any(|h| h == kept),
                "{kept} must stay: {hits:?}"
            );
        }
    }

    #[test]
    fn a_clean_environment_yields_nothing_to_drop() {
        let hits = markers_in(["PATH", "HOME", "SHELL"].iter().map(|s| s.to_string()));
        assert!(hits.is_empty(), "{hits:?}");
    }
}

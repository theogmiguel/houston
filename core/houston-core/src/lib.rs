pub mod acp;
#[cfg(unix)]
pub mod adoption;
pub mod agent_accounts;
pub mod agent_events;
pub mod agent_hooks;
pub mod agents;
pub mod antigravity_transcript;
pub mod blocks;
pub mod boot;
pub mod browser_relay;
pub mod checkpoints;
pub mod claude_hooks;
pub mod cli_probe;
pub mod context_window;
pub mod daemon;
pub mod db;
pub mod env_hygiene;
pub mod exe_path;
pub mod frame_queue;
pub mod fs_watch;
pub mod gh;
pub mod git;
pub mod handoff;
pub mod harness;
pub mod home_dir;
pub mod hook_drop;
pub mod hook_state;
pub mod launch;
pub mod legacy_hook_sweep;
pub mod lock;
pub mod logging;
pub mod login_path;
pub mod markers;
pub mod mcp;
pub mod mcp_check;
pub mod mcp_creds;
pub mod mcp_harness;
pub mod mcp_launch;
pub mod mcp_orchestration;
pub mod mcp_register;
pub mod mcp_register_antigravity;
pub mod mcp_register_codex;
pub mod mcp_register_cursor;
pub mod mcp_register_grok;
pub mod mcp_server;
pub mod model_catalog;
pub mod orchestrate;
pub mod osc52;
pub mod osc_title;
pub mod pane_name;
pub mod paths;
pub mod pid;
pub mod pull_requests;
pub mod routines;
pub mod sanitize;
pub mod scope;
pub mod scrollback;
pub mod server;
pub mod shellint;
pub mod skill_sync;
pub mod spawn;
pub mod ssh;
pub mod ssh_config;
pub mod ssh_credentials;
pub mod statusline_sweep;
pub mod supervisor;
pub mod updates;
pub mod usage;
pub mod voice;
pub mod vt;
pub mod worktree_cleanup;
pub mod worktrees;

#[cfg(test)]
pub mod test_tracing_capture;

#[cfg(feature = "test-barriers")]
#[doc(hidden)]
pub mod test_barriers {
    pub fn pause(point: &str, subject: u32) {
        let Some(directory) = std::env::var_os("HOUSTON_TEST_BARRIER_DIR") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let armed = directory.join("armed");
        if std::fs::read_to_string(&armed).ok().as_deref() != Some(point) {
            return;
        }
        std::fs::write(directory.join("reached"), format!("{point} {subject}"))
            .expect("barrier receipt");
        while std::fs::read_to_string(&armed).ok().as_deref() == Some(point) {
            // A short test-only pause keeps barrier release responsive without busy spinning.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

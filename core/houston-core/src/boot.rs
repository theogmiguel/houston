use crate::daemon::Daemon;
use std::sync::Arc;

/// Both hosts (the standalone binary and the in-process app host) call this
/// instead of each spawning loops themselves, so the set can never drift
/// between them.
pub fn spawn_background_loops(daemon: &Arc<Daemon>) {
    let swarm_mail = daemon.clone();
    tokio::spawn(async move { swarm_mail.swarm_mail_loop().await });
    let delegations = daemon.clone();
    tokio::spawn(async move { delegations.delegation_watch_loop().await });
    let routines = daemon.clone();
    tokio::spawn(async move { routines.routine_fire_loop().await });
    let updates = daemon.clone();
    tokio::spawn(async move { updates.update_check_loop().await });
}

/// Runs off the async runtime via `spawn_blocking` so the window can paint
/// before every known workspace's hook files are refreshed.
pub fn spawn_startup_refresh(daemon: &Arc<Daemon>) {
    let bound_port = daemon.bound_port();
    let daemon = daemon.clone();
    tokio::task::spawn_blocking(move || {
        daemon.sweep_legacy_hooks();
        daemon.install_all_workspace_hooks();
        daemon.install_consented_agent_hooks();
    });
    crate::mcp_register::spawn_at_boot();
    crate::mcp_register_codex::spawn_at_boot(bound_port);
    crate::mcp_register_grok::spawn_at_boot();
    crate::mcp_register_cursor::spawn_at_boot();
    crate::mcp_register_antigravity::spawn_at_boot();
}

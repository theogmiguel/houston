use crate::daemon::Daemon;
use std::sync::Arc;

/// The standalone daemon owns these loops. The desktop app connects as a client
/// and must not start another copy in its own process.
pub fn spawn_background_loops(daemon: &Arc<Daemon>) {
    let swarm_mail = daemon.clone();
    tokio::spawn(async move { swarm_mail.swarm_mail_loop().await });
    let delegations = daemon.clone();
    tokio::spawn(async move { delegations.delegation_watch_loop().await });
    let routines = daemon.clone();
    tokio::spawn(async move { routines.routine_fire_loop().await });
    let updates = daemon.clone();
    tokio::spawn(async move { updates.update_check_loop().await });
    tokio::spawn(daemon.clone().worktree_cleanup_loop());
    // Read-only and local: no switch, and idle without an orchestrator's worktree.
    tokio::spawn(daemon.clone().conflict_prediction_loop());
    // Not gated by worktree_cleanup_enabled: closing a task on its merged PR
    // is task behaviour, and the sweep above has its own switch.
    tokio::spawn(daemon.clone().task_pr_watch_loop());
    // Idle until Settings > Remote access turns the listener on.
    tokio::spawn(daemon.clone().remote_loops());
    tokio::spawn(daemon.clone().pr_watch_loop());
    // Idle until a workspace has a merge queue; a pause stops its pushes and merges.
    tokio::spawn(daemon.clone().merge_queue_loop());
    tokio::spawn(crate::checkout_watch::checkout_watch_loop(daemon.clone()));
    // Idle until Settings ▸ Slack turns the intake on.
    tokio::spawn(daemon.clone().slack_loops());
    // Idle until a workspace opts into a task tracker.
    tokio::spawn(daemon.clone().task_tracker_loop());
    // Windows only; parks until a session spawns or produces output.
    tokio::spawn(crate::power_throttling::sweep_loop());
}

/// Runs off the async runtime via `spawn_blocking` so the window can paint
/// before the agent hook configs are refreshed.
pub fn spawn_startup_refresh(daemon: &Arc<Daemon>) {
    let bound_port = daemon.bound_port();
    let env = daemon.env();
    let daemon = daemon.clone();
    tokio::task::spawn_blocking(move || {
        daemon.sweep_legacy_hooks();
        daemon.install_consented_agent_hooks();
    });
    crate::mcp_register::spawn_at_boot(env.clone());
    crate::mcp_register_codex::spawn_at_boot(env.clone(), bound_port);
    crate::mcp_register_antigravity::spawn_at_boot(env.clone());
}

#![allow(clippy::disallowed_methods)]

use crate::common;

use common::{collect_broadcast_until, TOKEN};
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

const DONE: &str = "PANE-ENV-PROBE-DONE";

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "test@example.invalid"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README.md"), "pane env\n").unwrap();
    git(dir, &["add", "README.md"]);
    git(dir, &["commit", "-q", "-m", "initial"]);
}

fn daemon(state: &Path, env: houston_core::host_env::HostEnv) -> Arc<Daemon> {
    Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state.join("test.db"),
        env,
    ))
    .unwrap()
}

/// A command that writes the pane's workspace and slug (or `unset`) to `out`, then prints DONE.
fn probe_argv(out: &Path) -> Vec<String> {
    #[cfg(unix)]
    let argv = vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "printf '%s\\n%s\\n' \"$HOUSTON_WORKSPACE\" \"${{HOUSTON_WORKTREE_SLUG-unset}}\" > '{}'; echo {DONE}",
            out.display()
        ),
    ];
    #[cfg(windows)]
    let argv = vec![
        "powershell".to_string(),
        "-NoProfile".to_string(),
        "-Command".to_string(),
        format!(
            "$slug = if ($null -eq $env:HOUSTON_WORKTREE_SLUG) {{ 'unset' }} else {{ $env:HOUSTON_WORKTREE_SLUG }}; \
             Set-Content -LiteralPath '{}' -Value @($env:HOUSTON_WORKSPACE, $slug); Write-Output {DONE}",
            out.display()
        ),
    ];
    argv
}

async fn probe(daemon: &Arc<Daemon>, dir: &Path, out: &Path) -> (String, String) {
    let mut rx = daemon.observe();
    let id = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: dir.to_path_buf(),
            cmd: Some(probe_argv(out)),
            cols: 120,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap()
        .id;
    collect_broadcast_until(&mut rx, id, DONE).await;
    let text = std::fs::read_to_string(out).unwrap();
    let mut lines = text.lines().map(str::to_string);
    (lines.next().unwrap(), lines.next().unwrap())
}

fn same_dir(reported: &str, expected: &Path) -> bool {
    Path::new(reported).canonicalize().ok() == expected.canonicalize().ok()
}

#[tokio::test]
async fn a_pane_names_its_workspace_and_drops_an_inherited_worktree_slug() {
    let state = tempfile::tempdir().unwrap();
    let env = common::capture_env().with("HOUSTON_WORKTREE_SLUG", Some("stale-launcher-slug"));
    let daemon = daemon(state.path(), env);
    let workspace = tempfile::tempdir().unwrap();
    let out = state.path().join("probe.txt");

    let (reported, slug) = probe(&daemon, workspace.path(), &out).await;

    assert!(
        same_dir(&reported, workspace.path()),
        "HOUSTON_WORKSPACE {reported:?} names {}",
        workspace.path().display()
    );
    assert_eq!(slug, "unset");
}

#[tokio::test]
async fn a_pane_in_a_managed_worktree_names_its_slug() {
    let state = tempfile::tempdir().unwrap();
    let daemon = daemon(state.path(), common::capture_env());
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let (worktree, _) = daemon
        .git_worktree_create(repo.path(), "env-slug", None)
        .unwrap();
    let out = state.path().join("probe.txt");

    let (reported, slug) = probe(&daemon, &worktree.path, &out).await;

    assert!(
        same_dir(&reported, &worktree.path),
        "HOUSTON_WORKSPACE {reported:?} names {}",
        worktree.path.display()
    );
    assert_eq!(slug, "env-slug");
}

#[cfg(unix)]
#[tokio::test]
async fn a_shell_pane_names_its_workspace() {
    let state = tempfile::tempdir().unwrap();
    let daemon = daemon(
        state.path(),
        common::capture_env().with("SHELL", Some("/bin/sh")),
    );
    let workspace = tempfile::tempdir().unwrap();
    let out = state.path().join("probe.txt");
    let mut rx = daemon.observe();
    let id = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: workspace.path().to_path_buf(),
            cmd: None,
            cols: 120,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap()
        .id;
    let line = format!(
        "printf '%s\\n' \"$HOUSTON_WORKSPACE\" > '{}'; echo {DONE}-$((1+1))\n",
        out.display()
    );
    daemon.write_stdin(id, line.as_bytes()).unwrap();
    collect_broadcast_until(&mut rx, id, &format!("{DONE}-2")).await;

    let reported = std::fs::read_to_string(&out).unwrap();
    assert!(
        same_dir(reported.trim_end(), workspace.path()),
        "HOUSTON_WORKSPACE {reported:?} names {}",
        workspace.path().display()
    );
    let _ = daemon.kill(id);
}

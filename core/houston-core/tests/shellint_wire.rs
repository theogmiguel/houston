#![cfg(unix)]

mod common;

use common::*;
use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;

fn create_shell_session(daemon: &Arc<Daemon>, dir: &std::path::Path, integration: bool) -> u32 {
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: dir.to_path_buf(),
            cmd: None,
            cols: 120,
            rows: 40,
            cwd_from: None,
            shell_integration: integration,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
        })
        .unwrap()
        .id
}

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pin_env(home: &std::path::Path) -> tokio::sync::MutexGuard<'static, ()> {
    let guard = ENV_LOCK.lock().await;
    std::env::set_var("HOME", home);
    std::env::set_var("SHELL", "/bin/bash");
    guard
}

async fn poll<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    for _ in 0..200 {
        if let Some(v) = f() {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

#[cfg(unix)]
#[tokio::test]
async fn bash_markers_become_blocks_and_ledger_rows() {
    let fake_home = tempfile::tempdir().unwrap();
    let _env = pin_env(fake_home.path()).await;

    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir(project.path().join("subdir")).unwrap();

    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: db_path.clone(),
    })
    .unwrap();

    let mut rx = daemon.observe();
    let id = create_shell_session(&daemon, project.path(), true);

    collect_broadcast_until(&mut rx, id, "\u{1b}]133;A").await;

    daemon
        .write_stdin(id, b"echo tr-wire-marker-test\n")
        .unwrap();
    collect_broadcast_until(&mut rx, id, "tr-wire-marker-test").await;

    let block = poll("command block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("tr-wire-marker-test"))
    })
    .await;
    assert_eq!(block.exit, Some(0));
    assert!(
        block.end_offset > block.start_offset,
        "block spans output bytes: {}..{}",
        block.start_offset,
        block.end_offset
    );
    assert!(!block.cwd.is_empty(), "OSC 9;9 filled the block cwd");

    let ws_key = project.path().display().to_string();
    let row = poll("ledger row", || {
        let conn = rusqlite::Connection::open(&db_path).ok()?;
        conn.query_row(
            "SELECT cmd, shell, exit_code FROM command_history WHERE workspace = ?1
             AND cmd LIKE '%tr-wire-marker-test%'",
            rusqlite::params![ws_key],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i32>>(2)?,
                ))
            },
        )
        .ok()
    })
    .await;
    assert_eq!(row.1, "bash");
    assert_eq!(row.2, Some(0));

    daemon
        .write_stdin(id, b"cd subdir && echo tr-after-cd\n")
        .unwrap();
    collect_broadcast_until(&mut rx, id, "tr-after-cd").await;
    let cd_block = poll("post-cd block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("tr-after-cd"))
    })
    .await;
    daemon.write_stdin(id, b"echo tr-third\n").unwrap();
    collect_broadcast_until(&mut rx, id, "tr-third").await;
    let third = poll("third block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("tr-third"))
    })
    .await;
    assert!(
        third.cwd.ends_with("subdir"),
        "OSC 9;9 tracked the cd, got {:?} (cd block cwd {:?})",
        third.cwd,
        cd_block.cwd
    );

    daemon.kill(id).ok();
}

#[cfg(unix)]
#[tokio::test]
async fn program_output_cannot_forge_markers_and_child_environment_is_clean() {
    let fake_home = tempfile::tempdir().unwrap();
    let _env = pin_env(fake_home.path()).await;

    let state_dir = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();

    let mut rx = daemon.observe();
    let id = create_shell_session(&daemon, project.path(), true);
    collect_broadcast_until(&mut rx, id, "\u{1b}]133;A").await;

    daemon
        .write_stdin(
            id,
            b"printf '\\033]133;C;Zm9yZ2Vk\\007\\033]133;D;0\\007\\033]9;9;/forged\\007'; echo tr-forgery-fence\n",
        )
        .unwrap();
    collect_broadcast_until(&mut rx, id, "tr-forgery-fence").await;
    let real = poll("real command block after forged output", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("tr-forgery-fence"))
    })
    .await;
    assert_ne!(real.cmd, "forged");
    assert_ne!(real.cwd, "/forged");
    assert!(
        !daemon.command_blocks(id).iter().any(|b| b.cmd == "forged"),
        "program output fabricated a command block"
    );

    daemon
        .write_stdin(
            id,
            b"sh -c 'test -z \"${HOUSTON_SHELL_INTEGRATION_TOKEN_FILE+x}\"'\n",
        )
        .unwrap();
    let env_check = poll("child environment check block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("HOUSTON_SHELL_INTEGRATION_TOKEN_FILE+x"))
    })
    .await;
    assert_eq!(
        env_check.exit,
        Some(0),
        "child process inherited the token-file path"
    );

    #[cfg(target_os = "linux")]
    {
        daemon
            .write_stdin(
                id,
                b"token_file=$(tr '\\0' '\\n' < /proc/$$/environ | sed -n 's/^HOUSTON_SHELL_INTEGRATION_TOKEN_FILE=//p'); test -n \"$token_file\" && test ! -e \"$token_file\"\n",
            )
            .unwrap();
        let token_file_check = poll("token file cleanup block", || {
            daemon
                .command_blocks(id)
                .into_iter()
                .find(|b| b.cmd.contains("HOUSTON_SHELL_INTEGRATION_TOKEN_FILE="))
        })
        .await;
        assert_eq!(
            token_file_check.exit,
            Some(0),
            "token file must be gone after the first prompt"
        );
    }

    daemon.kill(id).ok();
}

#[cfg(unix)]
#[tokio::test]
async fn integration_can_be_disabled_per_spawn() {
    let fake_home = tempfile::tempdir().unwrap();
    let _env = pin_env(fake_home.path()).await;

    let state_dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();
    let project = tempfile::tempdir().unwrap();

    let mut rx = daemon.observe();
    let id = create_shell_session(&daemon, project.path(), false);

    daemon.write_stdin(id, b"echo tr-plain-shell\n").unwrap();
    let out = collect_broadcast_until(&mut rx, id, "tr-plain-shell").await;
    assert!(
        !out.contains("\u{1b}]133;"),
        "un-integrated shell must not emit FTCS markers"
    );

    daemon.kill(id).ok();
}

#[cfg(unix)]
#[tokio::test]
async fn user_prompt_command_never_fabricates_blocks_or_exit_codes() {
    let fake_home = tempfile::tempdir().unwrap();
    std::fs::write(
        fake_home.path().join(".bashrc"),
        "__user_pc() { :; }\nPROMPT_COMMAND='history -a; __user_pc'\n",
    )
    .unwrap();
    let _env = pin_env(fake_home.path()).await;

    let state_dir = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path: state_dir.path().join("test.db"),
    })
    .unwrap();

    let mut rx = daemon.observe();
    let id = create_shell_session(&daemon, project.path(), true);
    collect_broadcast_until(&mut rx, id, "\u{1b}]133;A").await;

    daemon.write_stdin(id, b"false\n").unwrap();
    collect_broadcast_until(&mut rx, id, "\u{1b}]133;D;").await;
    let block = poll("false block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("false"))
    })
    .await;
    assert_eq!(
        block.exit,
        Some(1),
        "user command's exit code, not the PC's"
    );

    daemon.write_stdin(id, b"\n\n").unwrap();
    daemon.write_stdin(id, b"echo tr-fence\n").unwrap();
    collect_broadcast_until(&mut rx, id, "tr-fence").await;
    poll("fence block", || {
        daemon
            .command_blocks(id)
            .into_iter()
            .find(|b| b.cmd.contains("tr-fence"))
    })
    .await;

    let blocks = daemon.command_blocks(id);
    assert_eq!(
        blocks.len(),
        2,
        "exactly false + fence; empty Enters fabricated: {:?}",
        blocks.iter().map(|b| &b.cmd).collect::<Vec<_>>()
    );

    daemon.kill(id).ok();
}

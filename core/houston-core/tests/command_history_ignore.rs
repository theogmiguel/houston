mod common;

use houston_core::daemon::{Daemon, DaemonConfig};
use std::path::Path;
use std::sync::Arc;

fn daemon(state_dir: &Path) -> Arc<Daemon> {
    Daemon::new(DaemonConfig {
        token: "test-token".to_string(),
        db_path: state_dir.join("test.db"),
    })
    .unwrap()
}

fn with_globs(d: &Arc<Daemon>, globs: &[&str]) {
    let owned: Vec<String> = globs.iter().map(|g| (*g).to_string()).collect();
    d.set_command_history_ignore_globs(&owned).unwrap();
}

#[test]
fn matches_paths_under_an_ignored_dir_but_not_the_dir_itself() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    with_globs(&d, &["**/secrets/**"]);

    assert!(d.command_history_ignored("ls", "/home/t/secrets/prod"));
    assert!(
        !d.command_history_ignored("ls", "/home/t/secrets"),
        "documented edge, shared with the memory ledger — a user who wants the \
         directory itself covered writes a glob that says so"
    );
}

#[test]
fn records_everything_when_no_globs_are_configured() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    assert!(d.command_history_ignore_globs().is_empty());
    assert!(!d.command_history_ignored("cat .env", "/home/t/secrets"));
}

#[test]
fn drops_a_command_that_names_an_ignored_path() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    with_globs(&d, &["**/secrets/**"]);

    assert!(d.command_history_ignored("vim config/secrets/db.yaml", "/home/t/proj"));
    assert!(
        !d.command_history_ignored("vim config/app.yaml", "/home/t/proj"),
        "an unrelated command in an unrelated directory is still recorded"
    );
}

#[test]
fn drops_a_command_run_inside_an_ignored_directory() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    with_globs(&d, &["**/secrets/**"]);

    assert!(d.command_history_ignored("cat .env", "/home/t/secrets/prod"));
}

#[test]
fn matches_the_same_way_the_memory_ledger_does() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    with_globs(&d, &["**/secrets/**", "*.pem"]);

    for (cmd, cwd) in [
        ("scp deploy.pem host:", "/home/t/proj"),
        ("ls", "/home/t/secrets/prod"),
    ] {
        assert!(
            d.command_history_ignored(cmd, cwd),
            "expected {cmd:?} in {cwd:?} to be ignored"
        );
        assert!(
            houston_core::sanitize::matches_ignored(cmd, &["**/secrets/**".into(), "*.pem".into()])
                || houston_core::sanitize::matches_ignored(
                    cwd,
                    &["**/secrets/**".into(), "*.pem".into()]
                ),
            "and to be ignored by the shared matcher for the same reason"
        );
    }
}

#[test]
fn honours_a_glob_added_between_two_commands() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());

    assert!(!d.command_history_ignored("cat notes.txt", "/home/t/journal/2026"));
    with_globs(&d, &["**/journal/**"]);
    assert!(d.command_history_ignored("cat notes.txt", "/home/t/journal/2026"));
}

#[test]
fn set_over_the_count_cap_refuses_and_leaves_the_stored_list_alone() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());
    with_globs(&d, &["**/secrets/**"]);

    let too_many: Vec<String> = (0..65).map(|i| format!("pattern-{i}")).collect();
    let err = d
        .set_command_history_ignore_globs(&too_many)
        .expect_err("65 patterns is over the 64 cap");
    let msg = format!("{err:#}");
    assert!(
        msg.contains('6') && msg.contains("64"),
        "must name the cap: {msg}"
    );
    assert!(msg.contains("65"), "must name what was asked for: {msg}");
    assert_eq!(
        d.command_history_ignore_globs(),
        vec!["**/secrets/**".to_string()],
        "a refused set must not truncate the list to fit: refused, never truncated"
    );
}

#[test]
fn set_with_an_oversize_pattern_refuses_naming_its_length() {
    let state = tempfile::tempdir().unwrap();
    let d = daemon(state.path());

    let oversize = "*".repeat(201);
    let err = d
        .set_command_history_ignore_globs(&[oversize])
        .expect_err("a 201-byte pattern is over the 200-byte cap");
    let msg = format!("{err:#}");
    assert!(msg.contains("201"), "{msg}");
    assert!(msg.contains("200"), "{msg}");
}

async fn next_globs(ws: &mut common::WsStream) -> Vec<String> {
    use houston_protocol as proto;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::CommandHistoryIgnoreGlobs { globs } => return globs,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn get_and_set_round_trip_over_the_wire() {
    use futures_util::SinkExt;
    use houston_protocol as proto;
    use tokio_tungstenite::tungstenite::Message;

    let (addr, _state, daemon) = common::start_daemon_with_handle().await;
    let mut ws = common::connect_and_hello(addr, common::TOKEN).await;

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::CommandHistoryIgnoreGlobsGet).unwrap(),
    ))
    .await
    .unwrap();
    assert_eq!(next_globs(&mut ws).await, Vec::<String>::new());

    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::CommandHistoryIgnoreGlobsSet {
            globs: vec!["*.pem".to_string()],
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    assert_eq!(next_globs(&mut ws).await, vec!["*.pem".to_string()]);
    assert_eq!(
        daemon.command_history_ignore_globs(),
        vec!["*.pem".to_string()]
    );
}

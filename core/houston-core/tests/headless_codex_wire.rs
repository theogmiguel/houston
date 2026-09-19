#![cfg(unix)]

mod common;

use houston_core::headless::{self, TurnRequest};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn shim(dir: &Path, fixture: &str) -> PathBuf {
    let argv = dir.join("argv.txt");
    let fixture_path = format!(
        "{}/tests/fixtures/headless/codex/{fixture}",
        env!("CARGO_MANIFEST_DIR")
    );
    let script = format!(
        "#!/bin/sh\n\
         : > {argv}\n\
         for a in \"$@\"; do printf '%s\\n' \"$a\" >> {argv}; done\n\
         cat '{fixture_path}'\n",
        argv = argv.display(),
    );
    let exe = dir.join("codex");
    std::fs::write(&exe, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    exe
}

fn req(cwd: &Path) -> TurnRequest {
    TurnRequest {
        cwd: cwd.to_path_buf(),
        prompt: "reply with OK".into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn one_shot_runs_the_read_only_argv_and_decodes_the_agent_message() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = shim(tmp.path(), "text_only.ndjson");
    let engine = headless::engine_for(proto::AgentKind::Codex).expect("codex is registered");

    let mut r = req(tmp.path());
    r.one_shot = true;
    let outcome = headless::one_shot(engine, &exe, &r, Duration::from_secs(10))
        .await
        .expect("the shim answers");

    assert_eq!(outcome.text, "OK");

    let argv = std::fs::read_to_string(tmp.path().join("argv.txt")).expect("argv dump");
    let args: Vec<&str> = argv.lines().collect();
    assert_eq!(
        args,
        vec![
            "exec",
            "--json",
            "-C",
            tmp.path().to_str().unwrap(),
            "-s",
            "read-only",
            "reply with OK",
        ],
        "a one-shot call must always sandbox read-only, D2, regardless of \
         the mode field it never sets: {args:?}"
    );
}

#[tokio::test]
async fn a_resumed_turn_carries_no_cd_or_sandbox_flag_to_the_real_process() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = shim(tmp.path(), "resume.ndjson");
    let engine = headless::engine_for(proto::AgentKind::Codex).expect("codex is registered");

    let mut r = req(tmp.path());
    r.resume = Some("01a069da-9814-7690-b690-e4d1e9190e85".into());
    let outcome = headless::one_shot(engine, &exe, &r, Duration::from_secs(10))
        .await
        .expect("the shim answers");
    assert!(outcome.text.contains("Continuing from before"));

    let argv = std::fs::read_to_string(tmp.path().join("argv.txt")).expect("argv dump");
    let args: Vec<&str> = argv.lines().collect();
    assert_eq!(
        args,
        vec![
            "exec",
            "resume",
            "01a069da-9814-7690-b690-e4d1e9190e85",
            "--json",
            "reply with OK",
        ],
        "resume rejects -C and -s on the real CLI (verified against codex-cli \
         0.144.5); neither may reach the process: {args:?}"
    );
}

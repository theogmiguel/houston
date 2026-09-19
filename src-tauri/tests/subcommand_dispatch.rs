#![allow(clippy::disallowed_methods)]

use std::process::Command;

fn run(args: &[&str]) -> (bool, String, String) {
    let home = tempfile::tempdir().expect("tempdir");
    let output = Command::new(env!("CARGO_BIN_EXE_houston-tauri"))
        .env_clear()
        .env("HOME", home.path())
        .args(args)
        .output()
        .expect("failed to run houston-tauri");
    let sandbox_contents: Vec<_> = std::fs::read_dir(home.path())
        .expect("read sandbox home")
        .collect();
    assert!(
        sandbox_contents.is_empty(),
        "subcommand dispatch for {args:?} must have zero side effects on the sandbox HOME, \
         found: {sandbox_contents:?}"
    );
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn hook_argv_is_dispatched_before_the_unrecognized_arg_gate() {
    let (success, stdout, stderr) = run(&["hook", "Stop", "--houston-managed=dev"]);
    assert!(
        success,
        "`hook Stop --houston-managed=dev` must be dispatched to run_hook_client and \
         exit 0, not fall through to reject_unrecognized_args; stdout={stdout:?} stderr={stderr:?}"
    );
    assert!(
        !stderr.contains("unrecognized argument"),
        "hook argv must never reach reject_unrecognized_args's refusal, got: {stderr}"
    );
}

#[test]
fn hs_mail_argv_is_dispatched_before_the_unrecognized_arg_gate() {
    let (_success, stdout, stderr) = run(&["hs-mail", "send"]);
    let combined = format!("{stdout}{stderr}");
    assert!(
        combined.contains("hs-mail is gone"),
        "hs-mail argv must be refused by the dispatch's own retirement message, not the argv \
         gate; stdout={stdout:?} stderr={stderr:?}"
    );
    assert!(
        combined.contains("pane_submit"),
        "the refusal must name the replacement: {combined}"
    );
    assert!(
        !combined.contains("unrecognized argument"),
        "hs-mail argv must never reach reject_unrecognized_args's refusal, got: {combined}"
    );
}

#[test]
fn hs_pane_argv_is_dispatched_before_the_unrecognized_arg_gate() {
    let (_success, stdout, stderr) = run(&["hs-pane", "whoami"]);
    let combined = format!("{stdout}{stderr}");
    assert!(
        combined.contains("HOUSTON_SESSION is not set"),
        "hs-pane whoami with no HOUSTON_SESSION must be refused by run_pane_cli's own \
         check, not the argv gate; stdout={stdout:?} stderr={stderr:?}"
    );
    assert!(
        !combined.contains("unrecognized argument"),
        "hs-pane argv must never reach reject_unrecognized_args's refusal, got: {combined}"
    );
}

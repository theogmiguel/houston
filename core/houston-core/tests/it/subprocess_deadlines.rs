#![cfg(target_os = "linux")]

use houston_core::spawn::{command, output_within, output_within_with_stdin};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[test]
fn normal_output_and_closed_stdin_are_preserved() {
    let mut cmd = command("sh");
    cmd.args(["-c", "read x; printf out; printf err >&2; exit 7"]);
    let out = output_within(cmd, Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(out.status.code(), Some(7));
    assert_eq!(out.stdout, b"out");
    assert_eq!(out.stderr, b"err");
}

#[test]
fn root_exit_does_not_end_the_pipe_deadline() {
    let mut cmd = command("sh");
    // Bounded descendants also finish naturally if the regression fails.
    cmd.args(["-c", "sleep 1 & exit 0"]);
    let start = Instant::now();
    assert!(output_within(cmd, Duration::from_millis(50))
        .unwrap()
        .is_none());
    assert!(start.elapsed() < Duration::from_millis(750));
}

#[test]
fn continuous_output_fails_at_the_combined_limit() {
    let mut cmd = command("sh");
    cmd.args(["-c", "head -c 9000000 /dev/zero; sleep 1"]);
    let start = Instant::now();
    let error = output_within(cmd, Duration::from_secs(3)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("combined output limit is 8388608 bytes"),
        "{error}"
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn file_stdin_is_delivered_directly_and_nonreader_times_out() {
    let file = tempfile::tempfile().unwrap();
    file.set_len(16 * 1024 * 1024).unwrap();
    let mut cmd = command("sh");
    cmd.args(["-c", "sleep 1"]);
    let start = Instant::now();
    assert!(
        output_within_with_stdin(cmd, Duration::from_millis(50), Stdio::from(file))
            .unwrap()
            .is_none()
    );
    assert!(start.elapsed() < Duration::from_millis(750));

    let mut file = tempfile::tempfile().unwrap();
    use std::io::{Seek, Write};
    file.write_all(b"streamed payload").unwrap();
    file.rewind().unwrap();
    let out = output_within_with_stdin(command("cat"), Duration::from_secs(2), Stdio::from(file))
        .unwrap()
        .unwrap();
    assert_eq!(out.stdout, b"streamed payload");
}

#[test]
fn closed_pipes_do_not_hide_a_running_child() {
    let mut cmd = command("sh");
    cmd.args(["-c", "exec 1>&- 2>&-; sleep 1"]);
    let start = Instant::now();
    assert!(output_within(cmd, Duration::from_millis(50))
        .unwrap()
        .is_none());
    assert!(start.elapsed() < Duration::from_millis(750));
}

#[test]
fn descendants_without_pipes_are_cleaned_before_success() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("late-side-effect");
    let mut cmd = command("sh");
    cmd.args([
        "-c",
        "(sleep 0.2; touch \"$1\") >/dev/null 2>&1 & exit 0",
        "sh",
    ]);
    cmd.arg(&marker);
    assert!(output_within(cmd, Duration::from_secs(2))
        .unwrap()
        .unwrap()
        .status
        .success());
    std::thread::sleep(Duration::from_millis(350));
    assert!(
        !marker.exists(),
        "owned descendant survived capture cleanup"
    );
}

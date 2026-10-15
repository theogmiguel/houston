#![cfg(windows)]
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

use crate::common;
use houston_core::spawn::{command, output_within, output_within_with_stdin};
use std::io::{Read, Seek, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn fixture(mode: &str) -> Command {
    let mut cmd = command(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        &common::exact_path(module_path!(), "subprocess_fixture"),
        "--nocapture",
        "--quiet",
    ])
    .env("HOUSTON_SUBPROCESS_FIXTURE", mode);
    cmd
}

#[test]
fn subprocess_fixture() {
    let Some(mode) = std::env::var_os("HOUSTON_SUBPROCESS_FIXTURE") else {
        return;
    };
    match mode.to_str().unwrap() {
        "normal" => {
            let mut input = Vec::new();
            std::io::stdin().read_to_end(&mut input).unwrap();
            std::io::stdout().write_all(&input).unwrap();
            print!("fixture-out");
            eprint!("fixture-err");
            std::io::stdout().flush().unwrap();
            std::io::stderr().flush().unwrap();
            std::process::exit(7);
        }
        "held-pipes" | "side-effect" => {
            let side_effect = mode == "side-effect";
            let mut child = fixture(if side_effect { "marker" } else { "sleep" });
            if side_effect {
                use std::os::windows::io::AsRawHandle;
                use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
                // Redirecting the child's streams does not clear inheritance on
                // this fixture's original pipe handles. Exclude those as well.
                for handle in [
                    std::io::stdout().as_raw_handle(),
                    std::io::stderr().as_raw_handle(),
                ] {
                    // SAFETY: these live handles belong to this isolated fixture.
                    assert_ne!(
                        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) },
                        0,
                        "cannot clear pipe inheritance: {}",
                        std::io::Error::last_os_error()
                    );
                }
                child.stdout(Stdio::null()).stderr(Stdio::null());
            }
            let _descendant = child.spawn().unwrap();
            if !side_effect {
                std::fs::write(
                    std::env::var_os("HOUSTON_FIXTURE_MARKER").unwrap(),
                    b"root exited",
                )
                .unwrap();
            }
            std::process::exit(0);
        }
        "sleep" | "marker" => {
            std::thread::sleep(Duration::from_secs(3));
            if mode == "marker" {
                std::fs::write(std::env::var_os("HOUSTON_FIXTURE_MARKER").unwrap(), b"late")
                    .unwrap();
            }
        }
        "output-limit" => {
            let bytes = vec![b'x'; 4_500_000];
            let _ = std::io::stdout().write_all(&bytes);
            let _ = std::io::stdout().flush();
            let _ = std::io::stderr().write_all(&bytes);
        }
        "closed-pipes" => {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: this isolated fixture exits without using either handle again.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(std::io::stdout().as_raw_handle());
                windows_sys::Win32::Foundation::CloseHandle(std::io::stderr().as_raw_handle());
            }
            std::thread::sleep(Duration::from_secs(3));
            std::process::exit(0);
        }
        other => panic!("unknown fixture mode {other}"),
    }
    std::process::exit(0);
}

#[test]
fn normal_output_nonzero_exit_and_closed_stdin_are_preserved() {
    let out = output_within(fixture("normal"), Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&out.stdout).contains("fixture-out"));
    assert_eq!(out.stderr, b"fixture-err");
}

#[test]
fn root_exit_does_not_end_the_pipe_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("root-exited");
    let mut cmd = fixture("held-pipes");
    cmd.env("HOUSTON_FIXTURE_MARKER", &marker);
    let start = Instant::now();
    assert!(output_within(cmd, Duration::from_secs(1))
        .unwrap()
        .is_none());
    assert!(start.elapsed() < Duration::from_millis(2500));
    assert!(
        marker.exists(),
        "fixture must reach root exit before deadline"
    );
}

#[test]
fn continuous_output_fails_at_the_combined_limit() {
    let error = output_within(fixture("output-limit"), Duration::from_secs(10)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("combined output limit is 8388608 bytes"),
        "{error}"
    );
}

#[test]
fn file_stdin_streams_directly_and_nonreader_times_out() {
    let file = tempfile::tempfile().unwrap();
    file.set_len(16 * 1024 * 1024).unwrap();
    let start = Instant::now();
    assert!(output_within_with_stdin(
        fixture("sleep"),
        Duration::from_millis(500),
        Stdio::from(file)
    )
    .unwrap()
    .is_none());
    assert!(start.elapsed() < Duration::from_secs(2));
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(b"streamed payload").unwrap();
    file.rewind().unwrap();
    let out =
        output_within_with_stdin(fixture("normal"), Duration::from_secs(5), Stdio::from(file))
            .unwrap()
            .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("streamed payloadfixture-out"));
}

#[test]
fn closed_pipes_do_not_hide_a_running_root() {
    let start = Instant::now();
    assert!(
        output_within(fixture("closed-pipes"), Duration::from_secs(1))
            .unwrap()
            .is_none()
    );
    assert!(start.elapsed() < Duration::from_millis(2500));
}

#[test]
fn success_cancels_descendants_without_pipes() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("late-side-effect");
    let mut cmd = fixture("side-effect");
    cmd.env("HOUSTON_FIXTURE_MARKER", &marker);
    let start = Instant::now();
    assert!(output_within(cmd, Duration::from_secs(5))
        .unwrap()
        .unwrap()
        .status
        .success());
    assert!(
        start.elapsed() < Duration::from_millis(2500),
        "capture waited for the pipe-free descendant: {:?}",
        start.elapsed()
    );
    std::thread::sleep(Duration::from_millis(3500));
    assert!(!marker.exists(), "owned descendant survived job cleanup");
}

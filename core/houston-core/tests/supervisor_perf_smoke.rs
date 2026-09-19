#![allow(clippy::disallowed_methods)]
#![cfg(unix)]

use std::process::{Command, Stdio};
use std::time::Duration;

fn supervisor_bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-supervisor")
}

fn sleep_bin() -> String {
    let output = Command::new("which")
        .arg("sleep")
        .output()
        .expect("`which sleep` failed to run");
    assert!(output.status.success(), "`which sleep` did not find sleep");
    String::from_utf8(output.stdout)
        .expect("which output is not utf8")
        .trim()
        .to_string()
}

fn vmrss_kib(pid: u32) -> Option<u64> {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
}

const RSS_CEILING_MIB: f64 = 8.0;

#[test]
#[ignore = "perf smoke — run explicitly, release only (cargo test --release --test supervisor_perf_smoke -- --ignored --nocapture)"]
fn supervisor_rss_stays_near_the_floor_while_idle() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut child = Command::new(supervisor_bin())
        .arg("--channel-dir")
        .arg(dir.path())
        .arg("--daemon")
        .arg(sleep_bin())
        .arg("--")
        .arg("100")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn houston-supervisor");
    let pid = child.id();

    std::thread::sleep(Duration::from_secs(1));
    let mut last_kib: u64 = 0;
    for _ in 0..10 {
        if let Some(kib) = vmrss_kib(pid) {
            last_kib = kib;
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let _ = child.kill();
    let _ = child.wait();

    assert!(last_kib > 0, "never got a readable VmRSS for pid {pid}");
    let settled_mib = last_kib as f64 / 1024.0;
    println!(
        "houston-supervisor settled idle RSS: {settled_mib:.2} MiB (ceiling {RSS_CEILING_MIB} MiB)"
    );
    assert!(
        settled_mib <= RSS_CEILING_MIB,
        "houston-supervisor settled RSS {settled_mib:.2} MiB exceeds the {RSS_CEILING_MIB} MiB \
         ceiling -- it must stay std+libc/nix-only (no tokio, no tracing subscriber, no DB); a \
         new dependency on its code path is the likely cause"
    );
}

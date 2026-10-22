//! `hs-pane heavy -- <cmd>`: runs a heavy command only while holding the
//! daemon's one build slot, the same slot the merge queue verifies in.
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::json;

/// A lease the CLI stops renewing (its process died) frees the slot after this.
pub const LEASE_TTL_MS: i64 = 60_000;
/// Renewal comes well inside the TTL, so one slow round trip never loses it.
const RENEW_EVERY: Duration = Duration::from_secs(15);
/// How often a waiting CLI asks again.
const POLL_EVERY: Duration = Duration::from_secs(2);

/// The slot's holder, as the waiting CLI reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub session: u32,
    pub id: String,
    pub expires_at_ms: i64,
}

impl Lease {
    pub fn expired(&self, now_ms: i64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// The command after `--`, or every argument when there is none.
pub fn command_of(args: &[String]) -> Result<Vec<String>> {
    let cmd: Vec<String> = match args.iter().position(|a| a == "--") {
        Some(i) => args[i + 1..].to_vec(),
        None => args.to_vec(),
    };
    if cmd.is_empty() {
        bail!("usage: hs-pane heavy -- <command> [args]");
    }
    Ok(cmd)
}

/// Waits for the slot, runs the command, frees the slot; answers the
/// command's exit code. `call` is one request to the daemon's build-slot door.
pub fn run(
    args: &[String],
    call: &(dyn Fn(serde_json::Value) -> Result<serde_json::Value> + Sync),
) -> Result<i32> {
    let cmd = command_of(args)?;
    let started = Instant::now();
    let mut announced = false;
    let lease = loop {
        let v = call(json!({ "action": "acquire" }))?;
        if let Some(id) = v["lease"].as_str() {
            break id.to_string();
        }
        if !announced {
            eprintln!(
                "hs-pane heavy: waiting for the build slot, held by {}",
                v["holder"].as_str().unwrap_or("another build")
            );
            announced = true;
        }
        std::thread::sleep(POLL_EVERY);
    };
    eprintln!(
        "hs-pane heavy: waited {} s for the build slot; running {}",
        started.elapsed().as_secs(),
        cmd.join(" ")
    );
    let stop = std::sync::atomic::AtomicBool::new(false);
    let code = std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut last = Instant::now();
            while !stop.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(250));
                if last.elapsed() >= RENEW_EVERY {
                    last = Instant::now();
                    if let Err(e) = call(json!({ "action": "renew", "lease": lease })) {
                        eprintln!("hs-pane heavy: renewing the build slot: {e:#}");
                    }
                }
            }
        });
        let status = crate::spawn::command(&cmd[0]).args(&cmd[1..]).status();
        stop.store(true, std::sync::atomic::Ordering::Release);
        status
    });
    if let Err(e) = call(json!({ "action": "release", "lease": lease })) {
        eprintln!("hs-pane heavy: releasing the build slot: {e:#}");
    }
    let status = code.map_err(|e| anyhow!("running {}: {e}", cmd[0]))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_follows_the_separator() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            command_of(&args(&["--", "cargo", "test", "--", "x"])).unwrap(),
            ["cargo", "test", "--", "x"]
        );
        assert_eq!(command_of(&args(&["make"])).unwrap(), ["make"]);
        assert!(command_of(&args(&["--"])).is_err());
    }

    #[test]
    fn a_lease_expires_at_its_deadline() {
        let l = Lease {
            session: 1,
            id: "a".into(),
            expires_at_ms: 100,
        };
        assert!(!l.expired(99));
        assert!(l.expired(100));
    }
}

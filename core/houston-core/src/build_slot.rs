//! `hs-pane heavy -- <cmd>`: runs a heavy command only while holding the
//! daemon's one build slot, the same slot the merge queue verifies in.
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use serde_json::json;

/// A lease the CLI stops renewing (its process died) frees the slot after this.
pub const LEASE_TTL_MS: i64 = 60_000;
/// Renewal comes well inside the TTL, so one slow round trip never loses it.
const RENEW_EVERY: Duration = Duration::from_secs(15);
/// How often a waiting CLI asks again.
const POLL_EVERY: Duration = Duration::from_secs(2);
/// No build starts below this much free memory: a Rust core test build peaks
/// near 3.5 GiB, and the machine keeps the rest for the panes it hosts.
pub const MEMORY_FLOOR_MIB: u32 = 4 * 1024;

/// Why a build may not start now, if free memory is below the floor.
pub fn memory_hold(free_mib: Option<u32>) -> Option<String> {
    let free = free_mib?;
    (free < MEMORY_FLOOR_MIB).then(|| {
        format!("the memory floor ({free} MiB free, below the {MEMORY_FLOOR_MIB} MiB floor)")
    })
}

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
    run_with(
        args,
        call,
        RENEW_EVERY,
        Duration::from_millis(LEASE_TTL_MS as u64),
    )
}

/// `run`, with the renewal period and the lease's lifetime as the CLI sees
/// it. A lease that may have lapsed stops the command, so it never runs
/// beside a build that took the freed slot.
fn run_with(
    args: &[String],
    call: &(dyn Fn(serde_json::Value) -> Result<serde_json::Value> + Sync),
    renew_every: Duration,
    ttl: Duration,
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
    let mut child = match crate::spawn::command(&cmd[0]).args(&cmd[1..]).spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = call(json!({ "action": "release", "lease": lease }));
            bail!("running {}: {e}", cmd[0]);
        }
    };
    let mut renewed = Instant::now();
    let mut asked = Instant::now();
    let lapsed = loop {
        if let Some(status) = child.try_wait()? {
            break Ok(status);
        }
        std::thread::sleep(Duration::from_millis(50).min(renew_every));
        if asked.elapsed() >= renew_every {
            asked = Instant::now();
            match call(json!({ "action": "renew", "lease": lease })) {
                Ok(_) => renewed = Instant::now(),
                Err(e) => eprintln!("hs-pane heavy: renewing the build slot: {e:#}"),
            }
        }
        if renewed.elapsed() >= ttl {
            break Err(renewed.elapsed());
        }
    };
    match lapsed {
        Ok(status) => {
            if let Err(e) = call(json!({ "action": "release", "lease": lease })) {
                eprintln!("hs-pane heavy: releasing the build slot: {e:#}");
            }
            Ok(status.code().unwrap_or(1))
        }
        Err(since) => {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "hs-pane heavy: the build slot was not renewed for {} s (the lease lasts {} s), \
                 so another build may hold it now; {} was stopped. Run it again",
                since.as_secs(),
                ttl.as_secs(),
                cmd.join(" ")
            )
        }
    }
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
    fn the_memory_floor_holds_builds() {
        assert_eq!(memory_hold(None), None);
        assert_eq!(memory_hold(Some(MEMORY_FLOOR_MIB)), None);
        let held = memory_hold(Some(1024)).unwrap();
        assert!(held.contains("1024 MiB free") && held.contains("4096 MiB floor"), "{held}");
    }

    /// The command stops once its lease may have lapsed, and a renewed one
    /// runs to its own exit code.
    #[cfg(unix)]
    #[test]
    fn a_lapsed_lease_stops_the_command() {
        let refuse = |v: serde_json::Value| -> Result<serde_json::Value> {
            match v["action"].as_str() {
                Some("acquire") => Ok(json!({ "lease": "l" })),
                Some("renew") => bail!("lease \"l\" of pane 1 no longer holds the build slot"),
                _ => Ok(json!({ "released": true })),
            }
        };
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let started = Instant::now();
        let err = run_with(
            &args(&["sleep", "30"]),
            &refuse,
            Duration::from_millis(50),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10), "stopped promptly");
        assert!(format!("{err:#}").contains("sleep 30 was stopped"), "{err:#}");

        let renew = |v: serde_json::Value| -> Result<serde_json::Value> {
            Ok(match v["action"].as_str() {
                Some("acquire") => json!({ "lease": "l" }),
                _ => json!({ "renewed": true }),
            })
        };
        let code = run_with(
            &args(&["sh", "-c", "sleep 0.5; exit 3"]),
            &renew,
            Duration::from_millis(50),
            Duration::from_millis(300),
        )
        .unwrap();
        assert_eq!(code, 3);
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

//! Night shift: settings, window, brief, preflight and keep-awake. The daemon
//! side lives in `daemon/night_shift.rs`; the agent door in `mcp_night.rs`.
pub mod awake;
pub mod brief;
pub mod cli;
pub mod detect;
pub mod preflight;
pub mod settings;
pub mod window;
pub mod zcode_probe;

use std::path::{Path, PathBuf};

/// Set in the orchestrator pane: the directory its `report.md` goes in.
pub const RUN_DIR_ENV: &str = "HOUSTON_NIGHT_RUN_DIR";

/// The routine row's own prompt; the brief is composed at every start.
pub const ROUTINE_PROMPT: &str =
    "Night shift: Houston composes this run's brief from the workspace's settings and ledger.";

/// Panes a run may keep live beyond its live workers: one reviewer and one
/// QA pane, so a gate never waits for a worker slot.
pub const GATE_PANES: u32 = 2;

/// The ledger verbs, as MCP tools (`night_<verb>`) and `hs-night <verb>`.
pub const VERBS: [&str; 5] = ["plan", "pr", "lesson", "decision", "report"];

pub fn run_dir(state_dir: &Path, run_id: u32) -> PathBuf {
    state_dir.join("night-shift").join(run_id.to_string())
}

/// The first flaky test name that appears in a failed check's name or log.
pub fn flaky_match<'a>(flaky: &'a [String], texts: &[String]) -> Option<&'a str> {
    flaky
        .iter()
        .map(|t| t.trim())
        .filter(|t| t.len() >= 3)
        .find(|t| texts.iter().any(|line| line.contains(t)))
}

/// The morning notice: "7 PRs, 2 open decisions", or why the run did not start.
/// Answered decisions stay in the report, so the count names what it counts.
pub fn headline(prs: usize, open_decisions: usize, refused: Option<&str>) -> String {
    if let Some(why) = refused {
        return format!("Night shift did not start: {why}");
    }
    let plural =
        |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let decisions = match open_decisions {
        0 => "no open decisions".to_string(),
        n => plural(n, "open decision", "open decisions"),
    };
    format!("{}, {decisions}", plural(prs, "PR", "PRs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flaky_names_match_inside_log_lines() {
        let flaky = vec!["pty::resize_race".to_string(), "x".to_string()];
        let log = vec![
            "core-checks".to_string(),
            "test pty::resize_race ... FAILED".to_string(),
        ];
        assert_eq!(flaky_match(&flaky, &log), Some("pty::resize_race"));
        assert_eq!(flaky_match(&flaky, &["x failed".to_string()]), None);
    }

    #[test]
    fn headline_counts() {
        assert_eq!(headline(7, 2, None), "7 PRs, 2 open decisions");
        assert_eq!(headline(1, 1, None), "1 PR, 1 open decision");
        assert_eq!(headline(1, 0, None), "1 PR, no open decisions");
        assert_eq!(
            headline(0, 0, Some("missed: the machine was asleep")),
            "Night shift did not start: missed: the machine was asleep"
        );
    }

    /// Quota resets are never spent automatically: no Night shift code path
    /// names one.
    #[test]
    fn no_quota_reset_symbol() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let files = [
            "night_shift/mod.rs",
            "night_shift/detect.rs",
            "night_shift/awake.rs",
            "night_shift/brief.rs",
            "night_shift/cli.rs",
            "night_shift/preflight.rs",
            "night_shift/settings.rs",
            "night_shift/window.rs",
            "night_shift/zcode_probe.rs",
            "daemon/night_shift.rs",
            "mcp_night.rs",
        ];
        let needles = [
            ["quota", "_reset"].concat(),
            ["reset", "_quota"].concat(),
            ["usage", "_reset"].concat(),
            ["reset", "Quota"].concat(),
            ["quota_auto", "_resume"].concat(),
        ];
        for f in files {
            let body = std::fs::read_to_string(src.join(f)).unwrap_or_else(|e| panic!("{f}: {e}"));
            let code = body.split("#[cfg(test)]").next().unwrap_or_default();
            let body = code.to_ascii_lowercase();
            for n in &needles {
                assert!(
                    !body.contains(&n.to_ascii_lowercase()),
                    "{f} names {n}; Night shift never spends a quota reset"
                );
            }
        }
    }
}

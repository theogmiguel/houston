//! Night shift: settings, window, brief, preflight and keep-awake. The daemon
//! side lives in `daemon/night_shift.rs`; the agent door in `mcp_night.rs`.
pub mod apps;
pub mod awake;
pub mod brief;
pub mod cli;
pub mod cost;
pub mod detect;
pub mod preflight;
pub mod provider_probe;
pub mod settings;
pub mod window;

use std::path::{Path, PathBuf};

/// Set in the orchestrator pane: the directory its `report.md` goes in.
pub const RUN_DIR_ENV: &str = "HOUSTON_NIGHT_RUN_DIR";

/// The routine row's own prompt; the brief is composed at every start.
pub const ROUTINE_PROMPT: &str =
    "Night shift: Houston composes this run's brief from the workspace's settings and ledger.";

/// Panes a run may keep live beyond its live workers: one reviewer and one
/// QA pane, so a gate never waits for a worker slot.
pub const GATE_PANES: u32 = 2;

/// Fixer panes one pull request may receive. The first fixer's patch may miss
/// the failure; one retry catches a second attempt without looping all night.
pub const CI_FIXES_PER_PR: u32 = 2;

/// The failing log a fixer prompt quotes, from the already-fetched check lines.
pub const CI_FIX_EXCERPT_CHARS: usize = 1_500;

/// What Houston does with a pull request's CI failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CiAction {
    /// Re-run the failed jobs once after a known flaky test matched.
    Rerun { test: String },
    /// Start a fixer pane for a real failure.
    Fix,
    /// Stop; another attempt would loop.
    GiveUp { why: String },
}

/// The failure plan. A known flaky failure is re-run once; anything else, or
/// the same flaky failure again, goes to a fixer until the per-PR cap.
pub fn ci_failure_plan(flaky_hit: Option<&str>, reruns: u32, fixes: u32) -> CiAction {
    if let Some(test) = flaky_hit {
        if reruns == 0 {
            return CiAction::Rerun {
                test: test.to_string(),
            };
        }
    }
    if fixes >= CI_FIXES_PER_PR {
        return CiAction::GiveUp {
            why: format!(
                "the pull request has {fixes} fixer panes already used of its \
                 {CI_FIXES_PER_PR}; Houston leaves the failure to the orchestrator"
            ),
        };
    }
    CiAction::Fix
}

/// The last `max` characters of the check lines, on a character boundary.
pub fn bounded_excerpt(lines: &[String], max: usize) -> String {
    let joined = lines.join("\n");
    let count = joined.chars().count();
    if count <= max {
        return joined;
    }
    joined.chars().skip(count - max).collect()
}

/// The fixer's brief: which pull request and checks failed, what the log says,
/// where to work and what to run. It carries no token or terminal transcript.
pub fn fixer_prompt(
    number: u32,
    checks: &[String],
    head: Option<&str>,
    excerpt: &str,
    configured_checks: &[String],
) -> String {
    let checks = if checks.is_empty() {
        "the failing check names were not recorded".to_string()
    } else {
        checks.join(", ")
    };
    let head = head.unwrap_or("not recorded");
    let configured = if configured_checks.is_empty() {
        "none configured".to_string()
    } else {
        configured_checks.join(", ")
    };
    format!(
        "Night shift: fix CI on pull request #{number}.\n\n\
         Failed checks: {checks}\n\
         The pull request's head is {head}. You start in your own fresh worktree at the \
         workspace's HEAD, so the run's own worktree stays untouched. Fetch the pull \
         request's head with `git fetch origin pull/{number}/head` and create your fix \
         branch from `FETCH_HEAD`; do not rewrite published history.\n\n\
         Last lines of the failing log:\n{excerpt}\n\n\
         Find the cause, fix it and push one commit to the pull request's head branch. Read \
         its name with `gh pr view {number} --json headRefName` and push with \
         `git push origin HEAD:<headRefName>`. Do not force-push. Run the checks Houston \
         runs on every pull request: {configured}. Then submit with pane_submit: the cause, \
         the fix, the commit and each check's result. If you cannot push, submit with what \
         you found instead of guessing."
    )
}

/// The ledger verbs, as MCP tools (`night_<verb>`) and `hs-night <verb>`.
/// `verdict` is the verifier's; the others are the orchestrator's.
pub const VERBS: [&str; 7] = [
    "plan", "pr", "lesson", "decision", "studied", "report", "verdict",
];

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

    #[test]
    fn a_flaky_failure_is_rerun_once_then_fixed() {
        assert_eq!(
            ci_failure_plan(Some("pty::resize_race"), 0, 0),
            CiAction::Rerun {
                test: "pty::resize_race".into()
            }
        );
        assert_eq!(
            ci_failure_plan(Some("pty::resize_race"), 1, 0),
            CiAction::Fix
        );
        assert_eq!(
            ci_failure_plan(Some("pty::resize_race"), 1, CI_FIXES_PER_PR),
            CiAction::GiveUp {
                why: format!(
                    "the pull request has {CI_FIXES_PER_PR} fixer panes already used of its \
                     {CI_FIXES_PER_PR}; Houston leaves the failure to the orchestrator"
                )
            }
        );
    }

    #[test]
    fn a_real_failure_goes_to_a_fixer_until_the_cap() {
        assert_eq!(ci_failure_plan(None, 0, 0), CiAction::Fix);
        assert_eq!(ci_failure_plan(None, 0, 1), CiAction::Fix);
        assert!(matches!(
            ci_failure_plan(None, 1, CI_FIXES_PER_PR),
            CiAction::GiveUp { why } if why.contains("2 fixer panes")
        ));
        assert!(matches!(
            ci_failure_plan(None, 0, CI_FIXES_PER_PR + 1),
            CiAction::GiveUp { .. }
        ));
    }

    #[test]
    fn a_fixer_prompt_names_the_pr_checks_log_and_worktree() {
        let prompt = fixer_prompt(
            12,
            &["core-checks".into(), "renderer-checks".into()],
            Some("abc123"),
            "test pty::resize_race ... FAILED",
            &["cargo test -p houston-core".into()],
        );
        for needle in [
            "pull request #12",
            "core-checks, renderer-checks",
            "abc123",
            "own fresh worktree",
            "git fetch origin pull/12/head",
            "FETCH_HEAD",
            "gh pr view 12 --json headRefName",
            "git push origin HEAD:<headRefName>",
            "Do not force-push",
            "test pty::resize_race ... FAILED",
            "cargo test -p houston-core",
            "pane_submit",
        ] {
            assert!(prompt.contains(needle), "{needle:?} missing: {prompt}");
        }
        assert!(fixer_prompt(3, &[], None, "", &[]).contains("not recorded"));
    }

    #[test]
    fn the_fixer_excerpt_keeps_the_tail_on_a_character_boundary() {
        let lines: Vec<String> = (0..5).map(|i| format!("linha {i} ção")).collect();
        let short = bounded_excerpt(&lines, 1_000);
        assert_eq!(short, lines.join("\n"));
        let capped = bounded_excerpt(&lines, 12);
        assert_eq!(capped.chars().count(), 12);
        assert!(short.ends_with(&capped), "the tail is kept: {capped:?}");
    }

    /// Quota resets are never spent automatically: no Night shift code path
    /// names one.
    #[test]
    fn no_quota_reset_symbol() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let files = [
            "night_shift/mod.rs",
            "night_shift/apps.rs",
            "night_shift/detect.rs",
            "night_shift/awake.rs",
            "night_shift/brief.rs",
            "night_shift/cli.rs",
            "night_shift/cost.rs",
            "night_shift/preflight.rs",
            "night_shift/settings.rs",
            "night_shift/window.rs",
            "night_shift/provider_probe.rs",
            "daemon/night_shift.rs",
            "daemon/zcode_quota.rs",
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

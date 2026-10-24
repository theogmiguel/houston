//! The orchestrator's brief: Houston's method, the workspace's settings and
//! the ledger digest of earlier runs, within `ROUTINE_PROMPT_MAX`.
use std::fmt::Write as _;

use houston_protocol::{
    AgentKind, NightAgent, NightEntry, NightEntryKind, NightFocusLevel, NightOutput,
    NightPrSize, NightShiftSettings, ROUTINE_PROMPT_MAX,
};

use super::settings::{clock_label, has_app_check};

pub const METHOD: &str = include_str!("method.txt");

/// What the brief says about this one run.
pub struct BriefRun<'a> {
    pub run_id: u32,
    pub report_path: &'a str,
    pub wrap_up: &'a str,
    pub hard_stop: &'a str,
}

/// Entries the next run must know: earlier PRs and their fate, deferred and
/// rejected work, lessons and flaky tests.
pub fn belongs_in_digest(e: &NightEntry) -> bool {
    matches!(
        e.kind,
        NightEntryKind::Deferred
            | NightEntryKind::Lesson
            | NightEntryKind::Flaky
            | NightEntryKind::Pr
    ) || is_rejected(e)
}

pub fn is_rejected(e: &NightEntry) -> bool {
    let status = e.status.as_deref().unwrap_or_default();
    matches!(status, "rejected" | "closed")
        || e.choice
            .as_deref()
            .is_some_and(|c| c.trim().to_ascii_lowercase().starts_with("reject"))
}

fn agent_label(a: &NightAgent) -> String {
    let name = crate::agent_hooks::provider_slug(a.provider);
    match &a.model {
        Some(m) if !m.is_empty() => format!("{name} ({m})"),
        _ => name.to_string(),
    }
}

fn level(l: NightFocusLevel) -> &'static str {
    match l {
        NightFocusLevel::Off => "Off",
        NightFocusLevel::Low => "Low",
        NightFocusLevel::Normal => "Normal",
        NightFocusLevel::High => "High",
    }
}

fn digest_line(e: &NightEntry) -> String {
    let tag = if is_rejected(e) {
        "rejected"
    } else {
        match e.kind {
            NightEntryKind::Deferred => "deferred",
            NightEntryKind::Lesson => "lesson",
            NightEntryKind::Flaky => "flaky test",
            NightEntryKind::Plan => "plan",
            NightEntryKind::Pr if e.status.as_deref() == Some("merged") => "pr merged",
            NightEntryKind::Pr => "pr not merged yet",
            NightEntryKind::Decision => "decision",
        }
    };
    let mut line = format!("- [{tag}] {}", one_line(&e.title));
    if let Some(n) = e.pr_number {
        let _ = write!(line, " (PR #{n})");
    }
    if let Some(choice) = &e.choice {
        let _ = write!(line, " - answered: {}", one_line(choice));
    }
    if !e.body.trim().is_empty() {
        let _ = write!(line, ": {}", one_line(&e.body));
    }
    line.push('\n');
    line
}

/// A change is one plan entry; grouping never mixes themes.
fn pr_size(s: &NightShiftSettings) -> String {
    match s.pr_size {
        NightPrSize::One => "one change per pull request".into(),
        NightPrSize::Related { max_changes } => format!(
            "related changes together (one theme per pull request), up to {max_changes} \
             changes per pull request"
        ),
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A Claude orchestrator's first input, before the brief: the goal as its
/// completion condition.
pub fn goal_command(s: &NightShiftSettings) -> Option<String> {
    let goal = one_line(&s.goal);
    (s.orchestrator.provider == AgentKind::Claude && !goal.is_empty())
        .then(|| format!("/goal {goal}"))
}

/// `digest` is newest first; entries that do not fit are counted, not cut.
pub fn compose(s: &NightShiftSettings, run: &BriefRun<'_>, digest: &[NightEntry]) -> String {
    let mut out = String::new();
    let goal = one_line(&s.goal);
    out.push_str(METHOD);
    out.push_str("\n## This run\n\n");
    let _ = writeln!(out, "- Run: {}", run.run_id);
    let _ = writeln!(
        out,
        "- Wrap-up at {}, hard stop at {} (local time).",
        run.wrap_up, run.hard_stop
    );
    let _ = writeln!(out, "- Report path: {}", run.report_path);
    if goal.is_empty() {
        out.push_str("- Goal: none; work the focus areas.\n");
    } else {
        let _ = writeln!(out, "- Goal (the run's completion condition): {goal}");
    }
    let f = &s.focus;
    let _ = writeln!(
        out,
        "- Focus: reliability {}, performance {}, UI and UX polish {}, competitor gaps {}, \
         docs accuracy {}, test gaps {}.",
        level(f.reliability),
        level(f.performance),
        level(f.ui_polish),
        level(f.competitor_gaps),
        level(f.docs_accuracy),
        level(f.test_gaps)
    );
    if !s.competitor_sources.is_empty() {
        let _ = writeln!(
            out,
            "- Competitor sources: {}",
            s.competitor_sources
                .iter()
                .map(|x| one_line(x))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let _ = writeln!(
        out,
        "- Workers, in fallback order: {}. Houston switches a spawn to the next provider when \
         one reports its limit and tells you once.",
        s.workers
            .iter()
            .map(agent_label)
            .collect::<Vec<_>>()
            .join(", then ")
    );
    let _ = writeln!(
        out,
        "- Live workers at most: {}, plus one reviewer and one QA pane. Houston refuses a \
         spawn past {} live panes besides you.",
        s.live_workers,
        s.live_workers + super::GATE_PANES
    );
    let reviewer = s.reviewer.as_ref().unwrap_or(&s.orchestrator);
    let _ = writeln!(out, "- Reviewer: {}", agent_label(reviewer));
    if s.checks.is_empty() {
        out.push_str("- Checks before hand-back: none configured.\n");
    } else {
        out.push_str("- Checks before hand-back:\n");
        for c in &s.checks {
            let _ = writeln!(out, "  - `{}`", one_line(c));
        }
    }
    match s.output {
        NightOutput::Prs => {
            let _ = writeln!(
                out,
                "- Output: draft pull requests only, {}{}.",
                pr_size(s),
                if s.screenshots {
                    ", with screenshots for visible changes"
                } else {
                    ""
                }
            );
        }
        NightOutput::MergeQueue => {
            let _ = writeln!(
                out,
                "- Output: merge queue. Mark ready PRs and hand them to the queue with \
                 pane_pr_enqueue and depends_on; the queue's gates decide. Pull requests: {}. \
                 App QA is required for visible changes.{}",
                pr_size(s),
                if s.hold_for_qa {
                    " Hold for my QA is on: record visible PRs with night_pr and leave them \
                     out of the queue; the user releases them after QA."
                } else {
                    ""
                }
            );
        }
    }
    match s.app_check.as_ref().filter(|_| has_app_check(s)) {
        Some(a) => {
            let _ = writeln!(
                out,
                "- App check: start with `{}`, open {}{}.",
                one_line(&a.start_command),
                one_line(&a.address),
                if a.smoke_flows.is_empty() {
                    String::new()
                } else {
                    format!(
                        ", smoke flows: {}",
                        a.smoke_flows
                            .iter()
                            .map(|x| one_line(x))
                            .collect::<Vec<_>>()
                            .join("; ")
                    )
                }
            );
        }
        None => out.push_str("- App check: none; App QA is off.\n"),
    }
    out.push_str("- Questions: parked for the morning report.\n");
    out.push_str("\n## Ledger of earlier runs (newest first)\n\n");
    let budget = ROUTINE_PROMPT_MAX.saturating_sub(out.chars().count() + 120);
    let mut used = 0usize;
    let mut omitted = 0usize;
    let mut any = false;
    for e in digest.iter().filter(|e| belongs_in_digest(e)) {
        let line = digest_line(e);
        let len = line.chars().count();
        if omitted == 0 && used + len <= budget {
            out.push_str(&line);
            used += len;
            any = true;
        } else {
            omitted += 1;
        }
    }
    if !any && omitted == 0 {
        out.push_str("Empty: this is the first run.\n");
    }
    if omitted > 0 {
        let _ = writeln!(out, "({omitted} older entries omitted to fit the brief.)");
    }
    out
}

pub fn window_labels(
    wrap_up_ms: i64,
    hard_stop_ms: i64,
    offset: impl Fn(i64) -> i64,
) -> (String, String) {
    let label = |ms: i64| {
        let local = (ms + offset(ms)).rem_euclid(86_400_000) / 60_000;
        clock_label(houston_protocol::NightClock {
            hour: (local / 60) as u8,
            minute: (local % 60) as u8,
        })
    };
    (label(wrap_up_ms), label(hard_stop_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> BriefRun<'static> {
        BriefRun {
            run_id: 7,
            report_path: "/state/night-shift/7/report.md",
            wrap_up: "06:45",
            hard_stop: "07:30",
        }
    }

    fn entry(id: u32, kind: NightEntryKind, title: &str) -> NightEntry {
        NightEntry {
            id,
            run_id: 1,
            kind,
            title: title.into(),
            theme: None,
            status: None,
            pr_number: None,
            visible: false,
            qa_passed: false,
            body: "x".repeat(houston_protocol::NIGHT_SHIFT_ENTRY_BODY_MAX),
            gates: Default::default(),
            created_at_ms: i64::from(id),
            decided_at_ms: None,
            choice: None,
        }
    }

    /// Every field at the most `validate` accepts, and a full ledger, still
    /// fit `ROUTINE_PROMPT_MAX` with the newest entries kept.
    #[test]
    fn bounded_with_full_ledger() {
        use super::super::settings::*;
        let mut s = defaults();
        s.goal = "g".repeat(TEXT_FIELD_MAX);
        s.checks = vec!["c".repeat(TEXT_FIELD_MAX); 4];
        s.competitor_sources = vec!["s".repeat(600); SOURCES_MAX];
        s.app_check = Some(houston_protocol::NightAppCheck {
            start_command: "a".repeat(1_000),
            address: "b".repeat(1_000),
            smoke_flows: vec!["f".repeat(300); SMOKE_FLOWS_MAX],
        });
        s.focus.competitor_gaps = NightFocusLevel::High;
        s.orchestrator.model = Some("m".repeat(MODEL_MAX));
        s.workers = vec![
            NightAgent {
                provider: AgentKind::Codex,
                model: Some("m".repeat(MODEL_MAX)),
            };
            WORKERS_MAX
        ];
        s.reviewer = Some(s.workers[0].clone());
        validate(
            &s,
            &WorkspaceFacts {
                merge_verify_command: true,
            },
        )
        .expect("every field at its limit is valid");
        let digest: Vec<NightEntry> = (0..houston_protocol::NIGHT_SHIFT_DIGEST_ENTRIES_MAX)
            .map(|i| entry(i, NightEntryKind::Lesson, &format!("lesson {i}")))
            .collect();
        let brief = compose(&s, &run(), &digest);
        assert!(
            brief.chars().count() <= ROUTINE_PROMPT_MAX,
            "{} chars",
            brief.chars().count()
        );
        assert!(brief.contains("lesson 0"), "the newest entry is kept");
        assert!(brief.contains("older entries omitted"));
        crate::routines::validate_prompt(&brief).unwrap();
    }

    #[test]
    fn brief_names_every_setting() {
        let mut s = super::super::settings::defaults();
        s.goal = "CI is green".into();
        s.checks = vec!["cargo test".into()];
        let digest = vec![
            entry(3, NightEntryKind::Flaky, "pty_resize_race"),
            entry(2, NightEntryKind::Deferred, "rewrite the tray"),
            entry(1, NightEntryKind::Plan, "kept plan"),
        ];
        let brief = compose(&s, &run(), &digest);
        for needle in [
            "CI is green",
            "reliability Normal",
            "performance Normal",
            "zcode (GLM-5.3-Flash), then claude (opus)",
            "Live workers at most: 4",
            "`cargo test`",
            "draft pull requests only",
            "/state/night-shift/7/report.md",
            "[flaky test] pty_resize_race",
            "[deferred] rewrite the tray",
        ] {
            assert!(brief.contains(needle), "missing {needle:?}");
        }
        assert!(!brief.contains("kept plan"), "plans are not digested");
        assert!(
            brief.find("pty_resize_race").unwrap() < brief.find("rewrite the tray").unwrap(),
            "newest first"
        );
        // include_str! embeds the checkout's line endings; CI's Windows runners
        // check out CRLF, so accept either terminator per line.
        assert!(METHOD
            .lines()
            .all(|line| line.chars().all(|c| (' '..='~').contains(&c))));
    }

    #[test]
    fn pr_size_is_stated() {
        let mut s = super::super::settings::defaults();
        assert!(compose(&s, &run(), &[])
            .contains("related changes together (one theme per pull request), up to 5 changes"));
        s.pr_size = NightPrSize::One;
        assert!(compose(&s, &run(), &[]).contains("one change per pull request"));
    }

    #[test]
    fn goal_command_only_for_claude() {
        let mut s = super::super::settings::defaults();
        s.goal = "ship the\ntray fix".into();
        assert_eq!(goal_command(&s).as_deref(), Some("/goal ship the tray fix"));
        let brief = compose(&s, &run(), &[]);
        assert!(
            !brief.contains("/goal"),
            "the brief is a separate input: {brief}"
        );
        assert!(brief.contains("ship the tray fix"));
        s.orchestrator.provider = AgentKind::Codex;
        assert_eq!(goal_command(&s), None);
        s.orchestrator.provider = AgentKind::Claude;
        s.goal.clear();
        assert_eq!(goal_command(&s), None);
    }
}

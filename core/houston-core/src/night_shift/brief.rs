//! The orchestrator's brief: Houston's method, the workspace's settings and
//! the ledger digest of earlier runs, within `ROUTINE_PROMPT_MAX`.
use std::fmt::Write as _;

use houston_protocol::{
    NightAgent, NightCompetitor, NightEntry, NightEntryKind, NightFocus, NightFocusLevel,
    NightOutput,
    NightPrSize, NightShiftSettings, NightVerification, ROUTINE_PROMPT_MAX,
};

use super::settings::{app_qa_on, clock_label};

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
            | NightEntryKind::Studied
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

/// Each area's name, level and one-line definition, in Setup's order. Setup
/// shows the same definitions as tooltips.
pub fn focus_areas(f: &NightFocus) -> [(&'static str, NightFocusLevel, &'static str); 6] {
    [
        (
            "Reliability",
            f.reliability,
            "Crashes, hangs, lost state, error handling and recovery paths.",
        ),
        (
            "Performance",
            f.performance,
            "Startup, memory, CPU and latency, measured before and after.",
        ),
        (
            "UI and UX polish",
            f.ui_polish,
            "Rough edges you can see: layout, wording, states, keyboard and focus.",
        ),
        (
            "Competitor gaps",
            f.competitor_gaps,
            "Things the competitors listed below do that this project does not.",
        ),
        (
            "Docs accuracy",
            f.docs_accuracy,
            "Docs that say something the code does not do.",
        ),
        (
            "Test gaps",
            f.test_gaps,
            "Important paths no test covers.",
        ),
    ]
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
            NightEntryKind::Studied => "studied",
        }
    };
    let mut line = format!("- [{tag}] {}", one_line(&e.title));
    if e.kind == NightEntryKind::Studied {
        if let Some(version) = &e.status {
            let _ = write!(line, " at {}", one_line(version));
        }
    }
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

/// What each verification depth does and what it cannot catch; Setup and the
/// report say the same.
pub fn depth_line(depth: NightVerification) -> &'static str {
    match depth {
        NightVerification::Light => {
            "Verification depth: Light. The verifier re-runs every proof and confirms each test \
             exists and asserts its claim. It cannot catch a test that would also pass with a \
             wrong implementation."
        }
        NightVerification::Standard => {
            "Verification depth: Standard. The verifier also breaks the new code once per \
             assertion and requires the test to fail. It cannot catch a requirement nobody wrote \
             down as a claim."
        }
    }
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

/// `digest` is newest first; entries that do not fit are counted, not cut.
pub fn compose(s: &NightShiftSettings, run: &BriefRun<'_>, digest: &[NightEntry]) -> String {
    let mut out = String::new();
    let direction = one_line(&s.direction);
    out.push_str(METHOD);
    out.push_str("\n## This run\n\n");
    let _ = writeln!(out, "- Run: {}", run.run_id);
    let _ = writeln!(
        out,
        "- Wrap-up at {}, hard stop at {} (local time).",
        run.wrap_up, run.hard_stop
    );
    let _ = writeln!(out, "- Report path: {}", run.report_path);
    if direction.is_empty() {
        out.push_str("- Direction: none; weigh the focus areas by their levels.\n");
    } else {
        let _ = writeln!(
            out,
            "- Direction, in the user's words: \"{direction}\". Within the focus areas, look \
             first at what serves it and rank it higher; it steers the night, the window ends \
             it."
        );
    }
    let areas = focus_areas(&s.focus);
    out.push_str("- Focus areas, with their level and what each covers; scout only these:\n");
    for (name, l, definition) in areas.iter().filter(|a| a.1 != NightFocusLevel::Off) {
        let _ = writeln!(out, "  - {name} ({}): {definition}", level(*l));
    }
    let off: Vec<&str> = areas
        .iter()
        .filter(|a| a.1 == NightFocusLevel::Off)
        .map(|a| a.0)
        .collect();
    if !off.is_empty() {
        let _ = writeln!(out, "- Off, not scouted: {}.", off.join(", "));
    }
    if s.focus.competitor_gaps != NightFocusLevel::Off && !s.competitors.is_empty() {
        out.push_str(
            "- Competitors. Study only what is newer than the ledger's [studied] entry for each, \
             record what you studied with night_studied, and bring back features and behaviour, \
             never copied code:\n",
        );
        for c in &s.competitors {
            let _ = match c {
                NightCompetitor::Repo { repo } => writeln!(
                    out,
                    "  - {repo}: clone https://github.com/{repo} read-only outside the repository \
                     and read the releases after the studied tag."
                ),
                NightCompetitor::App {
                    name,
                    version,
                    path,
                } => writeln!(
                    out,
                    "  - {} {} installed at {}: analyse it with REA, only what changed since the \
                     studied version.",
                    one_line(name),
                    if version.is_empty() { "(version not reported)" } else { version.as_str() },
                    one_line(path)
                ),
            };
        }
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
        out.push_str("- Checks: none configured.\n");
    } else {
        out.push_str(
            "- Checks: Houston runs these on each pull request's head when night_pr names it \
             and records the Checks gate; workers run them first with hs-pane heavy:\n",
        );
        for c in &s.checks {
            let _ = writeln!(
                out,
                "  - `{}` (from {})",
                one_line(&c.command),
                one_line(&c.source)
            );
        }
    }
    let _ = writeln!(out, "- {}", depth_line(s.verification));
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
    if app_qa_on(s) {
        let a = &s.app_qa;
        let open = if a.address.trim().is_empty() {
            "the story or screen that change touches, chosen from the change".to_string()
        } else {
            format!("`{}`", one_line(&a.address))
        };
        let _ = writeln!(
            out,
            "- App QA: on, for every change the user can see. The QA pane starts the app with \
             `{}`, opens {open}, and checks that change's claims{}.",
            one_line(&a.start_command),
            if a.smoke_flows.is_empty() {
                String::new()
            } else {
                format!(
                    " plus these smoke flows: {}",
                    a.smoke_flows
                        .iter()
                        .map(|x| one_line(x))
                        .collect::<Vec<_>>()
                        .join("; ")
                )
            }
        );
    } else {
        out.push_str("- App QA: off.\n");
    }
    out.push_str("- Questions: parked for the morning report.\n");
    out.push_str("\n## Ledger of earlier runs (newest first)\n\n");
    let budget = ROUTINE_PROMPT_MAX.saturating_sub(out.chars().count() + 120);
    let mut used = 0usize;
    let mut omitted = 0usize;
    let mut any = false;
    // Only the newest studied entry per competitor: the next run reads what is newer.
    let mut studied = std::collections::HashSet::new();
    let digest = digest.iter().filter(|e| {
        belongs_in_digest(e)
            && (e.kind != NightEntryKind::Studied || studied.insert(e.title.to_ascii_lowercase()))
    });
    for e in digest {
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
    use houston_protocol::AgentKind;

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
            detail: Default::default(),
        }
    }

    /// Every field at the most `validate` accepts, and a full ledger, still
    /// fit `ROUTINE_PROMPT_MAX` with the newest entries kept.
    #[test]
    fn bounded_with_full_ledger() {
        use super::super::settings::*;
        let mut s = defaults();
        s.direction = "g".repeat(TEXT_FIELD_MAX);
        s.checks = vec![
            houston_protocol::NightCheck {
                command: "c".repeat(TEXT_FIELD_MAX),
                source: "s".repeat(SOURCE_MAX),
            };
            4
        ];
        s.competitors = vec![
            NightCompetitor::App {
                name: "n".repeat(200),
                version: "v".repeat(100),
                path: "p".repeat(300),
            };
            COMPETITORS_MAX
        ];
        s.app_qa = houston_protocol::NightAppQa {
            enabled: true,
            start_command: "a".repeat(1_000),
            source: "s".repeat(SOURCE_MAX),
            address: "b".repeat(1_000),
            smoke_flows: vec!["f".repeat(300); SMOKE_FLOWS_MAX],
        };
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
        s.direction = "stop crashing in long sessions".into();
        s.checks = vec![houston_protocol::NightCheck {
            command: "cargo test".into(),
            source: "ci.yml · core-checks".into(),
        }];
        let digest = vec![
            entry(3, NightEntryKind::Flaky, "pty_resize_race"),
            entry(2, NightEntryKind::Deferred, "rewrite the tray"),
            entry(1, NightEntryKind::Plan, "kept plan"),
        ];
        let brief = compose(&s, &run(), &digest);
        for needle in [
            "\"stop crashing in long sessions\"",
            "  - Reliability (Normal): Crashes, hangs",
            "  - Performance (Normal): Startup, memory",
            "- Off, not scouted: UI and UX polish, Competitor gaps, Docs accuracy, Test gaps.",
            "zcode (GLM-5.3-Flash), then claude (opus)",
            "Live workers at most: 4",
            "`cargo test` (from ci.yml · core-checks)",
            "Verification depth: Light.",
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
    fn app_qa_opens_what_each_change_touches() {
        let mut s = super::super::settings::defaults();
        assert!(compose(&s, &run(), &[]).contains("- App QA: off."));
        s.app_qa.enabled = true;
        s.app_qa.start_command = "node ui/harness/shot.mjs <story> <out.png>".into();
        s.app_qa.smoke_flows = vec!["open a workspace".into()];
        let brief = compose(&s, &run(), &[]);
        assert!(brief.contains("opens the story or screen that change touches"), "{brief}");
        assert!(brief.contains("checks that change's claims plus these smoke flows: open a workspace"), "{brief}");
        s.app_qa.address = "http://127.0.0.1:5173".into();
        assert!(compose(&s, &run(), &[]).contains("opens `http://127.0.0.1:5173`"));
    }

    #[test]
    fn competitors_and_the_newest_studied_entry_reach_the_brief() {
        let mut s = super::super::settings::defaults();
        s.focus.competitor_gaps = NightFocusLevel::Normal;
        s.competitors = vec![
            NightCompetitor::Repo {
                repo: "pingdotgg/t3code".into(),
            },
            NightCompetitor::App {
                name: "Orca".into(),
                version: String::new(),
                path: "/opt/orca/orca".into(),
            },
        ];
        let studied = |id: u32, version: &str| NightEntry {
            status: Some(version.into()),
            body: String::new(),
            ..entry(id, NightEntryKind::Studied, "pingdotgg/t3code")
        };
        let brief = compose(&s, &run(), &[studied(2, "v0.9.0"), studied(1, "v0.8.0")]);
        assert!(brief.contains("clone https://github.com/pingdotgg/t3code read-only"), "{brief}");
        assert!(brief.contains("Orca (version not reported) installed at /opt/orca/orca: analyse it with REA"), "{brief}");
        assert!(brief.contains("- [studied] pingdotgg/t3code at v0.9.0"), "{brief}");
        assert!(!brief.contains("v0.8.0"), "only the newest studied entry: {brief}");
    }

    #[test]
    fn areas_are_defined() {
        let mut s = super::super::settings::defaults();
        s.focus.test_gaps = NightFocusLevel::High;
        let brief = compose(&s, &run(), &[]);
        assert!(
            brief.contains("  - Test gaps (High): Important paths no test covers."),
            "{brief}"
        );
        for (name, _, definition) in focus_areas(&s.focus) {
            assert!(!definition.is_empty() && !name.is_empty());
        }
        assert!(!brief.contains("Docs that say something"), "Off areas are not defined");
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
    fn direction_steers_and_is_no_goal() {
        let mut s = super::super::settings::defaults();
        s.direction = "make it feel\nfaster".into();
        let brief = compose(&s, &run(), &[]);
        assert!(brief.contains("\"make it feel faster\""), "{brief}");
        assert!(brief.contains("Within the focus areas, look first"), "{brief}");
        assert!(!brief.contains("/goal"), "{brief}");
        assert!(!brief.contains("completion condition"), "{brief}");
        s.direction.clear();
        assert!(compose(&s, &run(), &[]).contains("- Direction: none"));
    }
}

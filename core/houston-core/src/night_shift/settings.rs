//! A Night shift routine's settings document: defaults, revision and the
//! checks `night_shift_update` refuses with.
use anyhow::{bail, Result};
use houston_protocol::{
    AgentKind, NightAgent, NightClock, NightFocus, NightFocusLevel, NightOutput, NightQuestions,
    NightShiftSettings, NightWindow, NIGHT_SHIFT_SETTINGS_VERSION, NIGHT_SHIFT_WINDOW_MAX_MINUTES,
};
use sha2::{Digest, Sha256};

/// More workers than this would outgrow the orchestration child cap.
pub const LIVE_WORKERS_MAX: u32 = 12;
pub const MAX_CHANGES_PER_PR_MAX: u32 = 20;
/// A week of continuous panes; anything larger is no safety net.
pub const SAFETY_CAP_PANE_HOURS_MAX: u32 = 1_000;
pub const CHECKS_MAX: usize = 20;
pub const SOURCES_MAX: usize = 10;
pub const SMOKE_FLOWS_MAX: usize = 20;
/// The setup offers four; more providers than this is no fallback order.
pub const WORKERS_MAX: usize = 4;
pub const TEXT_FIELD_MAX: usize = 2_000;
pub const MODEL_MAX: usize = 100;
/// All free text together. With the method and labels it keeps the brief's
/// fixed part under half of `ROUTINE_PROMPT_MAX`, leaving the rest to the ledger.
pub const TEXT_TOTAL_MAX: usize = 24_000;

pub fn defaults() -> NightShiftSettings {
    let at = |hour, minute| NightClock { hour, minute };
    NightShiftSettings {
        v: NIGHT_SHIFT_SETTINGS_VERSION,
        enabled: false,
        window: NightWindow {
            start: at(23, 30),
            wrap_up: at(6, 45),
            hard_stop: at(7, 30),
            nights: Vec::new(),
        },
        focus: NightFocus {
            reliability: NightFocusLevel::Normal,
            performance: NightFocusLevel::Normal,
            ui_polish: NightFocusLevel::Off,
            competitor_gaps: NightFocusLevel::Off,
            platform_parity: NightFocusLevel::Off,
            docs_accuracy: NightFocusLevel::Off,
            test_gaps: NightFocusLevel::Off,
        },
        goal: String::new(),
        competitor_sources: Vec::new(),
        orchestrator: NightAgent {
            provider: AgentKind::Claude,
            model: Some("opus".into()),
        },
        workers: vec![
            NightAgent {
                provider: AgentKind::Zcode,
                model: Some("GLM-5.3-Flash".into()),
            },
            NightAgent {
                provider: AgentKind::Claude,
                model: Some("opus".into()),
            },
        ],
        live_workers: 4,
        reviewer: None,
        output: NightOutput::Prs,
        themed: true,
        max_changes_per_pr: 5,
        screenshots: true,
        app_check: None,
        hold_for_qa: true,
        checks: Vec::new(),
        safety_cap_pane_hours: 60,
        questions: NightQuestions::Park,
    }
}

/// A content hash of the document; every update must echo it.
pub fn revision(settings: &NightShiftSettings) -> String {
    let canonical = serde_json::to_vec(settings).expect("settings serialize to JSON");
    Sha256::digest(&canonical)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn clock_label(c: NightClock) -> String {
    format!("{:02}:{:02}", c.hour, c.minute)
}

fn minute_of_day(c: NightClock) -> u32 {
    u32::from(c.hour) * 60 + u32::from(c.minute)
}

/// Minutes from `from` forward to `to`; a full day when they are equal.
pub fn minutes_between(from: NightClock, to: NightClock) -> u32 {
    let (a, b) = (minute_of_day(from), minute_of_day(to));
    match (b + 1440 - a) % 1440 {
        0 => 1440,
        d => d,
    }
}

/// Providers that never report a usage limit: a run could not switch away
/// from them when they stop working.
pub fn reports_no_limit(provider: AgentKind) -> bool {
    matches!(
        provider,
        AgentKind::Cursor | AgentKind::Antigravity | AgentKind::Grok
    )
}

pub fn is_worker_provider(provider: AgentKind) -> bool {
    matches!(
        provider,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode | AgentKind::Zcode
    )
}

/// The orchestrator watches its PRs' CI, so its provider must be one a pull
/// request watch can wake (`pr_watch_start`).
pub fn is_orchestrator_provider(provider: AgentKind) -> bool {
    matches!(
        provider,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode
    )
}

pub fn validate_window(w: &NightWindow) -> Result<()> {
    for (name, c) in [
        ("start", w.start),
        ("wrap-up", w.wrap_up),
        ("hard stop", w.hard_stop),
    ] {
        if c.hour > 23 || c.minute > 59 {
            bail!(
                "{name} {}:{} is not a clock time; expected 00:00 to 23:59",
                c.hour,
                c.minute
            );
        }
    }
    if let Some(bad) = w.nights.iter().find(|d| !(1..=7).contains(*d)) {
        bail!("night {bad} is out of range; expected 1 = Sunday … 7 = Saturday");
    }
    let total = minutes_between(w.start, w.hard_stop);
    if total > NIGHT_SHIFT_WINDOW_MAX_MINUTES {
        bail!(
            "the window {} to {} lasts {} h {:02} min; the limit is {} h",
            clock_label(w.start),
            clock_label(w.hard_stop),
            total / 60,
            total % 60,
            NIGHT_SHIFT_WINDOW_MAX_MINUTES / 60
        );
    }
    let wrap = minutes_between(w.start, w.wrap_up);
    if wrap >= total {
        bail!(
            "wrap-up {} is not before the hard stop {} (window starting {})",
            clock_label(w.wrap_up),
            clock_label(w.hard_stop),
            clock_label(w.start)
        );
    }
    Ok(())
}

/// What the workspace offers that the settings may depend on.
pub struct WorkspaceFacts {
    pub merge_verify_command: bool,
}

pub fn validate(s: &NightShiftSettings, facts: &WorkspaceFacts) -> Result<()> {
    if s.v != NIGHT_SHIFT_SETTINGS_VERSION {
        bail!(
            "settings version {} is not supported; expected {NIGHT_SHIFT_SETTINGS_VERSION}",
            s.v
        );
    }
    validate_window(&s.window)?;
    if s.enabled && s.window.nights.is_empty() {
        bail!("Night shift is on but no night is selected; choose at least one night");
    }
    if s.workers.is_empty() {
        bail!("Night shift needs at least one worker provider");
    }
    if s.workers.len() > WORKERS_MAX {
        bail!(
            "{} worker providers; the limit is {WORKERS_MAX}",
            s.workers.len()
        );
    }
    for w in &s.workers {
        if reports_no_limit(w.provider) {
            bail!(
                "{} cannot be a Night shift worker: it reports no usage limit, so a run \
                 could not switch away from it",
                crate::agent_hooks::provider_slug(w.provider)
            );
        }
        if !is_worker_provider(w.provider) {
            bail!(
                "{} cannot be a Night shift worker; expected claude, codex, opencode or zcode",
                crate::agent_hooks::provider_slug(w.provider)
            );
        }
    }
    if s.orchestrator.provider == AgentKind::Zcode {
        bail!(
            "zcode cannot orchestrate Night shift: a pull request watch cannot wake a ZCode \
             pane, so the run's CI stage would be off; expected claude, codex or opencode"
        );
    }
    if !is_orchestrator_provider(s.orchestrator.provider) {
        bail!(
            "{} cannot orchestrate Night shift; expected claude, codex or opencode",
            crate::agent_hooks::provider_slug(s.orchestrator.provider)
        );
    }
    if let Some(r) = &s.reviewer {
        if !is_worker_provider(r.provider) || reports_no_limit(r.provider) {
            bail!(
                "{} cannot review for Night shift; expected claude, codex, opencode or zcode",
                crate::agent_hooks::provider_slug(r.provider)
            );
        }
    }
    let bounded = |name: &str, v: u32, max: u32| -> Result<()> {
        if v == 0 || v > max {
            bail!("{name} is {v}; expected 1 to {max}");
        }
        Ok(())
    };
    bounded("live workers", s.live_workers, LIVE_WORKERS_MAX)?;
    bounded(
        "changes per PR",
        s.max_changes_per_pr,
        MAX_CHANGES_PER_PR_MAX,
    )?;
    bounded(
        "safety cap (pane-hours)",
        s.safety_cap_pane_hours,
        SAFETY_CAP_PANE_HOURS_MAX,
    )?;
    let smoke_flows = s.app_check.as_ref().map_or(&[][..], |a| &a.smoke_flows[..]);
    for (name, count, max) in [
        ("checks before hand-back", s.checks.len(), CHECKS_MAX),
        (
            "competitor sources",
            s.competitor_sources.len(),
            SOURCES_MAX,
        ),
        ("smoke flows", smoke_flows.len(), SMOKE_FLOWS_MAX),
    ] {
        if count > max {
            bail!("{count} {name}; the limit is {max}");
        }
    }
    let app = s.app_check.as_ref();
    let texts = [
        ("goal", s.goal.as_str()),
        (
            "App start command",
            app.map_or("", |a| a.start_command.as_str()),
        ),
        ("App address", app.map_or("", |a| a.address.as_str())),
    ]
    .into_iter()
    .chain(s.checks.iter().map(|c| ("check", c.as_str())))
    .chain(s.competitor_sources.iter().map(|c| ("source", c.as_str())))
    .chain(smoke_flows.iter().map(|c| ("smoke flow", c.as_str())));
    let mut total = 0;
    for (name, text) in texts {
        let len = text.chars().count();
        if len > TEXT_FIELD_MAX {
            bail!("a {name} is {len} characters; the limit is {TEXT_FIELD_MAX}");
        }
        total += len;
    }
    if total > TEXT_TOTAL_MAX {
        bail!(
            "the settings' text fields hold {total} characters together; the limit is \
             {TEXT_TOTAL_MAX}, so the brief keeps room for the ledger"
        );
    }
    let models = std::iter::once(&s.orchestrator)
        .chain(&s.workers)
        .chain(&s.reviewer)
        .filter_map(|a| a.model.as_deref());
    for model in models {
        let len = model.chars().count();
        if len > MODEL_MAX {
            bail!("a model name is {len} characters; the limit is {MODEL_MAX}");
        }
    }
    if s.focus.competitor_gaps != NightFocusLevel::Off && s.competitor_sources.is_empty() {
        bail!("competitor gaps is on but no competitor source is listed; add one or turn it off");
    }
    if s.output == NightOutput::MergeQueue {
        let mut missing = Vec::new();
        if !facts.merge_verify_command {
            missing.push("the workspace's merge queue verification command");
        }
        if !has_app_check(s) {
            missing.push("an App check");
        }
        if !missing.is_empty() {
            bail!(
                "merge queue output needs {}; set them first or keep pull requests only",
                missing.join(" and ")
            );
        }
    }
    Ok(())
}

pub fn has_app_check(s: &NightShiftSettings) -> bool {
    s.app_check
        .as_ref()
        .is_some_and(|a| !a.start_command.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> WorkspaceFacts {
        WorkspaceFacts {
            merge_verify_command: false,
        }
    }

    #[test]
    fn defaults_are_valid_and_paused() {
        let d = defaults();
        assert!(!d.enabled);
        validate(&d, &facts()).unwrap();
        assert_eq!(revision(&d), revision(&defaults()));
        assert_eq!(revision(&d).len(), 16);
    }

    #[test]
    fn refuses_workers_without_limit_signal() {
        for (provider, name) in [
            (AgentKind::Cursor, "cursor"),
            (AgentKind::Antigravity, "antigravity"),
            (AgentKind::Grok, "grok"),
        ] {
            let mut s = defaults();
            s.workers.push(NightAgent {
                provider,
                model: None,
            });
            let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
            assert!(err.contains(name), "{err}");
            assert!(err.contains("reports no usage limit"), "{err}");
        }
    }

    #[test]
    fn a_zcode_orchestrator_is_refused_with_the_reason() {
        let mut s = defaults();
        s.orchestrator = NightAgent {
            provider: AgentKind::Zcode,
            model: None,
        };
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(err.contains("zcode cannot orchestrate"), "{err}");
        assert!(err.contains("cannot wake a ZCode pane"), "{err}");
        assert!(err.contains("CI stage"), "{err}");
        for provider in [AgentKind::Claude, AgentKind::Codex, AgentKind::Opencode] {
            s.orchestrator = NightAgent {
                provider,
                model: None,
            };
            validate(&s, &facts()).unwrap();
        }
    }

    #[test]
    fn window_bounds() {
        let at = |hour, minute| NightClock { hour, minute };
        let mut s = defaults();
        s.window.wrap_up = at(7, 45);
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(
            err.contains("07:45") && err.contains("07:30"),
            "names both values: {err}"
        );
        let mut s = defaults();
        s.window.start = at(14, 0);
        s.window.wrap_up = at(6, 0);
        s.window.hard_stop = at(7, 0);
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(err.contains("17 h"), "names the length: {err}");
        assert!(err.contains("16 h"), "names the limit: {err}");
        assert!(err.contains("14:00") && err.contains("07:00"), "{err}");
        s.window.start = at(15, 0);
        validate(&s, &facts()).expect("exactly 16 h is allowed");
    }

    #[test]
    fn merge_output_names_each_missing_setting() {
        let mut s = defaults();
        s.output = NightOutput::MergeQueue;
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(err.contains("verification command"), "{err}");
        assert!(err.contains("App check"), "{err}");
        s.app_check = Some(houston_protocol::NightAppCheck {
            start_command: "bun run dev".into(),
            address: "http://127.0.0.1:5173".into(),
            smoke_flows: Vec::new(),
        });
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(!err.contains("App check"), "{err}");
        validate(
            &s,
            &WorkspaceFacts {
                merge_verify_command: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn enabled_needs_a_night() {
        let mut s = defaults();
        s.enabled = true;
        assert!(validate(&s, &facts()).is_err());
        s.window.nights = vec![1, 5];
        validate(&s, &facts()).unwrap();
    }

    /// Every free-text field and list is bounded, each refusal naming the
    /// field, the value and the limit.
    #[test]
    fn every_text_field_and_list_is_bounded() {
        let app = |start: &str, address: &str, flows: Vec<String>| {
            Some(houston_protocol::NightAppCheck {
                start_command: start.into(),
                address: address.into(),
                smoke_flows: flows,
            })
        };
        type Edit = Box<dyn Fn(&mut NightShiftSettings)>;
        let cases: Vec<(&str, Edit)> = vec![
            (
                "App start command",
                Box::new(move |s| s.app_check = app(&"x".repeat(TEXT_FIELD_MAX + 1), "", vec![])),
            ),
            (
                "App address",
                Box::new(move |s| s.app_check = app("", &"x".repeat(TEXT_FIELD_MAX + 1), vec![])),
            ),
            (
                "smoke flow",
                Box::new(move |s| s.app_check = app("", "", vec!["x".repeat(TEXT_FIELD_MAX + 1)])),
            ),
            (
                "21 smoke flows",
                Box::new(move |s| {
                    s.app_check = app("", "", vec!["open".into(); SMOKE_FLOWS_MAX + 1])
                }),
            ),
            (
                "11 competitor sources",
                Box::new(|s| s.competitor_sources = vec!["https://x".into(); SOURCES_MAX + 1]),
            ),
            (
                "5 worker providers",
                Box::new(|s| s.workers = vec![s.workers[0].clone(); WORKERS_MAX + 1]),
            ),
            (
                "model name",
                Box::new(|s| s.orchestrator.model = Some("m".repeat(MODEL_MAX + 1))),
            ),
            (
                "together",
                Box::new(|s| s.checks = vec!["c".repeat(TEXT_FIELD_MAX); 13]),
            ),
        ];
        for (needle, edit) in cases {
            let mut s = defaults();
            edit(&mut s);
            let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
            assert!(err.contains(needle), "{needle}: {err}");
            assert!(err.contains("limit"), "{err}");
        }
    }
}

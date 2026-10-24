//! A Night shift routine's settings document: defaults, revision and the
//! checks `night_shift_update` refuses with.
use anyhow::{bail, Context, Result};
use houston_protocol::{
    AgentKind, NightAgent, NightClock, NightFocus, NightFocusLevel, NightOutput, NightPrSize,
    NightQuestions, NightShiftSettings, NightVerification, NightWindow, NIGHT_SHIFT_SETTINGS_VERSION,
    NIGHT_SHIFT_WINDOW_MAX_MINUTES,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// More workers than this would outgrow the orchestration child cap.
pub const LIVE_WORKERS_MAX: u32 = 12;
/// Grouping needs room for two; past twenty a pull request is no longer reviewable.
pub const MAX_CHANGES_PER_PR_MIN: u32 = 2;
pub const MAX_CHANGES_PER_PR_MAX: u32 = 20;
pub const CHECKS_MAX: usize = 20;
/// Where a check was found: a workflow and job name, or a file name.
pub const SOURCE_MAX: usize = 120;
/// The source of a check the user typed.
pub const ADDED_BY_YOU: &str = "added by you";
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
            docs_accuracy: NightFocusLevel::Off,
            test_gaps: NightFocusLevel::Off,
        },
        direction: String::new(),
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
        pr_size: NightPrSize::Related { max_changes: 5 },
        screenshots: true,
        app_qa: houston_protocol::NightAppQa::default(),
        hold_for_qa: true,
        checks: Vec::new(),
        verification: NightVerification::Light,
        questions: NightQuestions::Park,
    }
}

/// Reads a stored document, upgrading an older version first.
pub fn parse(json: &str) -> Result<NightShiftSettings> {
    let mut doc: Value = serde_json::from_str(json)
        .with_context(|| format!("unreadable Night shift settings {json:?}"))?;
    if doc.get("v").and_then(Value::as_u64) == Some(1) {
        upgrade_v1(&mut doc);
    }
    serde_json::from_value(doc)
        .with_context(|| format!("unreadable Night shift settings {json:?}"))
}

/// v1 → v2. Fields v2 dropped are ignored by the reader.
fn upgrade_v1(doc: &mut Value) {
    let Some(o) = doc.as_object_mut() else {
        return;
    };
    let max = o
        .remove("max_changes_per_pr")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .min(u64::from(MAX_CHANGES_PER_PR_MAX));
    o.remove("themed");
    if let Some(Value::Array(checks)) = o.get_mut("checks") {
        for c in checks.iter_mut() {
            if let Value::String(command) = c {
                *c = json!({ "command": command, "source": ADDED_BY_YOU });
            }
        }
    }
    o.insert("verification".into(), json!("light"));
    let app = o.remove("app_check").unwrap_or(Value::Null);
    let text = |key: &str| app.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let start = text("start_command");
    o.insert(
        "app_qa".into(),
        json!({
            "enabled": !start.trim().is_empty(),
            "source": if start.trim().is_empty() { "" } else { ADDED_BY_YOU },
            "start_command": start,
            "address": text("address"),
            "smoke_flows": app.get("smoke_flows").cloned().unwrap_or(json!([])),
        }),
    );
    if let Some(goal) = o.remove("goal") {
        o.insert("direction".into(), goal);
    }
    o.insert(
        "pr_size".into(),
        if max < u64::from(MAX_CHANGES_PER_PR_MIN) {
            json!({ "kind": "one" })
        } else {
            json!({ "kind": "related", "max_changes": max })
        },
    );
    o.insert("v".into(), json!(2));
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
    if let NightPrSize::Related { max_changes } = s.pr_size {
        if !(MAX_CHANGES_PER_PR_MIN..=MAX_CHANGES_PER_PR_MAX).contains(&max_changes) {
            bail!(
                "pull request size is related changes up to {max_changes}; expected \
                 {MAX_CHANGES_PER_PR_MIN} to {MAX_CHANGES_PER_PR_MAX}"
            );
        }
    }
    let smoke_flows = &s.app_qa.smoke_flows[..];
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
    let app = &s.app_qa;
    let texts = [
        ("direction", s.direction.as_str()),
        ("App start command", app.start_command.as_str()),
        ("App address", app.address.as_str()),
    ]
    .into_iter()
    .chain(s.checks.iter().map(|c| ("check", c.command.as_str())))
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
    if let Some(c) = s
        .checks
        .iter()
        .find(|c| c.source.chars().count() > SOURCE_MAX || c.command.trim().is_empty())
    {
        bail!(
            "check {:?} from {:?} is empty or its source is over {SOURCE_MAX} characters",
            c.command,
            c.source
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
    if s.focus.ui_polish != NightFocusLevel::Off && !s.screenshots {
        bail!(
            "UI and UX polish is on but screenshots are off; its changes are visible, so turn \
             screenshots on or turn UI and UX polish off"
        );
    }
    if s.focus.competitor_gaps != NightFocusLevel::Off && s.competitor_sources.is_empty() {
        bail!("competitor gaps is on but no competitor source is listed; add one or turn it off");
    }
    if s.output == NightOutput::MergeQueue {
        let mut missing = Vec::new();
        if !facts.merge_verify_command {
            missing.push("the workspace's merge queue verification command");
        }
        if !app_qa_on(s) {
            missing.push("App QA on with a start command");
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

/// App QA runs: it is on and knows how to start the app.
pub fn app_qa_on(s: &NightShiftSettings) -> bool {
    s.app_qa.enabled && !s.app_qa.start_command.trim().is_empty()
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

    /// A document an earlier version stored, with every v1 field.
    pub(crate) const V1_DOC: &str = r#"{"v":1,"enabled":false,
        "window":{"start":{"hour":23,"minute":30},"wrap_up":{"hour":6,"minute":45},
          "hard_stop":{"hour":7,"minute":30},"nights":[2]},
        "focus":{"reliability":"normal","performance":"high","ui_polish":"off",
          "competitor_gaps":"low","platform_parity":"normal","docs_accuracy":"off",
          "test_gaps":"off"},
        "goal":"no lost hook events",
        "competitor_sources":["https://github.com/pingdotgg/t3code","a notes file"],
        "orchestrator":{"provider":"claude","model":"opus"},
        "workers":[{"provider":"zcode","model":null}],"live_workers":4,"reviewer":null,
        "output":"prs","themed":true,"max_changes_per_pr":3,"screenshots":true,
        "app_check":{"start_command":"bun run dev","address":"","smoke_flows":["open"]},
        "hold_for_qa":true,"checks":["cargo test"],"safety_cap_pane_hours":60,
        "questions":"park"}"#;

    #[test]
    fn a_v1_document_upgrades_to_v2() {
        let s = parse(V1_DOC).unwrap();
        assert_eq!(s.v, 2);
        assert_eq!(s.pr_size, NightPrSize::Related { max_changes: 3 });
        assert_eq!(s.focus.performance, NightFocusLevel::High);
        assert_eq!(s.direction, "no lost hook events");
        assert_eq!(
            s.checks,
            [houston_protocol::NightCheck {
                command: "cargo test".into(),
                source: ADDED_BY_YOU.into()
            }]
        );
        assert_eq!(s.verification, NightVerification::Light);
        assert!(s.app_qa.enabled && s.app_qa.source == ADDED_BY_YOU, "{:?}", s.app_qa);
        assert_eq!(
            (s.app_qa.start_command.as_str(), &s.app_qa.smoke_flows[..]),
            ("bun run dev", &["open".to_string()][..])
        );
        let none = parse(&V1_DOC.replace(
            r#""app_check":{"start_command":"bun run dev","address":"","smoke_flows":["open"]}"#,
            r#""app_check":null"#,
        ))
        .unwrap();
        assert_eq!(none.app_qa, houston_protocol::NightAppQa::default());
        let one = parse(&V1_DOC.replace(r#""max_changes_per_pr":3"#, r#""max_changes_per_pr":1"#))
            .unwrap();
        assert_eq!(one.pr_size, NightPrSize::One);
        let v2 = serde_json::to_string(&defaults()).unwrap();
        assert_eq!(parse(&v2).unwrap(), defaults());
    }

    #[test]
    fn ui_polish_needs_screenshots() {
        let mut s = defaults();
        s.focus.ui_polish = NightFocusLevel::Low;
        s.screenshots = false;
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(
            err.contains("UI and UX polish") && err.contains("screenshots"),
            "{err}"
        );
        s.screenshots = true;
        validate(&s, &facts()).unwrap();
        s.focus.ui_polish = NightFocusLevel::Off;
        s.screenshots = false;
        validate(&s, &facts()).unwrap();
    }

    #[test]
    fn pr_size_bounds() {
        for bad in [1, 21] {
            let mut s = defaults();
            s.pr_size = NightPrSize::Related { max_changes: bad };
            let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
            assert!(err.contains(&format!("up to {bad}")) && err.contains("2 to 20"), "{err}");
        }
        let mut s = defaults();
        s.pr_size = NightPrSize::One;
        validate(&s, &facts()).unwrap();
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
        assert!(err.contains("App QA on with a start command"), "{err}");
        s.app_qa.start_command = "bun run dev".into();
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(err.contains("App QA"), "a start command alone is not App QA on: {err}");
        s.app_qa.enabled = true;
        let err = format!("{:#}", validate(&s, &facts()).unwrap_err());
        assert!(!err.contains("App QA"), "{err}");
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
        let app = |start: &str, address: &str, flows: Vec<String>| houston_protocol::NightAppQa {
            enabled: true,
            start_command: start.into(),
            source: ADDED_BY_YOU.into(),
            address: address.into(),
            smoke_flows: flows,
        };
        type Edit = Box<dyn Fn(&mut NightShiftSettings)>;
        let cases: Vec<(&str, Edit)> = vec![
            (
                "App start command",
                Box::new(move |s| s.app_qa = app(&"x".repeat(TEXT_FIELD_MAX + 1), "", vec![])),
            ),
            (
                "App address",
                Box::new(move |s| s.app_qa = app("", &"x".repeat(TEXT_FIELD_MAX + 1), vec![])),
            ),
            (
                "smoke flow",
                Box::new(move |s| s.app_qa = app("", "", vec!["x".repeat(TEXT_FIELD_MAX + 1)])),
            ),
            (
                "21 smoke flows",
                Box::new(move |s| {
                    s.app_qa = app("", "", vec!["open".into(); SMOKE_FLOWS_MAX + 1])
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
                Box::new(|s| {
                    s.checks = vec![
                        houston_protocol::NightCheck {
                            command: "c".repeat(TEXT_FIELD_MAX),
                            source: ADDED_BY_YOU.into()
                        };
                        13
                    ]
                }),
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

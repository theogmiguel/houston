//! Night shift: a built-in routine kind that runs an orchestrator pane for a
//! window, keeps a run ledger and leaves a morning report.
use serde::{Deserialize, Serialize};

use crate::{AgentKind, AgentStatus, RoutineTrigger};

/// The `v` of a stored settings document.
pub const NIGHT_SHIFT_SETTINGS_VERSION: u32 = 2;
/// The longest window, start to hard stop.
pub const NIGHT_SHIFT_WINDOW_MAX_MINUTES: u32 = 16 * 60;
/// A run's `report.md` past this is refused by `night_report`.
pub const NIGHT_SHIFT_REPORT_MAX_BYTES: u64 = 256 * 1024;
/// Run rows `night_shift_state` answers with, newest first.
pub const NIGHT_SHIFT_RUNS_PAGE: u32 = 20;
/// Run now's wrap-up comes this long before its hard stop.
pub const NIGHT_SHIFT_WRAP_UP_LEAD_MINUTES: u32 = 45;
/// Free memory below this blocks a start: one core build peaks near 4 GiB and
/// the orchestrator and workers need the rest.
pub const NIGHT_SHIFT_MEMORY_FLOOR_MIB: u32 = 6 * 1024;
/// Free disk below this blocks a start: each worker worktree builds its own target.
pub const NIGHT_SHIFT_DISK_FLOOR_MIB: u32 = 20 * 1024;
/// A ZCode pane that ends no turn for this long, with a failed quota probe, is limited.
pub const NIGHT_SHIFT_ZCODE_STALL_MINUTES: u32 = 20;
/// The ledger digest in a brief keeps at most this many entries.
pub const NIGHT_SHIFT_DIGEST_ENTRIES_MAX: u32 = 200;
/// One ledger entry's title; longer titles are refused.
pub const NIGHT_SHIFT_ENTRY_TITLE_MAX: usize = 200;
/// One ledger entry's body; longer bodies are refused.
pub const NIGHT_SHIFT_ENTRY_BODY_MAX: usize = 4_000;
/// Ledger entries one run may record.
pub const NIGHT_SHIFT_ENTRIES_PER_RUN_MAX: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightClock {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub hour: u8,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub minute: u8,
}

/// Local clock times. `nights` are the weekdays a scheduled run starts on,
/// 1 = Sunday … 7 = Saturday; an empty list never starts on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightWindow {
    pub start: NightClock,
    pub wrap_up: NightClock,
    pub hard_stop: NightClock,
    #[cfg_attr(feature = "ts-gen", ts(type = "number[]"))]
    pub nights: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightFocusLevel {
    Off,
    Low,
    Normal,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightFocus {
    pub reliability: NightFocusLevel,
    pub performance: NightFocusLevel,
    pub ui_polish: NightFocusLevel,
    pub competitor_gaps: NightFocusLevel,
    pub docs_accuracy: NightFocusLevel,
    pub test_gaps: NightFocusLevel,
}

/// A provider and, optionally, its model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightAgent {
    pub provider: AgentKind,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightOutput {
    /// Draft pull requests only.
    Prs,
    /// Ready pull requests handed to the workspace's merge queue.
    MergeQueue,
}

/// How a QA pane starts and drives the app. An empty `start_command` means no
/// App check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightAppCheck {
    pub start_command: String,
    pub address: String,
    pub smoke_flows: Vec<String>,
}

/// A command every change passes, and where Houston found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightCheck {
    pub command: String,
    /// `ci.yml · core-checks`, `package.json`, `AGENTS.md` or `added by you`.
    pub source: String,
}

/// How hard the independent verifier tries to break a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightVerification {
    /// Re-runs every proof and confirms each test exists and asserts its claim.
    #[default]
    Light,
    /// Also injects one fault per assertion; the test must then fail.
    Standard,
}

/// What Houston found in the workspace, for Setup to offer.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightDetected {
    /// From CI workflows, package manifests and AGENTS.md, runnable here.
    pub checks: Vec<NightCheck>,
}

/// How finished changes become pull requests. A change is one plan entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NightPrSize {
    /// One change per pull request.
    One,
    /// Changes of one theme together, at most `max_changes` per pull request.
    Related {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        max_changes: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightQuestions {
    /// Parked for the morning report; nothing is sent during the night.
    Park,
}

/// The stored document is `{"v":2,...}`; a v1 document is upgraded on read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightShiftSettings {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub v: u32,
    pub enabled: bool,
    pub window: NightWindow,
    pub focus: NightFocus,
    /// Where the run should go, in the user's words: a priority within the
    /// focus areas, not a completion condition. Empty for none.
    pub direction: String,
    pub competitor_sources: Vec<String>,
    pub orchestrator: NightAgent,
    /// The worker providers in fallback order.
    pub workers: Vec<NightAgent>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub live_workers: u32,
    /// Absent means the orchestrator's provider and model.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub reviewer: Option<NightAgent>,
    pub output: NightOutput,
    pub pr_size: NightPrSize,
    pub screenshots: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub app_check: Option<NightAppCheck>,
    pub hold_for_qa: bool,
    /// Commands Houston runs on every pull request's head.
    pub checks: Vec<NightCheck>,
    pub verification: NightVerification,
    pub questions: NightQuestions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PreflightStatus {
    Ok,
    Warn,
    Block,
}

/// One preflight check under a stable `id` (`memory`, `hooks_off:<provider>`,
/// …); `limit` and `actual` name a threshold's numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PreflightItem {
    pub id: String,
    pub status: PreflightStatus,
    pub label: String,
    pub detail: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub limit: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightRunPhase {
    /// Preflight or the launch refused it; nothing ran.
    Refused,
    Running,
    /// Wrap-up passed: the orchestrator was told to start nothing new.
    WrappingUp,
    Settled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightStopReason {
    /// The report was published and the orchestrator's turn ended.
    Report,
    HardStop,
    /// The user chose Stop.
    Stopped,
    PaneExited,
    /// The daemon came back after wrap-up or past the hard stop.
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightKeepAwake {
    /// No run holds it.
    Off,
    Held,
    /// The platform refused or has no inhibitor; the run continues.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightInterruption {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub resumed_at_ms: i64,
    pub detail: String,
    /// False when the run was settled instead of resumed.
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightCostLine {
    pub provider: AgentKind,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub panes: u32,
    pub pane_hours: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightCost {
    pub pane_hours: f64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub panes: u32,
    pub per_provider: Vec<NightCostLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightEntryKind {
    Plan,
    Pr,
    Lesson,
    Decision,
    Deferred,
    Flaky,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NightGate {
    #[default]
    None,
    Pending,
    Passed,
    Failed,
}

/// A PR's gates. `checks` and `ci` are facts Houston or CI observed; `review`
/// and `qa` are agents' verdicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightGates {
    #[serde(default)]
    pub checks: NightGate,
    #[serde(default)]
    pub review: NightGate,
    #[serde(default)]
    pub qa: NightGate,
    #[serde(default)]
    pub ci: NightGate,
    /// CI re-runs Houston asked for after a known flaky failure.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub reruns: u32,
}

/// One row of the run ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightEntry {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub run_id: u32,
    pub kind: NightEntryKind,
    pub title: String,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub theme: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub status: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub pr_number: Option<u32>,
    /// A change the user can see in the app.
    pub visible: bool,
    pub qa_passed: bool,
    pub body: String,
    pub gates: NightGates,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub decided_at_ms: Option<i64>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub choice: Option<String>,
}

/// A pane of a live run, the orchestrator first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightCrewMember {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub session_id: u32,
    pub provider: AgentKind,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub role: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub status: Option<AgentStatus>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub started_at_ms: i64,
    pub limited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightRun {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub run_id: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub routine_id: u32,
    pub workspace: String,
    pub trigger: RoutineTrigger,
    pub phase: NightRunPhase,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub session_id: Option<u32>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub started_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub wrap_up_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub hard_stop_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub ended_at_ms: Option<i64>,
    pub report_path: String,
    pub report_published: bool,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub summary: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub stop_reason: Option<NightStopReason>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub stop_detail: Option<String>,
    pub interruptions: Vec<NightInterruption>,
    pub cost: NightCost,
    /// Providers that reported a limit during this run.
    pub limited: Vec<AgentKind>,
    pub preflight: Vec<PreflightItem>,
    pub keep_awake: NightKeepAwake,
    /// PR numbers in the order the orchestrator suggests merging them.
    #[cfg_attr(feature = "ts-gen", ts(type = "number[]"))]
    pub merge_order: Vec<u32>,
    pub entries: Vec<NightEntry>,
    pub crew: Vec<NightCrewMember>,
}

/// The machine as preflight last read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct NightMachine {
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub memory_free_mib: Option<u32>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub disk_free_mib: Option<u32>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "boolean | null"))]
    pub on_battery: Option<bool>,
    pub keep_awake: NightKeepAwake,
}

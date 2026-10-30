//! Night shift: a built-in routine kind that runs an orchestrator pane for a
//! window, keeps a run ledger and leaves a morning report.
use serde::{Deserialize, Serialize};

use crate::{AgentKind, AgentStatus, RoutineTrigger, UsageTokenTotals};

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
/// A Working pane that ends no turn for this long gets a quota probe.
pub const NIGHT_SHIFT_STALL_MINUTES: u32 = 20;
/// The ledger digest in a brief keeps at most this many entries.
pub const NIGHT_SHIFT_DIGEST_ENTRIES_MAX: u32 = 200;
/// One ledger entry's title; longer titles are refused.
pub const NIGHT_SHIFT_ENTRY_TITLE_MAX: usize = 200;
/// One ledger entry's body; longer bodies are refused.
pub const NIGHT_SHIFT_ENTRY_BODY_MAX: usize = 4_000;
/// Ledger entries one run may record.
pub const NIGHT_SHIFT_ENTRIES_PER_RUN_MAX: u32 = 500;
/// Claims one plan entry may carry; more is several changes.
pub const NIGHT_SHIFT_CLAIMS_MAX: usize = 12;
/// One claim, proof, evidence or fault text.
pub const NIGHT_SHIFT_CLAIM_TEXT_MAX: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightClock {
    pub hour: u8,
    pub minute: u8,
}

/// Local clock times. `nights` are the weekdays a scheduled run starts on,
/// 1 = Sunday … 7 = Saturday; an empty list never starts on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightWindow {
    pub start: NightClock,
    pub wrap_up: NightClock,
    pub hard_stop: NightClock,
    pub nights: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NightFocusLevel {
    Off,
    Low,
    Normal,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct NightAgent {
    pub provider: AgentKind,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NightOutput {
    /// Draft pull requests only.
    Prs,
    /// Ready pull requests handed to the workspace's merge queue.
    MergeQueue,
}

/// App QA: a QA pane starts the app, opens what each visible change touches
/// and checks that change's claims plus the smoke flows. On only when
/// `enabled` and a start command is set.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NightAppQa {
    pub enabled: bool,
    pub start_command: String,
    /// Where the start command was found, or `added by you`; empty for none.
    pub source: String,
    /// A fixed address every change starts from; empty means each change
    /// opens the story or screen it touches.
    pub address: String,
    /// Flows run on every change, beyond its claims.
    pub smoke_flows: Vec<String>,
}

/// What a run studies for Competitor gaps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NightCompetitor {
    /// A GitHub repository, `owner/repo`, cloned read-only.
    Repo { repo: String },
    /// An app installed on this computer, analysed with REA.
    App {
        name: String,
        version: String,
        path: String,
    },
}

/// An app installed on this computer, as Setup offers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightInstalledApp {
    pub name: String,
    /// Empty when the app reports none.
    pub version: String,
    pub path: String,
}

/// A command every change passes, and where Houston found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightCheck {
    pub command: String,
    /// `ci.yml · core-checks`, `package.json`, `AGENTS.md` or `added by you`.
    pub source: String,
}

/// How hard the independent verifier tries to break a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
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
pub struct NightDetected {
    /// From CI workflows, package manifests and AGENTS.md, runnable here.
    pub checks: Vec<NightCheck>,
    /// How the app starts, from a harness, package scripts or AGENTS.md.
    #[serde(default)]
    pub start_command: Option<NightCheck>,
    /// Apps installed on this computer, by name.
    #[serde(default)]
    pub apps: Vec<NightInstalledApp>,
    /// Why `apps` is empty on this platform, when it cannot list them.
    #[serde(default)]
    pub apps_note: Option<String>,
}

/// How finished changes become pull requests. A change is one plan entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NightPrSize {
    /// One change per pull request.
    One,
    /// Changes of one theme together, at most `max_changes` per pull request.
    Related { max_changes: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NightQuestions {
    /// Parked for the morning report; nothing is sent during the night.
    Park,
}

/// The stored document is `{"v":2,...}`; a v1 document is upgraded on read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightShiftSettings {
    pub v: u32,
    pub enabled: bool,
    pub window: NightWindow,
    pub focus: NightFocus,
    /// Where the run should go, in the user's words: a priority within the
    /// focus areas, not a completion condition. Empty for none.
    pub direction: String,
    pub competitors: Vec<NightCompetitor>,
    pub orchestrator: NightAgent,
    /// The worker providers in fallback order.
    pub workers: Vec<NightAgent>,
    pub live_workers: u32,
    /// Absent means the orchestrator's provider and model.
    #[serde(default)]
    pub reviewer: Option<NightAgent>,
    pub output: NightOutput,
    pub pr_size: NightPrSize,
    pub screenshots: bool,
    pub app_qa: NightAppQa,
    pub hold_for_qa: bool,
    /// Commands Houston runs on every pull request's head.
    pub checks: Vec<NightCheck>,
    pub verification: NightVerification,
    pub questions: NightQuestions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightStatus {
    Ok,
    Warn,
    Block,
}

/// One preflight check under a stable `id` (`memory`, `hooks_off:<provider>`,
/// …); `limit` and `actual` name a threshold's numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreflightItem {
    pub id: String,
    pub status: PreflightStatus,
    pub label: String,
    pub detail: String,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "snake_case")]
pub enum NightKeepAwake {
    /// No run holds it.
    Off,
    Held,
    /// The platform refused or has no inhibitor; the run continues.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightInterruption {
    pub at_ms: i64,
    pub resumed_at_ms: i64,
    pub detail: String,
    /// False when the run was settled instead of resumed.
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NightCostLine {
    pub provider: AgentKind,
    pub panes: u32,
    pub pane_hours: f64,
    /// The provider's own token counts for the run's window; `None` when its
    /// CLI exposes none to Houston. Never a zero standing in for "unknown".
    #[serde(default)]
    pub tokens: Option<UsageTokenTotals>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NightCost {
    pub pane_hours: f64,
    pub panes: u32,
    pub per_provider: Vec<NightCostLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NightEntryKind {
    Plan,
    Pr,
    Lesson,
    Decision,
    Deferred,
    Flaky,
    /// What a run studied of a competitor: title the competitor, status the
    /// release tag or app version.
    Studied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NightGate {
    #[default]
    None,
    Pending,
    Passed,
    Failed,
}

/// A PR's gates. `checks`, `ci` and `verify` are facts Houston or CI
/// observed (Houston ran the checks; the verifier's per-claim verdicts);
/// `review` and `qa` are agents' verdicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NightGates {
    #[serde(default)]
    pub checks: NightGate,
    #[serde(default)]
    pub review: NightGate,
    #[serde(default)]
    pub qa: NightGate,
    #[serde(default)]
    pub ci: NightGate,
    /// Every claim of the PR's plan entries has a passing verdict (passed),
    /// or one has a failing one (failed).
    #[serde(default)]
    pub verify: NightGate,
    /// CI re-runs Houston asked for after a known flaky failure.
    #[serde(default)]
    pub reruns: u32,
    /// Fixer panes Houston started for this PR's CI failures.
    #[serde(default)]
    pub fixes: u32,
}

/// What a planned change must make true, with a concrete value, and the
/// specific test that proves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightClaim {
    pub claim: String,
    pub proof: String,
}

/// One check Houston ran on a pull request's head.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightCheckRun {
    pub command: String,
    pub passed: bool,
    /// Absent when the command timed out or could not start.
    #[serde(default)]
    pub code: Option<i32>,
    /// The output's last lines, for a failure.
    pub tail: String,
}

/// The independent verifier's verdict on one claim of a plan entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightVerdict {
    /// The plan entry's id.
    pub plan: u32,
    /// The claim's index in that entry's claims.
    pub claim: u32,
    pub passed: bool,
    /// `file:line` of the proof that ran, and what it showed.
    pub evidence: String,
    /// With Standard depth: the fault injected and the test failing on it.
    #[serde(default)]
    pub fault: Option<String>,
    /// The pane that verified.
    pub verifier: u32,
}

/// What a plan or pull request entry carries beyond its row.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NightEntryDetail {
    /// A plan entry's claims.
    #[serde(default)]
    pub claims: Vec<NightClaim>,
    /// A pull request's plan entries.
    #[serde(default)]
    pub plans: Vec<u32>,
    /// The commit Houston ran the checks on.
    #[serde(default)]
    pub head_sha: Option<String>,
    /// Panes that built the change; none of them may verify it.
    #[serde(default)]
    pub built_by: Vec<u32>,
    #[serde(default)]
    pub checks_run: Vec<NightCheckRun>,
    #[serde(default)]
    pub verdicts: Vec<NightVerdict>,
}

/// One row of the run ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightEntry {
    pub id: u32,
    pub run_id: u32,
    pub kind: NightEntryKind,
    pub title: String,
    pub theme: Option<String>,
    pub status: Option<String>,
    pub pr_number: Option<u32>,
    /// A change the user can see in the app.
    pub visible: bool,
    pub qa_passed: bool,
    pub body: String,
    pub gates: NightGates,
    pub created_at_ms: i64,
    pub decided_at_ms: Option<i64>,
    pub choice: Option<String>,
    #[serde(default)]
    pub detail: NightEntryDetail,
}

/// A pane of a live run, the orchestrator first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightCrewMember {
    pub session_id: u32,
    pub provider: AgentKind,
    pub role: Option<String>,
    pub status: Option<AgentStatus>,
    pub started_at_ms: i64,
    pub limited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NightRun {
    pub run_id: u32,
    pub routine_id: u32,
    pub workspace: String,
    pub trigger: RoutineTrigger,
    pub phase: NightRunPhase,
    pub session_id: Option<u32>,
    pub started_at_ms: i64,
    pub wrap_up_at_ms: i64,
    pub hard_stop_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub report_path: String,
    pub report_published: bool,
    pub summary: Option<String>,
    pub stop_reason: Option<NightStopReason>,
    pub stop_detail: Option<String>,
    pub interruptions: Vec<NightInterruption>,
    pub cost: NightCost,
    /// Providers that reported a limit during this run.
    pub limited: Vec<AgentKind>,
    pub preflight: Vec<PreflightItem>,
    pub keep_awake: NightKeepAwake,
    /// PR numbers in the order the orchestrator suggests merging them.
    pub merge_order: Vec<u32>,
    pub entries: Vec<NightEntry>,
    pub crew: Vec<NightCrewMember>,
}

/// The machine as preflight last read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NightMachine {
    pub memory_free_mib: Option<u32>,
    pub disk_free_mib: Option<u32>,
    pub on_battery: Option<bool>,
    pub keep_awake: NightKeepAwake,
}

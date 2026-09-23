use serde::{Deserialize, Serialize};

/// Bump once per wire-touching batch (`/ws` only); several PRs may land
/// under one coordinated bump instead of each incrementing it.
pub const PROTOCOL_VERSION: u32 = 113;

pub const VOICE_LEVEL_INTERVAL_MS: u64 = 50;

pub const FRAME_OUTPUT: u8 = 1;
pub const FRAME_STDIN: u8 = 2;
pub const FRAME_GAP: u8 = 3;
pub const FRAME_STDIN_HEADER_LEN: usize = 5;
pub const FRAME_OUTPUT_HEADER_LEN: usize = 13;
pub const FRAME_GAP_LEN: usize = 21;

pub fn encode_output_frame(session: u32, offset: u64, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_OUTPUT_HEADER_LEN + payload.len());
    buf.push(FRAME_OUTPUT);
    buf.extend_from_slice(&session.to_be_bytes());
    buf.extend_from_slice(&offset.to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

pub fn decode_output_frame(buf: &[u8]) -> Option<(u32, u64, &[u8])> {
    if buf.len() < FRAME_OUTPUT_HEADER_LEN || buf[0] != FRAME_OUTPUT {
        return None;
    }
    let session = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let offset = u64::from_be_bytes([
        buf[5], buf[6], buf[7], buf[8], buf[9], buf[10], buf[11], buf[12],
    ]);
    Some((session, offset, &buf[FRAME_OUTPUT_HEADER_LEN..]))
}

pub fn encode_stdin_frame(session: u32, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_STDIN_HEADER_LEN + payload.len());
    buf.push(FRAME_STDIN);
    buf.extend_from_slice(&session.to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

pub fn decode_stdin_frame(buf: &[u8]) -> Option<(u32, &[u8])> {
    if buf.len() < FRAME_STDIN_HEADER_LEN || buf[0] != FRAME_STDIN {
        return None;
    }
    let session = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    Some((session, &buf[FRAME_STDIN_HEADER_LEN..]))
}

pub fn encode_gap_frame(session: u32, bytes_seen: u64, dropped: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_GAP_LEN);
    buf.push(FRAME_GAP);
    buf.extend_from_slice(&session.to_be_bytes());
    buf.extend_from_slice(&bytes_seen.to_be_bytes());
    buf.extend_from_slice(&dropped.to_be_bytes());
    buf
}

pub fn decode_gap_frame(buf: &[u8]) -> Option<(u32, u64, u64)> {
    // `!=`, not `<`: a gap frame carries no payload, so any other length is
    // malformed, not merely truncated.
    if buf.len() != FRAME_GAP_LEN || buf[0] != FRAME_GAP {
        return None;
    }
    let session = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let bytes_seen = u64::from_be_bytes(buf[5..13].try_into().expect("5..13 is 8 bytes"));
    let dropped = u64::from_be_bytes(buf[13..21].try_into().expect("13..21 is 8 bytes"));
    Some((session, bytes_seen, dropped))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    #[serde(alias = "gemini")]
    Antigravity,
    Shell,
    Custom,
    Opencode,
    Cursor,
    Grok,
    Droid,
    Copilot,
    Aider,
    Ssh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub url: Option<String>,
    pub headers: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub enabled: bool,
    pub fingerprint: String,
    #[serde(default)]
    pub destinations: Vec<AgentKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct McpToolState {
    pub tool: AgentKind,
    pub path: String,
    pub detected: bool,
    pub servers: Vec<McpServer>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum McpConnectionCheck {
    NotChecked,
    Checking,
    Verified {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        tool_count: u32,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct AgentProfile {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u32,
    pub agent: AgentKind,
    pub name: String,
    pub config_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct AgentProfileActive {
    pub agent: AgentKind,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileChoice {
    Default,
    Profile {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        id: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct Routine {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u32,
    pub name: String,
    pub prompt: String,
    pub cadence: Cadence,
    pub enabled: bool,
    /// The working directory a run starts in, and the base an isolated run
    /// branches from.
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub workspace_id: Option<String>,
    /// The provider a run executes with.
    pub engine: AgentKind,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub model: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub effort: Option<ChatEffort>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub next_run_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub last_run_at_ms: Option<i64>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub last_run_session_id: Option<u32>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub last_error: Option<String>,
    pub permission_mode: ChatPermissionMode,
    pub isolate: bool,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub last_outcome: Option<RoutineOutcome>,
    pub revision: String,
}

/// Why one run of a routine started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum RoutineTrigger {
    Schedule,
    Manual,
}

/// The state of one run. `Running` is the only non-terminal arm; every other
/// arm is the `RoutineOutcome` of the same name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum RoutineRunStatus {
    Running,
    Ok,
    Denied,
    KilledAtCap,
    EngineRefused,
    Failed,
}

impl From<RoutineOutcome> for RoutineRunStatus {
    fn from(outcome: RoutineOutcome) -> Self {
        match outcome {
            RoutineOutcome::Ok => Self::Ok,
            RoutineOutcome::Denied => Self::Denied,
            RoutineOutcome::KilledAtCap => Self::KilledAtCap,
            RoutineOutcome::EngineRefused => Self::EngineRefused,
            RoutineOutcome::Failed => Self::Failed,
        }
    }
}

/// One execution of a routine, independent of any conversation. A run carries
/// the pane `session_id` its turn runs in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct RoutineRun {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub routine_id: u32,
    pub trigger: RoutineTrigger,
    pub status: RoutineRunStatus,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub session_id: Option<u32>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub error: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub started_at_ms: i64,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub ended_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum RoutineOutcome {
    Ok,
    Denied,
    KilledAtCap,
    EngineRefused,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Cadence {
    Interval {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        seconds: u32,
    },
    Clock {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        hour: u8,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        minute: u8,
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number[] | null"))]
        weekdays: Option<Vec<u8>>,
    },
}

/// Distinguishes an absent key (`None`, leave unchanged) from an explicit
/// `null` (`Some(None)`, clear the field) from a real value (`Some(Some(_))`).
fn double_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Deserialize::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum RoutineErrorKind {
    Conflict,
    DuplicateName,
    Limit,
    NotFound,
    /// A manual run was asked for while this routine's previous run is still
    /// in flight; one routine runs one turn at a time.
    AlreadyRunning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SkillToolState {
    pub tool: AgentKind,
    pub path: String,
    pub detected: bool,
    pub inherits_claude: bool,
    pub skills: Vec<SkillEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SkillPushRecord {
    pub tool: AgentKind,
    pub skill: String,
    pub path: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub pushed_at: i64,
    pub had_existing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct McpSyncResult {
    pub tool: AgentKind,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub written: usize,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub removed: usize,
    pub skipped: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum AgentHookScope {
    Workspace,
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct AgentHookState {
    pub provider: AgentKind,
    pub path: String,
    pub scope: AgentHookScope,
    pub enabled: bool,
    pub installed: bool,
    pub error: Option<String>,
    pub present: bool,
    pub version: Option<String>,
    #[serde(default)]
    pub trust: Option<HookTrust>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum HookTrust {
    NoConfig,
    NotConfirmed,
    SomeTrusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "kebab-case")]
pub enum RestoreReason {
    /// A sibling's respawn already failed this boot; this husk was never
    /// attempted. Distinct from `SpawnFailed`, which names the failing husk.
    CircuitBreaker,
    InvalidCwd,
    Ssh,
    Budget,
    PreviousCrash,
    SafeMode,
    SpawnFailed,
}

/// No variant here ever carries a credential: `passphrase_profile` and
/// `Password.profile` are keychain lookup keys, not secrets — the secret
/// itself never crosses the wire, lands in the DB, or appears in a log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshAuth {
    Agent,
    IdentityFile {
        path: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        passphrase_profile: Option<String>,
    },
    Password {
        profile: String,
    },
    SshConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SshProfile {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub default_dir: Option<String>,
    #[serde(default)]
    pub startup_cmd: Option<String>,
    /// Unix SECONDS, unlike the millisecond `_at` fields elsewhere on this wire.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(type = "number | null"))]
    pub last_used_at: Option<u64>,
    #[serde(default)]
    pub has_credential: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SwarmStatus {
    Idle,
    Active,
    Completed,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SwarmRole {
    Coordinator,
    Builder,
    Scout,
    Reviewer,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SwarmAgentStatus {
    Idle,
    Spawning,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SwarmMsgKind {
    Message,
    Status,
    Escalation,
    WorkerDone,
    SwarmComplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SessionPolicy {
    pub idle_reap_enabled: bool,
    pub idle_reap_minutes: u32,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        SessionPolicy {
            idle_reap_enabled: false,
            idle_reap_minutes: 15,
        }
    }
}

/// Off means no request is ever made. On, the request carries nothing about the
/// machine it came from: no version, no OS, no identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UpdatePolicy {
    pub check: bool,
}

impl Default for UpdatePolicy {
    fn default() -> Self {
        UpdatePolicy { check: true }
    }
}

/// What the daemon found on GitHub. `notes` is the release body verbatim; no
/// installer URL rides here, because the app's signed updater manifest picks the
/// artifact for this exact bundle instead of the daemon guessing one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UpdateRelease {
    pub version: String,
    /// GitHub's release body, verbatim; empty when the release carries none.
    pub notes: String,
    pub notes_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateState {
    /// Never asked in this daemon's lifetime — distinct from "asked and found
    /// nothing", which is what lets the panel say when it last looked.
    #[default]
    Unknown,
    Disabled,
    Checking,
    UpToDate {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        checked_at_ms: u64,
    },
    Available {
        release: UpdateRelease,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        checked_at_ms: u64,
    },
    Failed {
        error: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        checked_at_ms: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SwarmSeverity {
    #[default]
    None,
    Escalation,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SwarmInfo {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u64,
    pub name: String,
    pub root_dir: String,
    pub goal: String,
    pub status: SwarmStatus,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
    #[serde(default)]
    pub budget_minutes: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub activated_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub completed_at: Option<u64>,
    #[serde(default)]
    pub severity: SwarmSeverity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SwarmAgentInfo {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub swarm: u64,
    pub label: String,
    pub role: SwarmRole,
    pub agent: AgentKind,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub session: Option<u32>,
    pub auto_approve: bool,
    #[serde(default)]
    pub plan_mode: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub model: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub custom_prompt: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub cmd: Option<Vec<String>>,
    pub status: SwarmAgentStatus,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub activity: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SwarmMessage {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub id: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub swarm: u64,
    pub from: String,
    pub to: String,
    pub body: String,
    pub kind: SwarmMsgKind,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SwarmRosterEntry {
    pub label: String,
    pub role: SwarmRole,
    pub agent: AgentKind,
    pub auto_approve: bool,
    #[serde(default)]
    pub plan_mode: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub model: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub custom_prompt: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub cmd: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SessionCwdEntry {
    pub session: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SessionProcsEntry {
    pub session: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub has_procs: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub has_running_procs: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct KeyChord {
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct KeymapOverrides {
    pub bindings: std::collections::HashMap<String, KeyChord>,
    #[serde(default = "default_true")]
    pub shortcuts_enabled: bool,
}

impl Default for KeymapOverrides {
    fn default() -> Self {
        KeymapOverrides {
            bindings: std::collections::HashMap::new(),
            shortcuts_enabled: true,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct RecoverySummary {
    pub respawned: u32,
    pub deferred: u32,
    pub crashed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SafeModeSummary {
    pub disable_auto_restore: bool,
    pub disable_swarm_autolaunch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Exited,
    Killed,
    Interrupted,
}

impl SessionState {
    pub fn is_live(self) -> bool {
        matches!(self, SessionState::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "kebab-case")]
pub enum AgentStatus {
    Spawning,
    Working,
    Idle,
    NeedsInput,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ContextState {
    Unknown,
    Idle,
    Working,
    NearLimit,
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ContextSource {
    Reported,
    Derived,
}

// A session's latest context occupancy, including output. A provider with no
// readable signal carries `state: Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SessionContext {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub used_tokens: u64,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub window_tokens: Option<u64>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub used_percent: Option<u8>,
    pub state: ContextState,
    pub source: ContextSource,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub as_of_ms: i64,
}

impl SessionContext {
    /// No readable signal for this session; the UI hides the indicator.
    pub fn unknown() -> Self {
        Self {
            used_tokens: 0,
            window_tokens: None,
            used_percent: None,
            state: ContextState::Unknown,
            source: ContextSource::Reported,
            as_of_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "kebab-case")]
pub enum AgentNoticeKind {
    Finished,
    NeedsInput,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct OrchestrationCaps {
    pub max_live_children: u32,
    pub max_spawn_depth: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct AcpAgentInfo {
    pub slug: String,
    pub display_name: String,
    pub command: String,
    pub agent: AgentKind,
}

pub const DEFAULT_RMS_FLOOR: f32 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum CloudStt {
    Groq,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceEngine {
    Local { model_id: String },
    Cloud { provider: CloudStt },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum VoiceOutputMode {
    Original,
    English,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum InsertMode {
    Direct,
    ConfirmFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum MicPolicy {
    Persistent,
    OnKeypress,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct VoiceSettings {
    pub enabled: bool,
    pub engine: VoiceEngine,
    pub output_mode: VoiceOutputMode,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub input_language: Option<String>,
    pub capture_mode: CaptureMode,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub input_device: Option<String>,
    pub insert_mode: InsertMode,
    pub vocabulary: String,
    pub agent_preamble: bool,
    pub mic_policy: MicPolicy,
    #[serde(default = "default_rms_floor")]
    pub rms_floor: f32,
}

fn default_rms_floor() -> f32 {
    DEFAULT_RMS_FLOOR
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: VoiceEngine::Local {
                model_id: "ggml-small".to_string(),
            },
            output_mode: VoiceOutputMode::Original,
            input_language: None,
            capture_mode: CaptureMode::Hold,
            input_device: None,
            insert_mode: InsertMode::Direct,
            vocabulary: String::new(),
            agent_preamble: true,
            mic_policy: MicPolicy::Persistent,
            rms_floor: DEFAULT_RMS_FLOOR,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct VoiceDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceModelStatus {
    NotDownloaded,
    Downloading {
        progress: f32,
    },
    Downloaded {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        size_bytes: u64,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct VoiceModelState {
    pub id: String,
    pub display_name: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub size_bytes: u64,
    pub status: VoiceModelStatus,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub cooldown_remaining_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceFailure {
    NoModel {
        model_id: String,
    },
    MissingKey {
        provider: CloudStt,
    },
    DeviceUnavailable {
        device: String,
    },
    TooQuiet {
        rms: f32,
        floor: f32,
    },
    TooShort {
        seconds: f32,
        minimum: f32,
    },
    RingBufferOverrun {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        dropped: u64,
    },
    NoSpeech,
    TargetGone {
        session: u32,
    },
    Engine {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VoiceState {
    Idle,
    Listening { session: u32 },
    Transcribing { session: u32 },
    Error { failure: VoiceFailure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum DelegationState {
    Spawning,
    Working,
    NeedsInput,
    Done,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub enum TurnEndSource {
    #[serde(rename = "stop-hook")]
    StopHook,
    #[serde(rename = "acp-turn")]
    AcpTurn,
    #[serde(rename = "quiet-settle")]
    QuietSettle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct DelegationInfo {
    pub parent: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub role: Option<String>,
    pub state: DelegationState,
    pub stalled: bool,
    pub result_staged: bool,
    pub superseded: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub ended_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub stop_reason: Option<String>,
    pub turn_end_source: TurnEndSource,
    #[serde(default)]
    pub inbox_owed: u32,
    #[serde(default)]
    pub inbox_provisional: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub last_result_corrected_by: Option<i64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub capability_note: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub hold_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum InboxKind {
    Result,
    NoHandback,
    NeedsInput,
    Exited,
    Stalled,
    OperatorNote,
    Mail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum InboxDeliveredVia {
    Wait,
    StopHook,
    Paste,
    Operator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct InboxRow {
    pub id: i64,
    pub to_session: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub original_to: Option<u32>,
    pub workspace: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub from_session: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub request_id: Option<u32>,
    pub kind: InboxKind,
    pub urgent: bool,
    pub summary: String,
    pub body: String,
    pub artifacts: Vec<String>,
    pub superseded: u32,
    pub provisional: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub corrects: Option<i64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub reason: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub ready_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub resolved_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub delivered_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub delivered_via: Option<InboxDeliveredVia>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub confirmed_at: Option<u64>,
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct SessionInfo {
    pub id: u32,
    pub agent: AgentKind,
    pub project_dir: String,
    pub cwd: String,
    pub state: SessionState,
    pub title: String,
    #[serde(default)]
    pub codename: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub detected_agent: Option<AgentKind>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub ssh_host: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub restore_deferred: Option<RestoreReason>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub status: Option<AgentStatus>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub context: Option<SessionContext>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub swarm_agent: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub spawned_by: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub acp: Option<String>,
    #[serde(default)]
    pub live_children: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub profile_label: Option<String>,
    #[serde(default)]
    pub children_waiting: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub delegation: Option<DelegationInfo>,
    #[serde(default)]
    pub inbox_unread: u32,
    #[serde(default)]
    pub tags: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TagInfo {
    pub id: u32,
    pub name: String,
    pub color: String,
}

pub const TAG_PALETTE: [&str; 11] = [
    "#a78bfa", "#7cb7ff", "#22d3ee", "#2dd4bf", "#4ade80", "#a3e635", "#f59e0b", "#fb923c",
    "#f472b6", "#e879f9", "#a8b0c2",
];

pub const MAX_TAG_NAME_LEN: usize = 32;

pub const MAX_TAGS_PER_SESSION: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct Workspace {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GitFileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct GitFileStatus {
    pub path: String,
    pub status: GitFileState,
    pub staged: bool,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub added: Option<i64>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub deleted: Option<i64>,
    pub is_sensitive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GitReviewScope {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct GitReviewSection {
    pub scope: GitReviewScope,
    pub patch: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GitDiscardKind {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    pub is_default: bool,
    pub is_remote: bool,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub remote_name: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub upstream: Option<String>,
    /// Set when another worktree has this branch checked out; that worktree
    /// holds the branch, so it cannot be switched to or deleted here.
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct GitWorktreeInfo {
    pub path: String,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub branch: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub head: Option<String>,
    pub is_main: bool,
    pub is_detached: bool,
    pub is_bare: bool,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct GitCheckpointInfo {
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub label: String,
    pub owner: String,
    pub sha: String,
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub created_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GitCheckpointAgainst {
    Working,
    Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GitPullStatus {
    Pulled,
    UpToDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum GhState {
    Missing,
    Unauthenticated,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrChecks {
    None,
    Running,
    Passing,
    Failing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrInfo {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub url: String,
    pub state: String,
    pub review_decision: Option<String>,
    pub checks: PrChecks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PullRequestLinkSource {
    Manual,
    Created,
    Agent,
    /// The branch's own pull request, resolved by `gh pr view`; never persisted.
    Detected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PullRequestLink {
    pub host: String,
    pub repository: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub url: String,
    pub state: PullRequestState,
    pub source: PullRequestLinkSource,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub title: Option<String>,
    pub is_draft: bool,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub additions: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub deletions: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub changed_files: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub checks: Option<PrChecks>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub review_decision: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub linked_at: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub merged_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub closed_at: Option<u64>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub synced_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrMergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrMergeState {
    Clean,
    Behind,
    Blocked,
    Dirty,
    Draft,
    HasHooks,
    Unstable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrCheckState {
    Queued,
    Running,
    Passing,
    Failing,
    Skipped,
    /// A status or conclusion this build does not recognise; refuse merge on it.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrCheck {
    pub name: String,
    pub state: PrCheckState,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub url: Option<String>,
    /// Only a completed check run carries both timestamps; absent otherwise.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrComment {
    /// GitHub's node id, where the read that produced this comment carried one;
    /// it is what an edit or a reaction on the remark names.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub id: Option<String>,
    pub author: String,
    pub body: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub url: Option<String>,
    #[serde(default)]
    pub reactions: Vec<PrReactionCount>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrReview {
    /// GitHub's node id, where the read carried one; a reaction on the review
    /// names it.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub id: Option<String>,
    pub author: String,
    pub state: String,
    pub body: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub submitted_at: u64,
    #[serde(default)]
    pub reactions: Vec<PrReactionCount>,
}

/// The reading behind one pull request: what the body, checks, reviews and merge
/// gate say right now. The identity (number, url, state, title) rides separately
/// in `PullRequestLink`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrDetail {
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub body: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub author: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub base_ref: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub head_ref: Option<String>,
    pub head_sha: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub commit_count: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub updated_at: u64,
    pub mergeable: PrMergeable,
    pub merge_state: PrMergeState,
    #[serde(default)]
    pub checks: Vec<PrCheck>,
    #[serde(default)]
    pub comments: Vec<PrComment>,
    #[serde(default)]
    pub reviews: Vec<PrReview>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub comments_total: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub reviews_total: u32,
    /// Server-computed gate: `None` means the action is allowed, `Some` names the
    /// fact that blocks it. The UI shows it; the daemon re-checks it before merging.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub merge_disabled_reason: Option<String>,
    /// What GitHub says this viewer may do here, or `None` when that read failed;
    /// `viewer_message` then names why, and no write is offered.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub viewer: Option<PrPermissions>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub viewer_message: Option<String>,
    /// Commits the head is behind its base; `None` when the comparison could not
    /// be made, which is not the same fact as `Some(0)`.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub behind_by: Option<u32>,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    /// Accounts with a review requested; team-level requests are excluded.
    #[serde(default)]
    pub reviewers: Vec<PrReviewer>,
    /// The pull request's own reactions, which sit on its description.
    #[serde(default)]
    pub reactions: Vec<PrReactionCount>,
    /// Inline review discussions, the GitHub kind: a thread per anchored
    /// conversation, resolved or not.
    #[serde(default)]
    pub threads: Vec<PrThread>,
    /// True when GitHub had more threads or thread comments than this read carried.
    #[serde(default)]
    pub threads_truncated: bool,
    /// Why the thread read is empty, when it failed; a failed thread read leaves
    /// the rest of the detail standing.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub threads_message: Option<String>,
    /// `None` when the host does not report an armed auto-merge; `Some(false)`
    /// when it reports none armed.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub auto_merge_enabled: Option<bool>,
    /// The strategy stored with an armed auto-merge, where gh reports it.
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub auto_merge_method: Option<PrMergeMethod>,
    /// GitHub's `isCrossRepository`: a fork head, which is the only kind whose
    /// workflow runs can be waiting on a maintainer's approval.
    #[serde(default)]
    pub cross_repository: bool,
}

/// One layer of a host-native stack, bottom to top order is the array's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrStackLayer {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub head_ref: String,
    pub state: PullRequestState,
    pub is_draft: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub title: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub head_sha: Option<String>,
}

/// A host-native stack: an ordered set of pull requests GitHub itself merges
/// and retargets as a unit. Only GitHub offers one; hosts without the preview
/// answer 404, which the daemon reports as no stack rather than an error.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrStack {
    pub id: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub url: String,
    pub base: String,
    /// Bottom to top, which is the order GitHub lists them in.
    pub layers: Vec<PrStackLayer>,
}

/// One layer's head as the user saw it, which a stack merge pins before any
/// layer is merged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrStackHead {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub head_sha: String,
}

/// One write a pull request accepts, other than the merge itself: merging has its
/// own message because it re-reads the gate and pins the reviewed head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrAction {
    Ready,
    Draft,
    Close,
    Reopen,
    UpdateBranch,
    EnableAutoMerge,
    DisableAutoMerge,
    Revert,
    ApproveWorkflows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrUpdateMethod {
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrCommentKind {
    IssueComment,
    ReviewComment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrReviewVerdict {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrReaction {
    ThumbsUp,
    ThumbsDown,
    Laugh,
    Hooray,
    Confused,
    Heart,
    Rocket,
    Eyes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrDiffSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrReviewerKind {
    User,
    Team,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrReviewDraft {
    pub path: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub line: u32,
    pub side: PrDiffSide,
    pub body: String,
}

/// One account or team whose review is outstanding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrReviewer {
    pub id: String,
    pub kind: PrReviewerKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrReviewerCandidate {
    pub id: String,
    pub kind: PrReviewerKind,
    pub login: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub name: Option<String>,
    pub is_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrLabel {
    pub name: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrLabelCandidate {
    pub name: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub color: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub description: Option<String>,
    pub is_applied: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrReactionCount {
    pub content: PrReaction,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub count: u32,
    pub reacted: bool,
}

/// What GitHub says the signed-in account may do. `can_write` gates merging, a
/// review request and ready/draft/close/reopen; labelling is the one action
/// triage may take without writing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrPermissions {
    pub can_write: bool,
    pub can_triage: bool,
    pub can_update: bool,
    pub did_author: bool,
    /// GitHub's `viewerCanUpdateBranch`: false for a branch already current, so
    /// it answers "may update, and there is something to update" at once.
    pub can_update_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrThreadComment {
    pub id: String,
    pub author: String,
    pub body: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub created_at: u64,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub url: Option<String>,
    #[serde(default)]
    pub reactions: Vec<PrReactionCount>,
}

/// One inline review discussion: its anchor, its resolution, and the remarks in
/// it. `id` is GitHub's node id, which is what a reply or a resolution names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrThread {
    pub id: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub path: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub line: Option<u32>,
    pub resolved: bool,
    pub outdated: bool,
    #[serde(default)]
    pub comments: Vec<PrThreadComment>,
}

/// One row of a pull-request listing, which is a read of the repository's pull
/// requests rather than of the one on screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct PrListItem {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
    pub is_draft: bool,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub author: Option<String>,
    pub head_ref: String,
    pub base_ref: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub updated_at: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub additions: u32,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub deletions: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub review_decision: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
    pub checks: Option<PrChecks>,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
}

/// Which pull requests a listing asks the host for. `Closed` excludes merged
/// ones — gh's own `--state closed` folds them together, so the daemon adds the
/// `is:unmerged` narrowing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrListState {
    Open,
    Closed,
    Merged,
    All,
}

/// Whose pull requests a listing is about, resolved by the host against the
/// signed-in account: everything, the viewer's own, or those asking the viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrListInvolvement {
    All,
    Authored,
    Reviewing,
}

/// Which write a `pr_mutation` reply answers: one shape for every write keeps
/// the UI's single in-flight guard honest, and the kind is what tells the panel
/// which control to release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum PrMutationKind {
    Edit,
    Comment,
    CommentEdit,
    Review,
    ThreadReply,
    ThreadResolve,
    Reaction,
    ReviewerSet,
    LabelSet,
    Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ChatEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ChatEffort {
    pub fn cli_value(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ChatPermissionMode {
    AcceptEdits,
    BypassPermissions,
}

impl ChatPermissionMode {
    pub fn cli_value(self) -> &'static str {
        match self {
            Self::AcceptEdits => "acceptEdits",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        token: String,
        protocol: u32,
    },
    SessionCreate {
        agent: AgentKind,
        project_dir: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cmd: Option<Vec<String>>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cols: Option<u16>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        rows: Option<u16>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cwd_from: Option<u32>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        shell_integration: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        auto_approve: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        acp: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        profile: Option<ProfileChoice>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        prompt: Option<String>,
    },
    SessionKill {
        session: u32,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        confirm_children: Option<bool>,
    },
    OrchestrationSettingsGet,
    OrchestrationSet {
        enabled: bool,
    },
    InboxList {
        workspace: String,
    },
    InboxAck {
        id: i64,
    },
    InboxResolve {
        id: i64,
    },
    InboxDeliverNow {
        session: u32,
    },
    SessionResize {
        session: u32,
        cols: u16,
        rows: u16,
    },
    SessionList,
    SessionAttach {
        session: u32,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        replay_bytes: Option<u64>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        snapshot: Option<bool>,
    },
    SessionRespawn {
        session: u32,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        shell_integration: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cwd: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        shell: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        force: Option<bool>,
    },
    SessionCwd {
        session: u32,
    },
    WorkspaceAdd {
        path: String,
    },
    WorkspaceRemove {
        path: String,
    },
    WorkspaceRename {
        path: String,
        name: String,
    },
    WorkspaceList,
    SessionClose {
        session: u32,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        confirm_children: Option<bool>,
    },
    SessionRename {
        session: u32,
        title: String,
    },
    SessionSetTags {
        session: u32,
        tags: Vec<u32>,
    },
    TagCreate {
        name: String,
        color: String,
    },
    TagUpdate {
        tag: u32,
        name: String,
        color: String,
    },
    TagDelete {
        tag: u32,
    },
    SessionReparent {
        session: u32,
        project_dir: String,
    },
    GitStatus {
        dir: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        base: Option<String>,
    },
    GitDiff {
        dir: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        path: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        base: Option<String>,
    },
    GitBranch {
        dir: String,
    },
    GitStage {
        dir: String,
        #[serde(default)]
        paths: Vec<String>,
    },
    GitUnstage {
        dir: String,
        #[serde(default)]
        paths: Vec<String>,
    },
    GitCommit {
        dir: String,
        message: String,
    },
    GitPush {
        dir: String,
    },
    GitDiscard {
        dir: String,
        path: String,
        kind: GitDiscardKind,
    },
    PrStatus {
        dir: String,
    },
    /// Opens the branch's pull request. `title`/`body` come from the compose
    /// control; absent, `gh pr create --fill` writes them from the commits.
    PrCreate {
        dir: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        title: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        body: Option<String>,
    },
    PrDetail {
        dir: String,
        request: u32,
        /// One pull request to read without linking it; absent reads the stored
        /// association, else the branch's own.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        number: Option<u32>,
    },
    PrLink {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        request: u32,
    },
    PrUnlink {
        dir: String,
        request: u32,
    },
    PrMerge {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        method: PrMergeMethod,
        expected_head_sha: String,
        request: u32,
    },
    PrAction {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        action: PrAction,
        /// Meaningful for `enable_auto_merge`; absent takes `merge`.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        merge_method: Option<PrMergeMethod>,
        /// Meaningful for `update_branch`; absent takes `merge`.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        update_method: Option<PrUpdateMethod>,
        request: u32,
    },
    PrEdit {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        /// Both absent is refused: a host asked to change nothing answers
        /// differently on each field.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        title: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        body: Option<String>,
        request: u32,
    },
    PrComment {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        body: String,
        request: u32,
    },
    PrCommentEdit {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        comment_id: String,
        kind: PrCommentKind,
        body: String,
        request: u32,
    },
    PrReview {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        verdict: PrReviewVerdict,
        body: String,
        #[serde(default)]
        comments: Vec<PrReviewDraft>,
        request: u32,
    },
    PrThreadReply {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        thread_id: String,
        body: String,
        request: u32,
    },
    PrThreadResolve {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        thread_id: String,
        resolved: bool,
        request: u32,
    },
    PrReaction {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        /// A remark's node id; absent means the pull request itself.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        subject_id: Option<String>,
        content: PrReaction,
        reacted: bool,
        request: u32,
    },
    PrReviewers {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        request: u32,
    },
    PrReviewerSet {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        reviewers: Vec<PrReviewer>,
        requested: bool,
        request: u32,
    },
    PrLabels {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        request: u32,
    },
    PrLabelSet {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        labels: Vec<String>,
        applied: bool,
        request: u32,
    },
    PrList {
        dir: String,
        state: PrListState,
        involvement: PrListInvolvement,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        query: Option<String>,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        limit: u32,
        request: u32,
    },
    PrDiff {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        request: u32,
    },
    PrStack {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        request: u32,
    },
    /// Merges every open layer up to and including `number`, pinned to the heads
    /// the user saw. Stack update-branch is not offered: GitHub's own endpoint
    /// takes no expected head, so a rebase of a moved stack cannot be pinned.
    PrStackMerge {
        dir: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        stack_number: u32,
        heads: Vec<PrStackHead>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        merge_method: Option<PrMergeMethod>,
        request: u32,
    },
    GitReviewDiffs {
        dir: String,
    },
    GitBranches {
        dir: String,
    },
    GitWorktrees {
        dir: String,
    },
    GitCheckpoints {
        dir: String,
    },
    /// The checkpoint's patch. `against` picks the other side: the working tree
    /// or `HEAD`.
    GitCheckpointDiff {
        dir: String,
        #[serde(rename = "ref")]
        r#ref: String,
        against: GitCheckpointAgainst,
    },
    GitPull {
        dir: String,
    },
    GitFetch {
        dir: String,
    },
    GitBranchCreate {
        dir: String,
        name: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        base: Option<String>,
        switch_to: bool,
    },
    GitBranchSwitch {
        dir: String,
        name: String,
    },
    GitBranchRename {
        dir: String,
        from: String,
        to: String,
    },
    GitBranchDelete {
        dir: String,
        name: String,
        /// `git branch -D`: deletes a branch whose work is not merged.
        force: bool,
    },
    GitWorktreeCreate {
        dir: String,
        name: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        base: Option<String>,
    },
    GitWorktreeRemove {
        dir: String,
        path: String,
        force: bool,
    },
    GitWorktreePrune {
        dir: String,
    },
    GitCheckpointCreate {
        dir: String,
        label: String,
    },
    GitCheckpointRestore {
        dir: String,
        #[serde(rename = "ref")]
        r#ref: String,
    },
    GitCheckpointDelete {
        dir: String,
        #[serde(rename = "ref")]
        r#ref: String,
    },
    HistoryClear {
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        workspace: Option<String>,
    },
    HistoryCount,
    HandoffGenerate {
        session: u32,
        provider: AgentKind,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cmd: Option<Vec<String>>,
    },
    HandoffCancel {
        request: u32,
    },
    SshConnect {
        request: u32,
        host: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        port: Option<u16>,
        user: String,
        auth: SshAuth,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cols: Option<u16>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        rows: Option<u16>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        profile: Option<String>,
    },
    SshHostKeyAnswer {
        request: u32,
        accept: bool,
    },
    SshUploadTerminalFile {
        request: u32,
        session: u32,
        local_path: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        remote_name: Option<String>,
    },
    SshProfileSave {
        profile: SshProfile,
    },
    SshProfileDelete {
        name: String,
    },
    SshProfileList,
    SshCredentialSet {
        profile: String,
        password: String,
    },
    SshCredentialClear {
        profile: String,
    },
    SshConfigHosts,
    SessionCwds {
        sessions: Vec<u32>,
    },
    SessionRunningProcs {
        sessions: Vec<u32>,
    },
    SessionVisibility {
        session: u32,
        visible: bool,
    },
    WaitForIdle {
        request: u32,
        session: u32,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        timeout_ms: Option<u64>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        idle_quiet_ms: Option<u64>,
    },
    SessionPolicyGet,
    SessionPolicySet {
        policy: SessionPolicy,
    },
    UpdateGet,
    UpdatePolicySet {
        policy: UpdatePolicy,
    },
    UpdateCheckNow,
    KeymapGet,
    KeymapSet {
        overrides: KeymapOverrides,
    },
    McpState,
    McpSync {
        tool: Option<AgentKind>,
    },
    McpImport {
        tool: AgentKind,
    },
    McpSetEnabled {
        name: String,
        enabled: bool,
    },
    McpServerUpsert {
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        previous_name: Option<String>,
        server: McpServer,
    },
    McpServerRemove {
        name: String,
    },
    McpTest {
        name: String,
    },
    AgentProfileList,
    AgentProfileUpsert {
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        id: Option<u32>,
        agent: AgentKind,
        name: String,
        config_dir: String,
    },
    AgentProfileDelete {
        id: u32,
    },
    AgentProfileSetActive {
        agent: AgentKind,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        id: Option<u32>,
    },
    RoutineList,
    RoutineCreate {
        name: String,
        prompt: String,
        cadence: Cadence,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        workspace_id: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        engine: Option<AgentKind>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        model: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        effort: Option<ChatEffort>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        permission_mode: Option<ChatPermissionMode>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "boolean | null"))]
        isolate: Option<bool>,
    },
    RoutineUpdate {
        id: u32,
        expected_revision: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        name: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        prompt: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        cadence: Option<Cadence>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "boolean | null"))]
        enabled: Option<bool>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        workspace_id: Option<Option<String>>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        engine: Option<AgentKind>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
        model: Option<Option<String>>,
        #[serde(
            default,
            deserialize_with = "double_option",
            skip_serializing_if = "Option::is_none"
        )]
        #[cfg_attr(
            feature = "ts-gen",
            ts(optional = nullable, type = "ChatEffort | null")
        )]
        effort: Option<Option<ChatEffort>>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        permission_mode: Option<ChatPermissionMode>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "boolean | null"))]
        isolate: Option<bool>,
    },
    RoutineDelete {
        id: u32,
        expected_revision: String,
    },
    /// Run this routine now, on the same path the scheduler uses.
    RoutineRunNow {
        id: u32,
    },
    /// The independent run records, newest first. `routine_id` absent lists
    /// the latest runs of every routine.
    RoutineRuns {
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        routine_id: Option<u32>,
    },
    SkillSync,
    SkillPush {
        tool: Option<AgentKind>,
        skill: Option<String>,
    },
    SkillPushUndo {
        tool: AgentKind,
        skill: String,
    },
    SkillAutoPushSet {
        enabled: bool,
    },
    AgentHooks,
    AgentHooksSet {
        provider: AgentKind,
        enabled: bool,
    },
    VoiceSettingsGet,
    VoiceSettingsSet {
        settings: VoiceSettings,
    },
    VoiceKeySet {
        provider: CloudStt,
        key: String,
    },
    VoiceKeyClear {
        provider: CloudStt,
    },
    VoiceDevicesGet,
    VoiceStart {
        session: u32,
    },
    VoiceStop {
        session: u32,
    },
    VoiceModelDownload {
        model_id: String,
    },
    VoiceModelDelete {
        model_id: String,
    },
    VoiceLevelMonitor {
        enabled: bool,
    },
    HostInfoGet,
    RestoreBudgetSet {
        budget: u32,
    },
    MailboxRetentionSet {
        hours: u32,
    },
    OrchestrationCapsSet {
        max_live_children: u32,
        max_spawn_depth: u32,
    },
    CommandHistoryIgnoreGlobsGet,
    CommandHistoryIgnoreGlobsSet {
        globs: Vec<String>,
    },
    UsageSummaryGet {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        since_ms: i64,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        until_ms: i64,
        #[serde(default)]
        refresh_pricing: bool,
    },
    BrowserToolResult {
        request_id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts-gen", ts(type = "unknown | null"))]
        output: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
// One allocation per message is not worth an indirection: every arm is serialized
// once on its way out, so the largest payload's bytes never sit on a hot path.
#[allow(clippy::large_enum_variant)]
pub enum ServerMsg {
    HelloOk {
        protocol: u32,
        sessions: Vec<SessionInfo>,
        workspaces: Vec<Workspace>,
        #[serde(default)]
        tags: Vec<TagInfo>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        recovery: Option<RecoverySummary>,
        safe_mode: SafeModeSummary,
        #[serde(default)]
        snapshot_attach: bool,
        #[serde(default)]
        snapshot_format_version: u32,
    },
    SessionCreated {
        info: SessionInfo,
    },
    SessionState {
        session: u32,
        state: SessionState,
        exit_code: Option<i32>,
    },
    SessionList {
        sessions: Vec<SessionInfo>,
    },
    SessionRemoved {
        session: u32,
    },
    Scrollback {
        session: u32,
        data: String,
        generation: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        replayed_bytes: u64,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        bytes_seen: u64,
        attempt: u32,
    },
    AttachSnapshot {
        session: u32,
        generation: u32,
        attempt: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        output_offset: u64,
        format_version: u32,
        state: String,
    },
    WorkspaceList {
        workspaces: Vec<Workspace>,
    },
    SessionResized {
        session: u32,
        cols: u16,
        rows: u16,
    },
    SessionRenamed {
        session: u32,
        title: String,
    },
    SessionTagsSet {
        session: u32,
        tags: Vec<u32>,
    },
    TagList {
        tags: Vec<TagInfo>,
    },
    TagDeleted {
        tag: u32,
    },
    LiveChildrenChanged {
        session: u32,
        live_children: u32,
        #[serde(default)]
        children_waiting: u32,
    },
    DelegationChanged {
        session: u32,
        delegation: DelegationInfo,
    },
    InboxRows {
        workspace: String,
        rows: Vec<InboxRow>,
    },
    InboxChanged {
        workspace: String,
        row: InboxRow,
    },
    SessionReparented {
        session: u32,
        project_dir: String,
    },
    GitStatus {
        dir: String,
        files: Vec<GitFileStatus>,
        branch: Option<String>,
        upstream: Option<String>,
        ahead: u32,
        behind: u32,
        base: Option<String>,
        default_base: Option<String>,
    },
    GitDiff {
        dir: String,
        path: Option<String>,
        patch: String,
        truncated: bool,
        base: Option<String>,
    },
    GitBranch {
        dir: String,
        branch: Option<String>,
        /// The work tree's root, absent outside one; two panes share a checkout
        /// exactly when this is equal.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        toplevel: Option<String>,
        /// The repository's common dir, absent outside one; a main checkout and
        /// its worktrees share it, which is how the same-repository pair is found.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        common_dir: Option<String>,
    },
    GitCommit {
        dir: String,
        sha: String,
        summary: String,
    },
    PrStatus {
        dir: String,
        gh: GhState,
        has_upstream: bool,
        pr: Option<PrInfo>,
        hint: Option<String>,
    },
    PrCreate {
        dir: String,
        gh: GhState,
        pr: Option<PrInfo>,
        message: Option<String>,
    },
    PrDetail {
        dir: String,
        /// Echoes the request; a detail pushed after link/unlink/merge carries
        /// that mutation's id, so a client can drop anything it has superseded.
        request: u32,
        gh: GhState,
        has_upstream: bool,
        /// The pull request on screen: the manually linked one when one exists,
        /// else the branch's own. `None` when nothing resolves.
        link: Option<PullRequestLink>,
        /// The reading behind `link`; `None` when `gh` could not produce one.
        detail: Option<PrDetail>,
        /// True when `link` is the manually linked pull request, so the UI offers
        /// Unlink only then.
        linked: bool,
        hint: Option<String>,
        /// A read failure for a specific pull request, naming it and `gh`'s reason.
        message: Option<String>,
    },
    PrLinked {
        dir: String,
        request: u32,
        ok: bool,
        message: Option<String>,
    },
    PrUnlinked {
        dir: String,
        request: u32,
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        number: Option<u32>,
        ok: bool,
        message: Option<String>,
    },
    PrMerged {
        dir: String,
        request: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        ok: bool,
        message: Option<String>,
    },
    /// The one reply shape for every pull-request write other than merge: `kind`
    /// says which control the UI may release, `ok`/`message` what happened.
    PrMutation {
        dir: String,
        request: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        kind: PrMutationKind,
        ok: bool,
        message: Option<String>,
    },
    PrReviewerCandidates {
        dir: String,
        request: u32,
        #[serde(default)]
        candidates: Vec<PrReviewerCandidate>,
        truncated: bool,
        message: Option<String>,
    },
    PrLabelCandidates {
        dir: String,
        request: u32,
        #[serde(default)]
        candidates: Vec<PrLabelCandidate>,
        truncated: bool,
        message: Option<String>,
    },
    PrList {
        dir: String,
        request: u32,
        #[serde(default)]
        items: Vec<PrListItem>,
        /// True when the host has more rows than `limit` asked for.
        truncated: bool,
        message: Option<String>,
    },
    PrDiff {
        dir: String,
        request: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        number: u32,
        patch: String,
        /// Something in the patch could not be shown: it hit the daemon's byte
        /// cap, or the host withheld a file's hunks.
        truncated: bool,
        message: Option<String>,
    },
    PrStack {
        dir: String,
        request: u32,
        /// `None` when the host serves no stack for this pull request, which is
        /// the answer on every host without the stacks preview.
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        stack: Option<PrStack>,
        message: Option<String>,
    },
    GitReviewDiffs {
        dir: String,
        branch: Option<String>,
        upstream: Option<String>,
        ahead: u32,
        behind: u32,
        head: Option<String>,
        files: Vec<GitFileStatus>,
        sections: Vec<GitReviewSection>,
        blocked_paths: Vec<String>,
        warnings: Vec<String>,
        truncated: bool,
        redacted: bool,
    },
    GitBranches {
        dir: String,
        branches: Vec<GitBranchInfo>,
        /// Remote-tracking branches, listed apart from the locals.
        remotes: Vec<GitBranchInfo>,
        /// The branch `origin/HEAD` (or `main`/`master`) points at, when one resolves.
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        default_branch: Option<String>,
        /// True when the listing hit the cap and is not the whole repository.
        truncated: bool,
    },
    GitWorktrees {
        dir: String,
        worktrees: Vec<GitWorktreeInfo>,
        /// A note about the operation that produced this reply (prune, say).
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        message: Option<String>,
    },
    GitCheckpoints {
        dir: String,
        checkpoints: Vec<GitCheckpointInfo>,
    },
    GitCheckpointDiff {
        dir: String,
        #[serde(rename = "ref")]
        r#ref: String,
        patch: String,
        truncated: bool,
        redacted: bool,
    },
    GitPull {
        dir: String,
        status: GitPullStatus,
    },
    GitFetch {
        dir: String,
        summary: String,
    },
    AgentDetected {
        session: u32,
        agent: AgentKind,
    },
    AgentStatus {
        session: u32,
        status: AgentStatus,
    },
    SessionContext {
        session: u32,
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        context: Option<SessionContext>,
    },
    AgentNotice {
        session: u32,
        kind: AgentNoticeKind,
    },
    OrchestrationState {
        caps: OrchestrationCaps,
        enabled: bool,
        acp_agents: Vec<AcpAgentInfo>,
    },
    HandoffStarted {
        request: u32,
        session: u32,
        provider: AgentKind,
    },
    HandoffChunk {
        request: u32,
        text: String,
    },
    HandoffDone {
        request: u32,
        markdown: String,
        saved_path: String,
    },
    HandoffError {
        request: u32,
        message: String,
    },
    ClipboardSet {
        session: u32,
        text: String,
    },
    SessionCwd {
        session: u32,
        cwd: String,
    },
    SshHostKey {
        request: u32,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        randomart: String,
        changed: bool,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        previous_fingerprint: Option<String>,
    },
    SshUploadDone {
        request: u32,
        session: u32,
        remote_path: String,
        bytes: u64,
    },
    SshProfiles {
        profiles: Vec<SshProfile>,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable))]
        keyring_error: Option<String>,
    },
    SshConfigHosts {
        hosts: Vec<SshConfigHost>,
    },
    SessionCwds {
        entries: Vec<SessionCwdEntry>,
    },
    SessionRunningProcs {
        entries: Vec<SessionProcsEntry>,
    },
    Idle {
        request: u32,
        session: u32,
        idle: bool,
    },
    SwarmMessage {
        message: SwarmMessage,
    },
    SwarmAgent {
        agent: SwarmAgentInfo,
    },
    SessionPolicy {
        policy: SessionPolicy,
    },
    /// Policy and state travel together: every client that learns one needs the
    /// other to render a row at all, and one message cannot show them disagreeing.
    Update {
        policy: UpdatePolicy,
        state: UpdateState,
    },
    Keymap {
        overrides: KeymapOverrides,
    },
    HistoryCount {
        count: u32,
    },
    SkillSync {
        tools: Vec<SkillToolState>,
        pushes: Vec<SkillPushRecord>,
        auto_push_enabled: bool,
    },
    McpState {
        source: Vec<McpServer>,
        source_path: String,
        tools: Vec<McpToolState>,
        results: Vec<McpSyncResult>,
        checks: Vec<(String, McpConnectionCheck)>,
    },
    AgentHooks {
        providers: Vec<AgentHookState>,
    },
    AgentProfileState {
        profiles: Vec<AgentProfile>,
        active: Vec<AgentProfileActive>,
    },

    Routines {
        routines: Vec<Routine>,
        #[cfg_attr(feature = "ts-gen", ts(type = "number[]"))]
        running: Vec<u32>,
    },
    RoutineRefused {
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        id: Option<u32>,
        kind: RoutineErrorKind,
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        limit: Option<u32>,
        #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
        requested: Option<u32>,
    },
    /// Every independent run record, newest first.
    RoutineRuns {
        runs: Vec<RoutineRun>,
    },
    /// One run changed state (started, ended); broadcast as it happens.
    RoutineRunEvent {
        run: RoutineRun,
    },

    VoiceSettings {
        settings: VoiceSettings,
        cloud_key_present: bool,
        #[serde(default)]
        keyring_error: Option<String>,
        models: Vec<VoiceModelState>,
    },
    VoiceDevices {
        devices: Vec<VoiceDevice>,
    },
    VoiceState {
        state: VoiceState,
    },
    VoiceTranscript {
        session: u32,
        text: String,
        engine: String,
        translated: bool,
    },
    VoiceModelState {
        model: VoiceModelState,
    },
    VoiceLevel {
        rms: f32,
    },
    HostInfo {
        channel: String,
        state_dir: String,
        pid: u32,
        port: u16,
        protocol_version: u32,
        app_version: String,
        build_commit: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        uptime_ms: u64,
        live_sessions: u32,
        restore_budget: u32,
        restore_deferred: u32,
        orchestration_depth_in_use: u32,
        orchestration_max_depth: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        mailbox_files_on_disk: u64,
        mailbox_retention_hours: u32,
        command_history_ignore_glob_count: u32,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        session_db_bytes: u64,
    },
    CommandHistoryIgnoreGlobs {
        globs: Vec<String>,
    },
    UsageSummary {
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        since_ms: i64,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        until_ms: i64,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        read_at_ms: i64,
        buckets: Vec<UsageBucket>,
        sources: Vec<UsageSource>,
        pricing: UsagePricing,
        untracked_agents: Vec<AgentKind>,
        #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
        scan_duration_ms: u64,
    },
    Error {
        message: String,
        context: Option<String>,
    },
    BrowserToolCall {
        request_id: u64,
        tool: String,
        #[cfg_attr(feature = "ts-gen", ts(type = "unknown"))]
        args: serde_json::Value,
        session_id: u32,
        workspace_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum UsageProvider {
    Claude,
    Codex,
}

impl UsageProvider {
    pub const ALL: [UsageProvider; 2] = [UsageProvider::Claude, UsageProvider::Codex];

    pub fn agent_kind(self) -> AgentKind {
        match self {
            UsageProvider::Claude => AgentKind::Claude,
            UsageProvider::Codex => AgentKind::Codex,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UsageTokenTotals {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub uncached_input_tokens: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub cached_input_tokens: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub cache_creation_tokens: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub output_tokens: u64,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub reasoning_tokens: u64,
}

impl UsageTokenTotals {
    pub fn add(&mut self, other: &UsageTokenTotals) {
        self.uncached_input_tokens += other.uncached_input_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }

    pub fn total(&self) -> u64 {
        self.uncached_input_tokens
            + self.cached_input_tokens
            + self.cache_creation_tokens
            + self.output_tokens
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum UsageCostSource {
    ProviderReported,
    ModelPriced,
    Unpriced,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UsageBucket {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub hour_start_ms: i64,
    pub provider: UsageProvider,
    pub model: String,
    pub totals: UsageTokenTotals,
    pub cost_usd: f64,
    pub cache_savings_usd: f64,
    pub cost_source: UsageCostSource,
    pub records: u32,
    pub unpriced_records: u32,
    pub sessions: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum UsageSourceStatus {
    Ok,
    Missing,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UsageSource {
    pub provider: UsageProvider,
    pub path: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub profile_name: Option<String>,
    pub status: UsageSourceStatus,
    pub scanned_files: u32,
    pub skipped_files: u32,
    pub failed_files: u32,
    pub distinct_sessions: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum UsagePricingStatus {
    Fresh,
    Cached,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct UsagePricing {
    pub status: UsagePricingStatus,
    pub source: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "number | null"))]
    pub fetched_at_ms: Option<i64>,
    pub known_models: u32,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub message: Option<String>,
}

pub const USAGE_MAX_WINDOW_DAYS: u32 = 90;

pub const USAGE_WINDOW_REFUSED: &str = "usage_window_refused:";

pub const ROUTINES_TOTAL: u32 = 4_096;

pub const ROUTINE_NAME_MAX: usize = 160;

pub const ROUTINE_PROMPT_MAX: usize = 64_000;

pub const ROUTINE_LAST_ERROR_MAX: usize = 512;

pub const ROUTINE_MIN_INTERVAL_SECS: u32 = 300;

pub const ROUTINE_TICK_MS: u64 = 15_000;

pub const ROUTINE_RUNS_CONCURRENT: usize = 3;

pub const ROUTINE_RUN_MAX_MS: u64 = 1_800_000;

/// How many run rows `routine_runs` answers with, newest first.
pub const ROUTINE_RUNS_PAGE: u32 = 50;

pub const RESTORE_BUDGET_DEFAULT: u32 = 24;

pub const RESTORE_BUDGET_MAX: u32 = 500;

pub const MAILBOX_RETENTION_HOURS_DEFAULT: u32 = 24;

pub const MAILBOX_RETENTION_HOURS_MAX: u32 = 720;

pub const ORCHESTRATION_CAP_MAX: u32 = 16;

pub const COMMAND_HISTORY_IGNORE_GLOBS_MAX: u32 = 64;

pub const COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX: u32 = 200;

/// The `/manage` surface's own compat version, independent of
/// `PROTOCOL_VERSION`. Checked for exact match; the additive
/// `candidate_bin` field keeps the number — see protocol/protocol.md.
pub const MANAGE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ManageVerb {
    DaemonStatus,
    DaemonShutdown,
    DaemonHandoff,
    /// `daemon_shutdown`, but refusing when any session is live: the update
    /// installer's verb, so a session that appeared after its own check is
    /// never killed. An older daemon refuses it by name (manual update).
    DaemonShutdownIfIdle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageRequest {
    pub manage_version: u32,
    pub verb: ManageVerb,
    /// `daemon_handoff` only: the daemon binary the retiring daemon should
    /// spawn as its successor; absent means it resolves its own executable.
    /// Shape and refusal rules: protocol/protocol.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts-gen", ts(optional = nullable, type = "string | null"))]
    pub candidate_bin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageLiveSessions {
    pub count: u32,
    pub ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageHandoffInfo {
    pub supported: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageDaemonHandoffResult {
    pub accepted: bool,
    pub reason: Option<String>,
    pub generation: Option<u64>,
    pub sessions_transferred: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageReapInfo {
    pub armed: bool,
    pub deadline_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageDaemonStatus {
    pub manage_version: u32,
    pub protocol_version: u32,
    pub build: String,
    pub pid: u32,
    pub started_at: String,
    pub live_sessions: ManageLiveSessions,
    pub routines_enabled: u32,
    pub clients_connected: u32,
    pub handoff: ManageHandoffInfo,
    pub reap: ManageReapInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageDaemonShutdownOk {
    pub ok: bool,
    pub stopped_sessions: u32,
    pub disarmed_routines: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageDaemonShutdownFailed {
    pub ok: bool,
    pub error: String,
    pub unterminated: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct ManageErrorBody {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_frame_roundtrip() {
        let f = encode_output_frame(42, 1 << 40, b"hello");
        let (session, offset, payload) = decode_output_frame(&f).unwrap();
        assert_eq!(session, 42);
        assert_eq!(offset, 1 << 40);
        assert_eq!(payload, b"hello");
    }

    #[test]
    fn stdin_frame_roundtrip() {
        let f = encode_stdin_frame(7, b"ls\n");
        let (session, payload) = decode_stdin_frame(&f).unwrap();
        assert_eq!(session, 7);
        assert_eq!(payload, b"ls\n");
    }

    #[test]
    fn decoders_reject_short_or_mismatched_frames() {
        assert!(decode_output_frame(&[1, 0, 0, 0, 5, 0, 0]).is_none());
        assert!(decode_stdin_frame(&[2, 0, 0]).is_none());
        let stdin = encode_stdin_frame(1, b"x");
        assert!(decode_output_frame(&stdin).is_none());
        let output = encode_output_frame(1, 0, b"x");
        assert!(decode_stdin_frame(&output).is_none());
    }

    #[test]
    fn gap_frame_roundtrip() {
        let f = encode_gap_frame(42, 1 << 40, 4096);
        assert_eq!(f.len(), FRAME_GAP_LEN, "gap frame must be exactly 21 bytes");
        assert_eq!(f[0], FRAME_GAP);
        let (session, bytes_seen, dropped) = decode_gap_frame(&f).unwrap();
        assert_eq!(session, 42);
        assert_eq!(bytes_seen, 1 << 40);
        assert_eq!(dropped, 4096);
    }

    #[test]
    fn decode_gap_frame_rejects_a_wrong_kind_buffer() {
        let output = encode_output_frame(1, 0, &[0u8; 8]);
        assert_eq!(
            output.len(),
            FRAME_GAP_LEN,
            "must share FRAME_GAP_LEN for this to be a real test"
        );
        assert!(decode_gap_frame(&output).is_none());
    }

    #[test]
    fn decode_gap_frame_rejects_a_truncated_buffer() {
        let f = encode_gap_frame(42, 1, 2);
        assert!(decode_gap_frame(&f[..f.len() - 1]).is_none());
        assert!(decode_gap_frame(&[]).is_none());
    }

    #[test]
    fn decode_gap_frame_rejects_an_oversized_buffer() {
        let mut f = encode_gap_frame(42, 1, 2);
        f.push(0xff);
        assert!(decode_gap_frame(&f).is_none());
    }

    #[test]
    fn control_msg_json_shape() {
        let msg = ClientMsg::SessionResize {
            session: 7,
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(
            json,
            r#"{"type":"session_resize","session":7,"cols":120,"rows":40}"#
        );
    }

    #[test]
    fn git_file_status_json_shape_carries_is_sensitive() {
        let f = GitFileStatus {
            path: ".env".into(),
            status: GitFileState::Modified,
            staged: false,
            added: Some(1),
            deleted: Some(0),
            is_sensitive: true,
        };
        let value = serde_json::to_value(&f).unwrap();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = [
            "path",
            "status",
            "staged",
            "added",
            "deleted",
            "is_sensitive",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(obj["is_sensitive"], serde_json::json!(true));
    }

    #[test]
    fn git_review_diffs_request_json_shape() {
        let msg = ClientMsg::GitReviewDiffs {
            dir: "/work/project".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"type":"git_review_diffs","dir":"/work/project"}"#);
    }

    #[test]
    fn git_review_diffs_reply_json_shape_carries_every_field() {
        let msg = ServerMsg::GitReviewDiffs {
            dir: "/work/project".into(),
            branch: Some("main".into()),
            upstream: Some("origin/main".into()),
            ahead: 1,
            behind: 0,
            head: Some("abc123".into()),
            files: vec![GitFileStatus {
                path: ".env".into(),
                status: GitFileState::Modified,
                staged: false,
                added: None,
                deleted: None,
                is_sensitive: true,
            }],
            sections: vec![GitReviewSection {
                scope: GitReviewScope::Staged,
                patch: "diff --git a/x b/x\n".into(),
            }],
            blocked_paths: vec![".env".into()],
            warnings: vec!["no commits yet".into()],
            truncated: false,
            redacted: true,
        };
        let value = serde_json::to_value(&msg).unwrap();
        let obj = value.as_object().unwrap();
        assert_eq!(obj["type"], serde_json::json!("git_review_diffs"));
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = [
            "type",
            "dir",
            "branch",
            "upstream",
            "ahead",
            "behind",
            "head",
            "files",
            "sections",
            "blocked_paths",
            "warnings",
            "truncated",
            "redacted",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        let sections = obj["sections"].as_array().unwrap();
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0]["scope"], serde_json::json!("staged"));
        assert_eq!(obj["blocked_paths"], serde_json::json!([".env"]));
        assert_eq!(obj["redacted"], serde_json::json!(true));
    }

    #[test]
    fn git_discard_request_json_shape() {
        let msg = ClientMsg::GitDiscard {
            dir: "/work/project".into(),
            path: "src/main.rs".into(),
            kind: GitDiscardKind::Untracked,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(
            json,
            r#"{"type":"git_discard","dir":"/work/project","path":"src/main.rs","kind":"untracked"}"#
        );
    }

    #[test]
    fn git_status_base_defaults_to_working_tree() {
        let msg: ClientMsg =
            serde_json::from_str(r#"{"type":"git_status","dir":"/work/project"}"#).unwrap();
        match msg {
            ClientMsg::GitStatus { dir, base } => {
                assert_eq!(dir, "/work/project");
                assert_eq!(base, None, "no base means the working tree, not a branch");
            }
            other => panic!("expected git_status, got {other:?}"),
        }
    }

    #[test]
    fn git_status_reply_json_shape_carries_base_and_default_base() {
        let msg = ServerMsg::GitStatus {
            dir: "/work/project".into(),
            files: vec![],
            branch: Some("feature".into()),
            upstream: Some("origin/feature".into()),
            ahead: 2,
            behind: 0,
            base: None,
            default_base: Some("main".into()),
        };
        let value = serde_json::to_value(&msg).unwrap();
        let obj = value.as_object().unwrap();
        assert_eq!(obj["type"], serde_json::json!("git_status"));
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = [
            "type",
            "dir",
            "files",
            "branch",
            "upstream",
            "ahead",
            "behind",
            "base",
            "default_base",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(obj["base"], serde_json::json!(null));
        assert_eq!(obj["default_base"], serde_json::json!("main"));
    }

    #[test]
    fn pr_status_reply_reports_missing_gh_without_erroring() {
        let msg = ServerMsg::PrStatus {
            dir: "/work/project".into(),
            gh: GhState::Missing,
            has_upstream: true,
            pr: None,
            hint: Some("Install the GitHub CLI (gh) to open PRs from here".into()),
        };
        let value = serde_json::to_value(&msg).unwrap();
        let obj = value.as_object().unwrap();
        assert_eq!(obj["type"], serde_json::json!("pr_status"));
        assert_eq!(obj["gh"], serde_json::json!("missing"));
        assert_eq!(obj["pr"], serde_json::json!(null));
        assert!(obj["hint"].is_string(), "a blocked gh must name its fix");
    }

    #[test]
    fn pr_status_reply_json_shape_carries_pr_info() {
        let msg = ServerMsg::PrStatus {
            dir: "/work/project".into(),
            gh: GhState::Ready,
            has_upstream: true,
            pr: Some(PrInfo {
                number: 212,
                url: "https://github.com/o/r/pull/212".into(),
                state: "OPEN".into(),
                review_decision: Some("REVIEW_REQUIRED".into()),
                checks: PrChecks::Running,
            }),
            hint: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        let pr = value["pr"].as_object().unwrap();
        let mut keys: Vec<&str> = pr.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = ["number", "url", "state", "review_decision", "checks"];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert_eq!(pr["number"], serde_json::json!(212));
        assert_eq!(pr["checks"], serde_json::json!("running"));
    }

    #[test]
    fn pr_merge_parses_the_method_and_the_head_it_pins() {
        let msg: ClientMsg = serde_json::from_str(
            r#"{"type":"pr_merge","dir":"/work/project","number":61,"method":"squash","expected_head_sha":"abc1234","request":9}"#,
        )
        .unwrap();
        match msg {
            ClientMsg::PrMerge {
                number,
                method,
                expected_head_sha,
                request,
                ..
            } => {
                assert_eq!(number, 61);
                assert_eq!(method, PrMergeMethod::Squash);
                assert_eq!(expected_head_sha, "abc1234");
                assert_eq!(request, 9);
            }
            other => panic!("expected pr_merge, got {other:?}"),
        }
    }

    #[test]
    fn pr_detail_reply_carries_the_link_and_its_gate() {
        let link = PullRequestLink {
            host: "GitHub".into(),
            repository: "o/r".into(),
            number: 61,
            url: "https://github.com/o/r/pull/61".into(),
            state: PullRequestState::Open,
            source: PullRequestLinkSource::Detected,
            title: Some("a change".into()),
            is_draft: false,
            additions: 1,
            deletions: 0,
            changed_files: 1,
            checks: Some(PrChecks::Running),
            review_decision: None,
            linked_at: 1,
            merged_at: None,
            closed_at: None,
            synced_at: Some(1),
        };
        let detail = PrDetail {
            body: None,
            author: Some("theo".into()),
            base_ref: Some("main".into()),
            head_ref: Some("feat/x".into()),
            head_sha: "abc1234".into(),
            commit_count: 2,
            created_at: 1,
            updated_at: 2,
            mergeable: PrMergeable::Mergeable,
            merge_state: PrMergeState::Clean,
            checks: vec![PrCheck {
                name: "core-checks".into(),
                state: PrCheckState::Running,
                url: None,
                duration_ms: None,
            }],
            comments: vec![],
            reviews: vec![],
            comments_total: 0,
            reviews_total: 0,
            merge_disabled_reason: Some("PR #61 is waiting on 1 check: core-checks".into()),
            viewer: None,
            viewer_message: None,
            behind_by: None,
            labels: vec![],
            reviewers: vec![],
            reactions: vec![],
            threads: vec![],
            threads_truncated: false,
            threads_message: None,
            auto_merge_enabled: None,
            auto_merge_method: None,
            cross_repository: false,
        };
        let msg = ServerMsg::PrDetail {
            dir: "/work/project".into(),
            request: 4,
            gh: GhState::Ready,
            has_upstream: true,
            link: Some(link),
            detail: Some(detail),
            linked: false,
            hint: None,
            message: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_detail"));
        assert_eq!(value["request"], serde_json::json!(4));
        assert_eq!(value["link"]["number"], serde_json::json!(61));
        assert_eq!(value["linked"], serde_json::json!(false));
        assert_eq!(
            value["detail"]["merge_disabled_reason"],
            serde_json::json!("PR #61 is waiting on 1 check: core-checks")
        );
        assert_eq!(
            value["detail"]["checks"][0]["state"],
            serde_json::json!("running")
        );
    }

    #[test]
    fn pr_unlinked_names_what_was_removed() {
        let msg = ServerMsg::PrUnlinked {
            dir: "/work/project".into(),
            request: 9,
            number: Some(61),
            ok: true,
            message: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_unlinked"));
        assert_eq!(value["number"], serde_json::json!(61));
        assert_eq!(value["ok"], serde_json::json!(true));
    }

    #[test]
    fn pr_action_parses_its_action_and_methods() {
        let msg: ClientMsg = serde_json::from_str(
            r#"{"type":"pr_action","dir":"/work/project","number":61,"action":"enable_auto_merge","merge_method":"squash","request":9}"#,
        )
        .unwrap();
        match msg {
            ClientMsg::PrAction {
                number,
                action,
                merge_method,
                update_method,
                request,
                ..
            } => {
                assert_eq!(number, 61);
                assert_eq!(action, PrAction::EnableAutoMerge);
                assert_eq!(merge_method, Some(PrMergeMethod::Squash));
                assert_eq!(update_method, None);
                assert_eq!(request, 9);
            }
            other => panic!("expected pr_action, got {other:?}"),
        }
    }

    #[test]
    fn pr_detail_without_a_number_stays_backward_shaped() {
        let msg: ClientMsg =
            serde_json::from_str(r#"{"type":"pr_detail","dir":"/w","request":1}"#).unwrap();
        match msg {
            ClientMsg::PrDetail { number, .. } => {
                assert_eq!(number, None, "an absent number is the branch read");
            }
            other => panic!("expected pr_detail, got {other:?}"),
        }
    }

    #[test]
    fn pr_review_carries_inline_drafts_with_their_side() {
        let msg: ClientMsg = serde_json::from_str(
            r#"{"type":"pr_review","dir":"/w","number":61,"verdict":"request_changes","body":"please fix","comments":[{"path":"src/a.rs","line":12,"side":"right","body":"rename this"}],"request":3}"#,
        )
        .unwrap();
        match msg {
            ClientMsg::PrReview {
                verdict,
                comments,
                request,
                ..
            } => {
                assert_eq!(verdict, PrReviewVerdict::RequestChanges);
                assert_eq!(comments.len(), 1);
                assert_eq!(comments[0].line, 12);
                assert_eq!(comments[0].side, PrDiffSide::Right);
                assert_eq!(request, 3);
            }
            other => panic!("expected pr_review, got {other:?}"),
        }
    }

    #[test]
    fn pr_mutation_reply_json_shape_names_its_kind() {
        let msg = ServerMsg::PrMutation {
            dir: "/w".into(),
            request: 4,
            number: 61,
            kind: PrMutationKind::ThreadResolve,
            ok: false,
            message: Some("the thread is already resolved".into()),
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_mutation"));
        assert_eq!(value["kind"], serde_json::json!("thread_resolve"));
        assert_eq!(value["ok"], serde_json::json!(false));
        assert_eq!(value["number"], serde_json::json!(61));
    }

    #[test]
    fn pr_candidate_replies_carry_current_values() {
        let reviewers = ServerMsg::PrReviewerCandidates {
            dir: "/w".into(),
            request: 1,
            candidates: vec![PrReviewerCandidate {
                id: "octo".into(),
                kind: PrReviewerKind::User,
                login: "octo".into(),
                name: None,
                is_requested: true,
            }],
            truncated: false,
            message: None,
        };
        let value = serde_json::to_value(&reviewers).unwrap();
        assert_eq!(
            value["candidates"][0]["is_requested"],
            serde_json::json!(true)
        );
        assert_eq!(value["candidates"][0]["kind"], serde_json::json!("user"));

        let labels = ServerMsg::PrLabelCandidates {
            dir: "/w".into(),
            request: 2,
            candidates: vec![PrLabelCandidate {
                name: "bug".into(),
                color: Some("d73a4a".into()),
                description: None,
                is_applied: true,
            }],
            truncated: true,
            message: None,
        };
        let value = serde_json::to_value(&labels).unwrap();
        assert_eq!(value["candidates"][0]["name"], serde_json::json!("bug"));
        assert_eq!(value["truncated"], serde_json::json!(true));
    }

    #[test]
    fn pr_list_reply_carries_rows_and_its_truncation() {
        let msg = ServerMsg::PrList {
            dir: "/w".into(),
            request: 5,
            items: vec![PrListItem {
                number: 61,
                title: "a change".into(),
                url: "https://github.com/o/r/pull/61".into(),
                state: PullRequestState::Open,
                is_draft: true,
                author: Some("theo".into()),
                head_ref: "feat/x".into(),
                base_ref: "main".into(),
                updated_at: 2,
                additions: 3,
                deletions: 1,
                review_decision: Some("REVIEW_REQUIRED".into()),
                checks: Some(PrChecks::Running),
                labels: vec![PrLabel {
                    name: "bug".into(),
                    color: None,
                }],
            }],
            truncated: true,
            message: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_list"));
        assert_eq!(value["items"][0]["is_draft"], serde_json::json!(true));
        assert_eq!(value["items"][0]["checks"], serde_json::json!("running"));
        assert_eq!(value["truncated"], serde_json::json!(true));
    }

    #[test]
    fn pr_stack_merge_parses_its_pinned_heads() {
        let msg: ClientMsg = serde_json::from_str(
            r#"{"type":"pr_stack_merge","dir":"/w","number":61,"stack_number":5,"heads":[{"number":61,"head_sha":"abc"},{"number":62,"head_sha":"def"}],"merge_method":"squash","request":7}"#,
        )
        .unwrap();
        match msg {
            ClientMsg::PrStackMerge {
                number,
                stack_number,
                heads,
                merge_method,
                request,
                ..
            } => {
                assert_eq!(number, 61);
                assert_eq!(stack_number, 5);
                assert_eq!(heads.len(), 2);
                assert_eq!(heads[1].number, 62);
                assert_eq!(heads[1].head_sha, "def");
                assert_eq!(merge_method, Some(PrMergeMethod::Squash));
                assert_eq!(request, 7);
            }
            other => panic!("expected pr_stack_merge, got {other:?}"),
        }
    }

    #[test]
    fn pr_stack_reply_carries_layers_and_a_null_stack() {
        let msg = ServerMsg::PrStack {
            dir: "/w".into(),
            request: 3,
            stack: Some(PrStack {
                id: "ST_1".into(),
                number: 5,
                url: "https://github.com/o/r/stacks/5".into(),
                base: "main".into(),
                layers: vec![PrStackLayer {
                    number: 61,
                    head_ref: "feat/x".into(),
                    state: PullRequestState::Open,
                    is_draft: false,
                    title: Some("a change".into()),
                    head_sha: Some("abc".into()),
                }],
            }),
            message: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_stack"));
        assert_eq!(value["stack"]["number"], serde_json::json!(5));
        assert_eq!(
            value["stack"]["layers"][0]["head_sha"],
            serde_json::json!("abc")
        );

        let none = serde_json::to_value(ServerMsg::PrStack {
            dir: "/w".into(),
            request: 4,
            stack: None,
            message: None,
        })
        .unwrap();
        assert_eq!(none["stack"], serde_json::json!(null));
    }

    #[test]
    fn pr_diff_reply_marks_a_truncated_patch() {
        let msg = ServerMsg::PrDiff {
            dir: "/w".into(),
            request: 6,
            number: 61,
            patch: "diff --git a/x b/x\n".into(),
            truncated: true,
            message: None,
        };
        let value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["type"], serde_json::json!("pr_diff"));
        assert_eq!(value["truncated"], serde_json::json!(true));
        assert_eq!(value["number"], serde_json::json!(61));
    }

    #[test]
    fn attach_without_replay_bytes_still_parses() {
        let msg: ClientMsg =
            serde_json::from_str(r#"{"type":"session_attach","session":3}"#).unwrap();
        match msg {
            ClientMsg::SessionAttach {
                session,
                replay_bytes,
                snapshot,
            } => {
                assert_eq!(session, 3);
                assert_eq!(replay_bytes, None);
                assert_eq!(snapshot, None, "a v93 client asks for no snapshot");
            }
            other => panic!("expected session_attach, got {other:?}"),
        }
    }

    #[test]
    fn state_predicates() {
        assert!(SessionState::Running.is_live());
        assert!(!SessionState::Exited.is_live());
        assert!(!SessionState::Killed.is_live());
        assert!(!SessionState::Interrupted.is_live());
    }

    #[test]
    fn generated_ts_gives_optional_numbers_their_null_branch() {
        let generated = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../ui/src/renderer/src/houston/generated/SshProfile.ts"
        );
        let src = std::fs::read_to_string(generated)
            .unwrap_or_else(|e| panic!("reading {generated}: {e}"));
        assert!(
            src.contains("last_used_at: number | null"),
            "Option<u64> lost its null branch in the generated TS — regenerate \
             with scripts/gen-protocol-types.sh after fixing the ts(type = ...) \
             override. Found:\n{src}"
        );
    }

    #[test]
    fn keymap_overrides_old_blob_defaults_shortcuts_to_enabled() {
        let v31_blob = r#"{"bindings":{"toggle-sidebar":{"code":"KeyJ","ctrl":true,"alt":false,"shift":false,"meta":false}}}"#;
        let overrides: KeymapOverrides = serde_json::from_str(v31_blob).unwrap();
        assert!(overrides.shortcuts_enabled);
        assert_eq!(overrides.bindings.len(), 1);
    }

    #[test]
    fn keymap_overrides_default_is_enabled() {
        assert!(KeymapOverrides::default().shortcuts_enabled);
        assert!(KeymapOverrides::default().bindings.is_empty());
    }

    #[test]
    fn routine_update_chat_defaults_tell_absent_from_null() {
        let absent: ClientMsg =
            serde_json::from_str(r#"{"type":"routine_update","id":1,"expected_revision":"r"}"#)
                .unwrap();
        let ClientMsg::RoutineUpdate {
            model,
            effort,
            workspace_id,
            ..
        } = absent
        else {
            panic!("expected a RoutineUpdate");
        };
        assert_eq!(model, None, "an absent key must be `unchanged`");
        assert_eq!(effort, None);
        assert_eq!(workspace_id, None);

        let cleared: ClientMsg = serde_json::from_str(
            r#"{"type":"routine_update","id":1,"expected_revision":"r","model":null}"#,
        )
        .unwrap();
        let ClientMsg::RoutineUpdate { model, .. } = cleared else {
            panic!("expected a RoutineUpdate");
        };
        assert_eq!(model, Some(None), "an explicit null must clear the field");

        let set: ClientMsg = serde_json::from_str(
            r#"{"type":"routine_update","id":1,"expected_revision":"r","model":"opus",
                "effort":"high","workspace_id":"/tmp/ws"}"#,
        )
        .unwrap();
        let ClientMsg::RoutineUpdate {
            model,
            effort,
            workspace_id,
            ..
        } = set
        else {
            panic!("expected a RoutineUpdate");
        };
        assert_eq!(model, Some(Some("opus".to_string())));
        assert_eq!(effort, Some(Some(ChatEffort::High)));
        assert_eq!(workspace_id, Some(Some("/tmp/ws".to_string())));
    }

    #[test]
    fn routine_update_untouched_fields_serialize_as_absent() {
        let msg = ClientMsg::RoutineUpdate {
            id: 1,
            expected_revision: "r".to_string(),
            name: Some("Nightly".to_string()),
            prompt: None,
            cadence: None,
            enabled: None,
            workspace_id: None,
            engine: None,
            model: None,
            effort: None,
            permission_mode: None,
            isolate: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(!json.contains("model"), "{json}");
        assert!(!json.contains("effort"), "{json}");
        assert!(!json.contains("workspace_id"), "{json}");
        assert!(!json.contains("agent_id"), "{json}");
        assert!(!json.contains("continue_context"), "{json}");
    }

    #[test]
    fn manage_request_candidate_bin_is_additive() {
        let legacy: ManageRequest =
            serde_json::from_str(r#"{"manage_version":1,"verb":"daemon_handoff"}"#).unwrap();
        assert_eq!(legacy.candidate_bin, None);
        assert_eq!(legacy.manage_version, MANAGE_VERSION);

        let with_candidate = ManageRequest {
            manage_version: MANAGE_VERSION,
            verb: ManageVerb::DaemonHandoff,
            candidate_bin: Some("/usr/bin/houston-core".to_string()),
        };
        let json = serde_json::to_string(&with_candidate).unwrap();
        assert!(
            json.contains(r#""candidate_bin":"/usr/bin/houston-core""#),
            "{json}"
        );

        let without = ManageRequest {
            manage_version: MANAGE_VERSION,
            verb: ManageVerb::DaemonStatus,
            candidate_bin: None,
        };
        let json = serde_json::to_string(&without).unwrap();
        assert!(
            !json.contains("candidate_bin"),
            "an absent candidate must not ride the wire: {json}"
        );
        assert_eq!(json, r#"{"manage_version":1,"verb":"daemon_status"}"#);
    }
}

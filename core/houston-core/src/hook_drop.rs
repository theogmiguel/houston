use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const DROP_V: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumeHookEvidence {
    pub source: Option<String>,
    pub profile_dir: Option<String>,
}

// True millisecond resolution, deliberately not `daemon::now_ms` (a
// multiple of 1000): on that coarser clock every event in one second would
// share `ms`, making seq-only ordering — the async-Stop race below — the norm.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn drop_dir(root: &Path) -> PathBuf {
    root.join("hooks").join(DROP_DIR_NAME)
}

const DROP_DIR_NAME: &str = "drop";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookDrop {
    pub v: u32,
    pub event: String,
    pub session: u32,
    #[serde(default)]
    pub cwd: Option<String>,
    // The CLI's own session log path, when the provider reports one. Carried so
    // the daemon can read context occupancy without scraping the terminal.
    #[serde(default)]
    pub transcript_path: Option<String>,
    // `#[serde(default)]` -> `None` -> Claude, deliberately: every hook
    // command installed before multi-provider support omits this field, and
    // those workspaces are not rewritten — an older drop file must keep working.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub last_message: Option<String>,
    #[serde(default)]
    pub background_tasks: Option<u32>,
    // A UserPromptSubmit the CLI wrote itself (a background sub-agent
    // waking it), not a new request: must not rename the pane, rearm a
    // no-handback round, or count as the parent prompting.
    #[serde(default)]
    pub internal_prompt: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_details: Option<String>,
    #[serde(default)]
    pub notification_type: Option<String>,
    #[serde(default)]
    pub stop_hook_active: bool,
    #[serde(default)]
    pub prompt_id: Option<String>,
    #[serde(default)]
    pub pending_task_ids: Vec<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    // Provider-native identifier for a permission or question request. Unlike
    // `tool_use_id`, this survives OpenCode's separate asked/replied events.
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub stop_continued: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    // Antigravity Stop.fullyIdle: `false` means the agent parked on
    // invoke_subagent and this Stop decides nothing; `true` closes the
    // round. Absent for every other provider's Stop.
    #[serde(default)]
    pub fully_idle: Option<bool>,
    #[serde(default)]
    pub subagent_type: Option<String>,
    // Antigravity PreToolUse/PostToolUse's toolCall.name. Only three names
    // open a block (ask_question, ask_permission, ask_custom_permission);
    // every other tool call is the agent working, not a human being asked.
    #[serde(default)]
    pub tool_name: Option<String>,
    // A provider may omit its tool-call ID from the permission event while
    // including the command in the later completion event. Keep only a
    // digest so correlation stays independent of bounded permission display metadata.
    #[serde(default)]
    pub tool_input_fingerprint: Option<String>,
    #[serde(default)]
    pub permission_command: Option<String>,
    #[serde(default)]
    pub permission_block_reason: Option<String>,
    #[serde(default)]
    pub resume_evidence: Option<ResumeHookEvidence>,
    // The remote feed's masked, bounded targets and edit previews: the exception to the
    // digest rule above, read only by the in-memory feed.
    #[serde(default)]
    pub feed: Option<crate::remote::feed::HookFeed>,
    // ZCode's PostToolUseFailure.is_interrupt: the operator aborted the turn mid-tool.
    #[serde(default)]
    pub interrupted: bool,
    // The model a Codex, OpenCode or Antigravity payload reports, shown on the
    // pane's remote session row.
    #[serde(default)]
    pub model: Option<String>,
}

impl HookDrop {
    pub fn root_cwd(&self, provider: houston_protocol::AgentKind) -> Option<&str> {
        (crate::agent_events::names_root_conversation(provider, &self.event)
            && self.agent_id.is_none()
            && self.subagent_type.is_none())
        .then_some(self.cwd.as_deref())
        .flatten()
    }
}

impl Default for HookDrop {
    fn default() -> Self {
        Self {
            v: DROP_V,
            event: String::new(),
            session: 0,
            cwd: None,
            transcript_path: None,
            agent: None,
            prompt: None,
            last_message: None,
            background_tasks: None,
            internal_prompt: false,
            reason: None,
            error: None,
            error_details: None,
            notification_type: None,
            stop_hook_active: false,
            prompt_id: None,
            pending_task_ids: Vec::new(),
            task_id: None,
            agent_id: None,
            tool_use_id: None,
            request_id: None,
            stop_continued: false,
            session_id: None,
            fully_idle: None,
            subagent_type: None,
            tool_name: None,
            tool_input_fingerprint: None,
            permission_command: None,
            permission_block_reason: None,
            resume_evidence: None,
            feed: None,
            interrupted: false,
            model: None,
        }
    }
}

// A pane title is at most 40 chars, cut at a word boundary; 200 covers every
// title the rule can produce with room to spare, while a large paste still
// stays out of the drop directory.
pub const PROMPT_CAPTURE_CHARS: usize = 200;

// Fixed widths so a lexicographic sort of the names is a numeric sort of
// (ms, seq).
const MS_WIDTH: usize = 13;
const SEQ_WIDTH: usize = 6;

// A tripwire, not a real ceiling: reaching it means a session accumulated a
// million undrained hook events in 10 minutes, against a real ceiling of
// four events per Claude turn. Hitting it is a named error, never a wrap.
const MAX_SEQ: u32 = 999_999;

// Deliberately doesn't end in `.json`, so a scan skips an in-flight write
// silently rather than reporting it as an unparseable drop name.
const TMP_INFIX: &str = ".tr-tmp.";

pub fn drop_filename(ms: u64, seq: u32, session: u32) -> String {
    format!("{ms:0MS_WIDTH$}-{seq:0SEQ_WIDTH$}-s{session}.json")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DropName {
    pub ms: u64,
    pub seq: u32,
    pub session: u32,
}

// Strict on purpose: a name that fails to parse is never deleted, so a
// loose parse is how a foreign file gets read as epoch-old and destroyed on
// the first sweep. Fixed widths, digits only, exactly three segments.
pub fn parse_drop_name(name: &str) -> Option<DropName> {
    let stem = name.strip_suffix(".json")?;
    let mut parts = stem.split('-');
    let (ms, seq, session) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let digits = |s: &str, width: Option<usize>| {
        !s.is_empty()
            && width.is_none_or(|w| s.len() == w)
            && s.bytes().all(|b| b.is_ascii_digit())
            && s.len() <= 20
    };
    if !digits(ms, Some(MS_WIDTH)) || !digits(seq, Some(SEQ_WIDTH)) {
        return None;
    }
    let session = session.strip_prefix('s')?;
    if !digits(session, None) {
        return None;
    }
    Some(DropName {
        ms: ms.parse().ok()?,
        seq: seq.parse().ok()?,
        session: session.parse().ok()?,
    })
}

pub fn ensure_drop_dir(dir: &Path) -> Result<()> {
    ensure_dir(dir)
}

pub fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("creating temp file in {}", dir.display()))?;
    use std::io::Write as _;
    tmp.write_all(bytes)
        .with_context(|| format!("writing temp file in {}", dir.display()))?;
    tmp.flush()
        .with_context(|| format!("flushing temp file in {}", dir.display()))?;
    tmp.as_file()
        .sync_all()
        .with_context(|| format!("syncing temp file in {}", dir.display()))?;
    let dest = dir.join(name);
    tmp.persist(&dest)
        .map_err(|e| anyhow!("persisting {}: {}", dest.display(), e.error))?;
    sync_dir(dir).with_context(|| format!("syncing directory {}", dir.display()))?;
    Ok(())
}

// Without both syncs, ext4 delayed allocation can leave a renamed or linked name pointing at
// an empty file after power loss. Cost per write on ext4/NVMe: 8.6 ms synced vs 0.08 ms
// unsynced (300 writes; 17-42 ms synced at load average 20).
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()
    }
    // std cannot open a directory handle on Windows; NTFS journals the rename itself, so
    // the file's own flush is the durable part there.
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

fn ensure_dir(dir: &Path) -> Result<()> {
    // Checked before create_dir_all: that call succeeds *through* a
    // pre-existing symlink (and set_permissions follows it), so a symlinked
    // `drop` would have Houston chmodding something it does not own.
    if let Ok(meta) = std::fs::symlink_metadata(dir) {
        if !meta.is_dir() {
            let kind = if meta.file_type().is_symlink() {
                "a symlink"
            } else {
                "not a directory"
            };
            return Err(anyhow!(
                "{} is {kind}, not a real directory — refusing to chmod through it",
                dir.display()
            ));
        }
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod {}", dir.display()))?;
    }
    Ok(())
}

// One directory pass doing both per-write jobs (sweep dead-writer temp
// files, find the next sequence): this directory is shared across every
// concurrently-active pane, so two scans grew with system-wide hook traffic.
fn sweep_and_next_seq(dir: &Path, session: u32) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 1;
    };
    let mut max = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some((_, rest)) = name.split_once(TMP_INFIX) {
            let Some((pid_str, _n)) = rest.split_once('.') else {
                continue;
            };
            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            if !crate::pid::process_is_alive(pid) {
                let _ = std::fs::remove_file(entry.path());
            }
            continue;
        }
        let Some(parsed) = parse_drop_name(name) else {
            continue;
        };
        if parsed.session == session {
            max = max.max(parsed.seq);
        }
    }
    max + 1
}

// hard_link makes the filesystem the critical section: it fails
// AlreadyExists rather than clobbering, so the writer claims the next free
// (ms, seq) name by trying to link, retrying on collision, never overwriting.
pub fn write_drop(dir: &Path, drop: &HookDrop, now_ms: u64) -> Result<PathBuf> {
    write_drop_with(dir, drop, now_ms, |from, to| std::fs::hard_link(from, to))
}

pub(crate) fn write_drop_with(
    dir: &Path,
    drop: &HookDrop,
    now_ms: u64,
    claim: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    ensure_dir(dir)?;
    // Draining can reuse a filename in the same millisecond; each write needs its own identity.
    let mut payload = serde_json::to_value(drop).context("serializing the hook drop payload")?;
    payload["_houston_drop_id"] = uuid::Uuid::new_v4().to_string().into();
    let bytes = serde_json::to_vec(&payload).context("serializing the hook drop payload")?;
    let tmp = dir.join(format!(
        "hook{TMP_INFIX}{}.{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let durable = needs_sync(drop);
    {
        use std::io::Write as _;
        let mut file =
            std::fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(&bytes)
            .and_then(|()| if durable { sync_file(&file) } else { Ok(()) })
            .with_context(|| format!("writing {}", tmp.display()))?;
    }
    let mut seq = sweep_and_next_seq(dir, drop.session);
    loop {
        if seq > MAX_SEQ {
            let _ = std::fs::remove_file(&tmp);
            return Err(anyhow!(
                "session {} has {MAX_SEQ} undrained hook drop files in {} — the per-session \
                 sequence is {SEQ_WIDTH} digits and this event cannot be ordered against them; \
                 expected the daemon to be draining this directory",
                drop.session,
                dir.display()
            ));
        }
        let dest = dir.join(drop_filename(now_ms, seq, drop.session));
        match claim(&tmp, &dest) {
            Ok(()) => {
                let _ = std::fs::remove_file(&tmp);
                if durable {
                    sync_claimed(dir, &dest);
                }
                return Ok(dest);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => seq += 1,
            Err(link_err) => match copy_claim(&tmp, &dest) {
                Ok(()) => {
                    tracing::debug!(
                        "hook drop claim via hard_link failed ({link_err}); delivered \
                         {} by copy",
                        dest.display()
                    );
                    let _ = std::fs::remove_file(&tmp);
                    if durable {
                        if let Err(error) = std::fs::File::open(&dest).and_then(|f| sync_file(&f)) {
                            tracing::warn!("syncing copied hook drop {}: {error}", dest.display());
                        }
                        sync_claimed(dir, &dest);
                    }
                    return Ok(dest);
                }
                Err(copy_err) => {
                    let _ = std::fs::remove_file(&dest);
                    let _ = std::fs::remove_file(&tmp);
                    return Err(copy_err).with_context(|| {
                        format!(
                            "claiming {} failed twice — hard_link: {link_err}; copy fallback \
                             also failed",
                            dest.display()
                        )
                    });
                }
            },
        }
    }
}

// Only drops recovery records as the root conversation are synced; losing another one to power
// loss loses a status cue. Per drop on ext4/NVMe (300 into one dir, load 2-6): SessionStart,
// prompt submit and turn end 2.1-16 ms synced; tool and other lifecycle events 0.45-0.8 ms.
fn needs_sync(drop: &HookDrop) -> bool {
    let provider = drop
        .agent
        .as_deref()
        .map(crate::agent_hooks::provider_from_slug)
        .unwrap_or(Ok(houston_protocol::AgentKind::Claude));
    provider.is_ok_and(|provider| {
        drop.session_id.as_deref().is_some_and(|id| !id.is_empty())
            && crate::db::resume_metadata::names_root_conversation_event(provider, drop)
    })
}

fn sync_file(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(test)]
    tests::SYNCED_FILES.with(|count| count.set(count.get() + 1));
    file.sync_all()
}

// The drop is already delivered; a failed directory sync only weakens power-loss durability,
// and failing the hook here would make its caller deliver the event twice.
fn sync_claimed(dir: &Path, dest: &Path) {
    if let Err(error) = sync_dir(dir) {
        tracing::warn!(
            "syncing hook drop directory for {}: {error}",
            dest.display()
        );
    }
}

// Only reached where hard links don't exist at all (exFAT, some shares):
// copy trades atomicity for delivery, so the byte count is verified before
// the caller treats the name as delivered — a short copy self-heals on retry.
fn copy_claim(from: &Path, to: &Path) -> std::io::Result<()> {
    let expected = std::fs::metadata(from)?.len();
    let copied = std::fs::copy(from, to)?;
    if copied != expected {
        let _ = std::fs::remove_file(to);
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "copied {copied} of {expected} bytes from {} to {} — removed the partial copy",
                from.display(),
                to.display()
            ),
        ));
    }
    Ok(())
}

// Far longer than any live daemon's poll gap (slowest rung is 30s) and far
// shorter than a session's lifetime, so a fresh event is never stale and a
// relaunch never marks a pane Idle from a three-day-old Stop.
pub const MAX_AGE_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropVerdict {
    Applied,
    NoSession,
    Retry,
}

#[derive(Debug, Default)]
pub struct DropDirState {
    warned: HashSet<OsString>,
    applied: HashSet<OsString>,
    protected_sessions: HashSet<u32>,
    recovery_candidates: Option<HashSet<u32>>,
}

impl DropDirState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn protect_sessions(&mut self, sessions: impl IntoIterator<Item = u32>) {
        self.protected_sessions = sessions.into_iter().collect();
    }
    pub fn recover_sessions(&mut self, sessions: impl IntoIterator<Item = u32>) {
        self.recovery_candidates = Some(sessions.into_iter().collect());
    }
    pub fn warned_len(&self) -> usize {
        self.warned.len()
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PassOutcome {
    pub applied: usize,
    pub kept: usize,
    pub collected: usize,
    pub listed_ok: bool,
    pub listing_limit_exceeded: Option<usize>,
    /// Recovery sessions whose drop the callback could not store (`DropVerdict::Retry`).
    pub failed_sessions: BTreeSet<u32>,
    /// Recovery drops set aside as unreadable or invalid evidence.
    pub quarantined: usize,
}

/// Suffix of a recovery drop set aside as invalid; it no longer ends in `.json`, so no pass
/// reads it again.
pub const QUARANTINE_SUFFIX: &str = ".quarantined";
// Enough evidence to diagnose a damaged directory; beyond it bad drops are deleted, so
// repeated power loss cannot fill the directory.
pub const QUARANTINE_MAX: usize = 64;

fn quarantine(path: &Path, held: &mut usize, reason: &str, out: &mut PassOutcome) {
    let target = PathBuf::from(format!("{}{QUARANTINE_SUFFIX}", path.display()));
    let result = if *held >= QUARANTINE_MAX {
        std::fs::remove_file(path)
            .or_else(|_| std::fs::remove_dir(path))
            .map(|()| {
                format!("deleted it (quarantine limit {QUARANTINE_MAX} reached, actual {held})")
            })
    } else {
        std::fs::rename(path, &target).map(|()| {
            *held += 1;
            format!("moved it to {}", target.display())
        })
    };
    match result {
        Ok(action) => {
            tracing::warn!("hook metadata recovery: {} {reason}; expected a regular file of at most 1048576 bytes holding a version {DROP_V} drop for the session named in its filename, sampled no later than now; {action}; the pane resumes from its stored handle", path.display());
            out.quarantined += 1;
        }
        Err(error) => {
            tracing::warn!("hook metadata recovery: {} {reason}; setting it aside failed ({error}); skipped, the pane resumes from its stored handle", path.display());
            out.kept += 1;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    Seed,
    Steady,
    RecoveryMetadata,
}

// Unparseable names are retained and warned once, since Houston cannot claim them.
// Ordinary passes expire files after MAX_AGE_MS; recovery reads bounded metadata across downtime.
// Recovery callbacks must not replay lifecycle effects.
pub fn run_pass(
    dir: &Path,
    state: &mut DropDirState,
    now_ms: u64,
    pass: Pass,
    mut apply: impl FnMut(&HookDrop) -> DropVerdict,
) -> PassOutcome {
    run_pass_with_io(
        dir,
        state,
        now_ms,
        pass,
        |drop, _, _| apply(drop),
        |path| std::fs::remove_file(path),
    )
}

/// The stable directory/name identity also covers replay after a daemon restart.
pub fn run_pass_with_io(
    dir: &Path,
    state: &mut DropDirState,
    now_ms: u64,
    pass: Pass,
    mut apply: impl FnMut(&HookDrop, &str, u64) -> DropVerdict,
    remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> PassOutcome {
    run_pass_with_name_io(
        dir,
        state,
        now_ms,
        pass,
        |drop, identity, name| apply(drop, identity, name.ms),
        remove,
    )
}

// Recovery and every steady pass read through this one bound, so recovery can
// replay any drop the steady pass applies. No hook client produces a larger
// file, so it is refused rather than allocated whole.
const MAX_DROP_BYTES: u64 = 1024 * 1024;

/// Stops at `MAX_DROP_BYTES + 1` so an oversized file is refused without ever
/// being read into memory in full.
fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    std::fs::File::open(path).and_then(|file| {
        let mut bytes = Vec::new();
        file.take(MAX_DROP_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_DROP_BYTES {
            return Err(std::io::Error::other(format!(
                "hook drop payload limit {MAX_DROP_BYTES} exceeded (actual at least {} bytes)",
                bytes.len()
            )));
        }
        Ok(bytes)
    })
}

/// Recovery retains event ordering without replaying the event's lifecycle effects.
pub fn run_pass_with_name_io(
    dir: &Path,
    state: &mut DropDirState,
    now_ms: u64,
    pass: Pass,
    mut apply: impl FnMut(&HookDrop, &str, DropName) -> DropVerdict,
    mut remove: impl FnMut(&Path) -> std::io::Result<()>,
) -> PassOutcome {
    let mut out = PassOutcome::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.listed_ok = true;
            state.warned.clear();
            state.applied.clear();
            return out;
        }
        Err(e) => {
            tracing::warn!(
                "hook drop {pass:?} pass: listing {} failed ({e}) — this is not \"no hook events\"; \
                 nothing was applied or collected this round",
                dir.display()
            );
            return out;
        }
    };
    out.listed_ok = true;

    let mut present: HashSet<OsString> = HashSet::new();
    let mut files: Vec<(DropName, PathBuf, OsString)> = Vec::new();
    let mut held = 0usize;
    for (index, entry) in entries.enumerate() {
        // Refuse a partial recovery scan before any application: skipped newer
        // drops could invalidate an older handle. Steady draining stays unchanged.
        if pass == Pass::RecoveryMetadata && index >= 4096 {
            out.listed_ok = false;
            out.listing_limit_exceeded = Some(index + 1);
            return out;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!("listing hook drop entry in {}: {error}", dir.display());
                out.listed_ok = false;
                if pass == Pass::RecoveryMetadata {
                    return out;
                }
                continue;
            }
        };
        let name = entry.file_name();
        let Some(text) = name.to_str() else {
            warn_once(state, &mut present, &name, || {
                tracing::warn!(
                    "hook drop pass: {}/{:?} has a non-UTF-8 name — not a drop file; never deleted",
                    dir.display(),
                    name
                );
            });
            continue;
        };
        if !text.ends_with(".json") {
            held += usize::from(text.ends_with(QUARANTINE_SUFFIX));
            continue;
        }
        let Some(parsed) = parse_drop_name(text) else {
            warn_once(state, &mut present, &name, || {
                tracing::warn!(
                    "hook drop pass: {} does not parse as \
                     <13-digit-ms>-<6-digit-seq>-s<session>.json — never deleted, never applied",
                    entry.path().display()
                );
            });
            continue;
        };
        present.insert(name.clone());
        files.push((parsed, entry.path(), name));
    }
    state.warned.retain(|n| present.contains(n));
    state.applied.retain(|n| present.contains(n));

    files.sort_by_key(|(n, _, _)| (n.ms, n.seq, n.session));

    for (parsed, path, name) in files {
        let recovering = pass == Pass::RecoveryMetadata;
        if recovering
            && state
                .recovery_candidates
                .as_ref()
                .is_some_and(|sessions| !sessions.contains(&parsed.session))
        {
            out.kept += 1;
            continue;
        }
        if pass != Pass::RecoveryMetadata && state.protected_sessions.contains(&parsed.session) {
            out.kept += 1;
            continue;
        }
        if pass != Pass::RecoveryMetadata && now_ms.saturating_sub(parsed.ms) > MAX_AGE_MS {
            state.applied.remove(&name);
            match remove(&path) {
                Ok(()) => out.collected += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => out.collected += 1,
                Err(e) => {
                    tracing::warn!("hook drop pass: removing stale {}: {e}", path.display());
                    out.kept += 1;
                }
            }
            continue;
        }
        if state.applied.contains(&name) {
            if remove(&path).is_ok() {
                state.applied.remove(&name);
                out.collected += 1;
            } else {
                out.kept += 1;
            }
            continue;
        }
        // Bound receipts without evicting identities whose drops can still be replayed.
        if state.applied.len() >= 4096 {
            let count = state.applied.len();
            warn_once(state, &mut present, &name, || {
                tracing::warn!(
                    "hook receipt limit 4096 reached (actual {count}); deferring application of {}",
                    path.display()
                );
            });
            out.kept += 1;
            continue;
        }
        if pass == Pass::RecoveryMetadata {
            // Metadata survives long downtime. Bound and validate the local drop
            // before reading; stale lifecycle TTL still applies in the seed pass.
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    quarantine(
                        &path,
                        &mut held,
                        &format!("has unreadable metadata ({error})"),
                        &mut out,
                    );
                    continue;
                }
            };
            if !metadata.is_file() || metadata.len() > MAX_DROP_BYTES || parsed.ms > now_ms {
                let reason = format!(
                    "is {} of {} bytes sampled at {} (now {now_ms})",
                    if metadata.is_file() {
                        "a file"
                    } else {
                        "not a regular file"
                    },
                    metadata.len(),
                    parsed.ms
                );
                quarantine(&path, &mut held, &reason, &mut out);
                continue;
            }
        }
        let bytes = match read_bounded(&path) {
            Ok(b) => b,
            Err(e) if recovering => {
                quarantine(&path, &mut held, &format!("cannot be read ({e})"), &mut out);
                continue;
            }
            Err(e) => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!("hook drop pass: reading {}: {e}", path.display());
                });
                out.kept += 1;
                continue;
            }
        };
        let drop = match serde_json::from_slice::<HookDrop>(&bytes) {
            Ok(d) if d.v == DROP_V && d.session == parsed.session => d,
            Ok(d) if recovering => {
                let reason = format!("holds version {} for session {}", d.v, d.session);
                quarantine(&path, &mut held, &reason, &mut out);
                continue;
            }
            Err(e) if recovering => {
                let reason = format!("does not parse ({} bytes: {e})", bytes.len());
                quarantine(&path, &mut held, &reason, &mut out);
                continue;
            }
            Ok(d) if d.v != DROP_V => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!(
                        "hook drop pass: {} has version {} (expected {DROP_V}) — kept, \
                         not applied",
                        path.display(),
                        d.v
                    );
                });
                out.kept += 1;
                continue;
            }
            Ok(d) => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!("hook drop pass: {} names session {} in its payload (expected {} from filename); kept, not applied", path.display(), d.session, parsed.session);
                });
                out.kept += 1;
                continue;
            }
            Err(e) => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!("hook drop pass: parsing {}: {e}", path.display());
                });
                out.kept += 1;
                continue;
            }
        };
        use sha2::Digest;
        let mut digest = sha2::Sha256::new();
        let path_bytes = path.as_os_str().as_encoded_bytes();
        digest.update((path_bytes.len() as u64).to_be_bytes());
        digest.update(path_bytes);
        digest.update(&bytes);
        let identity = format!("{:x}", digest.finalize());
        match apply(&drop, &identity, parsed) {
            DropVerdict::Applied => {
                state.applied.insert(name.clone());
                if let Err(e) = remove(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!("hook drop pass: removing applied {}: {e}", path.display());
                    }
                } else {
                    state.applied.remove(&name);
                }
                out.applied += 1;
            }
            DropVerdict::NoSession => out.kept += 1,
            DropVerdict::Retry => {
                if recovering {
                    out.failed_sessions.insert(parsed.session);
                }
                out.kept += 1;
            }
        }
    }
    out
}

fn warn_once(
    state: &mut DropDirState,
    present: &mut HashSet<OsString>,
    name: &OsString,
    emit: impl FnOnce(),
) {
    present.insert(name.clone());
    if state.warned.insert(name.clone()) {
        emit();
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    thread_local! {
        pub(super) static SYNCED_FILES: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }

    fn synced_by_write(drop: &HookDrop) -> bool {
        let dir = tempfile::tempdir().unwrap();
        let before = SYNCED_FILES.with(std::cell::Cell::get);
        write_drop(&dir.path().join("drop"), drop, now_ms()).unwrap();
        SYNCED_FILES.with(std::cell::Cell::get) > before
    }

    #[test]
    fn only_root_conversation_drops_take_the_synced_path() {
        let event = |agent: Option<&str>, event: &str| HookDrop {
            session: 7,
            event: event.into(),
            agent: agent.map(Into::into),
            session_id: Some("conv-7".into()),
            transcript_path: Some("/tmp/conv-7.jsonl".into()),
            ..HookDrop::default()
        };
        for tool in [
            "PreToolUse",
            "PostToolUse",
            "Notification",
            "PermissionRequest",
        ] {
            assert!(!synced_by_write(&event(None, tool)), "{tool} was synced");
        }
        assert!(!synced_by_write(&HookDrop {
            agent_id: Some("sub".into()),
            ..event(None, "Stop")
        }));
        assert!(!synced_by_write(&HookDrop {
            session_id: None,
            ..event(None, "SessionStart")
        }));
        for (agent, name) in [
            (None, "SessionStart"),
            (None, "UserPromptSubmit"),
            (None, "Stop"),
            (Some("codex"), "SessionStart"),
        ] {
            assert!(
                synced_by_write(&event(agent, name)),
                "{agent:?} {name} was not synced"
            );
        }
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl LogBuf {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            std::io::Write::write(&mut *self.0.lock().unwrap(), buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    fn drop_for(session: u32, event: &str) -> HookDrop {
        HookDrop {
            event: event.to_string(),
            session,
            ..Default::default()
        }
    }

    fn recorder(log: &mut Vec<String>) -> impl FnMut(&HookDrop) -> DropVerdict + '_ {
        move |d| {
            log.push(d.event.clone());
            DropVerdict::Applied
        }
    }

    #[test]
    fn a_filename_round_trips_through_the_strict_parser() {
        let name = drop_filename(1_754_600_000_123, 7, 42);
        assert_eq!(name, "1754600000123-000007-s42.json");
        assert_eq!(
            parse_drop_name(&name),
            Some(DropName {
                ms: 1_754_600_000_123,
                seq: 7,
                session: 42
            })
        );
    }

    #[test]
    fn the_parser_refuses_every_near_miss() {
        for bad in [
            "1754600000123-000007-s42.txt",
            "175460000012-000007-s42.json",
            "17546000001234-000007-s42.json",
            "1754600000123-00007-s42.json",
            "1754600000123-000007-42.json",
            "1754600000123-000007-s.json",
            "1754600000123-000007-sx.json",
            "1754600000123-000007-s42-x.json",
            "0000000000000-seed-primary-goal.json",
            ".json",
            "hook.tr-tmp.1234.0",
        ] {
            assert_eq!(parse_drop_name(bad), None, "must refuse {bad:?}");
        }
    }

    #[test]
    fn two_events_in_one_millisecond_keep_their_write_order() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        write_drop(&dir, &drop_for(9, "UserPromptSubmit"), ms).unwrap();
        write_drop(&dir, &drop_for(9, "Stop"), ms).unwrap();

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, ms + 1, Pass::Steady, recorder(&mut log));
        assert_eq!(out.applied, 2);
        assert_eq!(
            log,
            vec!["UserPromptSubmit".to_string(), "Stop".to_string()],
            "same-millisecond events must apply in write order, not name-sort order"
        );
    }

    #[test]
    fn the_sequence_is_what_orders_a_same_millisecond_pair() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        let a = write_drop(&dir, &drop_for(3, "UserPromptSubmit"), ms).unwrap();
        let b = write_drop(&dir, &drop_for(3, "Stop"), ms).unwrap();
        let (a, b) = (
            a.file_name().unwrap().to_str().unwrap().to_string(),
            b.file_name().unwrap().to_str().unwrap().to_string(),
        );
        assert!(a < b, "{a} must sort before {b}");
        assert_eq!(parse_drop_name(&a).unwrap().seq, 1);
        assert_eq!(parse_drop_name(&b).unwrap().seq, 2);
    }

    #[test]
    fn an_ordinary_pass_refuses_an_oversized_drop_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        let mut drop = drop_for(9, "Stop");
        drop.cwd = Some("x".repeat(1024 * 1024 + 16));
        let path = write_drop(&dir, &drop, ms).unwrap();
        assert!(path.metadata().unwrap().len() > 1_048_576);

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, ms + 1, Pass::Steady, recorder(&mut log));
        assert_eq!(out.applied, 0, "an oversized payload must not be applied");
        assert_eq!(out.kept, 1);
        assert!(
            path.exists(),
            "the oversized file stays until MAX_AGE_MS collection, it is not deleted"
        );

        let mut recovery_state = DropDirState::new();
        recovery_state.recover_sessions([9]);
        let out = run_pass(
            &dir,
            &mut recovery_state,
            ms + 1,
            Pass::RecoveryMetadata,
            recorder(&mut log),
        );
        assert_eq!(out.applied, 0);
        assert_eq!(out.quarantined, 1, "recovery sets it aside");
        assert!(
            out.failed_sessions.is_empty(),
            "an unreadable drop defers no session"
        );
        assert_eq!(log.len(), 0, "no pass applied the oversized payload");
    }

    #[test]
    fn the_module_clock_ticks_in_milliseconds_not_seconds() {
        let mut sub_second = 0;
        for _ in 0..50 {
            if !now_ms().is_multiple_of(1000) {
                sub_second += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        assert!(
            sub_second > 0,
            "hook_drop::now_ms must not be a whole-second clock: 50 samples over ~150ms were all \
             multiples of 1000"
        );
        let (mine, global) = (now_ms(), crate::daemon::now_ms());
        assert!(
            mine.abs_diff(global) < 2000,
            "hook_drop::now_ms {mine} and daemon::now_ms {global} must share the Unix epoch"
        );
    }

    #[test]
    fn the_earlier_timestamp_wins_even_when_it_is_written_last() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let stop_at = 1_754_600_000_100;
        let prompt_at = stop_at + 300;
        let prompt = write_drop(&dir, &drop_for(9, "UserPromptSubmit"), prompt_at).unwrap();
        let stop = write_drop(&dir, &drop_for(9, "Stop"), stop_at).unwrap();
        assert_eq!(
            parse_drop_name(prompt.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            1
        );
        assert_eq!(
            parse_drop_name(stop.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            2,
            "precondition: the Stop file was written second"
        );

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        let out = run_pass(
            &dir,
            &mut state,
            prompt_at + 1,
            Pass::Steady,
            recorder(&mut log),
        );
        assert_eq!(out.applied, 2);
        assert_eq!(
            log,
            vec!["Stop".to_string(), "UserPromptSubmit".to_string()],
            "the earlier-sampled event must apply first; applying UserPromptSubmit then Stop \
             leaves the pane Idle for the whole turn"
        );
    }

    #[test]
    fn a_cross_volume_claim_failure_falls_back_to_copy_and_delivers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let drop = drop_for(6, "UserPromptSubmit");
        let ms = 1_754_600_000_000;
        let path = write_drop_with(&dir, &drop, ms, |_, _| {
            Err(std::io::Error::other("simulated cross-volume link"))
        })
        .expect("copy fallback must deliver what the link could not");
        assert_eq!(
            parse_drop_name(path.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            1
        );
        let parsed: HookDrop = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(parsed, drop, "delivered content must round-trip exactly");

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, ms + 1, Pass::Steady, recorder(&mut log));
        assert_eq!(out.applied, 1);
        assert_eq!(log, vec!["UserPromptSubmit".to_string()]);
        assert!(!path.exists(), "an applied file is deleted");
    }

    #[test]
    fn an_already_exists_claim_retries_the_sequence_instead_of_copying() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let drop = drop_for(3, "Stop");
        let ms = 1_754_600_000_000;
        let claims = AtomicUsize::new(0);
        let path = write_drop_with(&dir, &drop, ms, |from, to| {
            let n = claims.fetch_add(1, Ordering::SeqCst);
            if n < 2 {
                Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
            } else {
                std::fs::hard_link(from, to)
            }
        })
        .unwrap();
        assert_eq!(claims.load(Ordering::SeqCst), 3, "two retries then success");
        assert_eq!(
            parse_drop_name(path.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            3
        );
        let remaining = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(remaining, 1, "no copies may be left at the skipped names");
    }

    #[test]
    fn when_both_claim_paths_fail_nothing_is_left_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let err = write_drop_with(&dir, &drop_for(4, "Stop"), 1_754_600_000_000, |from, _| {
            std::fs::remove_file(from).unwrap();
            Err(std::io::Error::other("simulated cross-volume link"))
        })
        .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("hard_link"), "{text}");
        assert!(text.contains("copy fallback"), "{text}");
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "neither a torn copy nor temp residue may survive"
        );
    }

    #[test]
    fn the_sequence_is_per_session() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        write_drop(&dir, &drop_for(1, "UserPromptSubmit"), ms).unwrap();
        write_drop(&dir, &drop_for(2, "UserPromptSubmit"), ms).unwrap();
        let a2 = write_drop(&dir, &drop_for(1, "Stop"), ms).unwrap();
        let b2 = write_drop(&dir, &drop_for(2, "Stop"), ms).unwrap();
        assert_eq!(
            parse_drop_name(a2.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            2
        );
        assert_eq!(
            parse_drop_name(b2.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            2
        );
    }

    #[test]
    fn the_sequence_restarts_after_the_backlog_drains() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        write_drop(&dir, &drop_for(4, "SessionStart"), ms).unwrap();
        let second = write_drop(&dir, &drop_for(4, "Stop"), ms).unwrap();
        assert_eq!(
            parse_drop_name(second.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            2
        );

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        run_pass(&dir, &mut state, ms + 1, Pass::Steady, recorder(&mut log));

        let after = write_drop(&dir, &drop_for(4, "Notification"), ms).unwrap();
        assert_eq!(
            parse_drop_name(after.file_name().unwrap().to_str().unwrap())
                .unwrap()
                .seq,
            1,
            "with nothing on disk for this session the sequence starts over"
        );
    }

    #[test]
    fn a_fresh_file_for_an_unknown_session_is_kept_not_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        let path = write_drop(&dir, &drop_for(77, "Stop"), ms).unwrap();

        let mut state = DropDirState::new();
        for round in 0..3 {
            let out = run_pass(&dir, &mut state, ms + 1000, Pass::Steady, |_| {
                DropVerdict::NoSession
            });
            assert_eq!(out.kept, 1, "round {round}");
            assert_eq!(out.applied, 0);
            assert_eq!(out.collected, 0);
            assert!(
                path.exists(),
                "round {round}: an unapplied file must survive"
            );
        }

        let out = run_pass(&dir, &mut state, ms + 1000, Pass::Steady, |_| {
            DropVerdict::Applied
        });
        assert_eq!(out.applied, 1);
        assert!(!path.exists(), "an applied file is deleted");
    }

    #[test]
    fn a_file_whose_durable_write_failed_is_kept_and_retried() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let ms = 1_754_600_000_000;
        let path = write_drop(&dir, &drop_for(12, "SessionStart"), ms).unwrap();

        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, ms + 1000, Pass::Steady, |_| {
            DropVerdict::Retry
        });
        assert_eq!((out.applied, out.kept, out.collected), (0, 1, 0));
        assert!(
            path.exists(),
            "a failed durable write must not consume the file"
        );

        let out = run_pass(&dir, &mut state, ms + 2000, Pass::Steady, |_| {
            DropVerdict::Applied
        });
        assert_eq!(out.applied, 1);
        assert!(!path.exists());
    }

    #[test]
    fn the_seed_pass_applies_a_fresh_file_and_collects_a_stale_one() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        let now = 3 * MAX_AGE_MS;
        let stale = write_drop(&dir, &drop_for(1, "Stop"), now - MAX_AGE_MS - 1).unwrap();
        let fresh = write_drop(&dir, &drop_for(1, "UserPromptSubmit"), now - 1000).unwrap();

        let mut log = Vec::new();
        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, now, Pass::Seed, recorder(&mut log));

        assert_eq!(
            log,
            vec!["UserPromptSubmit".to_string()],
            "the stale Stop must never be applied — that is the pane marked Idle from a \
             three-day-old event"
        );
        assert_eq!(out.applied, 1);
        assert_eq!(out.collected, 1);
        assert!(!stale.exists(), "a stale file is collected");
        assert!(!fresh.exists(), "an applied file is deleted");
    }

    #[test]
    fn an_unparseable_name_is_never_deleted_and_warned_once() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        let foreign = dir.join("0000000000000-seed-primary-goal.json");
        std::fs::write(&foreign, "{}").unwrap();

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut state = DropDirState::new();
        tracing::subscriber::with_default(subscriber, || {
            for _ in 0..3 {
                let out = run_pass(&dir, &mut state, u64::MAX / 2, Pass::Steady, |_| {
                    panic!("an unparseable name must never be applied")
                });
                assert_eq!(out.collected, 0);
            }
        });
        assert!(
            foreign.exists(),
            "an unparseable name must never be deleted"
        );
        let logged = buf.text();
        assert_eq!(
            logged.matches("does not parse").count(),
            1,
            "warned once per daemon run, not once per pass: {logged}"
        );
        assert!(
            logged.contains("0000000000000-seed-primary-goal.json"),
            "the warning must name the file: {logged}"
        );

        assert_eq!(state.warned_len(), 1);
        std::fs::remove_file(&foreign).unwrap();
        run_pass(&dir, &mut state, 0, Pass::Steady, |_| DropVerdict::Applied);
        assert_eq!(
            state.warned_len(),
            0,
            "a vanished file takes its warn entry"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unlistable_directory_warns_and_reports_the_listing_failed() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        write_drop(&dir, &drop_for(1, "Stop"), 1_754_600_000_000).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_dir(&dir).is_ok() {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut state = DropDirState::new();
        let out = tracing::subscriber::with_default(subscriber, || {
            run_pass(&dir, &mut state, u64::MAX / 2, Pass::Steady, |_| {
                DropVerdict::Applied
            })
        });
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(!out.listed_ok, "a failed listing must be reported as such");
        assert_eq!((out.applied, out.collected, out.kept), (0, 0, 0));
        let logged = buf.text();
        assert!(
            logged.contains("not \"no hook events\""),
            "the warning must refuse the \"no hooks yet\" reading: {logged}"
        );
    }

    #[test]
    fn a_missing_directory_is_an_empty_pass_not_a_failed_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state = DropDirState::new();
        let out = run_pass(&drop_dir(tmp.path()), &mut state, 0, Pass::Steady, |_| {
            DropVerdict::Applied
        });
        assert!(out.listed_ok);
        assert_eq!((out.applied, out.collected, out.kept), (0, 0, 0));
    }

    #[test]
    fn a_future_shape_or_corrupt_payload_is_kept_and_never_applied() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        let ms = 1_754_600_000_000;
        let future = dir.join(drop_filename(ms, 1, 5));
        std::fs::write(&future, br#"{"v":99,"event":"Stop","session":5}"#).unwrap();
        let corrupt = dir.join(drop_filename(ms, 2, 5));
        std::fs::write(&corrupt, b"{ not json").unwrap();

        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, ms + 1, Pass::Steady, |_| {
            panic!("neither file may be applied")
        });
        assert_eq!(out.kept, 2);
        assert!(future.exists() && corrupt.exists());

        let out = run_pass(&dir, &mut state, ms + MAX_AGE_MS + 1, Pass::Steady, |_| {
            panic!("neither file may be applied")
        });
        assert_eq!(out.collected, 2);
        assert!(!future.exists() && !corrupt.exists());
    }

    #[test]
    fn a_payload_missing_every_optional_field_still_applies() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(drop_filename(1_754_600_000_000, 1, 8)),
            br#"{"v":1,"event":"Stop","session":8}"#,
        )
        .unwrap();
        let mut seen = None;
        let mut state = DropDirState::new();
        let out = run_pass(&dir, &mut state, 1_754_600_000_001, Pass::Steady, |d| {
            seen = Some(d.clone());
            DropVerdict::Applied
        });
        assert_eq!(out.applied, 1);
        let seen = seen.unwrap();
        assert_eq!(seen.event, "Stop");
        assert_eq!(seen.session, 8);
        assert_eq!(seen.cwd, None);
    }

    #[cfg(unix)]
    #[test]
    fn the_drop_dir_is_0700() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        write_drop(&dir, &drop_for(1, "Stop"), 1).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_drop_dir_is_refused_rather_than_chmodded_through() {
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &dir).unwrap();
        let err = write_drop(&dir, &drop_for(1, "Stop"), 1).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("symlink"), "{text}");
        assert!(text.contains("refusing to chmod through it"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_pre_block_6_drop_file_still_parses_and_means_claude() {
        let json =
            r#"{"v":1,"event":"Stop","session":7,"cwd":"/home/dev/p","native_session_id":"abc"}"#;
        let d: HookDrop = serde_json::from_str(json).expect("an older drop file must still parse");
        assert_eq!(
            d.agent, None,
            "absent means Claude — the daemon's own default"
        );
        assert_eq!(d.event, "Stop");
        assert_eq!(d.session, 7);

        let with_agent = HookDrop {
            resume_evidence: None,

            agent: Some("cursor".to_string()),
            ..drop_for(7, "stop")
        };
        let text = serde_json::to_string(&with_agent).expect("serialize");
        assert_eq!(
            serde_json::from_str::<HookDrop>(&text).expect("parse"),
            with_agent
        );
    }

    #[test]
    fn tmp_residue_is_swept_from_dead_writers_only_and_never_warned_about() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = drop_dir(tmp.path());
        write_drop(&dir, &drop_for(1, "Stop"), 1_754_600_000_000).unwrap();

        let dead_pid = {
            let mut stable_dead = None;
            for _ in 0..64 {
                let mut child = std::process::Command::new("true").spawn().unwrap();
                let pid = child.id();
                child.wait().unwrap();
                drop(child);
                if !crate::pid::process_is_alive(pid) {
                    stable_dead = Some(pid);
                    break;
                }
            }
            stable_dead.expect("a reaped pid that stayed unrecycled in 64 attempts")
        };
        let stale = dir.join(format!("hook{TMP_INFIX}{dead_pid}.{}", u64::MAX));
        std::fs::write(&stale, "junk").unwrap();
        let in_flight = dir.join(format!(
            "hook{TMP_INFIX}{}.{}",
            std::process::id(),
            u64::MAX - 1
        ));
        std::fs::write(&in_flight, "junk").unwrap();

        let mut state = DropDirState::new();
        run_pass(&dir, &mut state, 1_754_600_000_001, Pass::Steady, |_| {
            DropVerdict::Applied
        });
        assert_eq!(
            state.warned_len(),
            0,
            "a temp file is not an unparseable drop name"
        );

        write_drop(&dir, &drop_for(1, "Stop"), 1_754_600_000_002).unwrap();
        assert!(!stale.exists(), "residue from a dead writer must be swept");
        assert!(
            in_flight.exists(),
            "a temp file whose writer is still alive may be mid-link — it must survive"
        );
    }

    #[test]
    fn write_atomic_round_trips_through_the_parser() {
        let tmp = tempfile::tempdir().unwrap();
        let msg = crate::scope::MailMessage {
            id: crate::scope::gen_mailbox_id(),
            from: "Alice".to_string(),
            to: "Bob".to_string(),
            body: "hello".to_string(),
            kind: houston_protocol::SwarmMsgKind::Message,
            timestamp_ms: 1_700_000_000_123,
        };
        let name = crate::scope::mail_filename(&msg.id);
        write_atomic(tmp.path(), &name, &msg.to_bytes().unwrap()).unwrap();

        let bytes = std::fs::read(tmp.path().join(&name)).unwrap();
        let round_tripped = crate::scope::MailMessage::from_bytes(&bytes).unwrap();
        assert_eq!(round_tripped, msg);
    }

    #[test]
    fn write_atomic_temp_file_never_looks_like_a_finished_message() {
        let tmp = tempfile::tempdir().unwrap();
        let temp = tempfile::NamedTempFile::new_in(tmp.path()).unwrap();
        let name = temp.path().file_name().unwrap().to_str().unwrap();
        assert!(
            !name.ends_with(".json"),
            "temp file {name:?} must never end in .json — readers filter on that suffix"
        );
    }
}

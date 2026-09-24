use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const DROP_V: u32 = 1;

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
    // Antigravity PreToolUse/PostToolUse's toolCall.name. Only three names
    // open a block (ask_question, ask_permission, ask_custom_permission);
    // every other tool call is the agent working, not a human being asked.
    #[serde(default)]
    pub tool_name: Option<String>,
    // A provider may omit its tool-call ID from the permission event while
    // including the command in the later completion event. Keep only a
    // digest so command contents never enter daemon state or hook drops.
    #[serde(default)]
    pub tool_input_fingerprint: Option<String>,
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
            tool_name: None,
            tool_input_fingerprint: None,
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
    let dest = dir.join(name);
    tmp.persist(&dest)
        .map_err(|e| anyhow!("persisting {}: {}", dest.display(), e.error))?;
    Ok(())
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
    let bytes = serde_json::to_vec(drop).context("serializing the hook drop payload")?;
    let tmp = dir.join(format!(
        "hook{TMP_INFIX}{}.{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
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
}

impl DropDirState {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn warned_len(&self) -> usize {
        self.warned.len()
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PassOutcome {
    pub applied: usize,
    pub kept: usize,
    pub collected: usize,
    pub listed_ok: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    Seed,
    Steady,
}

// An unparseable name accumulates forever by design — the alternative is
// deleting a file Houston does not own — and is warned once, not per pass.
// A file older than MAX_AGE_MS is collected without applying; else applied.
pub fn run_pass(
    dir: &Path,
    state: &mut DropDirState,
    now_ms: u64,
    pass: Pass,
    mut apply: impl FnMut(&HookDrop) -> DropVerdict,
) -> PassOutcome {
    let mut out = PassOutcome::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.listed_ok = true;
            state.warned.clear();
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
    for entry in entries.flatten() {
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

    files.sort_by_key(|(n, _, _)| (n.ms, n.seq, n.session));

    for (parsed, path, name) in files {
        if now_ms.saturating_sub(parsed.ms) > MAX_AGE_MS {
            match std::fs::remove_file(&path) {
                Ok(()) => out.collected += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => out.collected += 1,
                Err(e) => {
                    tracing::warn!("hook drop pass: removing stale {}: {e}", path.display());
                    out.kept += 1;
                }
            }
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!("hook drop pass: reading {}: {e}", path.display());
                });
                out.kept += 1;
                continue;
            }
        };
        let drop = match serde_json::from_slice::<HookDrop>(&bytes) {
            Ok(d) if d.v == DROP_V => d,
            Ok(d) => {
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
            Err(e) => {
                warn_once(state, &mut present, &name, || {
                    tracing::warn!("hook drop pass: parsing {}: {e}", path.display());
                });
                out.kept += 1;
                continue;
            }
        };
        match apply(&drop) {
            DropVerdict::Applied => {
                if let Err(e) = std::fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!("hook drop pass: removing applied {}: {e}", path.display());
                    }
                }
                out.applied += 1;
            }
            DropVerdict::NoSession | DropVerdict::Retry => out.kept += 1,
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

//! The last PR status answered per directory, kept on disk so a restarted daemon
//! answers its first `pr_status` at once. A served entry is re-asked of gh straight
//! after, so this file is never the source of truth. See docs/internals/daemon.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use houston_protocol as proto;
use serde::{Deserialize, Serialize};

use crate::gh::PrStatus;

pub const FILE_NAME: &str = "pr-status-cache.json";

/// Bumped whenever an entry's shape changes; a file of any other version is discarded.
const VERSION: u32 = 1;
/// Matches gh's in-memory PR status cache, the largest practical set of open cards.
const MAX_ENTRIES: usize = 256;
/// 256 entries of PR metadata stay far below this; a larger file is refused unread.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Restarts this serves (update handoff, a fresh dev daemon, a crash) take seconds;
/// an answer older than an hour is more likely wrong than useful.
const MAX_AGE_MS: u64 = 60 * 60 * 1000;
/// Bounds rewrites to the in-memory cache's own TTL.
const WRITE_EVERY: Duration = Duration::from_secs(30);
/// An unchanged answer is rewritten only to keep its entry inside `MAX_AGE_MS`, so the
/// file is not rewritten every interval while a client polls.
const REFRESH_UNCHANGED_MS: u64 = MAX_AGE_MS / 2;

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    entries: Vec<StoredEntry>,
}

/// PR metadata and gh's readiness only: nothing here is a credential.
#[derive(Clone, Serialize, Deserialize)]
struct StoredEntry {
    dir: PathBuf,
    saved_ms: u64,
    gh: proto::GhState,
    has_upstream: bool,
    pr: Option<proto::PrInfo>,
    hint: Option<String>,
}

struct Entry {
    stored: StoredEntry,
    /// Loaded from the previous daemon and not yet served; cleared once served
    /// so the next request asks gh.
    seed: bool,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<PathBuf, Entry>,
    last_write: Option<Instant>,
    dirty: bool,
}

pub struct PrStatusStore {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl PrStatusStore {
    /// Never fails: a missing, oversized, corrupt or other-version file starts empty.
    pub fn load(path: PathBuf, now_ms: u64) -> Self {
        let mut inner = Inner::default();
        match read_file(&path) {
            Ok(Some(file)) if file.version == VERSION => {
                for stored in file.entries.into_iter().take(MAX_ENTRIES) {
                    if now_ms.saturating_sub(stored.saved_ms) <= MAX_AGE_MS {
                        let dir = stored.dir.clone();
                        inner.entries.insert(dir, Entry { stored, seed: true });
                    }
                }
            }
            Ok(Some(file)) => tracing::info!(
                "PR status cache {} has version {}, expected {VERSION}; starting empty",
                path.display(),
                file.version
            ),
            Ok(None) => {}
            Err(e) => tracing::warn!(
                "PR status cache {}: {e:#}; starting empty, gh answers rebuild it",
                path.display()
            ),
        }
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    /// The previous daemon's answer for `dir`, at most once and only while fresh.
    pub fn take_seed(&self, dir: &Path, now_ms: u64) -> Option<PrStatus> {
        let mut inner = self.inner.lock().expect("PR status store lock");
        let entry = inner.entries.get_mut(dir).filter(|e| e.seed)?;
        entry.seed = false;
        (now_ms.saturating_sub(entry.stored.saved_ms) <= MAX_AGE_MS)
            .then(|| to_status(&entry.stored))
    }

    /// Records gh's answer and rewrites the file when the last write is old enough.
    pub fn record(&self, dir: &Path, status: &PrStatus, now_ms: u64) {
        let mut inner = self.inner.lock().expect("PR status store lock");
        if let Some(entry) = inner.entries.get_mut(dir) {
            let unchanged = same_answer(&entry.stored, status);
            if unchanged && now_ms.saturating_sub(entry.stored.saved_ms) < REFRESH_UNCHANGED_MS {
                entry.seed = false;
                return;
            }
        }
        if inner.entries.len() >= MAX_ENTRIES && !inner.entries.contains_key(dir) {
            if let Some(oldest) = inner
                .entries
                .iter()
                .min_by_key(|(_, e)| e.stored.saved_ms)
                .map(|(dir, _)| dir.clone())
            {
                inner.entries.remove(&oldest);
            }
        }
        let stored = StoredEntry {
            dir: dir.to_path_buf(),
            saved_ms: now_ms,
            gh: status.gh,
            has_upstream: status.has_upstream,
            pr: status.pr.clone(),
            hint: status.hint.clone(),
        };
        inner.entries.insert(
            dir.to_path_buf(),
            Entry {
                stored,
                seed: false,
            },
        );
        inner.dirty = true;
        if inner
            .last_write
            .is_none_or(|at| at.elapsed() >= WRITE_EVERY)
        {
            self.write_locked(&mut inner);
        }
    }

    /// Writes pending answers regardless of the write interval; orderly shutdown calls it.
    pub fn flush(&self) {
        let mut inner = self.inner.lock().expect("PR status store lock");
        if inner.dirty {
            self.write_locked(&mut inner);
        }
    }

    fn write_locked(&self, inner: &mut Inner) {
        let mut entries: Vec<StoredEntry> =
            inner.entries.values().map(|e| e.stored.clone()).collect();
        entries.sort_by(|a, b| a.dir.cmp(&b.dir));
        inner.last_write = Some(Instant::now());
        match write_file(
            &self.path,
            &File {
                version: VERSION,
                entries,
            },
        ) {
            Ok(()) => inner.dirty = false,
            Err(e) => tracing::warn!(
                "writing the PR status cache {}: {e:#}; the next gh answer retries",
                self.path.display()
            ),
        }
    }
}

// `PrInfo` has no `PartialEq`; its JSON is the stored form, so equal JSON is the same entry.
fn same_answer(stored: &StoredEntry, status: &PrStatus) -> bool {
    let json = |status: &PrStatus| {
        serde_json::to_vec(&(status.gh, status.has_upstream, &status.pr, &status.hint)).ok()
    };
    json(&to_status(stored)).is_some_and(|a| Some(a) == json(status))
}

fn to_status(stored: &StoredEntry) -> PrStatus {
    PrStatus {
        gh: stored.gh,
        has_upstream: stored.has_upstream,
        pr: stored.pr.clone(),
        hint: stored.hint.clone(),
    }
}

fn read_file(path: &Path) -> Result<Option<File>> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("opening {}", path.display())),
    };
    let mut raw = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut raw)
        .with_context(|| format!("reading {}", path.display()))?;
    if raw.len() as u64 > MAX_FILE_BYTES {
        anyhow::bail!(
            "file exceeds the {MAX_FILE_BYTES}-byte limit (read at least {} bytes)",
            raw.len()
        );
    }
    serde_json::from_slice(&raw)
        .map(Some)
        .context("expected {\"version\": <n>, \"entries\": [...]}")
}

fn write_file(path: &Path, file: &File) -> Result<()> {
    use std::io::Write as _;
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating a temporary file in {}", parent.display()))?;
    serde_json::to_writer(tmp.as_file_mut(), file).context("serialising the cache")?;
    tmp.as_file_mut().flush()?;
    crate::fs_retry::persist(tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000_000;

    fn status(title: &str) -> PrStatus {
        PrStatus {
            gh: proto::GhState::Ready,
            has_upstream: true,
            pr: Some(proto::PrInfo {
                number: 7,
                url: "https://github.com/o/r/pull/7".into(),
                state: "OPEN".into(),
                title: title.into(),
                head_ref: "feature".into(),
                additions: 2,
                deletions: 1,
                is_draft: false,
                review_decision: None,
                checks: proto::PrChecks::None,
            }),
            hint: None,
        }
    }

    fn title(status: &PrStatus) -> &str {
        &status.pr.as_ref().expect("a PR").title
    }

    #[test]
    fn a_recorded_answer_seeds_the_next_daemon_once() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join(FILE_NAME);
        let dir = Path::new("/work/repo");

        let first = PrStatusStore::load(path.clone(), NOW);
        assert!(first.take_seed(dir, NOW).is_none(), "no file, no seed");
        first.record(dir, &status("Change"), NOW);
        assert!(path.is_file(), "the first answer is written at once");
        assert!(
            first.take_seed(dir, NOW).is_none(),
            "a daemon's own answers are not seeds"
        );

        let next = PrStatusStore::load(path, NOW + 5_000);
        let seed = next.take_seed(dir, NOW + 5_000).expect("seeded");
        assert_eq!(title(&seed), "Change");
        assert!(seed.has_upstream);
        assert!(
            next.take_seed(dir, NOW + 5_001).is_none(),
            "a seed is served once, then gh is asked"
        );
    }

    #[test]
    fn rewrites_wait_for_the_interval_and_flush_writes_the_rest() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join(FILE_NAME);
        let store = PrStatusStore::load(path.clone(), NOW);
        store.record(Path::new("/a"), &status("A"), NOW);
        store.record(Path::new("/b"), &status("B"), NOW);

        let seen = PrStatusStore::load(path.clone(), NOW);
        assert!(seen.take_seed(Path::new("/a"), NOW).is_some());
        assert!(
            seen.take_seed(Path::new("/b"), NOW).is_none(),
            "a second answer within the interval is not written yet"
        );

        store.flush();
        let flushed = PrStatusStore::load(path, NOW);
        assert_eq!(
            title(&flushed.take_seed(Path::new("/b"), NOW).unwrap()),
            "B"
        );
    }

    #[test]
    fn an_unchanged_answer_does_not_mark_the_file_for_rewrite() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join(FILE_NAME);
        let store = PrStatusStore::load(path, NOW);
        let dir = Path::new("/a");
        let dirty = || store.inner.lock().unwrap().dirty;
        store.record(dir, &status("A"), NOW);
        assert!(!dirty(), "the first answer is written at once");

        store.record(dir, &status("A"), NOW + 30_000);
        assert!(!dirty(), "a repeated answer leaves nothing to write");
        store.record(dir, &status("A, renamed"), NOW + 31_000);
        assert!(dirty(), "a changed answer is written");
        store.flush();
        store.record(
            dir,
            &status("A, renamed"),
            NOW + 31_000 + REFRESH_UNCHANGED_MS,
        );
        assert!(
            dirty(),
            "an unchanged answer is refreshed before it ages out"
        );
    }

    #[test]
    fn stale_other_version_corrupt_and_oversized_files_start_empty() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join(FILE_NAME);
        let dir = Path::new("/work/repo");
        PrStatusStore::load(path.clone(), NOW).record(dir, &status("Change"), NOW);

        let stale = PrStatusStore::load(path.clone(), NOW + MAX_AGE_MS + 1);
        assert!(
            stale.take_seed(dir, NOW + MAX_AGE_MS + 1).is_none(),
            "too old"
        );

        let raw = std::fs::read_to_string(&path).unwrap();
        let bumped = raw.replacen("\"version\":1", "\"version\":2", 1);
        assert_ne!(raw, bumped);
        std::fs::write(&path, bumped).unwrap();
        assert!(PrStatusStore::load(path.clone(), NOW)
            .take_seed(dir, NOW)
            .is_none());

        std::fs::write(&path, b"{not json").unwrap();
        assert!(PrStatusStore::load(path.clone(), NOW)
            .take_seed(dir, NOW)
            .is_none());

        std::fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(PrStatusStore::load(path, NOW).take_seed(dir, NOW).is_none());
    }

    #[test]
    fn the_store_is_bounded_by_evicting_the_oldest_answer() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join(FILE_NAME);
        let store = PrStatusStore::load(path.clone(), NOW);
        for i in 0..=MAX_ENTRIES as u64 {
            store.record(Path::new(&format!("/repo/{i}")), &status("x"), NOW + i);
        }
        store.flush();

        let raw = std::fs::read_to_string(&path).unwrap();
        let file: File = serde_json::from_str(&raw).unwrap();
        assert_eq!(file.entries.len(), MAX_ENTRIES);
        assert!(
            !file.entries.iter().any(|e| e.dir == Path::new("/repo/0")),
            "the oldest answer is evicted"
        );
    }
}

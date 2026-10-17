//! Pull request reads shared by the pane PR watches and the task PR watch, and
//! the daemon-wide pause a GitHub rate limit imposes on them.

use super::{PrDetail, PullRequestLink, PullRequestLinkSource, PullRequestState};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// Just under `PR_WATCH_INTERVAL_MS`, so the task watch reuses a pane watch read
/// from the current minute and never one a newer tick has superseded.
pub const SHARED_READ_TTL_MS: i64 = 55_000;
/// Bounds memory when many pull requests are watched at once.
pub const SHARED_READ_MAX_ENTRIES: usize = 256;
/// GitHub asks for at least a minute after a secondary limit without a
/// `retry-after` header, which gh does not print; five watch intervals keep
/// repeated limits from escalating.
pub const RATE_LIMIT_FALLBACK_PAUSE_MS: i64 = 5 * 60_000;
/// GitHub's primary budgets reset hourly; a later reset is not one of them.
pub const RATE_LIMIT_MAX_PAUSE_MS: i64 = 61 * 60_000;

type Key = (String, u32);
type Outcome = Result<(PullRequestLink, PrDetail), String>;

struct Entry {
    read_at_ms: i64,
    state: PullRequestState,
    head_ref: Option<String>,
    cross_repository: bool,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<Key, Entry>,
    paused_until_ms: Option<i64>,
}

#[derive(Default)]
pub struct SharedReads {
    inner: Mutex<Inner>,
}

/// One watch tick: each (repository, number) is read at most once and the
/// outcome, success or failure, is handed to every watch of it.
#[derive(Default)]
pub struct Tick {
    memo: HashMap<Key, Outcome>,
}

pub enum Read {
    Done(Box<Outcome>),
    Paused { until_ms: i64 },
}

/// The repository's `owner/name` when the link has one, else the directory the
/// read runs in, so a URL-less link still shares within its own checkout.
fn key(repository: &str, dir: &Path, number: u32) -> Key {
    let repository = if repository.is_empty() {
        dir.display().to_string()
    } else {
        repository.to_ascii_lowercase()
    };
    (repository, number)
}

/// What the watch states show while reads are paused.
pub fn pause_text(until_ms: i64) -> String {
    format!(
        "GitHub rate limit reached; pull request reads are paused until {}",
        crate::usage::time::local_clock_from_ms(until_ms)
    )
}

fn pause_end(now_ms: i64, reset: anyhow::Result<Option<i64>>) -> i64 {
    match reset {
        Ok(Some(reset_ms)) if reset_ms - now_ms > RATE_LIMIT_MAX_PAUSE_MS => {
            tracing::warn!(
                "gh api rate_limit reported a reset at {reset_ms} ms, {} s ahead; expected at most {} s, so reads pause for that long",
                (reset_ms - now_ms) / 1_000,
                RATE_LIMIT_MAX_PAUSE_MS / 1_000
            );
            now_ms + RATE_LIMIT_MAX_PAUSE_MS
        }
        Ok(Some(reset_ms)) => reset_ms,
        Ok(None) => now_ms + RATE_LIMIT_FALLBACK_PAUSE_MS,
        Err(e) => {
            tracing::warn!(
                "reading GitHub's rate-limit reset: {e:#}; reads pause for {} s",
                RATE_LIMIT_FALLBACK_PAUSE_MS / 1_000
            );
            now_ms + RATE_LIMIT_FALLBACK_PAUSE_MS
        }
    }
}

impl SharedReads {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("shared PR reads poisoned")
    }

    /// The end of the current rate-limit pause; an elapsed pause is cleared.
    pub fn paused_until(&self, now_ms: i64) -> Option<i64> {
        let mut inner = self.lock();
        match inner.paused_until_ms {
            Some(until) if until > now_ms => Some(until),
            Some(_) => {
                inner.paused_until_ms = None;
                None
            }
            None => None,
        }
    }

    /// Pauses every read until GitHub's reset, or the bounded fallback when gh
    /// names none, and returns the end of the pause.
    pub fn pause(
        &self,
        now_ms: i64,
        reason: &str,
        reset: impl FnOnce() -> anyhow::Result<Option<i64>>,
    ) -> i64 {
        let until = pause_end(now_ms, reset());
        let mut inner = self.lock();
        let until = inner.paused_until_ms.unwrap_or(until).max(until);
        inner.paused_until_ms = Some(until);
        drop(inner);
        tracing::warn!("{} ({reason})", pause_text(until));
        until
    }

    /// One pull request read through the tick: answered from the tick when
    /// another watch already read it, refused while reads are paused, and a
    /// rate-limit failure pauses reads instead of failing the watch.
    pub fn tick_read(
        &self,
        tick: &mut Tick,
        dir: &Path,
        number: u32,
        source: PullRequestLinkSource,
        existing: Option<&PullRequestLink>,
        now_ms: i64,
    ) -> Read {
        let repository = existing.map(|l| l.repository.as_str()).unwrap_or_default();
        self.tick_read_with(
            tick,
            key(repository, dir, number),
            dir,
            now_ms,
            || super::read(dir, Some(number), source, existing).map_err(|e| format!("{e:#}")),
            || crate::gh::rate_limit_reset(dir, now_ms),
        )
    }

    /// A read by repository and number, for a reader with no stored link (the
    /// merge queue): keyed like a watch of the same pull request, so one tick
    /// reads it once for both.
    pub fn tick_read_repository(
        &self,
        tick: &mut Tick,
        dir: &Path,
        repository: &str,
        number: u32,
        now_ms: i64,
    ) -> Read {
        self.tick_read_with(
            tick,
            key(repository, dir, number),
            dir,
            now_ms,
            || {
                super::read(dir, Some(number), PullRequestLinkSource::Manual, None)
                    .map_err(|e| format!("{e:#}"))
            },
            || crate::gh::rate_limit_reset(dir, now_ms),
        )
    }

    fn tick_read_with(
        &self,
        tick: &mut Tick,
        key: Key,
        dir: &Path,
        now_ms: i64,
        read: impl FnOnce() -> Outcome,
        reset: impl FnOnce() -> anyhow::Result<Option<i64>>,
    ) -> Read {
        if let Some(outcome) = tick.memo.get(&key) {
            return Read::Done(Box::new(outcome.clone()));
        }
        if let Some(until_ms) = self.paused_until(now_ms) {
            return Read::Paused { until_ms };
        }
        let outcome = read();
        match &outcome {
            Err(e) if crate::gh::is_rate_limited(e) => {
                return Read::Paused {
                    until_ms: self.pause(now_ms, e, reset),
                };
            }
            Ok((link, detail)) => {
                // The core read landed, so its result stands; a limit hit by the
                // GraphQL enrichment still stops the reads that follow.
                if let Some(message) = [&detail.viewer_message, &detail.threads_message]
                    .into_iter()
                    .flatten()
                    .find(|m| crate::gh::is_rate_limited(m))
                {
                    self.pause(now_ms, message, reset);
                }
                self.record(link, detail, dir, now_ms);
            }
            Err(_) => {}
        }
        tick.memo.insert(key, outcome.clone());
        Read::Done(Box::new(outcome))
    }

    fn record(&self, link: &PullRequestLink, detail: &PrDetail, dir: &Path, now_ms: i64) {
        let key = key(&link.repository, dir, link.number);
        let mut inner = self.lock();
        inner
            .entries
            .retain(|_, e| now_ms - e.read_at_ms < SHARED_READ_TTL_MS);
        if inner.entries.len() >= SHARED_READ_MAX_ENTRIES && !inner.entries.contains_key(&key) {
            if let Some(oldest) = inner
                .entries
                .iter()
                .min_by_key(|(_, e)| e.read_at_ms)
                .map(|(k, _)| k.clone())
            {
                inner.entries.remove(&oldest);
            }
        }
        inner.entries.insert(
            key,
            Entry {
                read_at_ms: now_ms,
                state: link.state,
                head_ref: detail.head_ref.clone(),
                cross_repository: detail.cross_repository,
            },
        );
    }

    /// The number and state of `repository`'s pull request from its own
    /// `branch`, when a watch read it within the TTL. A fork's branch of the
    /// same name is a different pull request, so cross-repository reads never match.
    pub fn branch_state(
        &self,
        repository: &str,
        branch: &str,
        now_ms: i64,
    ) -> Option<(u32, PullRequestState)> {
        let repository = repository.to_ascii_lowercase();
        self.lock()
            .entries
            .iter()
            .filter(|((repo, _), e)| {
                *repo == repository
                    && now_ms - e.read_at_ms < SHARED_READ_TTL_MS
                    && !e.cross_repository
                    && e.head_ref.as_deref() == Some(branch)
            })
            .map(|((_, number), e)| (*number, e.state))
            .max_by_key(|(number, _)| *number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pull_requests::watch::tests::{detail, link};
    use std::cell::Cell;

    const NOW: i64 = 10_000_000;

    fn found(state: PullRequestState) -> Outcome {
        Ok((link(state), detail("abc")))
    }

    fn no_reset() -> anyhow::Result<Option<i64>> {
        panic!("only a rate limit asks for the reset")
    }

    #[test]
    fn one_tick_reads_each_pull_request_once_and_the_next_tick_reads_again() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            found(PullRequestState::Open)
        };
        let mut tick = Tick::default();
        for _ in 0..3 {
            let k = key("Owner/Repo", dir, 12);
            assert!(matches!(
                shared.tick_read_with(&mut tick, k, dir, NOW, read, no_reset),
                Read::Done(o) if o.is_ok()
            ));
        }
        assert_eq!(reads.get(), 1, "three watches of one PR share one read");
        let other = key("owner/repo", Path::new("/elsewhere"), 12);
        shared.tick_read_with(&mut tick, other, dir, NOW, read, no_reset);
        assert_eq!(
            reads.get(),
            1,
            "the repository, not the checkout, names the PR"
        );

        let mut next = Tick::default();
        shared.tick_read_with(
            &mut next,
            key("owner/repo", dir, 12),
            dir,
            NOW,
            read,
            no_reset,
        );
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn a_failed_read_is_shared_within_the_tick() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            Err("HTTP 404: Not Found".to_string())
        };
        let mut tick = Tick::default();
        for _ in 0..2 {
            let k = key("owner/repo", dir, 12);
            assert!(matches!(
                shared.tick_read_with(&mut tick, k, dir, NOW, read, no_reset),
                Read::Done(o) if o.as_ref().as_ref().is_err_and(|e| e.contains("404"))
            ));
        }
        assert_eq!(reads.get(), 1);
        assert_eq!(shared.paused_until(NOW), None);
    }

    #[test]
    fn a_rate_limit_pauses_every_read_until_the_reset_then_reads_resume() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        let reset_at = NOW + 120_000;
        let mut tick = Tick::default();
        let limited = shared.tick_read_with(
            &mut tick,
            key("owner/repo", dir, 12),
            dir,
            NOW,
            || Err("GraphQL: API rate limit exceeded for user ID 1.".into()),
            || Ok(Some(reset_at)),
        );
        assert!(matches!(limited, Read::Paused { until_ms } if until_ms == reset_at));

        let reads = Cell::new(0);
        let read = || {
            reads.set(reads.get() + 1);
            found(PullRequestState::Open)
        };
        let mut paused_tick = Tick::default();
        let other = key("owner/repo", dir, 13);
        assert!(matches!(
            shared.tick_read_with(&mut paused_tick, other, dir, reset_at - 1, read, no_reset),
            Read::Paused { until_ms } if until_ms == reset_at
        ));
        assert_eq!(reads.get(), 0, "no read reaches gh while paused");

        let mut resumed = Tick::default();
        let k = key("owner/repo", dir, 12);
        assert!(matches!(
            shared.tick_read_with(&mut resumed, k, dir, reset_at, read, no_reset),
            Read::Done(o) if o.is_ok()
        ));
        assert_eq!(reads.get(), 1);
        assert_eq!(shared.paused_until(reset_at), None);
    }

    #[test]
    fn a_pause_without_a_usable_reset_is_bounded() {
        assert_eq!(
            pause_end(NOW, Ok(None)),
            NOW + RATE_LIMIT_FALLBACK_PAUSE_MS,
            "a secondary limit exhausts no budget"
        );
        assert_eq!(
            pause_end(NOW, Err(anyhow::anyhow!("gh api rate_limit failed"))),
            NOW + RATE_LIMIT_FALLBACK_PAUSE_MS
        );
        assert_eq!(
            pause_end(NOW, Ok(Some(NOW + 10 * RATE_LIMIT_MAX_PAUSE_MS))),
            NOW + RATE_LIMIT_MAX_PAUSE_MS
        );
        let shared = SharedReads::default();
        shared.pause(NOW, "first", || Ok(Some(NOW + 600_000)));
        assert_eq!(
            shared.pause(NOW, "second", || Ok(None)),
            NOW + 600_000,
            "a shorter second pause never shortens the first"
        );
    }

    #[test]
    fn a_rate_limited_enrichment_keeps_its_read_and_pauses_the_rest() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        let mut read = detail("abc");
        read.threads_message =
            Some("could not read the review threads of PR #12: API rate limit exceeded".into());
        let mut tick = Tick::default();
        let outcome = shared.tick_read_with(
            &mut tick,
            key("owner/repo", dir, 12),
            dir,
            NOW,
            || Ok((link(PullRequestState::Open), read)),
            || Ok(Some(NOW + 60_000)),
        );
        assert!(matches!(outcome, Read::Done(o) if o.is_ok()));
        assert_eq!(shared.paused_until(NOW), Some(NOW + 60_000));
    }

    #[test]
    fn the_task_watch_finds_a_fresh_same_repository_read_by_branch() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        let mut tick = Tick::default();
        shared.tick_read_with(
            &mut tick,
            key("owner/repo", dir, 12),
            dir,
            NOW,
            || found(PullRequestState::Merged),
            no_reset,
        );
        assert_eq!(
            shared.branch_state("Owner/Repo", "feature", NOW + 1),
            Some((12, PullRequestState::Merged))
        );
        assert_eq!(shared.branch_state("owner/repo", "other", NOW), None);
        assert_eq!(shared.branch_state("owner/fork", "feature", NOW), None);
        assert_eq!(
            shared.branch_state("owner/repo", "feature", NOW + SHARED_READ_TTL_MS),
            None,
            "a read from a previous tick window is not reused"
        );

        let mut fork = detail("abc");
        fork.cross_repository = true;
        let mut forked = link(PullRequestState::Open);
        forked.number = 13;
        let mut tick = Tick::default();
        shared.tick_read_with(
            &mut tick,
            key("owner/repo", dir, 13),
            dir,
            NOW,
            || Ok((forked, fork)),
            no_reset,
        );
        assert_eq!(
            shared.branch_state("owner/repo", "feature", NOW),
            Some((12, PullRequestState::Merged)),
            "a fork's same-named branch is another pull request"
        );
    }

    #[test]
    fn the_shared_reads_stay_within_their_cap() {
        let shared = SharedReads::default();
        let dir = Path::new("/work");
        for number in 1..=(SHARED_READ_MAX_ENTRIES as u32 + 10) {
            let mut l = link(PullRequestState::Open);
            l.number = number;
            shared.record(&l, &detail("abc"), dir, NOW + i64::from(number));
        }
        assert_eq!(shared.lock().entries.len(), SHARED_READ_MAX_ENTRIES);
        assert!(!shared
            .lock()
            .entries
            .contains_key(&key("owner/repo", dir, 1)));
    }
}

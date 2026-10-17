//! The merge queue's model: queue order, the enqueue checks and the gates each
//! entry must pass. The daemon wiring (reads, verbs, broadcasts) lives in
//! `daemon/merge_queue.rs`; nothing here touches GitHub or the database.

use anyhow::{bail, Result};
use houston_protocol as proto;
use std::collections::HashSet;

/// One persisted queue entry, in enqueue order until `order` sorts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueRow {
    pub workspace: String,
    pub number: u32,
    pub repository: String,
    pub url: String,
    pub title: Option<String>,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: Option<String>,
    pub depends_on: Option<u32>,
    pub session_id: Option<u32>,
    pub position: i64,
    pub enqueued_at_ms: i64,
    pub facts: Option<Facts>,
}

/// What the latest GitHub read said about an entry: the inputs of the two
/// GitHub gates. A failed read keeps no earlier answer, so the gates fail closed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Facts {
    pub read_at_ms: i64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub merge_disabled_reason: Option<String>,
    /// Unresolved review threads among those read; `None` when they could not be read.
    #[serde(default)]
    pub unresolved_threads: Option<u32>,
    #[serde(default)]
    pub threads_message: Option<String>,
    #[serde(default)]
    pub threads_truncated: bool,
}

impl Facts {
    pub fn from_read(detail: &proto::PrDetail, now_ms: i64) -> Self {
        let unresolved = detail.threads.iter().filter(|t| !t.resolved).count();
        Facts {
            read_at_ms: now_ms,
            error: None,
            merge_disabled_reason: detail.merge_disabled_reason.clone(),
            unresolved_threads: detail
                .threads_message
                .is_none()
                .then(|| u32::try_from(unresolved).unwrap_or(u32::MAX)),
            threads_message: detail.threads_message.clone(),
            threads_truncated: detail.threads_truncated,
        }
    }

    pub fn from_error(error: String, now_ms: i64) -> Self {
        Facts {
            read_at_ms: now_ms,
            error: Some(error),
            merge_disabled_reason: None,
            unresolved_threads: None,
            threads_message: None,
            threads_truncated: false,
        }
    }

    /// The same answer, whenever it was read: a re-read that changed nothing
    /// is not a change worth broadcasting.
    pub fn same_answer(&self, other: &Facts) -> bool {
        Facts {
            read_at_ms: 0,
            ..self.clone()
        } == Facts {
            read_at_ms: 0,
            ..other.clone()
        }
    }
}

/// What the task backlog says about the reviewer gate of one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Review {
    /// The pull request is not a task Slice's; the gate does not apply.
    NotSlice,
    /// The Slice's key and the state of its newest review run, if any.
    Slice {
        key: String,
        state: Option<proto::TaskRunState>,
    },
    /// The backlog could not be read; the gate fails closed.
    Unreadable(String),
}

/// A full 40-character hex commit, the only head a merge may be pinned to.
pub fn valid_head_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Queue order: FIFO by position, except that an entry waits behind the entry
/// it depends on. Enqueue refuses cycles, so the fallback for one only keeps a
/// corrupt database from hiding entries.
pub fn order(mut rows: Vec<QueueRow>) -> Vec<QueueRow> {
    rows.sort_by_key(|r| r.position);
    let mut ordered = Vec::with_capacity(rows.len());
    while !rows.is_empty() {
        let waiting: HashSet<u32> = rows.iter().map(|r| r.number).collect();
        let next = rows
            .iter()
            .position(|r| r.depends_on.is_none_or(|d| !waiting.contains(&d)))
            .unwrap_or(0);
        ordered.push(rows.remove(next));
    }
    ordered
}

/// Refuses an enqueue that would overfill the queue, depend on an entry that
/// is not queued, or form a dependency cycle. Re-enqueueing a queued pull
/// request replaces its `depends_on` and keeps its place.
pub fn check_enqueue(
    entries: &[QueueRow],
    workspace: &str,
    number: u32,
    depends_on: Option<u32>,
    max: u32,
) -> Result<()> {
    let queued = entries.iter().any(|e| e.number == number);
    let count = entries.len();
    if !queued && count >= max as usize {
        bail!(
            "the merge queue of {workspace} is full: it holds {count} entries and its limit is {max}; refusing to enqueue PR #{number}"
        );
    }
    let Some(dependency) = depends_on else {
        return Ok(());
    };
    if dependency == number {
        bail!("PR #{number} cannot depend on itself: depends_on forms the cycle #{number} → #{number}");
    }
    if !entries.iter().any(|e| e.number == dependency) {
        bail!(
            "depends_on names PR #{dependency}, which is not in the merge queue of {workspace}; enqueue #{dependency} first"
        );
    }
    let mut chain = vec![number, dependency];
    let mut cursor = dependency;
    while let Some(next) = entries
        .iter()
        .find(|e| e.number == cursor)
        .and_then(|e| e.depends_on)
    {
        chain.push(next);
        if next == number {
            let chain = chain
                .iter()
                .map(|n| format!("#{n}"))
                .collect::<Vec<_>>()
                .join(" → ");
            bail!("PR #{number} cannot depend on #{dependency}: that forms the cycle {chain}");
        }
        if chain.len() > entries.len() + 1 {
            break;
        }
        cursor = next;
    }
    Ok(())
}

fn gate(
    kind: proto::MergeQueueGateKind,
    failure: Option<String>,
    applies: bool,
) -> proto::MergeQueueGate {
    let state = match (applies, &failure) {
        (false, _) => proto::MergeQueueGateState::NotApplicable,
        (true, None) => proto::MergeQueueGateState::Passed,
        (true, Some(_)) => proto::MergeQueueGateState::Failed,
    };
    proto::MergeQueueGate {
        kind,
        state,
        reason: failure,
    }
}

/// The three gates, in the order the page lists them. Each fails closed: an
/// input that has not been read, or could not be, fails with that fact.
pub fn gates(row: &QueueRow, review: &Review) -> Vec<proto::MergeQueueGate> {
    let number = row.number;
    let unread = |facts: &Option<Facts>| -> Option<String> {
        match facts {
            None => Some(format!("PR #{number} has not been read from GitHub yet")),
            Some(Facts { error: Some(e), .. }) => {
                Some(format!("could not read PR #{number} from GitHub: {e}"))
            }
            Some(_) => None,
        }
    };
    let mergeable = unread(&row.facts).or_else(|| {
        row.facts
            .as_ref()
            .and_then(|f| f.merge_disabled_reason.clone())
    });
    let threads =
        unread(&row.facts).or_else(|| {
            let facts = row.facts.as_ref()?;
            match facts.unresolved_threads {
                None => Some(facts.threads_message.clone().unwrap_or_else(|| {
                    format!("could not read the review threads of PR #{number}")
                })),
                Some(0) if facts.threads_truncated => Some(format!(
                    "PR #{number} has more review threads than Houston reads; check them on GitHub"
                )),
                Some(0) => None,
                Some(1) => Some(format!("PR #{number} has 1 unresolved review thread")),
                Some(n) => Some(format!("PR #{number} has {n} unresolved review threads")),
            }
        });
    let reviewer = match review {
        Review::NotSlice => None,
        Review::Unreadable(e) => Some(format!(
            "could not read the task backlog for PR #{number}'s reviewer verdict: {e}"
        )),
        Review::Slice { key, state } => match state {
            Some(proto::TaskRunState::HandedBack) => None,
            None => Some(format!("{key} has no reviewer verdict yet")),
            Some(
                proto::TaskRunState::Preparing
                | proto::TaskRunState::Running
                | proto::TaskRunState::WaitingForInput
                | proto::TaskRunState::Validating,
            ) => Some(format!("{key}'s review is still running")),
            Some(proto::TaskRunState::NeedsReview) => {
                Some(format!("{key}'s newest reviewer verdict is not pass"))
            }
            Some(
                proto::TaskRunState::Failed
                | proto::TaskRunState::Cancelled
                | proto::TaskRunState::Interrupted,
            ) => Some(format!("{key}'s newest review ended without a verdict")),
        },
    };
    vec![
        gate(proto::MergeQueueGateKind::Mergeable, mergeable, true),
        gate(proto::MergeQueueGateKind::ReviewThreads, threads, true),
        gate(
            proto::MergeQueueGateKind::Reviewer,
            reviewer,
            !matches!(review, Review::NotSlice),
        ),
    ]
}

/// One entry as the wire carries it, with its single blocking reason: a
/// dependency that left without merging first, then the first failed gate.
pub fn entry(
    row: &QueueRow,
    position: u32,
    queued: &HashSet<u32>,
    review: &Review,
) -> proto::MergeQueueEntry {
    let gates = gates(row, review);
    let dependency = row
        .depends_on
        .filter(|d| !queued.contains(d))
        .map(|d| format!("depends on #{d}, which left the queue without merging"));
    let reason = dependency.or_else(|| gates.iter().find_map(|g| g.reason.clone()));
    proto::MergeQueueEntry {
        number: row.number,
        repository: row.repository.clone(),
        url: row.url.clone(),
        title: row.title.clone(),
        head_ref: row.head_ref.clone(),
        head_sha: row.head_sha.clone(),
        base_ref: row.base_ref.clone(),
        depends_on: row.depends_on,
        session: row.session_id,
        position,
        enqueued_at_ms: row.enqueued_at_ms,
        read_at_ms: row.facts.as_ref().map(|f| f.read_at_ms),
        status: if reason.is_some() {
            proto::MergeQueueStatus::Blocked
        } else {
            proto::MergeQueueStatus::Ready
        },
        reason,
        gates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(number: u32, position: i64, depends_on: Option<u32>) -> QueueRow {
        QueueRow {
            workspace: "/work".into(),
            number,
            repository: "owner/repo".into(),
            url: format!("https://github.com/owner/repo/pull/{number}"),
            title: None,
            head_ref: format!("houston/{number}"),
            head_sha: "a".repeat(40),
            base_ref: Some("main".into()),
            depends_on,
            session_id: None,
            position,
            enqueued_at_ms: position,
            facts: Some(Facts {
                read_at_ms: 1,
                error: None,
                merge_disabled_reason: None,
                unresolved_threads: Some(0),
                threads_message: None,
                threads_truncated: false,
            }),
        }
    }

    fn numbers(rows: &[QueueRow]) -> Vec<u32> {
        rows.iter().map(|r| r.number).collect()
    }

    #[test]
    fn order_is_fifo_and_an_entry_waits_behind_its_dependency() {
        let rows = vec![row(13, 2, None), row(12, 1, Some(14)), row(14, 3, None)];
        assert_eq!(numbers(&order(rows)), [13, 14, 12]);
        let rows = vec![row(3, 3, None), row(1, 1, None), row(2, 2, None)];
        assert_eq!(numbers(&order(rows)), [1, 2, 3]);
    }

    #[test]
    fn a_dependency_outside_the_queue_does_not_hold_an_entry_back() {
        let rows = vec![row(12, 1, Some(99)), row(13, 2, None)];
        assert_eq!(numbers(&order(rows)), [12, 13]);
    }

    #[test]
    fn enqueue_refuses_a_full_queue_with_limit_count_and_operation() {
        let entries: Vec<_> = (1..=3).map(|n| row(n, i64::from(n), None)).collect();
        let err = check_enqueue(&entries, "/work", 9, None, 3)
            .unwrap_err()
            .to_string();
        assert!(err.contains("holds 3 entries"), "{err}");
        assert!(err.contains("limit is 3"), "{err}");
        assert!(err.contains("enqueue PR #9"), "{err}");
        check_enqueue(&entries, "/work", 2, None, 3).expect("a queued PR may re-enqueue");
    }

    #[test]
    fn enqueue_refuses_unknown_dependencies_and_cycles_by_name() {
        let entries = vec![row(12, 1, None), row(13, 2, Some(12))];
        let unknown = check_enqueue(&entries, "/work", 14, Some(99), 32)
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("#99"), "{unknown}");
        let own = check_enqueue(&entries, "/work", 14, Some(14), 32)
            .unwrap_err()
            .to_string();
        assert!(own.contains("#14 → #14"), "{own}");
        let cycle = check_enqueue(&entries, "/work", 12, Some(13), 32)
            .unwrap_err()
            .to_string();
        assert!(cycle.contains("#12 → #13 → #12"), "{cycle}");
        check_enqueue(&entries, "/work", 14, Some(13), 32).unwrap();
    }

    #[test]
    fn gates_fail_closed_before_a_read_and_after_a_failed_one() {
        let mut unread = row(12, 1, None);
        unread.facts = None;
        let e = entry(&unread, 1, &HashSet::new(), &Review::NotSlice);
        assert_eq!(e.status, proto::MergeQueueStatus::Blocked);
        assert!(e.reason.unwrap().contains("not been read"));

        let mut failed = row(12, 1, None);
        failed.facts = Some(Facts::from_error("HTTP 502".into(), 5));
        let e = entry(&failed, 1, &HashSet::new(), &Review::NotSlice);
        assert!(e.reason.unwrap().contains("HTTP 502"));
        assert!(e
            .gates
            .iter()
            .take(2)
            .all(|g| g.state == proto::MergeQueueGateState::Failed));
    }

    #[test]
    fn exactly_one_reason_names_the_first_failed_gate() {
        let mut blocked = row(12, 1, None);
        let facts = blocked.facts.as_mut().unwrap();
        facts.merge_disabled_reason = Some("PR #12 has 1 failing check: build".into());
        facts.unresolved_threads = Some(2);
        let e = entry(&blocked, 1, &HashSet::new(), &Review::NotSlice);
        assert_eq!(
            e.reason.as_deref(),
            Some("PR #12 has 1 failing check: build")
        );
        assert_eq!(
            e.gates[1].reason.as_deref(),
            Some("PR #12 has 2 unresolved review threads")
        );
        assert_eq!(e.gates[2].state, proto::MergeQueueGateState::NotApplicable);

        let ready = entry(&row(13, 2, None), 2, &HashSet::new(), &Review::NotSlice);
        assert_eq!(ready.status, proto::MergeQueueStatus::Ready);
        assert_eq!(ready.reason, None);
    }

    #[test]
    fn unreadable_or_truncated_threads_block() {
        let mut r = row(12, 1, None);
        r.facts.as_mut().unwrap().unresolved_threads = None;
        r.facts.as_mut().unwrap().threads_message = Some("GraphQL timed out".into());
        let e = entry(&r, 1, &HashSet::new(), &Review::NotSlice);
        assert_eq!(e.reason.as_deref(), Some("GraphQL timed out"));
        let mut r = row(12, 1, None);
        r.facts.as_mut().unwrap().threads_truncated = true;
        let e = entry(&r, 1, &HashSet::new(), &Review::NotSlice);
        assert!(e.reason.unwrap().contains("more review threads"));
    }

    #[test]
    fn a_slice_needs_its_newest_review_to_pass() {
        let r = row(12, 1, None);
        let slice = |state| Review::Slice {
            key: "HOU-7".into(),
            state,
        };
        let reason = |review: Review| entry(&r, 1, &HashSet::new(), &review).reason;
        assert_eq!(reason(slice(Some(proto::TaskRunState::HandedBack))), None);
        assert!(reason(slice(None)).unwrap().contains("no reviewer verdict"));
        assert!(reason(slice(Some(proto::TaskRunState::Running)))
            .unwrap()
            .contains("still running"));
        assert!(reason(slice(Some(proto::TaskRunState::NeedsReview)))
            .unwrap()
            .contains("not pass"));
        assert!(reason(Review::Unreadable("locked".into()))
            .unwrap()
            .contains("locked"));
    }

    #[test]
    fn a_dependency_that_left_without_merging_blocks_its_dependent() {
        let r = row(13, 2, Some(12));
        let e = entry(&r, 1, &HashSet::from([13]), &Review::NotSlice);
        assert_eq!(
            e.reason.as_deref(),
            Some("depends on #12, which left the queue without merging")
        );
        let waiting = entry(&r, 2, &HashSet::from([12, 13]), &Review::NotSlice);
        assert_eq!(waiting.reason, None);
    }

    #[test]
    fn only_a_full_hex_sha_pins_a_merge() {
        assert!(valid_head_sha(&"a1".repeat(20)));
        assert!(!valid_head_sha("abc1234"));
        assert!(!valid_head_sha(&"z".repeat(40)));
    }
}

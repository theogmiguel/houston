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
    /// The last passed verification; it holds only while `verification_holds` says so.
    pub verification: Option<proto::MergeQueueVerification>,
    /// The last failure; it keeps the entry out of line only for the head it names.
    pub failure: Option<proto::MergeQueueFailure>,
    /// The dependency that merged ahead of this entry, as it last stood.
    pub stacked: Option<Stacked>,
    /// What was handed to GitHub; it holds only for the head it names.
    pub github: Option<proto::MergeQueueGitHubHold>,
}

/// A merged dependency as the queue last saw it: the head its dependents may
/// still carry, the branch they may target and the base it merged into.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Stacked {
    pub number: u32,
    pub head_sha: String,
    pub head_ref: String,
    #[serde(default)]
    pub base_ref: Option<String>,
}

impl Stacked {
    pub fn of(row: &QueueRow) -> Self {
        Stacked {
            number: row.number,
            head_sha: row.head_sha.clone(),
            head_ref: row.head_ref.clone(),
            base_ref: base_of(row).map(str::to_string),
        }
    }
}

/// The branch an entry lands on. A dependent whose pull request still targets
/// its merged dependency's branch lands where that dependency merged.
pub fn base_of(row: &QueueRow) -> Option<&str> {
    match &row.stacked {
        Some(s) if row.base_ref.as_deref() == Some(s.head_ref.as_str()) => {
            s.base_ref.as_deref().or(row.base_ref.as_deref())
        }
        _ => row.base_ref.as_deref(),
    }
}

/// The pull request still targets its merged dependency's branch: it is
/// retargeted to the base before the queue pushes or merges it.
pub fn needs_retarget(row: &QueueRow) -> Option<&str> {
    let s = row.stacked.as_ref()?;
    (row.base_ref.as_deref() == Some(s.head_ref.as_str()))
        .then_some(s.base_ref.as_deref())
        .flatten()
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
    /// Checks GitHub reports failing on the head, by name.
    #[serde(default)]
    pub failing_checks: Vec<String>,
    /// The repository's merge method the queue uses: squash when allowed.
    #[serde(default)]
    pub merge_method: Option<proto::PrMergeMethod>,
    #[serde(default)]
    pub github_merge: Option<proto::PrGitHubMerge>,
    /// Whether GitHub reports auto-merge armed; `None` when the read could not say.
    #[serde(default)]
    pub auto_merge_on: Option<bool>,
    /// GitHub reported the pull request merged while GitHub owned it; the runner
    /// finishes the landing.
    #[serde(default)]
    pub merged: bool,
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
            failing_checks: detail
                .checks
                .iter()
                .filter(|c| c.state == proto::PrCheckState::Failing)
                .map(|c| c.name.clone())
                .collect(),
            merge_method: preferred_method(&detail.merge_methods),
            github_merge: detail.github_merge.clone(),
            auto_merge_on: detail.github_merge.as_ref().and(detail.auto_merge_enabled),
            merged: false,
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
            failing_checks: Vec::new(),
            merge_method: None,
            github_merge: None,
            auto_merge_on: None,
            merged: false,
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

/// Who merges, by the read: GitHub's merge queue where the base requires it, auto-merge
/// where it is allowed and the base requires checks, else Houston. `None` when GitHub hid
/// whether a merge queue applies; the caller keeps what it knew, Houston by default.
pub fn hand_off_from(facts: &Facts) -> Option<proto::MergeQueueHandOff> {
    let gm = facts.github_merge.as_ref()?;
    match gm.merge_queue_required? {
        true => Some(proto::MergeQueueHandOff::MergeQueue),
        false
            if gm.auto_merge_allowed == Some(true)
                && gm.required_checks.as_ref().is_some_and(|c| !c.is_empty()) =>
        {
            Some(proto::MergeQueueHandOff::AutoMerge)
        }
        false => Some(proto::MergeQueueHandOff::Houston),
    }
}

/// The hand-off an entry lands through: its own read's answer, else the
/// workspace's cached one for the same base, else Houston.
pub fn hand_off_mode(
    row: &QueueRow,
    cached: Option<&proto::MergeQueueHandOffInfo>,
) -> proto::MergeQueueHandOff {
    let from_read = row.facts.as_ref().and_then(hand_off_from);
    let cached = cached
        .filter(|c| c.base_ref.as_deref() == base_of(row))
        .map(|c| c.mode);
    from_read
        .or(cached)
        .unwrap_or(proto::MergeQueueHandOff::Houston)
}

/// What GitHub holds for `row`: the hand-off of its current head.
pub fn github_holds(row: &QueueRow) -> Option<&proto::MergeQueueGitHubHold> {
    row.github.as_ref().filter(|g| g.head_sha == row.head_sha)
}

fn watching_reason(row: &QueueRow, hold: &proto::MergeQueueGitHubHold) -> String {
    match hold.mode {
        proto::MergeQueueHandOff::AutoMerge => format!(
            "Auto-merge is on for {}; GitHub merges once required checks pass",
            short_sha(&hold.head_sha)
        ),
        _ => match row
            .facts
            .as_ref()
            .and_then(|f| f.github_merge.as_ref())
            .and_then(|g| g.queue_entry.as_ref())
            .and_then(|q| q.position)
        {
            Some(position) => format!("In GitHub's merge queue (position {position})"),
            None => "In GitHub's merge queue".to_string(),
        },
    }
}

/// The repository's allowed method the queue merges with: squash first, then a
/// merge commit, then rebase. `None` when the read could not say.
pub fn preferred_method(allowed: &[proto::PrMergeMethod]) -> Option<proto::PrMergeMethod> {
    [
        proto::PrMergeMethod::Squash,
        proto::PrMergeMethod::Merge,
        proto::PrMergeMethod::Rebase,
    ]
    .into_iter()
    .find(|m| allowed.contains(m))
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

/// The verification that still holds for `row`: made for its current head, or
/// for the verified commit the queue pushed as its head, on its current base branch.
pub fn verification_holds(row: &QueueRow) -> Option<&proto::MergeQueueVerification> {
    row.verification.as_ref().filter(|v| {
        (v.head_sha == row.head_sha || v.verified_sha == row.head_sha)
            && base_of(row) == Some(v.base_ref.as_str())
    })
}

/// The failure that keeps `row` out of line: one recorded for its current head.
/// A new head re-enters the line on its own.
pub fn failure_holds(row: &QueueRow) -> Option<&proto::MergeQueueFailure> {
    row.failure.as_ref().filter(|f| f.head_sha == row.head_sha)
}

/// What the line depends on besides the rows themselves.
#[derive(Debug, Clone, Default)]
pub struct LineContext {
    pub settings: Option<proto::MergeQueueSettings>,
    /// Why the queue is paused, naming the workspace or global pause.
    pub paused: Option<String>,
    /// The entry of this workspace being verified now, and since when.
    pub running: Option<(u32, i64)>,
    /// The Houston-managed worktree of each branch, for a hand-off pane.
    pub worktrees: std::collections::HashMap<String, String>,
    /// Why this daemon cannot verify the workspace at all.
    pub refusal: Option<String>,
}

impl LineContext {
    fn command_set(&self) -> bool {
        self.settings
            .as_ref()
            .is_some_and(|s| !s.verification_command.trim().is_empty())
    }
}

pub fn short_sha(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn verification_gate(
    row: &QueueRow,
    rank: Option<u32>,
    ctx: &LineContext,
) -> proto::MergeQueueGate {
    let (state, reason) = if !ctx.command_set() {
        (
            proto::MergeQueueGateState::NotApplicable,
            "No verification command is set".to_string(),
        )
    } else if let Some(refusal) = &ctx.refusal {
        (proto::MergeQueueGateState::Failed, refusal.clone())
    } else if let Some(v) = verification_holds(row) {
        (
            proto::MergeQueueGateState::Passed,
            format!("Verified on {}@{}", v.base_ref, short_sha(&v.base_sha)),
        )
    } else if ctx.running.is_some_and(|(n, _)| n == row.number) {
        (
            proto::MergeQueueGateState::Pending,
            "Verifying now".to_string(),
        )
    } else if let Some(f) = failure_holds(row) {
        (proto::MergeQueueGateState::Failed, f.message.clone())
    } else if rank == Some(1) {
        (
            proto::MergeQueueGateState::Pending,
            "Runs once the verification slot is free".to_string(),
        )
    } else {
        (
            proto::MergeQueueGateState::Pending,
            "Runs when it is first in line".to_string(),
        )
    };
    proto::MergeQueueGate {
        kind: proto::MergeQueueGateKind::Verification,
        state,
        reason: Some(reason),
    }
}

/// The workspace's entries as the wire carries them, from rows in queue order. Parked and
/// fixing entries, and those waiting behind one, are out of line with position 0; the
/// rest rank from 1, the head. Each carries one status and at most one blocking reason.
pub fn line(
    rows: &[QueueRow],
    reviews: &[Review],
    ctx: &LineContext,
) -> Vec<proto::MergeQueueEntry> {
    let queued: HashSet<u32> = rows.iter().map(|r| r.number).collect();
    let mut held: std::collections::HashMap<u32, &'static str> = Default::default();
    let mut rank = 0u32;
    let mut entries = Vec::with_capacity(rows.len());
    for (row, review) in rows.iter().zip(reviews) {
        let mut gates = gates(row, review);
        let failure = failure_holds(row).cloned();
        let holder = row
            .depends_on
            .and_then(|d| held.get(&d).map(|why| (d, *why)));
        let (status, reason, position) = if let Some(f) = &failure {
            let (status, why) = if f.handed_to.is_some() {
                (proto::MergeQueueStatus::Fixing, "being fixed")
            } else {
                (proto::MergeQueueStatus::Parked, "parked")
            };
            held.insert(row.number, why);
            (status, Some(f.message.clone()), 0)
        } else if let Some((dependency, why)) = holder {
            held.insert(row.number, why);
            (
                proto::MergeQueueStatus::Blocked,
                Some(format!("waits for #{dependency}, which is {why}")),
                0,
            )
        } else if let Some(hold) = github_holds(row) {
            rank += 1;
            (
                proto::MergeQueueStatus::Watching,
                Some(watching_reason(row, hold)),
                rank,
            )
        } else {
            rank += 1;
            let dependency = row
                .depends_on
                .filter(|d| !queued.contains(d))
                .map(|d| format!("depends on #{d}, which left the queue without merging"));
            let blocked = dependency
                .or_else(|| gates.iter().find_map(|g| g.reason.clone()))
                .or_else(|| ctx.refusal.clone().filter(|_| ctx.command_set()));
            let needs_verification = ctx.command_set() && verification_holds(row).is_none();
            let status = match &blocked {
                Some(_) => proto::MergeQueueStatus::Blocked,
                None if ctx.running.is_some_and(|(n, _)| n == row.number) => {
                    proto::MergeQueueStatus::Verifying
                }
                None if rank == 1 && ctx.paused.is_some() => proto::MergeQueueStatus::Paused,
                None if rank == 1 && needs_verification => proto::MergeQueueStatus::WaitingForSlot,
                None => proto::MergeQueueStatus::Ready,
            };
            let reason = match status {
                proto::MergeQueueStatus::Paused => ctx.paused.clone(),
                _ => blocked,
            };
            (status, reason, rank)
        };
        gates.push(verification_gate(
            row,
            (position > 0).then_some(position),
            ctx,
        ));
        entries.push(proto::MergeQueueEntry {
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
            verifying_since_ms: (status == proto::MergeQueueStatus::Verifying)
                .then(|| ctx.running.map(|(_, at)| at))
                .flatten(),
            status,
            reason,
            gates,
            verification: verification_holds(row).cloned(),
            failure,
            worktree: ctx.worktrees.get(&row.head_ref).cloned(),
            github: github_holds(row).cloned(),
        });
    }
    entries
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
                failing_checks: Vec::new(),
                merge_method: None,
                github_merge: None,
                auto_merge_on: None,
                merged: false,
            }),
            verification: None,
            failure: None,
            stacked: None,
            github: None,
        }
    }

    fn entry(row: &QueueRow, review: &Review) -> proto::MergeQueueEntry {
        line(
            std::slice::from_ref(row),
            std::slice::from_ref(review),
            &LineContext::default(),
        )
        .remove(0)
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
        let e = entry(&unread, &Review::NotSlice);
        assert_eq!(e.status, proto::MergeQueueStatus::Blocked);
        assert!(e.reason.unwrap().contains("not been read"));

        let mut failed = row(12, 1, None);
        failed.facts = Some(Facts::from_error("HTTP 502".into(), 5));
        let e = entry(&failed, &Review::NotSlice);
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
        let e = entry(&blocked, &Review::NotSlice);
        assert_eq!(
            e.reason.as_deref(),
            Some("PR #12 has 1 failing check: build")
        );
        assert_eq!(
            e.gates[1].reason.as_deref(),
            Some("PR #12 has 2 unresolved review threads")
        );
        assert_eq!(e.gates[2].state, proto::MergeQueueGateState::NotApplicable);

        let ready = entry(&row(13, 2, None), &Review::NotSlice);
        assert_eq!(ready.status, proto::MergeQueueStatus::Ready);
        assert_eq!(ready.reason, None);
    }

    #[test]
    fn unreadable_or_truncated_threads_block() {
        let mut r = row(12, 1, None);
        r.facts.as_mut().unwrap().unresolved_threads = None;
        r.facts.as_mut().unwrap().threads_message = Some("GraphQL timed out".into());
        let e = entry(&r, &Review::NotSlice);
        assert_eq!(e.reason.as_deref(), Some("GraphQL timed out"));
        let mut r = row(12, 1, None);
        r.facts.as_mut().unwrap().threads_truncated = true;
        let e = entry(&r, &Review::NotSlice);
        assert!(e.reason.unwrap().contains("more review threads"));
    }

    #[test]
    fn a_slice_needs_its_newest_review_to_pass() {
        let r = row(12, 1, None);
        let slice = |state| Review::Slice {
            key: "HOU-7".into(),
            state,
        };
        let reason = |review: Review| entry(&r, &review).reason;
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
        let e = entry(&r, &Review::NotSlice);
        assert_eq!(
            e.reason.as_deref(),
            Some("depends on #12, which left the queue without merging")
        );
        let both = [row(12, 1, None), r];
        let waiting = line(
            &both,
            &[Review::NotSlice, Review::NotSlice],
            &LineContext::default(),
        );
        assert_eq!(waiting[1].reason, None);
    }

    #[test]
    fn the_hand_off_follows_the_read_and_never_guesses_from_an_unknown() {
        let mut r = row(12, 1, None);
        let tools = |required, allowed, checks: Option<Vec<String>>| proto::PrGitHubMerge {
            merge_queue_required: required,
            auto_merge_allowed: allowed,
            required_checks: checks,
            ..Default::default()
        };
        let mode = |r: &QueueRow, cached| hand_off_mode(r, cached);
        assert_eq!(mode(&r, None), proto::MergeQueueHandOff::Houston);
        r.facts.as_mut().unwrap().github_merge = Some(tools(Some(true), None, None));
        assert_eq!(mode(&r, None), proto::MergeQueueHandOff::MergeQueue);
        let ci = Some(vec!["ci".to_string()]);
        r.facts.as_mut().unwrap().github_merge = Some(tools(Some(false), Some(true), ci));
        assert_eq!(mode(&r, None), proto::MergeQueueHandOff::AutoMerge);
        r.facts.as_mut().unwrap().github_merge = Some(tools(Some(false), Some(true), None));
        assert_eq!(
            mode(&r, None),
            proto::MergeQueueHandOff::Houston,
            "auto-merge without required checks would merge at once"
        );
        let learned = proto::MergeQueueHandOffInfo {
            mode: proto::MergeQueueHandOff::MergeQueue,
            base_ref: Some("main".into()),
            read_at_ms: 1,
            from_refusal: true,
        };
        r.facts.as_mut().unwrap().github_merge = Some(tools(None, None, None));
        assert_eq!(mode(&r, Some(&learned)), proto::MergeQueueHandOff::MergeQueue);
        r.base_ref = Some("release".into());
        assert_eq!(
            mode(&r, Some(&learned)),
            proto::MergeQueueHandOff::Houston,
            "a lesson about another base does not apply"
        );
    }

    #[test]
    fn a_dependent_targeting_its_merged_dependency_lands_on_that_base() {
        let mut r = row(13, 1, None);
        r.base_ref = Some("houston/12".into());
        assert_eq!(base_of(&r), Some("houston/12"));
        r.stacked = Some(Stacked {
            number: 12,
            head_sha: "b".repeat(40),
            head_ref: "houston/12".into(),
            base_ref: Some("main".into()),
        });
        assert_eq!(base_of(&r), Some("main"));
        assert_eq!(needs_retarget(&r), Some("main"));
        r.base_ref = Some("main".into());
        assert_eq!(base_of(&r), Some("main"));
        assert_eq!(needs_retarget(&r), None);
    }

    #[test]
    fn only_a_full_hex_sha_pins_a_merge() {
        assert!(valid_head_sha(&"a1".repeat(20)));
        assert!(!valid_head_sha("abc1234"));
        assert!(!valid_head_sha(&"z".repeat(40)));
    }
}

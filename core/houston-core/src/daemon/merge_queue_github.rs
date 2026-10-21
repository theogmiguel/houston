//! The merge queue's hand-off to GitHub: its merge queue or auto-merge takes the verified
//! head, the shared reads watch it, GitHub's merge finishes the landing and anything else
//! takes the failure path. See docs/internals/daemon.md.
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use houston_protocol as proto;

use super::merge_queue_runner::{log_row, Failed, Landing};
use super::{now_unix_ms, Daemon};
use crate::merge_queue::{self as mq, QueueRow, Stacked};
use crate::merge_queue_verify as verify;
use crate::pull_requests::shared::{pause_text, Read};

/// GitHub's clock and this machine's may differ; a removal this close before
/// the hand-off still names why GitHub let the head go.
const CLOCK_SKEW_MS: i64 = 60_000;

pub(super) fn hand_off_name(mode: proto::MergeQueueHandOff) -> &'static str {
    match mode {
        proto::MergeQueueHandOff::MergeQueue => "GitHub's merge queue",
        proto::MergeQueueHandOff::AutoMerge => "GitHub's auto-merge",
        proto::MergeQueueHandOff::Houston => "Houston",
    }
}

/// GitHub reports the request against the commit that was handed off.
fn confirmed(row: &QueueRow, hold: &proto::MergeQueueGitHubHold) -> bool {
    let Some(facts) = row.facts.as_ref().filter(|f| f.error.is_none()) else {
        return false;
    };
    match hold.mode {
        proto::MergeQueueHandOff::MergeQueue => facts
            .github_merge
            .as_ref()
            .and_then(|g| g.queue_entry.as_ref())
            .is_some_and(|q| {
                q.head_sha.as_deref().unwrap_or(&row.head_sha) == hold.head_sha
                    && row.head_sha == hold.head_sha
            }),
        proto::MergeQueueHandOff::AutoMerge => {
            facts.auto_merge_on == Some(true) && row.head_sha == hold.head_sha
        }
        proto::MergeQueueHandOff::Houston => false,
    }
}

/// Why GitHub let a held head go, if it did, from a read made after the hand-off.
fn let_go(row: &QueueRow, hold: &proto::MergeQueueGitHubHold) -> Option<Failed> {
    let facts = row
        .facts
        .as_ref()
        .filter(|f| f.error.is_none() && f.read_at_ms > hold.at_ms)?;
    let github = facts.github_merge.as_ref()?;
    let short = mq::short_sha(&hold.head_sha);
    let name = hand_off_name(hold.mode);
    if !facts.failing_checks.is_empty() {
        return Some(Failed {
            kind: proto::MergeQueueFailureKind::ChecksFailed,
            message: format!(
                "GitHub's checks failed on {short}, the commit handed to {name}: {}",
                facts.failing_checks.join(", ")
            ),
            files: Vec::new(),
            output_tail: None,
            base_sha: Some(hold.base_sha.clone()),
        });
    }
    let reason = github
        .removal
        .as_ref()
        .filter(|r| r.at_ms + CLOCK_SKEW_MS >= hold.at_ms)
        .map(|r| r.reason.clone());
    let message = match hold.mode {
        proto::MergeQueueHandOff::MergeQueue if github.queue_entry.is_none() => match reason {
            Some(reason) => format!("GitHub's merge queue removed PR #{}: {reason}", row.number),
            None => format!(
                "GitHub's merge queue no longer lists PR #{} at {short}",
                row.number
            ),
        },
        proto::MergeQueueHandOff::AutoMerge if facts.auto_merge_on == Some(false) => match reason {
            Some(reason) => format!(
                "GitHub turned auto-merge off for PR #{}: {reason}",
                row.number
            ),
            None => format!(
                "GitHub no longer reports auto-merge on for PR #{} at {short}",
                row.number
            ),
        },
        _ => return None,
    };
    Some(Failed {
        kind: proto::MergeQueueFailureKind::Ejected,
        message,
        files: Vec::new(),
        output_tail: None,
        base_sha: Some(hold.base_sha.clone()),
    })
}

impl Daemon {
    /// Moves a pull request that still targets its merged dependency's branch
    /// onto the base that dependency merged into, and logs it.
    pub(super) fn merge_queue_retarget(
        self: &Arc<Self>,
        workspace: &str,
        row: &QueueRow,
        base: &str,
        unattended: bool,
    ) -> Result<()> {
        let from = row.base_ref.clone().unwrap_or_default();
        if let Err(e) = crate::gh::pr_edit_base(Path::new(workspace), row.number, base) {
            let e = anyhow!(
                "could not retarget PR #{} from {from} to {base}: {e:#}",
                row.number
            );
            if unattended {
                self.merge_queue_fail(workspace, row, Failed::refused(format!("{e:#}")), true)?;
            }
            return Err(e);
        }
        self.db.merge_queue_log_record(
            workspace,
            &log_row(row, proto::MergeQueueLogKind::Retarget, unattended, |e| {
                e.ref_name = Some(base.to_string());
                e.detail = Some(format!("Retargeted from {from}"));
            }),
        )?;
        tracing::info!(
            "merge queue: retargeted PR #{} from {from} to {base}",
            row.number
        );
        Ok(())
    }

    /// Hands the verified head to GitHub instead of merging it, then confirms
    /// with one read that GitHub reports the request against that commit.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn merge_queue_hand_off(
        self: &Arc<Self>,
        workspace: &str,
        repository: &str,
        row: &QueueRow,
        mode: proto::MergeQueueHandOff,
        target: &str,
        method: proto::PrMergeMethod,
        base_ref: Option<&str>,
        base_before: Option<&str>,
        unattended: bool,
    ) -> Result<Landing> {
        let root = Path::new(workspace);
        let number = row.number;
        let name = hand_off_name(mode);
        let short = mq::short_sha(target);
        let base_ref = base_ref.ok_or_else(|| {
            anyhow!("GitHub reported no base branch for PR #{number}; it was not handed to {name}")
        })?;
        let sent = match mode {
            proto::MergeQueueHandOff::MergeQueue => {
                crate::gh::pr_enqueue(root, repository, number, target)
            }
            _ => {
                let out = crate::gh::pr_merge_auto(root, number, target, method);
                match out.ok {
                    true => Ok(()),
                    false => Err(anyhow!(
                        "GitHub refused auto-merge for PR #{number} at {short}: {}",
                        out.message
                            .unwrap_or_else(|| "gh gave no reason".to_string())
                    )),
                }
            }
        };
        if let Err(e) = sent {
            if unattended {
                self.merge_queue_fail(workspace, row, Failed::refused(format!("{e:#}")), true)?;
            }
            return Err(e);
        }
        let hold = proto::MergeQueueGitHubHold {
            mode,
            head_sha: target.to_string(),
            base_ref: base_ref.to_string(),
            base_sha: base_before.unwrap_or_default().to_string(),
            method: (mode == proto::MergeQueueHandOff::AutoMerge).then_some(method),
            unattended,
            at_ms: now_unix_ms(),
        };
        self.db
            .merge_queue_set_github(workspace, number, Some(&hold))?;
        self.db.merge_queue_log_record(
            workspace,
            &log_row(row, proto::MergeQueueLogKind::HandOff, unattended, |e| {
                e.ref_name = Some(base_ref.to_string());
                e.head_sha = Some(target.to_string());
                e.method = hold.method;
                e.detail = Some(match mode {
                    proto::MergeQueueHandOff::AutoMerge => format!(
                        "Auto-merge on with a {} merge",
                        super::merge_queue::method_name(method)
                    ),
                    _ => "Added to GitHub's merge queue".to_string(),
                });
            }),
        )?;
        let current = |daemon: &Self| -> Result<Option<QueueRow>> {
            Ok(daemon
                .db
                .merge_queue_entries(workspace)?
                .into_iter()
                .find(|r| r.number == number))
        };
        let outcome = match self.merge_queue_read_fresh(root, repository, number) {
            Read::Done(outcome) => *outcome,
            Read::Paused { until_ms } => {
                self.broadcast_merge_queue(workspace);
                return Ok(Landing::HandedOff(format!(
                    "handed PR #{number} to {name} at {short}; {}, so a later read confirms it",
                    pause_text(until_ms)
                )));
            }
        };
        if let Some(read) = current(self)? {
            self.merge_queue_apply_read(read, outcome)?;
        }
        let Some(read) = current(self)? else {
            self.broadcast_merge_queue(workspace);
            return Ok(Landing::Waiting(format!(
                "PR #{number} left the merge queue of {workspace} after it was handed to {name}"
            )));
        };
        if read.facts.as_ref().is_some_and(|f| f.merged) {
            return self
                .merge_queue_github_merged(workspace, &read)
                .map(Landing::Merged);
        }
        if !confirmed(&read, &hold) {
            if let Err(e) = self.merge_queue_cancel_github(&read, &hold) {
                tracing::warn!("merge queue: taking PR #{number} back from {name}: {e:#}");
            }
            self.db.merge_queue_set_github(workspace, number, None)?;
            let message = format!(
                "GitHub did not report PR #{number} in {name} at {short} after Houston handed it off; it was taken back"
            );
            self.merge_queue_fail(
                workspace,
                &read,
                Failed::refused(message.clone()),
                unattended,
            )?;
            return Err(anyhow!("{message}"));
        }
        self.broadcast_merge_queue(workspace);
        Ok(Landing::HandedOff(format!(
            "handed PR #{number} to {name} at {short}; Houston watches it there"
        )))
    }

    /// Settles what GitHub owns in `workspace` from the latest reads: a merge
    /// finishes the landing, a new head takes the hand-off back, and a head
    /// GitHub let go takes the failure path. Returns whether anything moved.
    pub(super) fn merge_queue_watch_github(self: &Arc<Self>, workspace: &str) -> Result<bool> {
        let mut moved = self.merge_queue_take_back_moved(workspace)?;
        for row in self.db.merge_queue_entries(workspace)? {
            let Some(hold) = row.github.clone() else {
                continue;
            };
            if row.facts.as_ref().is_some_and(|f| f.merged) {
                let text = self.merge_queue_github_merged(workspace, &row)?;
                tracing::info!("merge queue: {text}");
                return Ok(true);
            }
            if row.head_sha != hold.head_sha {
                continue;
            }
            let Some(failed) = let_go(&row, &hold) else {
                continue;
            };
            if let Err(e) = self.merge_queue_cancel_github(&row, &hold) {
                tracing::warn!(
                    "merge queue: taking PR #{} back from {}: {e:#}",
                    row.number,
                    hand_off_name(hold.mode)
                );
            }
            self.db
                .merge_queue_set_github(workspace, row.number, None)?;
            self.merge_queue_fail(workspace, &row, failed, hold.unattended)?;
            moved = true;
        }
        Ok(moved)
    }

    /// Takes back every hand-off of `workspace` whose head moved, so GitHub never
    /// merges a head Houston did not verify. The PR watch's read pass calls it too,
    /// so a verification holding the runner never delays it. Returns whether any moved.
    pub(super) fn merge_queue_take_back_moved(&self, workspace: &str) -> Result<bool> {
        let _one = self
            .merge_queue_take_back
            .lock()
            .expect("merge queue take-back lock");
        let mut moved = false;
        for row in self.db.merge_queue_entries(workspace)? {
            let Some(hold) = row.github.clone() else {
                continue;
            };
            if row.head_sha == hold.head_sha || row.facts.as_ref().is_some_and(|f| f.merged) {
                continue;
            }
            if let Err(e) = self.merge_queue_cancel_github(&row, &hold) {
                tracing::warn!(
                    "merge queue: PR #{} moved to {}; taking it back from {}: {e:#}",
                    row.number,
                    row.head_sha,
                    hand_off_name(hold.mode)
                );
                continue;
            }
            self.db
                .merge_queue_set_github(workspace, row.number, None)?;
            tracing::info!(
                "merge queue: PR #{} moved to {}; took it back from {} and it re-enters the line",
                row.number,
                row.head_sha,
                hand_off_name(hold.mode)
            );
            moved = true;
        }
        if moved {
            self.broadcast_merge_queue(workspace);
        }
        Ok(moved)
    }

    /// Takes a hand-off back: out of GitHub's merge queue, or auto-merge off.
    /// What GitHub already reports gone needs nothing.
    pub(super) fn merge_queue_cancel_github(
        &self,
        row: &QueueRow,
        hold: &proto::MergeQueueGitHubHold,
    ) -> Result<()> {
        let root = Path::new(&row.workspace);
        let facts = row.facts.as_ref().filter(|f| f.error.is_none());
        match hold.mode {
            proto::MergeQueueHandOff::MergeQueue => {
                let queued = facts
                    .and_then(|f| f.github_merge.as_ref())
                    .map(|g| g.queue_entry.is_some());
                if queued == Some(false) {
                    return Ok(());
                }
                crate::gh::pr_dequeue(root, &row.repository, row.number)
            }
            proto::MergeQueueHandOff::AutoMerge => {
                if facts.and_then(|f| f.auto_merge_on) == Some(false) {
                    return Ok(());
                }
                crate::gh::pr_disable_auto(root, row.number)
            }
            proto::MergeQueueHandOff::Houston => Ok(()),
        }
    }

    /// Takes back every hand-off of `workspace` (one entry's with `number`),
    /// for a pause or a dequeue. Returns the entries taken back.
    pub(super) fn merge_queue_release_github(
        &self,
        workspace: &str,
        number: Option<u32>,
    ) -> Result<Vec<u32>> {
        let mut released = Vec::new();
        for row in self.db.merge_queue_entries(workspace)? {
            if number.is_some_and(|n| n != row.number) {
                continue;
            }
            let Some(hold) = row.github.clone() else {
                continue;
            };
            self.merge_queue_cancel_github(&row, &hold).map_err(|e| {
                anyhow!(
                    "could not take PR #{} back from {}: {e:#}; it stays queued so GitHub's side is not left behind",
                    row.number,
                    hand_off_name(hold.mode)
                )
            })?;
            self.db
                .merge_queue_set_github(workspace, row.number, None)?;
            released.push(row.number);
        }
        Ok(released)
    }

    /// GitHub merged a head it owned: Houston's own after-merge steps run, as
    /// for a merge it made.
    pub(super) fn merge_queue_github_merged(
        self: &Arc<Self>,
        workspace: &str,
        row: &QueueRow,
    ) -> Result<String> {
        let hold = row
            .github
            .clone()
            .ok_or_else(|| anyhow!("PR #{} has no hand-off to GitHub to finish", row.number))?;
        let root = Path::new(workspace);
        self.db.merge_queue_remove(workspace, row.number)?;
        self.db
            .merge_queue_clear_dependency(workspace, row.number, Some(&Stacked::of(row)))?;
        let base_after = crate::git::remote_name(root).and_then(|remote| {
            verify::fetch(root, &remote, &[&hold.base_ref])
                .and_then(|()| verify::remote_sha(root, &remote, &hold.base_ref))
                .map_err(|e| {
                    tracing::warn!(
                        "merge queue: fetching {} after GitHub merged PR #{}: {e:#}",
                        hold.base_ref,
                        row.number
                    )
                })
                .ok()
        });
        let method = hold
            .method
            .or_else(|| row.facts.as_ref().and_then(|f| f.merge_method));
        self.db.merge_queue_log_record(
            workspace,
            &log_row(row, proto::MergeQueueLogKind::Merge, hold.unattended, |e| {
                e.ref_name = Some(hold.base_ref.clone());
                e.old_sha = Some(hold.base_sha.clone()).filter(|s| !s.is_empty());
                e.new_sha = base_after.clone();
                e.head_sha = Some(hold.head_sha.clone());
                e.method = method;
                e.detail = Some(format!("Merged by {}", hand_off_name(hold.mode)));
            }),
        )?;
        self.merge_queue_after_merge(workspace, row, Some(&hold.base_ref), base_after.as_deref());
        self.worktree_cleanup_notify.notify_one();
        self.broadcast_merge_queue(workspace);
        self.merge_queue_wake.notify_one();
        Ok(format!(
            "{} merged PR #{} at {}; the next entry is now first",
            hand_off_name(hold.mode),
            row.number,
            mq::short_sha(&hold.head_sha)
        ))
    }

    /// GitHub refused Houston's own merge because the base requires its merge
    /// queue: the cached path learns it, so the next landing hands off.
    pub(super) fn merge_queue_learn_refusal(
        &self,
        workspace: &str,
        row: &QueueRow,
        e: &anyhow::Error,
    ) {
        if !format!("{e:#}")
            .to_ascii_lowercase()
            .contains("merge queue")
        {
            return;
        }
        let info = proto::MergeQueueHandOffInfo {
            mode: proto::MergeQueueHandOff::MergeQueue,
            base_ref: mq::base_of(row).map(str::to_string),
            read_at_ms: now_unix_ms(),
            from_refusal: true,
        };
        if let Err(e) = self.db.merge_queue_set_hand_off(workspace, &info) {
            tracing::warn!("merge queue: caching the hand-off of {workspace}: {e:#}");
        }
    }

    /// Refreshes the workspace's cached hand-off path from a read that already
    /// happened. A read that cannot say leaves the cache, and so a refusal's
    /// lesson, as it is.
    pub(super) fn merge_queue_note_hand_off(&self, row: &QueueRow) {
        let Some(mode) = row.facts.as_ref().and_then(mq::hand_off_from) else {
            return;
        };
        let base_ref = mq::base_of(row).map(str::to_string);
        let cached = self.db.merge_queue_hand_off(&row.workspace).ok().flatten();
        if cached
            .as_ref()
            .is_some_and(|c| c.base_ref == base_ref && c.mode == mode && !c.from_refusal)
        {
            return;
        }
        let info = proto::MergeQueueHandOffInfo {
            mode,
            base_ref,
            read_at_ms: now_unix_ms(),
            from_refusal: false,
        };
        if let Err(e) = self.db.merge_queue_set_hand_off(&row.workspace, &info) {
            tracing::warn!(
                "merge queue: caching the hand-off of {}: {e:#}",
                row.workspace
            );
        }
    }
}

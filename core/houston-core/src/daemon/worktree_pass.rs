//! One cleanup pass over the worktrees Houston recorded: why each one stays, and
//! the removal of those nothing keeps. Clean now and the 6-hourly loop share it.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;
use proto::WorktreeKeep;

use super::{now_ms, Daemon};
use crate::db::ManagedWorktreeRow;
use crate::gh::PrLookup;
use crate::worktree_cleanup as wc;

pub(super) const WORKTREE_CLEANUP_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
const ENABLED_KEY: &str = "worktree_cleanup_enabled";
const GRACE_HOURS_KEY: &str = "worktree_cleanup_grace_hours";
const IDLE_REMOVAL_DAYS_KEY: &str = "worktree_idle_removal_days";

/// What the last pass found, kept in memory: a status reply reads it and asks nothing.
#[derive(Default)]
pub(super) struct CleanupState {
    checked: HashMap<String, Checked>,
    running: HashSet<String>,
}

#[derive(Clone)]
struct Checked {
    at_ms: i64,
    pr: Option<u32>,
    keep: Option<WorktreeKeep>,
    status: proto::WorktreeStatus,
}

struct CleanupWorkspace {
    key: String,
    dir: PathBuf,
    common_dir: Option<String>,
}

/// Which of the trees nothing keeps a pass removes.
enum Removal {
    None,
    All,
    /// Clean now: only what the operator saw listed as removable and confirmed.
    Only(HashSet<String>),
}

impl Removal {
    fn covers(&self, path: &str) -> bool {
        match self {
            Removal::None => false,
            Removal::All => true,
            Removal::Only(paths) => paths.contains(path),
        }
    }
}

/// Holds a workspace's pass; dropping it frees the workspace even if the pass panics.
struct PassClaim<'a> {
    daemon: &'a Daemon,
    key: String,
}

impl Drop for PassClaim<'_> {
    fn drop(&mut self) {
        self.daemon
            .worktree_cleanup
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .running
            .remove(&self.key);
    }
}

impl Daemon {
    pub fn worktree_cleanup_enabled(&self) -> bool {
        matches!(self.db.get_setting(ENABLED_KEY), Ok(Some(v)) if v == "1")
    }

    pub fn worktree_cleanup_grace_hours(&self) -> u32 {
        match self.db.get_setting(GRACE_HOURS_KEY) {
            Ok(Some(v)) => v
                .parse()
                .unwrap_or(proto::WORKTREE_CLEANUP_GRACE_HOURS_DEFAULT),
            _ => proto::WORKTREE_CLEANUP_GRACE_HOURS_DEFAULT,
        }
    }

    pub fn set_worktree_cleanup(&self, enabled: bool, grace_hours: u32) -> Result<()> {
        if grace_hours == 0 || grace_hours > proto::WORKTREE_CLEANUP_GRACE_HOURS_MAX {
            bail!(
                "worktree cleanup grace must be 1..={} hours (asked for {grace_hours}; currently {})",
                proto::WORKTREE_CLEANUP_GRACE_HOURS_MAX,
                self.worktree_cleanup_grace_hours()
            );
        }
        self.db
            .set_setting(ENABLED_KEY, if enabled { "1" } else { "0" })?;
        self.db
            .set_setting(GRACE_HOURS_KEY, &grace_hours.to_string())?;
        Ok(())
    }

    pub fn worktree_idle_removal_days(&self) -> u32 {
        self.db
            .get_setting(IDLE_REMOVAL_DAYS_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(proto::WORKTREE_IDLE_REMOVAL_DAYS_DEFAULT)
    }

    pub fn set_worktree_idle_removal_days(&self, days: u32) -> Result<()> {
        if !(proto::WORKTREE_IDLE_REMOVAL_DAYS_MIN..=proto::WORKTREE_IDLE_REMOVAL_DAYS_MAX)
            .contains(&days)
        {
            bail!(
                "worktree idle removal must be {}..={} days (asked for {days}; currently {})",
                proto::WORKTREE_IDLE_REMOVAL_DAYS_MIN,
                proto::WORKTREE_IDLE_REMOVAL_DAYS_MAX,
                self.worktree_idle_removal_days()
            );
        }
        self.db
            .set_setting(IDLE_REMOVAL_DAYS_KEY, &days.to_string())?;
        Ok(())
    }

    pub fn worktree_cleanup_status(&self, dir: &str) -> Result<proto::ServerMsg> {
        let ws = self.cleanup_workspace(dir)?;
        Ok(self.cleanup_message(&ws, Vec::new()))
    }

    /// Check (`paths` empty) or Clean now, with the setting on or off: removes only the
    /// confirmed `paths` this pass still finds nothing keeping.
    pub fn worktree_cleanup_run(&self, dir: &str, paths: Vec<String>) -> Result<()> {
        let ws = self.cleanup_workspace(dir)?;
        let removal = if paths.is_empty() {
            Removal::None
        } else {
            Removal::Only(paths.into_iter().collect())
        };
        let claim = self.claim_pass(&ws)?;
        let removed = self.cleanup_pass(&ws, &removal);
        drop(claim);
        self.broadcast_control(&self.cleanup_message(&ws, removed));
        Ok(())
    }

    pub fn worktree_idle_remove(&self, dir: &str, path: &str) -> Result<()> {
        let ws = self.cleanup_workspace(dir)?;
        let row = self
            .rows_of(&ws)
            .into_iter()
            .find(|r| r.path == path)
            .ok_or_else(|| anyhow!("{path} is not a managed worktree in {dir}"))?;
        let tree = PathBuf::from(&row.path);
        if !tree.exists()
            || wc::idle_days(&tree, now_ms() as i64)
                .is_none_or(|idle| idle < self.worktree_idle_removal_days().div_ceil(2))
        {
            bail!("{path} is not stale (expected a clean worktree with all commits on a remote and no live session, idle for at least {} days)", self.worktree_idle_removal_days().div_ceil(2));
        }
        if self
            .live_session_cwds()
            .iter()
            .any(|(_, cwd)| cwd.starts_with(&tree))
        {
            bail!("{path} is in use (expected no live session in the stale worktree)");
        }
        let claim = self.claim_pass(&ws)?;
        crate::worktrees::remove(&ws.dir, &tree, false)?;
        self.db.managed_worktree_delete(&row.path)?;
        self.forget_checked(&row.path);
        drop(claim);
        self.broadcast_control(&self.cleanup_message(
            &ws,
            vec![proto::RemovedWorktree {
                path: row.path,
                branch: row.branch,
                pr: None,
                bytes: row.bytes.map(|b| b as u64),
            }],
        ));
        Ok(())
    }

    /// One pass of the loop over every workspace with managed worktrees. With the
    /// setting off it does nothing at all: no `gh`, no fetch, no measuring. A workspace
    /// already mid-pass is skipped.
    pub fn worktree_cleanup_tick(&self) {
        if !self.worktree_cleanup_enabled() {
            return;
        }
        let rows = self.db.managed_worktrees().unwrap_or_default();
        for ws in self.cleanup_workspaces() {
            if !rows
                .iter()
                .any(|r| Some(&r.repo_common_dir) == ws.common_dir.as_ref())
            {
                continue;
            }
            let Ok(claim) = self.claim_pass(&ws) else {
                continue;
            };
            let removed = self.cleanup_pass(&ws, &Removal::All);
            drop(claim);
            self.broadcast_control(&self.cleanup_message(&ws, removed));
        }
    }

    pub async fn worktree_cleanup_loop(self: Arc<Self>) {
        loop {
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.worktree_cleanup_tick()).await;
            tokio::select! {
                _ = self.worktree_cleanup_notify.notified() => {},
                _ = tokio::time::sleep(Duration::from_millis(WORKTREE_CLEANUP_INTERVAL_MS)) => {},
            }
        }
    }

    fn cleanup_workspaces(&self) -> Vec<CleanupWorkspace> {
        self.db
            .list_workspaces()
            .unwrap_or_default()
            .into_iter()
            .map(|w| {
                let dir = PathBuf::from(&w.path);
                CleanupWorkspace {
                    common_dir: crate::git::checkout_facts(&dir).common_dir,
                    key: w.path,
                    dir,
                }
            })
            .collect()
    }

    fn cleanup_workspace(&self, dir: &str) -> Result<CleanupWorkspace> {
        let wanted = Path::new(dir).canonicalize().ok();
        self.cleanup_workspaces()
            .into_iter()
            .find(|w| w.key == dir || (wanted.is_some() && w.dir.canonicalize().ok() == wanted))
            .ok_or_else(|| {
                anyhow!("{dir} is not a Houston workspace, so it has no worktrees to clean")
            })
    }

    fn claim_pass(&self, ws: &CleanupWorkspace) -> Result<PassClaim<'_>> {
        let mut state = self.worktree_cleanup.lock().expect("worktree cleanup lock");
        let key = ws.common_dir.clone().unwrap_or_else(|| ws.key.clone());
        if !state.running.insert(key.clone()) {
            bail!("a worktree cleanup pass is already running for {}", ws.key);
        }
        Ok(PassClaim { daemon: self, key })
    }

    fn rows_of(&self, ws: &CleanupWorkspace) -> Vec<ManagedWorktreeRow> {
        let Some(common) = &ws.common_dir else {
            return Vec::new();
        };
        self.db
            .managed_worktrees()
            .unwrap_or_default()
            .into_iter()
            .filter(|r| &r.repo_common_dir == common)
            .collect()
    }

    fn cleanup_message(
        &self,
        ws: &CleanupWorkspace,
        removed: Vec<proto::RemovedWorktree>,
    ) -> proto::ServerMsg {
        let rows = self.rows_of(ws);
        let state = self.worktree_cleanup.lock().expect("worktree cleanup lock");
        let entries = rows
            .into_iter()
            .map(|r| {
                let checked = state.checked.get(&r.path);
                proto::ManagedWorktreeInfo {
                    pr: checked.and_then(|c| c.pr),
                    keep: checked.and_then(|c| c.keep.clone()),
                    checked_at_ms: checked.map(|c| c.at_ms),
                    bytes: r.bytes.map(|b| b as u64),
                    measured_at_ms: r.measured_at_ms,
                    path: r.path,
                    branch: r.branch,
                    base_branch: r.base_branch,
                    status: checked
                        .map(|c| c.status)
                        .unwrap_or(proto::WorktreeStatus::Kept),
                }
            })
            .collect();
        proto::ServerMsg::WorktreeCleanup {
            dir: ws.key.clone(),
            entries,
            removed,
        }
    }

    fn cleanup_pass(
        &self,
        ws: &CleanupWorkspace,
        removal: &Removal,
    ) -> Vec<proto::RemovedWorktree> {
        let rows = self.rows_of(ws);
        if rows.is_empty() {
            return Vec::new();
        }
        let gh = crate::gh::state(&ws.dir);
        let grace_ms = i64::from(self.worktree_cleanup_grace_hours()) * 3_600_000;
        let live = self.live_session_cwds();
        let mut removed = Vec::new();
        for row in rows {
            let path = PathBuf::from(&row.path);
            if !path.exists() {
                if let Err(e) = crate::worktrees::prune(&ws.dir) {
                    tracing::warn!("pruning worktrees of {}: {e:#}", ws.key);
                }
                let _ = self.db.managed_worktree_delete(&row.path);
                self.forget_checked(&row.path);
                continue;
            }
            let now = now_ms() as i64;
            let integrated_until = self.integrated_until(&row.path);
            let (pr, mut keep) = keep_reason(
                ws,
                &row,
                &path,
                gh,
                Grace {
                    ms: grace_ms,
                    integrated_until,
                },
                now,
                &live,
            );
            // Idle removal is for work with no evidence of being done; a reason that
            // already protects local work (or a merge still in grace) wins.
            let idle_days = keep
                .as_ref()
                .is_some_and(idle_may_apply)
                .then(|| wc::idle_days(&path, now))
                .flatten()
                .filter(|_| !live.iter().any(|(_, cwd)| cwd.starts_with(&path)));
            if let Some(idle_days) = idle_days {
                let threshold = self.worktree_idle_removal_days();
                if idle_days >= threshold && matches!(removal, Removal::All) {
                    let bytes = wc::tree_bytes(&path);
                    match remove_idle_managed(ws, &row, &path, &self.db) {
                        Ok(()) => {
                            tracing::info!(
                                "removed idle worktree {} (kept branch {}, {bytes} bytes)",
                                row.path,
                                row.branch
                            );
                            self.forget_checked(&row.path);
                            removed.push(proto::RemovedWorktree {
                                path: row.path,
                                branch: row.branch,
                                pr,
                                bytes: Some(bytes),
                            });
                            continue;
                        }
                        Err(e) => {
                            keep = Some(WorktreeKeep::RemoveFailed {
                                message: format!("{e:#}"),
                            });
                        }
                    }
                } else if idle_days >= threshold.div_ceil(2) {
                    keep = Some(WorktreeKeep::Stale {
                        idle_days,
                        removal_in_days: threshold.saturating_sub(idle_days),
                    });
                }
            }
            let status = match &keep {
                Some(WorktreeKeep::Stale { .. }) => proto::WorktreeStatus::Stale,
                Some(_) => proto::WorktreeStatus::Kept,
                None => proto::WorktreeStatus::Ready,
            };
            // Only a row the operator can act on is worth walking the tree for.
            let bytes = if status == proto::WorktreeStatus::Kept {
                row.bytes.unwrap_or(0) as u64
            } else {
                let bytes = wc::tree_bytes(&path);
                let _ = self
                    .db
                    .managed_worktree_set_size(&row.path, bytes as i64, now);
                bytes
            };
            let keep = match keep {
                None if removal.covers(&row.path) => {
                    if let Some((session, _)) = self
                        .live_session_cwds()
                        .iter()
                        .find(|(_, cwd)| cwd.starts_with(&path))
                    {
                        self.worktree_cleanup
                            .lock()
                            .expect("worktree cleanup lock")
                            .checked
                            .insert(
                                row.path,
                                Checked {
                                    at_ms: now,
                                    pr,
                                    keep: Some(WorktreeKeep::InUse { session: *session }),
                                    status: proto::WorktreeStatus::Kept,
                                },
                            );
                        continue;
                    }
                    match remove_managed(ws, &row, &path, &self.db) {
                        Ok(()) => {
                            tracing::info!(
                                "removed merged worktree {} (branch {}, PR #{}, {bytes} bytes)",
                                row.path,
                                row.branch,
                                pr.unwrap_or(0)
                            );
                            self.forget_checked(&row.path);
                            removed.push(proto::RemovedWorktree {
                                path: row.path,
                                branch: row.branch,
                                pr,
                                bytes: Some(bytes),
                            });
                            continue;
                        }
                        Err(e) => Some(WorktreeKeep::RemoveFailed {
                            message: format!("{e:#}"),
                        }),
                    }
                }
                other => other,
            };
            self.worktree_cleanup
                .lock()
                .expect("worktree cleanup lock")
                .checked
                .insert(
                    row.path,
                    Checked {
                        at_ms: now,
                        pr,
                        keep,
                        status,
                    },
                );
        }
        removed
    }

    /// The integrated-branch grace deadline a previous pass already started, so the
    /// grace counts from the first time integration was observed. In memory only: a
    /// daemon restart starts it again, which only delays removal.
    fn integrated_until(&self, path: &str) -> Option<i64> {
        let state = self.worktree_cleanup.lock().expect("worktree cleanup lock");
        let checked = state.checked.get(path)?;
        if checked.pr.is_some() {
            return None;
        }
        match checked.keep {
            Some(WorktreeKeep::Grace { until_ms }) => Some(until_ms),
            None => Some(checked.at_ms),
            _ => None,
        }
    }

    /// Moves an integrated branch's grace deadline into the past, standing in for the
    /// hours a test cannot wait.
    #[doc(hidden)]
    pub fn expire_worktree_grace_for_test(&self, path: &str) {
        let mut state = self.worktree_cleanup.lock().expect("worktree cleanup lock");
        if let Some(checked) = state.checked.get_mut(path) {
            if let Some(WorktreeKeep::Grace { until_ms }) = &mut checked.keep {
                *until_ms = 0;
            }
        }
    }

    fn forget_checked(&self, path: &str) {
        self.worktree_cleanup
            .lock()
            .expect("worktree cleanup lock")
            .checked
            .remove(path);
    }

    fn live_session_cwds(&self) -> Vec<(u32, PathBuf)> {
        let ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect();
        ids.into_iter()
            .filter_map(|id| {
                let cwd = self.live_cwd(id)?;
                Some((id, cwd.canonicalize().unwrap_or(cwd)))
            })
            .collect()
    }
}

/// Closing the pane that created a worktree wakes the loop instead of leaving that
/// worktree for the next 6-hour pass. It never makes a disabled pass run.
pub(super) fn queue_closed_session(daemon: &Daemon, session: u32) {
    let owns_worktree = daemon
        .db
        .managed_worktrees()
        .unwrap_or_default()
        .iter()
        .any(|row| row.created_by_session == Some(session));
    if owns_worktree {
        daemon.worktree_cleanup_notify.notify_one();
    }
}

struct Grace {
    ms: i64,
    /// For a branch with no PR: the deadline an earlier pass set when it first saw the
    /// branch integrated.
    integrated_until: Option<i64>,
}

/// The first thing keeping `path`, in the order a reader would ask: is it still on the
/// recorded branch, can Houston see the PR, is it merged, would removing lose work, is
/// someone in it, has the grace run.
fn keep_reason(
    ws: &CleanupWorkspace,
    row: &ManagedWorktreeRow,
    path: &Path,
    gh: proto::GhState,
    grace: Grace,
    now: i64,
    live: &[(u32, PathBuf)],
) -> (Option<u32>, Option<WorktreeKeep>) {
    // `gh pr view` and the ancestry check below both read the checked-out branch, while
    // removal deletes the recorded one; they must be the same branch.
    match wc::current_branch(path) {
        Some(Some(current)) if current == row.branch => {}
        Some(current) => return (None, Some(WorktreeKeep::BranchChanged { current })),
        None => {
            return (
                None,
                Some(WorktreeKeep::RemoveFailed {
                    message: format!("git branch failed in {}", row.path),
                }),
            )
        }
    }
    if gh != proto::GhState::Ready {
        let keep = if wc::upstream_gone(&ws.dir, &row.branch) {
            WorktreeKeep::ProbablyIntegrated
        } else {
            WorktreeKeep::GhUnavailable { gh }
        };
        return (None, Some(keep));
    }
    let facts = match crate::gh::pr_for_checkout(path) {
        PrLookup::Found(f) => f,
        PrLookup::NoPr => return (None, integrated_keep(ws, row, path, &grace, now, live)),
        PrLookup::Failed(e) => {
            tracing::warn!("gh pr view in {}: {e}", row.path);
            return (None, Some(WorktreeKeep::GhUnavailable { gh }));
        }
    };
    let pr = Some(facts.number);
    if facts.state != "MERGED" {
        return (pr, Some(WorktreeKeep::NotMerged { state: facts.state }));
    }
    if let Some(keep) = local_work_keep(row, path) {
        return (pr, Some(keep));
    }
    let head_here = wc::has_object(path, &facts.head_oid)
        || wc::pr_remote(path, &facts.url)
            .is_some_and(|remote| wc::fetch_pr_head(path, &remote, facts.number, &facts.head_oid));
    let outside = head_here
        .then(|| wc::commits_outside(path, &facts.head_oid))
        .flatten();
    match outside {
        None => {
            return (
                pr,
                Some(WorktreeKeep::PrHeadUnavailable { pr: facts.number }),
            )
        }
        Some(0) => {}
        Some(count) => {
            return (
                pr,
                Some(WorktreeKeep::CommitsOutsidePr {
                    count,
                    pr: facts.number,
                }),
            )
        }
    }
    if let Some((session, _)) = live.iter().find(|(_, cwd)| cwd.starts_with(path)) {
        return (pr, Some(WorktreeKeep::InUse { session: *session }));
    }
    // A merged PR always carries mergedAt; without one the grace starts now.
    let merged_at = facts
        .merged_at
        .as_deref()
        .and_then(wc::parse_github_time)
        .unwrap_or(now);
    let until_ms = merged_at + grace.ms;
    if now < until_ms {
        return (pr, Some(WorktreeKeep::Grace { until_ms }));
    }
    (pr, None)
}

/// A branch with no PR is done once every commit has a patch-equivalent in its recorded
/// base (else the default branch) or in the default branch, so squash and cherry-pick
/// integration count.
fn integrated_keep(
    ws: &CleanupWorkspace,
    row: &ManagedWorktreeRow,
    path: &Path,
    grace: &Grace,
    now: i64,
    live: &[(u32, PathBuf)],
) -> Option<WorktreeKeep> {
    let default = crate::git::default_base(&ws.dir);
    let Some(base) = row.base_branch.clone().or_else(|| default.clone()) else {
        return Some(WorktreeKeep::NoPr);
    };
    // A worktree on the base itself has nothing to integrate, and removing it would
    // delete the base branch.
    if base == row.branch || default.as_deref() == Some(row.branch.as_str()) {
        return Some(WorktreeKeep::NoPr);
    }
    if let Some(keep) = local_work_keep(row, path) {
        return Some(keep);
    }
    let Some(mut pending) = wc::cherry_unintegrated(&ws.dir, &base, &row.branch) else {
        return Some(WorktreeKeep::RemoveFailed {
            message: format!("git cherry {base} {} failed in {}", row.branch, ws.key),
        });
    };
    if !pending.is_empty() {
        if let Some(default) = default.as_deref().filter(|d| *d != base) {
            if let Some(in_default) = wc::cherry_unintegrated(&ws.dir, default, &row.branch) {
                pending.retain(|commit| in_default.contains(commit));
            }
        }
    }
    if !pending.is_empty() {
        return Some(WorktreeKeep::NotIntegrated {
            count: pending.len() as u32,
            base,
        });
    }
    if let Some((session, _)) = live.iter().find(|(_, cwd)| cwd.starts_with(path)) {
        return Some(WorktreeKeep::InUse { session: *session });
    }
    let until_ms = grace.integrated_until.unwrap_or(now + grace.ms);
    (now < until_ms).then_some(WorktreeKeep::Grace { until_ms })
}

/// Removing the tree must not lose anything git does not already hold elsewhere.
fn local_work_keep(row: &ManagedWorktreeRow, path: &Path) -> Option<WorktreeKeep> {
    match wc::dirty_files(path) {
        Some(0) => {}
        Some(files) => return Some(WorktreeKeep::Dirty { files }),
        None => {
            return Some(WorktreeKeep::RemoveFailed {
                message: format!("git status failed in {}", row.path),
            })
        }
    }
    match wc::ignored_files(path) {
        Some(0) => None,
        Some(files) => Some(WorktreeKeep::IgnoredFiles { files }),
        None => Some(WorktreeKeep::RemoveFailed {
            message: format!("git status --ignored failed in {}", row.path),
        }),
    }
}

/// Reasons that say "no evidence this work is done" rather than "this holds local work
/// or is still in its grace": only these give way to the idle rule.
fn idle_may_apply(keep: &WorktreeKeep) -> bool {
    matches!(
        keep,
        WorktreeKeep::NoPr
            | WorktreeKeep::NotIntegrated { .. }
            | WorktreeKeep::NotMerged { .. }
            | WorktreeKeep::GhUnavailable { .. }
            | WorktreeKeep::ProbablyIntegrated
            | WorktreeKeep::PrHeadUnavailable { .. }
            | WorktreeKeep::CommitsOutsidePr { .. }
    )
}

/// The worktree goes first; only then is its branch safe to drop, and a branch
/// that will not go is logged rather than keeping a row for a tree that is gone.
fn remove_managed(
    ws: &CleanupWorkspace,
    row: &ManagedWorktreeRow,
    path: &Path,
    db: &crate::db::Db,
) -> Result<()> {
    crate::worktrees::remove(&ws.dir, path, false)?;
    if let Err(e) = crate::git::delete_branch(&ws.dir, &row.branch, true) {
        tracing::warn!(
            "deleting branch {:?} of a removed worktree: {e:#}",
            row.branch
        );
    }
    db.managed_worktree_delete(&row.path)?;
    Ok(())
}

fn remove_idle_managed(
    ws: &CleanupWorkspace,
    row: &ManagedWorktreeRow,
    path: &Path,
    db: &crate::db::Db,
) -> Result<()> {
    crate::worktrees::remove(&ws.dir, path, false)?;
    db.managed_worktree_delete(&row.path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worktree_cleanup_pass_repeats_every_six_hours() {
        assert_eq!(WORKTREE_CLEANUP_INTERVAL_MS, 21_600_000);
    }
}

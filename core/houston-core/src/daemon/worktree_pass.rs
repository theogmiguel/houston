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
            tokio::time::sleep(Duration::from_millis(WORKTREE_CLEANUP_INTERVAL_MS)).await;
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
        if !state.running.insert(ws.key.clone()) {
            bail!("a worktree cleanup pass is already running for {}", ws.key);
        }
        Ok(PassClaim {
            daemon: self,
            key: ws.key.clone(),
        })
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
            let (pr, keep) = keep_reason(ws, &row, &path, gh, grace_ms, now, &live);
            let bytes = wc::tree_bytes(&path);
            let _ = self
                .db
                .managed_worktree_set_size(&row.path, bytes as i64, now);
            let keep = match keep {
                None if removal.covers(&row.path) => {
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
                    },
                );
        }
        removed
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

/// The first thing keeping `path`, in the order a reader would ask: is it still on the
/// recorded branch, can Houston see the PR, is it merged, would removing lose work, is
/// someone in it, has the grace run.
#[allow(clippy::too_many_arguments)]
fn keep_reason(
    ws: &CleanupWorkspace,
    row: &ManagedWorktreeRow,
    path: &Path,
    gh: proto::GhState,
    grace_ms: i64,
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
        PrLookup::NoPr => return (None, Some(WorktreeKeep::NoPr)),
        PrLookup::Failed(e) => {
            tracing::warn!("gh pr view in {}: {e}", row.path);
            return (None, Some(WorktreeKeep::GhUnavailable { gh }));
        }
    };
    let pr = Some(facts.number);
    if facts.state != "MERGED" {
        return (pr, Some(WorktreeKeep::NotMerged { state: facts.state }));
    }
    match wc::dirty_files(path) {
        Some(0) => {}
        Some(files) => return (pr, Some(WorktreeKeep::Dirty { files })),
        None => {
            return (
                pr,
                Some(WorktreeKeep::RemoveFailed {
                    message: format!("git status failed in {}", row.path),
                }),
            )
        }
    }
    match wc::ignored_files(path) {
        Some(0) => {}
        Some(files) => return (pr, Some(WorktreeKeep::IgnoredFiles { files })),
        None => {
            return (
                pr,
                Some(WorktreeKeep::RemoveFailed {
                    message: format!("git status --ignored failed in {}", row.path),
                }),
            )
        }
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
    let until_ms = merged_at + grace_ms;
    if now < until_ms {
        return (pr, Some(WorktreeKeep::Grace { until_ms }));
    }
    (pr, None)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worktree_cleanup_pass_repeats_every_six_hours() {
        assert_eq!(WORKTREE_CLEANUP_INTERVAL_MS, 21_600_000);
    }
}

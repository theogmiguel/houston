//! The merge queue's runner: verification (and restack) in the machine's one slot, failures
//! handed to the owning pane or parked, and landing (lease push, then a pinned merge or the
//! hand-off to GitHub) for the policy and the user's Merge. See docs/internals/daemon.md.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;

use super::merge_queue::{method_name, queue_repository};
use super::{now_unix_ms, Daemon};
use crate::merge_queue::{self as mq, QueueRow, Stacked};
use crate::merge_queue_verify::{self as verify, Outcome};
use crate::orchestrate;
use crate::pull_requests::shared::{pause_text, Read};

/// The queue moves at the PR watch's pace when nothing wakes it sooner.
const RUNNER_INTERVAL: Duration =
    Duration::from_millis(crate::pull_requests::watch::PR_WATCH_INTERVAL_MS);
/// Steps one workspace may take in a pass: a merge moves the next entry up,
/// and the bound keeps one busy workspace from holding the pass.
const MAX_STEPS_PER_PASS: usize = 8;
/// After a push GitHub takes a moment to report the new head: six reads five
/// seconds apart, and a slower answer waits for a later pass.
const AFTER_PUSH_READS: u32 = 6;
const AFTER_PUSH_WAIT: Duration = Duration::from_secs(5);
/// Bounds the failure note; the remainder is counted, not listed.
const MAX_NOTED_FILES: usize = 20;
/// The log rows a fork-point search reads for one dependency: far more than the
/// pushes and merges one pull request collects in the log's month.
const STACK_LOG_ROWS: u32 = 200;

/// The verification holding the machine's slot.
pub(super) struct Running {
    pub workspace: String,
    pub number: u32,
    pub started_at_ms: i64,
    /// Set when `hs-pane heavy` holds the slot instead of a verification.
    pub lease: Option<crate::build_slot::Lease>,
}

impl Running {
    fn holder(&self) -> String {
        match &self.lease {
            Some(l) => format!("hs-pane heavy in pane {}", l.session),
            None => format!(
                "the merge queue verifying PR #{} of {}",
                self.number, self.workspace
            ),
        }
    }
}

/// Frees the slot however a verification ends.
struct Slot<'a>(&'a Daemon);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self
            .0
            .merge_queue_slot
            .lock()
            .expect("merge queue slot lock") = None;
    }
}

/// What a landing attempt did.
pub(super) enum Landing {
    Merged(String),
    /// Nothing failed; the entry waits for GitHub, a rate-limit pause or a new
    /// verification, and a later pass continues.
    Waiting(String),
    /// GitHub owns the verified head now; Houston watches it there.
    HandedOff(String),
}

impl Landing {
    fn text(self) -> String {
        match self {
            Landing::Merged(text) | Landing::Waiting(text) | Landing::HandedOff(text) => text,
        }
    }
}

/// A failure before it is recorded: what happened, on which base.
pub(super) struct Failed {
    pub kind: proto::MergeQueueFailureKind,
    pub message: String,
    pub files: Vec<String>,
    pub output_tail: Option<String>,
    pub base_sha: Option<String>,
}

impl Failed {
    pub(super) fn refused(message: String) -> Self {
        Failed {
            kind: proto::MergeQueueFailureKind::Refused,
            message,
            files: Vec::new(),
            output_tail: None,
            base_sha: None,
        }
    }
}

impl Daemon {
    pub async fn merge_queue_loop(self: Arc<Self>) {
        loop {
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.merge_queue_runner_tick()).await;
            tokio::select! {
                _ = self.merge_queue_wake.notified() => {}
                _ = tokio::time::sleep(RUNNER_INTERVAL) => {}
            }
        }
    }

    /// One pass over every workspace with a queue, starting after the one
    /// served last so the slot goes round them in turn.
    pub fn merge_queue_runner_tick(self: &Arc<Self>) {
        let mut workspaces = match self.db.merge_queue_workspaces() {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("merge queue: listing queued workspaces: {e:#}");
                return;
            }
        };
        let last = self
            .merge_queue_cursor
            .lock()
            .expect("merge queue cursor lock")
            .clone();
        if let Some(at) = last.and_then(|l| workspaces.iter().position(|w| *w == l)) {
            workspaces.rotate_left(at + 1);
        }
        for workspace in workspaces {
            for _ in 0..MAX_STEPS_PER_PASS {
                match self.merge_queue_step(&workspace) {
                    Ok(true) => continue,
                    Ok(false) => break,
                    Err(e) => {
                        tracing::warn!("merge queue: advancing the queue of {workspace}: {e:#}");
                        break;
                    }
                }
            }
        }
    }

    /// Takes the slot for `number` of `workspace`, or `None` while another
    /// verification holds it; that head shows Waiting for a slot meanwhile.
    fn merge_queue_take_slot(&self, workspace: &str, number: u32) -> Option<Slot<'_>> {
        let mut slot = self.merge_queue_slot.lock().expect("merge queue slot lock");
        let now = now_unix_ms();
        if slot
            .as_ref()
            .is_some_and(|r| r.lease.as_ref().is_none_or(|l| !l.expired(now)))
        {
            return None;
        }
        *slot = Some(Running {
            workspace: workspace.to_string(),
            number,
            started_at_ms: now,
            lease: None,
        });
        *self
            .merge_queue_cursor
            .lock()
            .expect("merge queue cursor lock") = Some(workspace.to_string());
        Some(Slot(self))
    }

    /// `hs-pane heavy`'s door: `acquire` answers a lease or the current
    /// holder; `renew` and `release` act on the caller's own lease.
    pub fn build_slot_request(
        &self,
        session: u32,
        action: &str,
        lease: Option<&str>,
    ) -> Result<serde_json::Value> {
        let mut slot = self.merge_queue_slot.lock().expect("merge queue slot lock");
        let now = now_unix_ms();
        let expires_at_ms = now + crate::build_slot::LEASE_TTL_MS;
        let held = |slot: &Option<Running>| {
            slot.as_ref()
                .and_then(|r| r.lease.as_ref())
                .is_some_and(|l| Some(l.id.as_str()) == lease && l.session == session)
        };
        match action {
            "acquire" => {
                if let Some(r) = slot.as_ref() {
                    if r.lease.as_ref().is_none_or(|l| !l.expired(now)) {
                        return Ok(serde_json::json!({ "holder": r.holder() }));
                    }
                }
                let id = uuid::Uuid::new_v4().to_string();
                *slot = Some(Running {
                    workspace: String::new(),
                    number: 0,
                    started_at_ms: now,
                    lease: Some(crate::build_slot::Lease {
                        session,
                        id: id.clone(),
                        expires_at_ms,
                    }),
                });
                Ok(serde_json::json!({ "lease": id }))
            }
            "renew" if held(&slot) => {
                if let Some(l) = slot.as_mut().and_then(|r| r.lease.as_mut()) {
                    l.expires_at_ms = expires_at_ms;
                }
                Ok(serde_json::json!({ "renewed": true }))
            }
            "release" if held(&slot) => {
                *slot = None;
                Ok(serde_json::json!({ "released": true }))
            }
            "renew" | "release" => bail!(
                "lease {:?} of pane {session} no longer holds the build slot",
                lease.unwrap_or_default()
            ),
            other => bail!("build slot action {other:?}; expected acquire, renew or release"),
        }
    }

    /// Who holds the build slot now, if anyone.
    pub fn build_slot_holder(&self) -> Option<String> {
        let now = now_unix_ms();
        self.merge_queue_slot
            .lock()
            .expect("merge queue slot lock")
            .as_ref()
            .filter(|r| r.lease.as_ref().is_none_or(|l| !l.expired(now)))
            .map(Running::holder)
    }

    /// Holds the slot as a verification would, until the release call.
    #[doc(hidden)]
    pub fn hold_build_slot_for_test(&self, hold: bool) {
        *self.merge_queue_slot.lock().expect("merge queue slot lock") = hold.then(|| Running {
            workspace: "/test".into(),
            number: 7,
            started_at_ms: now_unix_ms(),
            lease: None,
        });
    }

    /// Moves the workspace's head one step: verify it, fail it, or land it.
    /// Returns whether it moved, so the pass takes the next step.
    fn merge_queue_step(self: &Arc<Self>, workspace: &str) -> Result<bool> {
        // GitHub can merge or eject what it owns during a pause, too.
        if self.merge_queue_watch_github(workspace)? {
            return Ok(true);
        }
        if self.merge_queue_paused(workspace)?.is_some()
            || queue_repository(Path::new(workspace), workspace).is_err()
        {
            return Ok(false);
        }
        let ctx = self.merge_queue_context(workspace)?;
        if ctx.refusal.is_some() {
            return Ok(false);
        }
        let settings = ctx
            .settings
            .clone()
            .unwrap_or_else(|| unreachable!("merge_queue_context always reads the settings"));
        let (rows, reviews) = self.merge_queue_rows(workspace)?;
        let entries = mq::line(&rows, &reviews, &ctx);
        let Some(index) = entries.iter().position(|e| e.position == 1) else {
            return Ok(false);
        };
        let row = &rows[index];
        if let Some(failed) =
            checks_failed_on_pushed(row).filter(|_| mq::github_holds(row).is_none())
        {
            self.merge_queue_fail(workspace, row, failed, true)?;
            return Ok(true);
        }
        match entries[index].status {
            proto::MergeQueueStatus::WaitingForSlot => {
                self.merge_queue_verify_head(workspace, row, &settings)
            }
            proto::MergeQueueStatus::Ready
                if settings.merge_when_verified
                    && !settings.verification_command.trim().is_empty() =>
            {
                match self.merge_queue_land(
                    workspace,
                    row.number,
                    None,
                    proto::PrMergeMethod::Squash,
                    true,
                ) {
                    Ok(Landing::Merged(text)) => {
                        tracing::info!("merge queue: {text}");
                        Ok(true)
                    }
                    Ok(Landing::Waiting(text) | Landing::HandedOff(text)) => {
                        tracing::info!("merge queue: {text}");
                        Ok(false)
                    }
                    Err(e) => {
                        tracing::warn!("merge queue: landing PR #{}: {e:#}", row.number);
                        Ok(false)
                    }
                }
            }
            _ => Ok(false),
        }
    }

    /// Verifies the head in the slot and records the outcome. Returns false
    /// when the slot is taken or the head moved under it.
    fn merge_queue_verify_head(
        self: &Arc<Self>,
        workspace: &str,
        row: &QueueRow,
        settings: &proto::MergeQueueSettings,
    ) -> Result<bool> {
        let Some(slot) = self.merge_queue_take_slot(workspace, row.number) else {
            return Ok(false);
        };
        self.broadcast_merge_queue(workspace);
        let root = Path::new(workspace);
        let command = settings.verification_command.trim();
        let limit_minutes = settings.time_limit_minutes;
        let stacked = row.stacked.as_ref();
        let ran = (|| {
            let remote = crate::git::remote_name(root)
                .ok_or_else(|| anyhow!("{workspace} has no git remote to fetch from"))?;
            let base_ref = mq::base_of(row)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("GitHub reported no base branch for PR #{}", row.number))?;
            let scratch = self.merge_queue_scratch();
            let heads = match stacked {
                Some(s) => self.merge_queue_stack_heads(workspace, s)?,
                None => Vec::new(),
            };
            let outcome = verify::verify(&verify::Request {
                repo: root,
                remote: &remote,
                base_ref: &base_ref,
                head_ref: &row.head_ref,
                head_sha: &row.head_sha,
                command,
                limit: Duration::from_secs(u64::from(limit_minutes) * 60),
                scratch: &scratch,
                stack: stacked.map(|s| verify::Stack {
                    heads: &heads,
                    head_ref: &s.head_ref,
                }),
            })?;
            Ok::<_, anyhow::Error>((outcome, base_ref, heads))
        })();
        let short = |sha: &str| mq::short_sha(sha).to_string();
        let dependency = stacked.map_or(0, |s| s.number);
        let moved = match ran {
            Ok((
                Outcome::Passed {
                    base_sha,
                    verified_sha,
                    fork_sha,
                },
                base_ref,
                _,
            )) => {
                tracing::info!(
                    "merge queue: PR #{} passed `{command}` as {verified_sha} on {base_ref}@{}{}",
                    row.number,
                    short(&base_sha),
                    fork_sha.as_deref().map_or_else(String::new, |f| format!(
                        ", restacked after #{dependency}'s {}",
                        short(f)
                    ))
                );
                self.db.merge_queue_set_verification(
                    workspace,
                    row.number,
                    Some(&proto::MergeQueueVerification {
                        base_ref,
                        base_sha,
                        head_sha: row.head_sha.clone(),
                        verified_sha,
                        at_ms: now_unix_ms(),
                        stacked_on: fork_sha.as_ref().map(|_| dependency),
                        fork_sha,
                    }),
                )?;
                true
            }
            Ok((
                Outcome::Conflict {
                    base_sha,
                    files,
                    fork_sha,
                },
                base_ref,
                _,
            )) => {
                let count = files.len();
                drop(slot);
                let what = match &fork_sha {
                    Some(fork) => format!(
                        "Restacking onto {base_ref}@{} after #{dependency}'s {}",
                        short(&base_sha),
                        short(fork)
                    ),
                    None => format!("Rebasing onto {base_ref}@{}", short(&base_sha)),
                };
                self.merge_queue_fail(
                    workspace,
                    row,
                    Failed {
                        kind: proto::MergeQueueFailureKind::Conflict,
                        message: format!(
                            "{what} stopped on a conflict in {count} file{}",
                            if count == 1 { "" } else { "s" }
                        ),
                        files,
                        output_tail: None,
                        base_sha: Some(base_sha),
                    },
                    true,
                )?;
                return Ok(true);
            }
            Ok((Outcome::NoForkPoint { base_sha, heads }, base_ref, _)) => {
                drop(slot);
                let heads: Vec<String> = heads.iter().map(|h| short(h)).collect();
                self.merge_queue_fail(
                    workspace,
                    row,
                    Failed {
                        base_sha: Some(base_sha),
                        ..Failed::refused(format!(
                            "PR #{} carries commits only #{dependency}'s branch had, but none of #{dependency}'s recorded heads ({}) is in its head {}, so there is no fork point to restack from; Houston does not guess one. Rebase {} onto {base_ref} and push",
                            row.number,
                            heads.join(", "),
                            short(&row.head_sha),
                            row.head_ref
                        ))
                    },
                    true,
                )?;
                return Ok(true);
            }
            Ok((
                Outcome::Failed {
                    base_sha,
                    code,
                    tail,
                },
                base_ref,
                _,
            )) => {
                drop(slot);
                let exit = code.map_or_else(|| "a signal".to_string(), |c| format!("exit {c}"));
                self.merge_queue_fail(
                    workspace,
                    row,
                    Failed {
                        kind: proto::MergeQueueFailureKind::Failed,
                        message: format!(
                            "`{command}` failed ({exit}) on the head rebased onto {base_ref}@{}",
                            short(&base_sha)
                        ),
                        files: Vec::new(),
                        output_tail: Some(tail),
                        base_sha: Some(base_sha),
                    },
                    true,
                )?;
                return Ok(true);
            }
            Ok((Outcome::TimedOut { base_sha, tail }, base_ref, _)) => {
                drop(slot);
                self.merge_queue_fail(
                    workspace,
                    row,
                    Failed {
                        kind: proto::MergeQueueFailureKind::TimedOut,
                        message: format!(
                            "`{command}` ran past its {limit_minutes}-minute time limit on the head rebased onto {base_ref}@{}",
                            short(&base_sha)
                        ),
                        files: Vec::new(),
                        output_tail: Some(tail),
                        base_sha: Some(base_sha),
                    },
                    true,
                )?;
                return Ok(true);
            }
            Ok((Outcome::HeadMoved { found }, _, _)) => {
                tracing::info!(
                    "merge queue: PR #{} moved from {} to {found} before its verification; the next read puts the new head in line",
                    row.number,
                    row.head_sha
                );
                false
            }
            Err(e) => {
                drop(slot);
                self.merge_queue_fail(
                    workspace,
                    row,
                    Failed::refused(format!(
                        "Houston could not verify PR #{}: {e:#}",
                        row.number
                    )),
                    true,
                )?;
                return Ok(true);
            }
        };
        drop(slot);
        self.broadcast_merge_queue(workspace);
        Ok(moved)
    }

    /// Outside `.houston/worktrees`: one directory serves the one slot.
    fn merge_queue_scratch(&self) -> PathBuf {
        self.state_dir.join("merge-queue").join("verify")
    }

    /// Every head the queue recorded for a merged dependency, newest first: the
    /// last one it read, then its log rows' heads. A push row's old head is the
    /// commit a branch stacked on the dependency was built on.
    fn merge_queue_stack_heads(&self, workspace: &str, stacked: &Stacked) -> Result<Vec<String>> {
        let mut heads = vec![stacked.head_sha.clone()];
        for e in self
            .db
            .merge_queue_log(workspace, 0, STACK_LOG_ROWS, Some(stacked.number))?
        {
            let recorded = match e.kind {
                proto::MergeQueueLogKind::Push | proto::MergeQueueLogKind::Restack => {
                    vec![e.new_sha, e.old_sha]
                }
                proto::MergeQueueLogKind::Merge
                | proto::MergeQueueLogKind::Park
                | proto::MergeQueueLogKind::HandOff => vec![e.head_sha],
                proto::MergeQueueLogKind::Retarget => Vec::new(),
            };
            for sha in recorded.into_iter().flatten() {
                if mq::valid_head_sha(&sha) && !heads.contains(&sha) {
                    heads.push(sha);
                }
            }
        }
        Ok(heads)
    }

    /// The pane that owns an entry: the one that enqueued it while it lives,
    /// else a live agent pane in the branch's Houston-managed worktree.
    fn merge_queue_owner(&self, workspace: &str, row: &QueueRow) -> Option<u32> {
        let agents = self.merge_queue_live_agents();
        if let Some(session) = row
            .session_id
            .filter(|s| agents.iter().any(|(id, _)| id == s))
        {
            return Some(session);
        }
        let tree = self
            .merge_queue_worktrees(workspace)
            .remove(&row.head_ref)?;
        let tree = Path::new(&tree);
        let tree = tree.canonicalize().unwrap_or_else(|_| tree.to_path_buf());
        agents
            .into_iter()
            .filter(|(_, cwd)| cwd.starts_with(&tree))
            .map(|(id, _)| id)
            .min()
    }

    /// Live agent panes and their working directories. Shell panes are left
    /// out: a note pasted into a shell would run as a command.
    fn merge_queue_live_agents(&self) -> Vec<(u32, PathBuf)> {
        let ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .iter()
            .filter(|(_, s)| {
                s.info.agent != proto::AgentKind::Shell
                    && s.state.lock().expect("state lock").is_live()
            })
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| {
                let cwd = self.live_cwd(id)?;
                Some((id, cwd.canonicalize().unwrap_or(cwd)))
            })
            .collect()
    }

    /// Takes an entry out of line for its current head: the owning pane gets
    /// one inbox row with the detail if it is live; otherwise the entry is
    /// parked and the park is logged. Nothing is spawned.
    pub(super) fn merge_queue_fail(
        self: &Arc<Self>,
        workspace: &str,
        row: &QueueRow,
        failed: Failed,
        unattended: bool,
    ) -> Result<()> {
        let owner = self.merge_queue_owner(workspace, row);
        let failure = proto::MergeQueueFailure {
            kind: failed.kind,
            message: failed.message,
            files: failed.files,
            output_tail: failed.output_tail,
            head_sha: row.head_sha.clone(),
            base_sha: failed.base_sha,
            handed_to: owner,
            at_ms: now_unix_ms(),
        };
        self.db
            .merge_queue_set_failure(workspace, row.number, Some(&failure))?;
        match owner {
            Some(session) => {
                let (summary, body) = failure_note(row, &failure);
                if let Err(e) = self.inbox_write(
                    session,
                    workspace,
                    None,
                    None,
                    orchestrate::InboxKind::OperatorNote,
                    &summary,
                    &body,
                    Vec::new(),
                    Some("merge_queue_failed"),
                    None,
                    false,
                    true,
                ) {
                    tracing::warn!(
                        "merge queue: telling pane {session} about PR #{}: {e:#}",
                        row.number
                    );
                }
            }
            None => {
                self.db.merge_queue_log_record(
                    workspace,
                    &log_row(row, proto::MergeQueueLogKind::Park, unattended, |e| {
                        e.ref_name = row.base_ref.clone();
                        e.old_sha = failure.base_sha.clone();
                        e.head_sha = Some(row.head_sha.clone());
                        e.detail = Some(failure.message.clone());
                    }),
                )?;
            }
        }
        tracing::info!(
            "merge queue: PR #{} left the line of {workspace} ({}): {}",
            row.number,
            owner.map_or_else(|| "parked".to_string(), |s| format!("handed to pane {s}")),
            failure.message
        );
        self.broadcast_merge_queue(workspace);
        Ok(())
    }

    /// Refuses a push the queue must never make, naming the branch: the base,
    /// the repository's default branch, a branch outside `houston/*`, and one
    /// Houston's managed-worktree records do not show it created.
    pub fn merge_queue_push_guard(
        &self,
        workspace: &str,
        branch: &str,
        base_ref: Option<&str>,
    ) -> Result<()> {
        if base_ref == Some(branch) {
            bail!("refusing to push to {branch}: it is the base of the pull request, and the merge queue never pushes to a base");
        }
        let default = crate::git::default_base(Path::new(workspace)).map(|b| {
            crate::git::remote_name(Path::new(workspace))
                .and_then(|r| b.strip_prefix(&format!("{r}/")).map(str::to_string))
                .unwrap_or(b)
        });
        if default.as_deref() == Some(branch) {
            bail!("refusing to push to {branch}: it is the default branch of {workspace}, and the merge queue never pushes to a base");
        }
        if !branch.starts_with("houston/") {
            bail!("refusing to push to {branch}: the merge queue pushes only to houston/* branches Houston created, and {branch} is not one");
        }
        if !self.merge_queue_worktrees(workspace).contains_key(branch) {
            bail!("refusing to push to {branch}: Houston's managed-worktree records show no worktree it created on that branch in {workspace}");
        }
        Ok(())
    }

    /// Fetches the base and checks it is still the one the verification ran
    /// on. A moved base discards the verification: the merged tree must be the
    /// tested tree, so the entry goes back to verify again.
    fn merge_queue_base_holds(
        &self,
        workspace: &str,
        row: &QueueRow,
        verification: &proto::MergeQueueVerification,
        remote: &str,
    ) -> Result<Option<String>> {
        let root = Path::new(workspace);
        verify::fetch(root, remote, &[&verification.base_ref])?;
        let now = verify::remote_sha(root, remote, &verification.base_ref)?;
        if now == verification.base_sha {
            return Ok(None);
        }
        self.db
            .merge_queue_set_verification(workspace, row.number, None)?;
        self.broadcast_merge_queue(workspace);
        self.merge_queue_wake.notify_one();
        Ok(Some(format!(
            "{} moved from {} to {} since PR #{} was verified; it verifies again on the new base",
            verification.base_ref,
            mq::short_sha(&verification.base_sha),
            mq::short_sha(&now),
            row.number
        )))
    }

    /// Lands the head: pushes the verified commit with a lease when it is not the head yet
    /// and merges exactly that commit (without a command, the head after a fresh read).
    /// The gates, the pause and the base are checked again right before the merge.
    pub(super) fn merge_queue_land(
        self: &Arc<Self>,
        workspace: &str,
        number: u32,
        expected_head_sha: Option<&str>,
        method: proto::PrMergeMethod,
        unattended: bool,
    ) -> Result<Landing> {
        let _landing = self
            .merge_queue_landing
            .lock()
            .expect("merge queue landing lock");
        let root = Path::new(workspace);
        if let Some(paused) = self.merge_queue_paused(workspace)? {
            bail!("{paused}; PR #{number} was not merged");
        }
        let repository = queue_repository(root, workspace)?;
        let ctx = self.merge_queue_context(workspace)?;
        let command_set = ctx
            .settings
            .as_ref()
            .is_some_and(|s| !s.verification_command.trim().is_empty());
        if let Some(refusal) = ctx.refusal.as_ref().filter(|_| command_set) {
            bail!("{refusal}");
        }
        let (rows, reviews) = self.merge_queue_rows(workspace)?;
        let entries = mq::line(&rows, &reviews, &ctx);
        let Some(index) = rows.iter().position(|r| r.number == number) else {
            bail!("PR #{number} is not in the merge queue of {workspace}");
        };
        if entries[index].position != 1 {
            let place = match entries[index].position {
                0 => "out of line".to_string(),
                n => format!("number {n}"),
            };
            let head = entries
                .iter()
                .find(|e| e.position == 1)
                .map_or_else(|| "no entry".to_string(), |e| format!("#{}", e.number));
            bail!("only the head of the merge queue can be merged from it: {head} is first and PR #{number} is {place}; dequeue #{number} to merge it on its own");
        }
        let row = rows[index].clone();
        let gh = crate::gh::state(root);
        if gh != proto::GhState::Ready {
            bail!(
                "{}",
                crate::gh::hint_for(gh).unwrap_or_else(|| "gh is not ready to merge".to_string())
            );
        }
        let verification = if command_set {
            if let Some(expected) = expected_head_sha.filter(|e| *e != row.head_sha) {
                bail!(
                    "PR #{number} head moved from {expected} to {}; refusing to merge an unseen commit",
                    row.head_sha
                );
            }
            Some(mq::verification_holds(&row).cloned().ok_or_else(|| {
                anyhow!("PR #{number} has not passed verification on its base yet; it merges once it is verified")
            })?)
        } else {
            None
        };
        let remote = crate::git::remote_name(root)
            .ok_or_else(|| anyhow!("{workspace} has no git remote to push to"))?;
        if let Some(v) = &verification {
            if let Some(moved) = self.merge_queue_base_holds(workspace, &row, v, &remote)? {
                return Ok(Landing::Waiting(moved));
            }
        }
        let mode = mq::hand_off_mode(&row, self.db.merge_queue_hand_off(workspace)?.as_ref());
        let restacked = verification.as_ref().and_then(|v| v.fork_sha.clone());
        // GitHub's merge queue tests the real merge itself, so only a restack,
        // which drops the dependency's commits from the branch, is pushed for it.
        let target = match (&verification, expected_head_sha) {
            (Some(_), _) if mode == proto::MergeQueueHandOff::MergeQueue && restacked.is_none() => {
                row.head_sha.clone()
            }
            (Some(v), _) => v.verified_sha.clone(),
            (None, Some(expected)) => expected.to_string(),
            (None, None) => row.head_sha.clone(),
        };
        let pushed = row.head_sha != target && verification.is_some();
        if let Some(base) = mq::needs_retarget(&row) {
            self.merge_queue_retarget(workspace, &row, base, unattended)?;
        }
        if pushed {
            if let Err(e) =
                self.merge_queue_push_guard(workspace, &row.head_ref, row.base_ref.as_deref())
            {
                if unattended {
                    self.merge_queue_fail(
                        workspace,
                        &row,
                        Failed::refused(format!("{e:#}")),
                        true,
                    )?;
                }
                return Err(e);
            }
            if let Some(paused) = self.merge_queue_paused(workspace)? {
                bail!("{paused}; PR #{number} was not pushed");
            }
            verify::push_with_lease(root, &remote, &row.head_ref, &row.head_sha, &target)?;
            self.db.merge_queue_log_record(
                workspace,
                &log_row(&row, proto::MergeQueueLogKind::Push, unattended, |e| {
                    e.ref_name = Some(row.head_ref.clone());
                    e.old_sha = Some(row.head_sha.clone());
                    e.new_sha = Some(target.clone());
                }),
            )?;
            if let Some(fork) = &restacked {
                self.db.merge_queue_log_record(
                    workspace,
                    &log_row(&row, proto::MergeQueueLogKind::Restack, unattended, |e| {
                        e.ref_name = Some(row.head_ref.clone());
                        e.old_sha = Some(row.head_sha.clone());
                        e.new_sha = Some(target.clone());
                        e.fork_sha = Some(fork.clone());
                        e.detail = row
                            .stacked
                            .as_ref()
                            .map(|s| format!("Restacked after #{}", s.number));
                    }),
                )?;
            }
            tracing::info!(
                "merge queue: pushed {target} to {} over {} with a lease{}",
                row.head_ref,
                row.head_sha,
                restacked
                    .as_deref()
                    .map_or_else(String::new, |f| format!(", restacked after {f}"))
            );
        }
        let mut reads = 0;
        let detail = loop {
            let outcome = match self.merge_queue_read_fresh(root, &repository, number) {
                Read::Done(outcome) => *outcome,
                Read::Paused { until_ms } => {
                    return Ok(Landing::Waiting(format!(
                        "{}; PR #{number} merges after then",
                        pause_text(until_ms)
                    )))
                }
            };
            let current = self
                .db
                .merge_queue_entries(workspace)?
                .into_iter()
                .find(|r| r.number == number)
                .unwrap_or_else(|| row.clone());
            if self.merge_queue_apply_read(current, outcome.clone())? {
                self.broadcast_merge_queue(workspace);
            }
            let (link, detail) =
                outcome.map_err(|e| anyhow!("could not read PR #{number} to merge it: {e}"))?;
            if link.state != proto::PullRequestState::Open {
                bail!(
                    "PR #{number} is {} on GitHub; it left the merge queue",
                    crate::db::wire_name(&link.state)?
                );
            }
            if detail.head_sha == target {
                break detail;
            }
            reads += 1;
            if !pushed {
                bail!(
                    "PR #{number} head moved from {target} to {}; refusing to merge an unseen commit",
                    detail.head_sha
                );
            }
            if reads >= AFTER_PUSH_READS {
                return Ok(Landing::Waiting(format!(
                    "GitHub still reports {} as the head of PR #{number} after the push of {target}; it merges once GitHub reports the pushed commit",
                    detail.head_sha
                )));
            }
            std::thread::sleep(AFTER_PUSH_WAIT);
        };
        let (rows, reviews) = self.merge_queue_rows(workspace)?;
        let ctx = self.merge_queue_context(workspace)?;
        let entries = mq::line(&rows, &reviews, &ctx);
        let (row, entry) = rows
            .iter()
            .zip(&entries)
            .find(|(r, _)| r.number == number)
            .ok_or_else(|| anyhow!("PR #{number} left the merge queue of {workspace}"))?;
        if let Some(failed) = checks_failed_on_pushed(row) {
            self.merge_queue_fail(workspace, row, failed, unattended)?;
            bail!(
                "GitHub's checks failed on the verified commit of PR #{number}; it left the line"
            );
        }
        // Handed off, GitHub enforces its own merge gate on the pushed commit;
        // Houston's other gates still hold the entry.
        let github_gate_only = mode != proto::MergeQueueHandOff::Houston
            && entry.gates.iter().all(|g| {
                g.kind == proto::MergeQueueGateKind::Mergeable
                    || g.state != proto::MergeQueueGateState::Failed
            });
        if entry.status == proto::MergeQueueStatus::Blocked && !github_gate_only {
            let reason = entry.reason.clone().unwrap_or_default();
            if pushed {
                return Ok(Landing::Waiting(format!(
                    "pushed the verified commit of PR #{number}; it merges once GitHub clears this: {reason}"
                )));
            }
            bail!("PR #{number} is blocked in the merge queue: {reason}");
        }
        let base_ref = row.base_ref.clone().or(detail.base_ref.clone());
        if let Some(v) = &verification {
            if let Some(moved) = self.merge_queue_base_holds(workspace, row, v, &remote)? {
                return Ok(Landing::Waiting(moved));
            }
        }
        if let Some(paused) = self.merge_queue_paused(workspace)? {
            bail!("{paused}; PR #{number} was not merged");
        }
        let method = row
            .facts
            .as_ref()
            .and_then(|f| f.merge_method)
            .unwrap_or(method);
        let base_before = base_ref
            .as_deref()
            .and_then(|b| verify::remote_sha(root, &remote, b).ok());
        if mode != proto::MergeQueueHandOff::Houston {
            return self.merge_queue_hand_off(
                workspace,
                &repository,
                row,
                mode,
                &target,
                method,
                base_ref.as_deref(),
                base_before.as_deref(),
                unattended,
            );
        }
        let native = match merge_pinned(root, number, &target, method) {
            Ok(native) => native,
            Err(e) => {
                self.merge_queue_learn_refusal(workspace, row, &e);
                if unattended {
                    self.merge_queue_fail(workspace, row, Failed::refused(format!("{e:#}")), true)?;
                }
                return Err(e);
            }
        };
        self.db.merge_queue_remove(workspace, number)?;
        self.db.merge_queue_clear_dependency(
            workspace,
            number,
            (!native).then(|| Stacked::of(row)).as_ref(),
        )?;
        let base_after = base_ref.as_deref().and_then(|b| {
            verify::fetch(root, &remote, &[b])
                .and_then(|()| verify::remote_sha(root, &remote, b))
                .map_err(|e| {
                    tracing::warn!("merge queue: fetching {b} after merging PR #{number}: {e:#}")
                })
                .ok()
        });
        self.db.merge_queue_log_record(
            workspace,
            &log_row(row, proto::MergeQueueLogKind::Merge, unattended, |e| {
                e.ref_name = base_ref.clone();
                e.old_sha = base_before.clone();
                e.new_sha = base_after.clone();
                e.head_sha = Some(target.clone());
                e.method = Some(method);
            }),
        )?;
        self.merge_queue_after_merge(workspace, row, base_ref.as_deref(), base_after.as_deref());
        // The existing cleanup check decides whether the merged branch's
        // worktree may go; it never runs while the setting is off.
        self.worktree_cleanup_notify.notify_one();
        self.broadcast_merge_queue(workspace);
        self.merge_queue_wake.notify_one();
        Ok(Landing::Merged(format!(
            "merged PR #{number} at {target} with a {} merge; the next entry is now first",
            method_name(method)
        )))
    }

    /// Each live agent pane in another of the workspace's managed worktrees
    /// gets one note that the base moved; conflict prediction then runs on it.
    pub(super) fn merge_queue_after_merge(
        self: &Arc<Self>,
        workspace: &str,
        row: &QueueRow,
        base_ref: Option<&str>,
        base_after: Option<&str>,
    ) {
        let trees: Vec<(String, PathBuf)> = self
            .merge_queue_worktrees(workspace)
            .into_iter()
            .filter(|(branch, _)| *branch != row.head_ref)
            .map(|(branch, path)| {
                let p = PathBuf::from(&path);
                (branch, p.canonicalize().unwrap_or(p))
            })
            .collect();
        let base = match (base_ref, base_after) {
            (Some(b), Some(sha)) => format!("{b}@{}", mq::short_sha(sha)),
            (Some(b), None) => b.to_string(),
            _ => "the base".to_string(),
        };
        let mut told = HashSet::new();
        for (session, cwd) in self.merge_queue_live_agents() {
            let Some((branch, _)) = trees.iter().find(|(_, tree)| cwd.starts_with(tree)) else {
                continue;
            };
            if !told.insert(session) {
                continue;
            }
            let summary = format!("The base moved: {base} now contains #{}", row.number);
            let body = format!(
                "The merge queue merged PR #{} ({}) into {base}. Houston fetched it; nothing in this worktree changed. Rebase {branch} onto it before you push again. Houston reports a predicted conflict with the new base separately.",
                row.number,
                row.title.as_deref().unwrap_or(&row.head_ref),
            );
            if let Err(e) = self.inbox_write(
                session,
                workspace,
                None,
                None,
                orchestrate::InboxKind::OperatorNote,
                &summary,
                &body,
                Vec::new(),
                Some("merge_queue_base_moved"),
                None,
                false,
                true,
            ) {
                tracing::warn!("merge queue: telling pane {session} the base moved: {e:#}");
            }
        }
        self.conflict_prediction_tick();
    }

    /// The landing lock's holder, for the user's Merge: the message either way.
    pub(super) fn merge_queue_land_text(
        self: &Arc<Self>,
        workspace: &str,
        number: u32,
        expected_head_sha: &str,
        method: proto::PrMergeMethod,
    ) -> Result<String> {
        self.merge_queue_land(workspace, number, Some(expected_head_sha), method, false)
            .map(Landing::text)
    }
}

/// GitHub's checks failed on the verified commit the queue pushed as the head.
fn checks_failed_on_pushed(row: &QueueRow) -> Option<Failed> {
    let v = mq::verification_holds(row)?;
    let facts = row.facts.as_ref()?;
    if v.verified_sha == v.head_sha
        || row.head_sha != v.verified_sha
        || facts.failing_checks.is_empty()
    {
        return None;
    }
    Some(Failed {
        kind: proto::MergeQueueFailureKind::ChecksFailed,
        message: format!(
            "GitHub's checks failed on the verified commit {} the queue pushed: {}",
            mq::short_sha(&v.verified_sha),
            facts.failing_checks.join(", ")
        ),
        files: Vec::new(),
        output_tail: None,
        base_sha: Some(v.base_sha.clone()),
    })
}

/// Merges exactly `sha`: through the stack endpoint for a native stack, else
/// the SHA-pinned `gh pr merge`. GitHub's refusal is returned as it said it.
/// Returns whether it merged a native stack's layer.
fn merge_pinned(root: &Path, number: u32, sha: &str, method: proto::PrMergeMethod) -> Result<bool> {
    let name = method_name(method);
    let refused = |message: Option<String>| {
        anyhow!(
            "GitHub refused the {name} merge of PR #{number}: {}",
            message.unwrap_or_else(|| "gh gave no reason".to_string())
        )
    };
    match crate::gh::pr_stack(root, number) {
        Ok(Some(stack)) => {
            let index = stack
                .layers
                .iter()
                .position(|l| l.number == number)
                .ok_or_else(|| anyhow!("PR #{number} is not a layer of stack #{}", stack.number))?;
            let below: Vec<String> = stack.layers[..index]
                .iter()
                .filter(|l| l.state != proto::PullRequestState::Merged)
                .map(|l| format!("#{}", l.number))
                .collect();
            if !below.is_empty() {
                bail!(
                    "PR #{number} sits on unmerged layers {} of stack #{}; enqueue them ahead of it",
                    below.join(", "),
                    stack.number
                );
            }
            let out = crate::gh::pr_stack_merge(
                root,
                number,
                stack.number,
                &[proto::PrStackHead {
                    number,
                    head_sha: sha.to_string(),
                }],
                method,
            );
            if !out.ok {
                return Err(refused(out.message));
            }
            Ok(true)
        }
        Ok(None) => {
            let out = crate::gh::pr_merge(root, number, sha, method);
            if !out.ok {
                return Err(refused(out.message));
            }
            Ok(false)
        }
        Err(e) => {
            bail!("could not read whether PR #{number} is in a stack, so it was not merged: {e:#}")
        }
    }
}

pub(super) fn log_row(
    row: &QueueRow,
    kind: proto::MergeQueueLogKind,
    unattended: bool,
    fill: impl FnOnce(&mut proto::MergeQueueLogEntry),
) -> proto::MergeQueueLogEntry {
    let mut entry = proto::MergeQueueLogEntry {
        kind,
        number: row.number,
        repository: row.repository.clone(),
        url: row.url.clone(),
        title: row.title.clone(),
        ref_name: None,
        old_sha: None,
        new_sha: None,
        head_sha: None,
        method: None,
        detail: None,
        unattended,
        at_ms: now_unix_ms(),
        fork_sha: None,
    };
    fill(&mut entry);
    entry
}

/// The owning pane's note: what failed, the files or output, and what to do.
fn failure_note(row: &QueueRow, failure: &proto::MergeQueueFailure) -> (String, String) {
    let summary = format!("Merge queue: PR #{} left the line", row.number);
    let mut body = format!(
        "PR #{} ({}) failed the merge queue's verification. {}.",
        row.number, row.head_ref, failure.message
    );
    if !failure.files.is_empty() {
        body.push_str("\n\nConflicting files:");
        for file in failure.files.iter().take(MAX_NOTED_FILES) {
            body.push_str(&format!("\n- {file}"));
        }
        if failure.files.len() > MAX_NOTED_FILES {
            body.push_str(&format!(
                "\n- and {} more",
                failure.files.len() - MAX_NOTED_FILES
            ));
        }
    }
    if let Some(tail) = failure.output_tail.as_deref().filter(|t| !t.is_empty()) {
        body.push_str(&format!("\n\nLast lines of the output:\n```\n{tail}\n```"));
    }
    body.push_str(&format!(
        "\n\nFix it on {} and push. The queue takes the new head back in line on its own; do not enqueue it again. The queue has moved on to the next entry.",
        row.head_ref
    ));
    (summary, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_failure_note_names_the_files_and_the_output_tail() {
        let row = QueueRow {
            workspace: "/w".into(),
            number: 9,
            repository: "o/r".into(),
            url: "u".into(),
            title: None,
            head_ref: "houston/x".into(),
            head_sha: "a".repeat(40),
            base_ref: Some("main".into()),
            depends_on: None,
            session_id: None,
            position: 1,
            enqueued_at_ms: 0,
            facts: None,
            verification: None,
            failure: None,
            stacked: None,
            github: None,
        };
        let failure = proto::MergeQueueFailure {
            kind: proto::MergeQueueFailureKind::Conflict,
            message: "Rebasing onto main@abc stopped on a conflict in 22 files".into(),
            files: (0..22).map(|n| format!("f{n}.rs")).collect(),
            output_tail: Some("boom".into()),
            head_sha: "a".repeat(40),
            base_sha: None,
            handed_to: Some(3),
            at_ms: 0,
        };
        let (summary, body) = failure_note(&row, &failure);
        assert!(summary.contains("#9"));
        assert!(body.contains("- f0.rs"));
        assert!(body.contains("- and 2 more"), "{body}");
        assert!(body.contains("boom"));
        assert!(body.contains("do not enqueue it again"));
    }
}

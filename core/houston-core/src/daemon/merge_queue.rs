//! The per-workspace merge queue: its verbs, the gates' reads on the PR watch tick, the
//! user's settings, pause, retry and revert, and the snapshots the page shows. The model
//! is `crate::merge_queue`; verification and merging are `merge_queue_runner.rs`.
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;

use super::{now_unix_ms, tasks, Daemon};
use crate::merge_queue::{self as mq, Facts, LineContext, QueueRow, Review};
use crate::pull_requests::shared::{pause_text, Read, Tick};
use crate::pull_requests::{classify_remote, Host};

/// The history the snapshot carries: the last day, which the page groups as Today.
const MERGE_HISTORY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

pub(super) type ReadOutcome =
    std::result::Result<(proto::PullRequestLink, proto::PrDetail), String>;

/// The workspace remote's `owner/name`, refusing a workspace with no GitHub
/// remote by name: it has no merge queue.
pub(super) fn queue_repository(root: &Path, workspace: &str) -> Result<String> {
    let Some(url) = crate::git::remote_url(root) else {
        bail!("{workspace} has no git remote, so it has no merge queue; the merge queue needs a GitHub remote");
    };
    if classify_remote(&url) != Host::GitHub {
        bail!("{workspace}'s remote {url} is not on GitHub, so it has no merge queue; the merge queue needs a GitHub remote");
    }
    crate::gh::split_repository(&url)
        .map(|(owner, name)| format!("{owner}/{name}"))
        .ok_or_else(|| {
            anyhow!("{workspace}'s remote {url} names no `owner/name` GitHub repository, so it has no merge queue")
        })
}

pub(super) fn method_name(method: proto::PrMergeMethod) -> &'static str {
    match method {
        proto::PrMergeMethod::Merge => "merge",
        proto::PrMergeMethod::Squash => "squash",
        proto::PrMergeMethod::Rebase => "rebase",
    }
}

impl Daemon {
    /// The registered workspace whose queue `dir` addresses: the workspace
    /// itself, a directory inside it, or a worktree of its repository.
    pub fn merge_queue_workspace(&self, dir: &str) -> Result<String> {
        let workspaces = self.db.list_workspaces()?;
        if let Some(w) = workspaces.iter().find(|w| w.path == dir) {
            return Ok(w.path.clone());
        }
        if let Ok(wanted) = Path::new(dir).canonicalize() {
            if let Some(w) = workspaces
                .iter()
                .filter_map(|w| {
                    let root = Path::new(&w.path).canonicalize().ok()?;
                    wanted.starts_with(&root).then_some((root, w))
                })
                .max_by_key(|(root, _)| root.as_os_str().len())
                .map(|(_, w)| w)
            {
                return Ok(w.path.clone());
            }
        }
        if let Some(common) = crate::git::checkout_facts(Path::new(dir)).common_dir {
            if let Some(w) = workspaces.iter().find(|w| {
                crate::git::checkout_facts(Path::new(&w.path))
                    .common_dir
                    .as_ref()
                    == Some(&common)
            }) {
                return Ok(w.path.clone());
            }
        }
        bail!("{dir} is not inside a Houston workspace, so it has no merge queue; add its workspace first")
    }

    fn merge_queue_review(&self, row: &QueueRow) -> Review {
        match self
            .db
            .merge_queue_slice_review(&row.workspace, &row.head_ref, &row.url)
        {
            Ok(None) => Review::NotSlice,
            Ok(Some((key, state))) => Review::Slice { key, state },
            Err(e) => Review::Unreadable(format!("{e:#}")),
        }
    }

    /// Why the queue of `workspace` does not push or merge now, naming the
    /// pause that holds it.
    pub(super) fn merge_queue_paused(&self, workspace: &str) -> Result<Option<String>> {
        if self.db.merge_queue_global_paused()? {
            return Ok(Some(
                "every merge queue on this machine is paused; resume it to push and merge"
                    .to_string(),
            ));
        }
        Ok(self.db.merge_queue_settings(workspace)?.paused.then(|| {
            format!("the merge queue of {workspace} is paused; resume it to push and merge")
        }))
    }

    /// The managed worktrees of `workspace`'s repository, by branch.
    pub(super) fn merge_queue_worktrees(
        &self,
        workspace: &str,
    ) -> std::collections::HashMap<String, String> {
        let Some(common) = crate::git::checkout_facts(Path::new(workspace)).common_dir else {
            return Default::default();
        };
        self.db
            .managed_worktrees()
            .unwrap_or_default()
            .into_iter()
            .filter(|w| same_dir(&w.repo_common_dir, &common))
            .map(|w| (w.branch, w.path))
            .collect()
    }

    pub(super) fn merge_queue_context(&self, workspace: &str) -> Result<LineContext> {
        let running = self
            .merge_queue_slot
            .lock()
            .expect("merge queue slot lock")
            .as_ref()
            .filter(|r| r.workspace == workspace)
            .map(|r| (r.number, r.started_at_ms));
        Ok(LineContext {
            settings: Some(self.db.merge_queue_settings(workspace)?),
            paused: self.merge_queue_paused(workspace)?,
            running,
            worktrees: self.merge_queue_worktrees(workspace),
            refusal: crate::merge_queue_verify::environment_refusal(workspace),
        })
    }

    /// The workspace's rows in queue order, and their reviewer gates.
    pub(super) fn merge_queue_rows(&self, workspace: &str) -> Result<(Vec<QueueRow>, Vec<Review>)> {
        let rows = mq::order(self.db.merge_queue_entries(workspace)?);
        let reviews = rows.iter().map(|r| self.merge_queue_review(r)).collect();
        Ok((rows, reviews))
    }

    /// The workspace's entries in queue order, each with its gates evaluated now.
    pub fn merge_queue_entries(&self, workspace: &str) -> Result<Vec<proto::MergeQueueEntry>> {
        let (rows, reviews) = self.merge_queue_rows(workspace)?;
        Ok(mq::line(
            &rows,
            &reviews,
            &self.merge_queue_context(workspace)?,
        ))
    }

    pub fn merge_queue_snapshot(&self, workspace: &str) -> Result<proto::ServerMsg> {
        Ok(proto::ServerMsg::MergeQueue {
            workspace: workspace.to_string(),
            dir: None,
            entries: self.merge_queue_entries(workspace)?,
            log: self.db.merge_queue_log(
                workspace,
                now_unix_ms() - MERGE_HISTORY_WINDOW_MS,
                proto::MERGE_QUEUE_HISTORY_MAX,
                None,
            )?,
            settings: Some(self.db.merge_queue_settings(workspace)?),
            global_paused: self.db.merge_queue_global_paused()?,
            away: self.db.merge_queue_away(workspace)?,
            message: None,
        })
    }

    /// The direct reply to a client asking for `dir`'s queue: the snapshot
    /// with `dir` echoed, or the reason `dir` has none.
    pub fn merge_queue_reply(&self, dir: &str) -> proto::ServerMsg {
        let snapshot = self.merge_queue_workspace(dir).and_then(|workspace| {
            queue_repository(Path::new(&workspace), &workspace)?;
            self.merge_queue_snapshot(&workspace)
        });
        match snapshot {
            Ok(proto::ServerMsg::MergeQueue {
                workspace,
                entries,
                log,
                settings,
                global_paused,
                away,
                ..
            }) => proto::ServerMsg::MergeQueue {
                workspace,
                dir: Some(dir.to_string()),
                entries,
                log,
                settings,
                global_paused,
                away,
                message: None,
            },
            Ok(other) => other,
            Err(e) => proto::ServerMsg::MergeQueue {
                workspace: String::new(),
                dir: Some(dir.to_string()),
                entries: Vec::new(),
                log: Vec::new(),
                settings: None,
                global_paused: self.db.merge_queue_global_paused().unwrap_or(false),
                away: proto::MergeQueueAway::default(),
                message: Some(format!("{e:#}")),
            },
        }
    }

    /// Every workspace with a parked entry, for the rail's count.
    pub fn merge_queue_summary(&self) -> Result<proto::ServerMsg> {
        let mut parked: Vec<proto::MergeQueueParkedCount> = Vec::new();
        for row in self.db.merge_queue_all_entries()? {
            if !mq::failure_holds(&row).is_some_and(|f| f.handed_to.is_none()) {
                continue;
            }
            match parked.iter_mut().find(|p| p.workspace == row.workspace) {
                Some(p) => p.parked += 1,
                None => parked.push(proto::MergeQueueParkedCount {
                    workspace: row.workspace,
                    parked: 1,
                }),
            }
        }
        Ok(proto::ServerMsg::MergeQueueSummary {
            parked,
            global_paused: self.db.merge_queue_global_paused()?,
        })
    }

    pub(super) fn broadcast_merge_queue(&self, workspace: &str) {
        match self.merge_queue_snapshot(workspace) {
            Ok(msg) => self.broadcast_control(&msg),
            Err(e) => tracing::warn!("merge queue: reading the queue of {workspace}: {e:#}"),
        }
        match self.merge_queue_summary() {
            Ok(msg) => self.broadcast_control(&msg),
            Err(e) => tracing::warn!("merge queue: reading the parked counts: {e:#}"),
        }
    }

    /// A task run changed: the reviewer gate of its workspace's entries may have.
    pub(super) fn merge_queue_task_changed(&self, task_id: i64) {
        let Ok(Some(task)) = self.db.task(task_id) else {
            return;
        };
        let Some(workspace) = task.workspace else {
            return;
        };
        if self
            .db
            .merge_queue_entries(&workspace)
            .is_ok_and(|rows| !rows.is_empty())
        {
            self.broadcast_merge_queue(&workspace);
            self.merge_queue_wake.notify_one();
        }
    }

    /// One read through the shared reader on a tick of its own: a user action
    /// reads fresh, and a rate-limit pause answers `Paused` rather than reaching gh.
    pub(super) fn merge_queue_read_fresh(
        &self,
        root: &Path,
        repository: &str,
        number: u32,
    ) -> Read {
        self.pr_reads.tick_read_repository(
            &mut Tick::default(),
            root,
            repository,
            number,
            now_unix_ms(),
        )
    }

    fn merge_queue_read_now(
        &self,
        root: &Path,
        repository: &str,
        number: u32,
    ) -> Result<ReadOutcome> {
        match self.merge_queue_read_fresh(root, repository, number) {
            Read::Done(outcome) => Ok(*outcome),
            Read::Paused { until_ms } => {
                bail!("{}; try PR #{number} after then", pause_text(until_ms))
            }
        }
    }

    /// Adds a pull request to the tail of the workspace's queue, or re-reads a
    /// queued one and replaces its `depends_on` in place.
    pub fn merge_queue_enqueue(
        self: &Arc<Self>,
        dir: &str,
        target: &str,
        depends_on: Option<u32>,
        session: Option<u32>,
    ) -> Result<proto::MergeQueueEntry> {
        let workspace = self.merge_queue_workspace(dir)?;
        let root = Path::new(&workspace);
        let repository = queue_repository(root, &workspace)?;
        let number = tasks::pr_watch_number(target)?;
        if let Some((_, named, _)) = tasks::pr_watch_url_identity(target)? {
            if !named.eq_ignore_ascii_case(&repository) {
                bail!("PR URL {target:?} is in {named}, but the merge queue of {workspace} is for {repository}; a pull request from another repository cannot join it");
            }
        }
        let check = |entries: &[QueueRow]| {
            mq::check_enqueue(
                entries,
                &workspace,
                number,
                depends_on,
                proto::MERGE_QUEUE_MAX_ENTRIES,
            )
        };
        // Refuse before reading GitHub what the entries alone refuse.
        check(&self.db.merge_queue_entries(&workspace)?)?;
        let (link, detail) = self
            .merge_queue_read_now(root, &repository, number)?
            .map_err(|e| anyhow!("could not read PR #{number} to enqueue it: {e}"))?;
        if link.state != proto::PullRequestState::Open {
            bail!(
                "PR #{number} is {}; only an open pull request joins the merge queue",
                crate::db::wire_name(&link.state)?
            );
        }
        if !link.repository.is_empty() && !link.repository.eq_ignore_ascii_case(&repository) {
            bail!("PR #{number} is in {}, but the merge queue of {workspace} is for {repository}; a pull request from another repository cannot join it", link.repository);
        }
        if detail.cross_repository {
            bail!("PR #{number}'s branch is in a fork, another repository; the merge queue of {workspace} takes pull requests whose branch is in {repository}");
        }
        let head_ref = detail.head_ref.clone().ok_or_else(|| {
            anyhow!("GitHub reported no head branch for PR #{number}; refusing to enqueue it")
        })?;
        let now = now_unix_ms();
        let row = QueueRow {
            workspace: workspace.clone(),
            number,
            repository,
            url: link.url.clone(),
            title: link.title.clone(),
            head_ref,
            head_sha: detail.head_sha.clone(),
            base_ref: detail.base_ref.clone(),
            depends_on,
            session_id: session,
            position: 0,
            enqueued_at_ms: now,
            facts: Some(Facts::from_read(&detail, now)),
            verification: None,
            failure: None,
        };
        self.db.merge_queue_enqueue(&row, check)?;
        self.broadcast_merge_queue(&workspace);
        self.merge_queue_wake.notify_one();
        self.merge_queue_entries(&workspace)?
            .into_iter()
            .find(|e| e.number == number)
            .ok_or_else(|| {
                anyhow!("PR #{number} left the merge queue of {workspace} while it was enqueued")
            })
    }

    pub fn merge_queue_dequeue(&self, dir: &str, target: &str) -> Result<()> {
        let workspace = self.merge_queue_workspace(dir)?;
        let number = tasks::pr_watch_number(target)?;
        if !self.db.merge_queue_remove(&workspace, number)? {
            bail!("PR #{number} is not in the merge queue of {workspace}");
        }
        self.broadcast_merge_queue(&workspace);
        self.merge_queue_wake.notify_one();
        Ok(())
    }

    /// The pane's own workspace queue, for `pane_pr_enqueue` and `hs-pane pr-enqueue`.
    pub fn merge_queue_enqueue_from_pane(
        self: &Arc<Self>,
        caller: u32,
        target: &str,
        depends_on: Option<u32>,
    ) -> Result<proto::MergeQueueEntry> {
        let workspace = self.current_workspace(caller)?;
        self.merge_queue_enqueue(&workspace, target, depends_on, Some(caller))
    }

    pub fn merge_queue_dequeue_from_pane(&self, caller: u32, target: &str) -> Result<()> {
        let workspace = self.current_workspace(caller)?;
        self.merge_queue_dequeue(&workspace, target)
    }

    /// Applies one read to an entry. A pull request merged or closed outside
    /// the queue leaves it; a merge also satisfies its dependents. Returns
    /// whether the queue changed in a way worth broadcasting.
    pub(super) fn merge_queue_apply_read(
        &self,
        mut row: QueueRow,
        outcome: ReadOutcome,
    ) -> Result<bool> {
        let now = now_unix_ms();
        let facts = match outcome {
            Ok((link, detail)) => {
                match link.state {
                    proto::PullRequestState::Merged => {
                        self.db.merge_queue_remove(&row.workspace, row.number)?;
                        self.db
                            .merge_queue_clear_dependency(&row.workspace, row.number)?;
                        tracing::info!(
                            "merge queue: PR #{} merged outside the queue of {}; it left the queue",
                            row.number,
                            row.workspace
                        );
                        return Ok(true);
                    }
                    proto::PullRequestState::Closed => {
                        self.db.merge_queue_remove(&row.workspace, row.number)?;
                        tracing::info!(
                            "merge queue: PR #{} was closed; it left the queue of {}",
                            row.number,
                            row.workspace
                        );
                        return Ok(true);
                    }
                    proto::PullRequestState::Open => {}
                }
                let moved = row.head_sha != detail.head_sha;
                row.title = link.title.clone();
                if let Some(head_ref) = detail.head_ref.clone() {
                    row.head_ref = head_ref;
                }
                row.head_sha = detail.head_sha.clone();
                row.base_ref = detail.base_ref.clone();
                let facts = Facts::from_read(&detail, now);
                let changed = moved || row.facts.as_ref().is_none_or(|f| !f.same_answer(&facts));
                row.facts = Some(facts);
                self.db.merge_queue_set_read(&row)?;
                return Ok(changed);
            }
            Err(e) => Facts::from_error(e, now),
        };
        let changed = row.facts.as_ref().is_none_or(|f| !f.same_answer(&facts));
        row.facts = Some(facts);
        self.db.merge_queue_set_read(&row)?;
        Ok(changed)
    }

    /// Re-reads every queued pull request through the PR watch tick's shared
    /// reads: a watch and a queue entry of one pull request cost one read, and
    /// a rate-limit pause leaves each entry's last answer in place.
    pub(super) fn merge_queue_read_pass(&self, tick: &mut Tick) {
        let workspaces = match self.db.merge_queue_workspaces() {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("merge queue: listing queued workspaces: {e:#}");
                return;
            }
        };
        let mut any = false;
        for workspace in workspaces {
            let rows = match self.db.merge_queue_entries(&workspace) {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!("merge queue: reading the queue of {workspace}: {e:#}");
                    continue;
                }
            };
            let root = Path::new(&workspace);
            let mut changed = false;
            for row in rows {
                let outcome = match self.pr_reads.tick_read_repository(
                    tick,
                    root,
                    &row.repository,
                    row.number,
                    now_unix_ms(),
                ) {
                    Read::Done(outcome) => *outcome,
                    Read::Paused { .. } => continue,
                };
                let number = row.number;
                match self.merge_queue_apply_read(row, outcome) {
                    Ok(c) => changed |= c,
                    Err(e) => tracing::warn!(
                        "merge queue: recording the read of PR #{number} in {workspace}: {e:#}"
                    ),
                }
            }
            if changed {
                self.broadcast_merge_queue(&workspace);
                any = true;
            }
        }
        if any {
            self.merge_queue_wake.notify_one();
        }
    }

    /// The user's merge of the queue head: only the head, pinned to the commit
    /// the user saw. With a verification command it pushes and merges the
    /// verified commit; without one it merges the head after a fresh read.
    pub fn merge_queue_merge_head(
        self: &Arc<Self>,
        dir: &str,
        number: u32,
        expected_head_sha: &str,
        method: proto::PrMergeMethod,
    ) -> Result<String> {
        let workspace = self.merge_queue_workspace(dir)?;
        if !mq::valid_head_sha(expected_head_sha) {
            bail!("expected_head_sha {expected_head_sha:?} is not a full 40-character hex commit sha; refusing to merge PR #{number}");
        }
        self.merge_queue_land_text(&workspace, number, expected_head_sha, method)
    }

    /// Stores the workspace's policy, command and limit after checking each.
    /// A changed command discards the verifications the old one passed.
    pub fn merge_queue_settings_set(
        &self,
        dir: &str,
        merge_when_verified: bool,
        verification_command: &str,
        time_limit_minutes: u32,
    ) -> Result<String> {
        let workspace = self.merge_queue_workspace(dir)?;
        let command = verification_command.trim();
        let (min, max) = (
            proto::MERGE_QUEUE_TIME_LIMIT_MIN_MINUTES,
            proto::MERGE_QUEUE_TIME_LIMIT_MAX_MINUTES,
        );
        if !(min..=max).contains(&time_limit_minutes) {
            bail!("the merge queue time limit must be {min} to {max} minutes; got {time_limit_minutes}, so the settings of {workspace} were not changed");
        }
        let limit = proto::MERGE_QUEUE_COMMAND_MAX_BYTES as usize;
        if command.len() > limit {
            bail!(
                "the verification command is {} bytes and its limit is {limit}; refusing to set it for {workspace}",
                command.len()
            );
        }
        if command.contains(['\n', '\r']) {
            bail!("the verification command must be one line; put several steps in a script the command runs");
        }
        if merge_when_verified && command.is_empty() {
            bail!("Merge when verified needs a Verification command: set one in Settings ▸ Workspaces ▸ Merge queue before turning the policy on for {workspace}");
        }
        let before = self.db.merge_queue_settings(&workspace)?;
        let settings = proto::MergeQueueSettings {
            merge_when_verified,
            verification_command: command.to_string(),
            time_limit_minutes,
            paused: before.paused,
        };
        self.db.merge_queue_settings_set(&workspace, &settings)?;
        if before.verification_command != settings.verification_command {
            for row in self.db.merge_queue_entries(&workspace)? {
                if row.verification.is_some() {
                    self.db
                        .merge_queue_set_verification(&workspace, row.number, None)?;
                }
            }
        }
        self.broadcast_merge_queue(&workspace);
        self.merge_queue_wake.notify_one();
        Ok(format!(
            "Merge when verified is {} for {workspace}",
            if merge_when_verified { "on" } else { "off" }
        ))
    }

    /// Pauses or resumes one workspace's queue, or every queue with no `dir`.
    pub fn merge_queue_pause(&self, dir: Option<&str>, paused: bool) -> Result<String> {
        let verb = if paused { "paused" } else { "resumed" };
        let message = match dir {
            Some(dir) => {
                let workspace = self.merge_queue_workspace(dir)?;
                self.db.merge_queue_set_paused(&workspace, paused)?;
                self.broadcast_merge_queue(&workspace);
                format!("the merge queue of {workspace} is {verb}")
            }
            None => {
                self.db.merge_queue_set_global_paused(paused)?;
                for workspace in self.db.merge_queue_workspaces()? {
                    self.broadcast_merge_queue(&workspace);
                }
                if let Ok(msg) = self.merge_queue_summary() {
                    self.broadcast_control(&msg);
                }
                format!("every merge queue on this machine is {verb}")
            }
        };
        tracing::info!("merge queue: {message}");
        if !paused {
            self.merge_queue_wake.notify_one();
        }
        Ok(message)
    }

    /// Puts a parked or fixing entry back in line at its current head.
    pub fn merge_queue_retry(&self, dir: &str, number: u32) -> Result<String> {
        let workspace = self.merge_queue_workspace(dir)?;
        let row = self
            .db
            .merge_queue_entries(&workspace)?
            .into_iter()
            .find(|r| r.number == number)
            .ok_or_else(|| anyhow!("PR #{number} is not in the merge queue of {workspace}"))?;
        if mq::failure_holds(&row).is_none() {
            bail!("PR #{number} is in line, not parked; there is nothing to retry");
        }
        self.db.merge_queue_set_failure(&workspace, number, None)?;
        self.broadcast_merge_queue(&workspace);
        self.merge_queue_wake.notify_one();
        Ok(format!("PR #{number} is back in line"))
    }

    /// Opens a revert pull request for a queue merge. The base is never pushed to.
    pub fn merge_queue_revert(&self, dir: &str, number: u32) -> Result<String> {
        let workspace = self.merge_queue_workspace(dir)?;
        let root = Path::new(&workspace);
        let merged = self
            .db
            .merge_queue_log(&workspace, 0, 1, Some(number))?
            .into_iter()
            .find(|e| e.kind == proto::MergeQueueLogKind::Merge)
            .ok_or_else(|| {
                anyhow!("the merge log of {workspace} has no queue merge of PR #{number} to revert")
            })?;
        let gh = crate::gh::state(root);
        if gh != proto::GhState::Ready {
            bail!(
                "{}",
                crate::gh::hint_for(gh).unwrap_or_else(|| "gh is not ready".to_string())
            );
        }
        let out = crate::gh::pr_revert(root, &merged.repository, number);
        if !out.ok {
            bail!(
                "{}",
                out.message
                    .unwrap_or_else(|| format!("reverting PR #{number} was refused"))
            );
        }
        Ok(out
            .message
            .unwrap_or_else(|| format!("opened a revert pull request for PR #{number}")))
    }

    /// The user has seen what the queue did while they were away.
    pub fn merge_queue_acknowledge(&self, dir: &str) -> Result<()> {
        let workspace = self.merge_queue_workspace(dir)?;
        self.db.merge_queue_acknowledge(&workspace, now_unix_ms())?;
        self.broadcast_merge_queue(&workspace);
        Ok(())
    }
}

/// Two paths name one directory: equal as written, or after resolving links.
pub(super) fn same_dir(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (Path::new(a).canonicalize(), Path::new(b).canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

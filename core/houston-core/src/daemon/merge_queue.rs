//! The per-workspace merge queue: enqueue and dequeue verbs, the gates' reads
//! (through the shared pull request reader, on the PR watch tick), and the
//! user's merge of the queue head. The model is `crate::merge_queue`.
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;

use super::{now_unix_ms, tasks, Daemon};
use crate::merge_queue::{self as mq, Facts, QueueRow, Review};
use crate::pull_requests::shared::{pause_text, Read, Tick};
use crate::pull_requests::{classify_remote, Host};

/// The history the snapshot carries: the last day, which the page groups as Today.
const MERGE_HISTORY_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

type ReadOutcome = std::result::Result<(proto::PullRequestLink, proto::PrDetail), String>;

/// The workspace remote's `owner/name`, refusing a workspace with no GitHub
/// remote by name: it has no merge queue.
fn queue_repository(root: &Path, workspace: &str) -> Result<String> {
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

fn method_name(method: proto::PrMergeMethod) -> &'static str {
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

    /// The workspace's entries in queue order, each with its gates evaluated now.
    pub fn merge_queue_entries(&self, workspace: &str) -> Result<Vec<proto::MergeQueueEntry>> {
        let rows = mq::order(self.db.merge_queue_entries(workspace)?);
        let queued: HashSet<u32> = rows.iter().map(|r| r.number).collect();
        Ok(rows
            .iter()
            .zip(1u32..)
            .map(|(row, position)| mq::entry(row, position, &queued, &self.merge_queue_review(row)))
            .collect())
    }

    pub fn merge_queue_snapshot(&self, workspace: &str) -> Result<proto::ServerMsg> {
        Ok(proto::ServerMsg::MergeQueue {
            workspace: workspace.to_string(),
            dir: None,
            entries: self.merge_queue_entries(workspace)?,
            merged: self.db.merge_queue_merges(
                workspace,
                now_unix_ms() - MERGE_HISTORY_WINDOW_MS,
                proto::MERGE_QUEUE_HISTORY_MAX,
            )?,
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
                merged,
                ..
            }) => proto::ServerMsg::MergeQueue {
                workspace,
                dir: Some(dir.to_string()),
                entries,
                merged,
                message: None,
            },
            Ok(other) => other,
            Err(e) => proto::ServerMsg::MergeQueue {
                workspace: String::new(),
                dir: Some(dir.to_string()),
                entries: Vec::new(),
                merged: Vec::new(),
                message: Some(format!("{e:#}")),
            },
        }
    }

    pub(super) fn broadcast_merge_queue(&self, workspace: &str) {
        match self.merge_queue_snapshot(workspace) {
            Ok(msg) => self.broadcast_control(&msg),
            Err(e) => tracing::warn!("merge queue: reading the queue of {workspace}: {e:#}"),
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
        }
    }

    /// One read through the shared reader on a tick of its own: a user action
    /// reads fresh, and a rate-limit pause refuses it rather than reaching gh.
    fn merge_queue_read_now(
        &self,
        root: &Path,
        repository: &str,
        number: u32,
    ) -> Result<ReadOutcome> {
        match self.pr_reads.tick_read_repository(
            &mut Tick::default(),
            root,
            repository,
            number,
            now_unix_ms(),
        ) {
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
        };
        self.db.merge_queue_enqueue(&row, check)?;
        self.broadcast_merge_queue(&workspace);
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
    fn merge_queue_apply_read(&self, mut row: QueueRow, outcome: ReadOutcome) -> Result<bool> {
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
            }
        }
    }

    /// The user's merge of the queue head: only the head, pinned to the commit
    /// the user saw, after a fresh read re-checks every gate. A native stack
    /// merges through the stack endpoint.
    pub fn merge_queue_merge_head(
        self: &Arc<Self>,
        dir: &str,
        number: u32,
        expected_head_sha: &str,
        method: proto::PrMergeMethod,
    ) -> Result<String> {
        let workspace = self.merge_queue_workspace(dir)?;
        let root = Path::new(&workspace);
        if !mq::valid_head_sha(expected_head_sha) {
            bail!("expected_head_sha {expected_head_sha:?} is not a full 40-character hex commit sha; refusing to merge PR #{number}");
        }
        let rows = mq::order(self.db.merge_queue_entries(&workspace)?);
        let Some(index) = rows.iter().position(|r| r.number == number) else {
            bail!("PR #{number} is not in the merge queue of {workspace}");
        };
        if index != 0 {
            bail!(
                "only the head of the merge queue can be merged from it: #{} is first and PR #{number} is number {}; dequeue #{number} to merge it on its own",
                rows[0].number,
                index + 1
            );
        }
        let repository = queue_repository(root, &workspace)?;
        let gh = crate::gh::state(root);
        if gh != proto::GhState::Ready {
            bail!(
                "{}",
                crate::gh::hint_for(gh).unwrap_or_else(|| "gh is not ready to merge".to_string())
            );
        }
        let row = rows[0].clone();
        let outcome = self.merge_queue_read_now(root, &repository, number)?;
        let read = outcome.clone();
        let changed = self.merge_queue_apply_read(row, outcome)?;
        if changed {
            self.broadcast_merge_queue(&workspace);
        }
        let (link, detail) =
            read.map_err(|e| anyhow!("could not read PR #{number} to merge it: {e}"))?;
        if link.state != proto::PullRequestState::Open {
            bail!(
                "PR #{number} is {} on GitHub; it left the merge queue",
                crate::db::wire_name(&link.state)?
            );
        }
        if detail.head_sha != expected_head_sha {
            bail!(
                "PR #{number} head moved from {expected_head_sha} to {}; refusing to merge an unseen commit",
                detail.head_sha
            );
        }
        let entry = self
            .merge_queue_entries(&workspace)?
            .into_iter()
            .find(|e| e.number == number)
            .ok_or_else(|| anyhow!("PR #{number} left the merge queue of {workspace}"))?;
        if let Some(reason) = entry.reason {
            bail!("PR #{number} is blocked in the merge queue: {reason}");
        }
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
                    .ok_or_else(|| {
                        anyhow!("PR #{number} is not a layer of stack #{}", stack.number)
                    })?;
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
                        head_sha: expected_head_sha.to_string(),
                    }],
                    method,
                );
                if !out.ok {
                    return Err(refused(out.message));
                }
            }
            Ok(None) => {
                let out = crate::gh::pr_merge(root, number, expected_head_sha, method);
                if !out.ok {
                    return Err(refused(out.message));
                }
            }
            Err(e) => bail!(
                "could not read whether PR #{number} is in a stack, so it was not merged: {e:#}"
            ),
        }
        self.db.merge_queue_remove(&workspace, number)?;
        self.db.merge_queue_clear_dependency(&workspace, number)?;
        self.db.merge_queue_record_merge(
            &workspace,
            &proto::MergeQueueMerge {
                number,
                repository: entry.repository,
                url: entry.url,
                title: entry.title,
                head_sha: expected_head_sha.to_string(),
                base_ref: entry.base_ref,
                method,
                merged_at_ms: now_unix_ms(),
            },
        )?;
        // The existing cleanup check decides whether the merged branch's
        // worktree may go; it never runs while the setting is off.
        self.worktree_cleanup_notify.notify_one();
        self.broadcast_merge_queue(&workspace);
        Ok(format!(
            "merged PR #{number} at {expected_head_sha} with a {name} merge; the next entry is now first"
        ))
    }
}

//! A workspace's GitHub Issues connector: a poll imports labelled or assigned
//! open issues as linked backlog tasks (never starting one); writes back are
//! derived from local state into an at-least-once outbox.
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use serde::{Deserialize, Serialize};

use super::{now_unix_ms, Daemon};
use crate::db::{TaskLinkWrite, TaskRow, TaskWrite};
use crate::github_issues::{self as issues, Issue, Page, Repo, PROVIDER};

/// The per-workspace settings key holding the connector's JSON settings.
const SETTINGS_PREFIX: &str = "tasks_github:";

/// The per-workspace settings key holding the last sync time and error.
const STATE_PREFIX: &str = "tasks_github_state:";

/// The per-workspace, per-filter settings key holding the list's last ETag.
const ETAG_PREFIX: &str = "tasks_github_etag:";

/// `created_by` of an imported task: `github:<issue author>`.
const IMPORT_ACTOR_PREFIX: &str = "github:";

/// The history actor of a write Houston made to GitHub.
const GITHUB_ACTOR: &str = "houston:github";

const OPEN_ISSUE: &str = "open_issue";
const COMMENT: &str = "comment";

#[derive(Default, Serialize, Deserialize)]
struct SyncState {
    last_sync_at_ms: Option<i64>,
    error: Option<String>,
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn truncate_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

impl Daemon {
    pub fn task_github_settings(&self, workspace: &str) -> proto::TaskGithubSettings {
        let key = format!("{SETTINGS_PREFIX}{workspace}");
        match self.db.get_setting(&key) {
            Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                tracing::warn!("{key:?} holds {raw:?}, which does not parse ({e}); using off");
                proto::TaskGithubSettings::default()
            }),
            Ok(None) => proto::TaskGithubSettings::default(),
            Err(e) => {
                tracing::warn!("reading {key:?}: {e:#}; using off");
                proto::TaskGithubSettings::default()
            }
        }
    }

    /// The repository the workspace's remote names; refused by name when the
    /// remote is missing or not on github.com.
    fn task_github_repo(workspace: &str) -> Result<Repo> {
        let url = crate::git::remote_url(Path::new(workspace)).with_context(|| {
            format!("workspace {workspace:?} has no git remote (expected a github.com remote)")
        })?;
        issues::repo_of_remote(&url).with_context(|| {
            format!(
                "workspace {workspace:?} has remote {url:?}, which is not on github.com (expected \
                 a github.com remote)"
            )
        })
    }

    pub fn task_github_state(&self, workspace: &str) -> proto::ServerMsg {
        let state: SyncState = self
            .db
            .get_setting(&format!("{STATE_PREFIX}{workspace}"))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        proto::ServerMsg::TaskGithub {
            workspace: workspace.to_string(),
            settings: self.task_github_settings(workspace),
            repository: Self::task_github_repo(workspace).ok().map(|r| r.slug()),
            last_sync_at_ms: state.last_sync_at_ms,
            error: state.error,
        }
    }

    /// Stores the connector's settings; enabling needs a github.com remote and
    /// a label over GitHub's limit is refused naming it.
    pub fn task_github_set(
        &self,
        workspace: &str,
        settings: proto::TaskGithubSettings,
    ) -> Result<proto::ServerMsg> {
        let operation = "task_github_set";
        if !self.workspace_list()?.iter().any(|w| w.path == workspace) {
            return Ok(Self::task_invalid(
                None,
                operation,
                format!(
                    "workspace {workspace:?} is not registered (expected a registered workspace \
                     path)"
                ),
            ));
        }
        let label = settings
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty());
        if let Some(label) = label {
            let chars = label.chars().count();
            if chars > proto::TASK_GITHUB_LABEL_MAX {
                return Ok(Self::task_limit_refused(
                    None,
                    operation,
                    proto::TASK_GITHUB_LABEL_MAX as u32,
                    chars as u64,
                    "chars in the label",
                ));
            }
        }
        if settings.enabled {
            if let Err(e) = Self::task_github_repo(workspace) {
                return Ok(Self::task_invalid(None, operation, format!("{e:#}")));
            }
        }
        let stored = proto::TaskGithubSettings {
            enabled: settings.enabled,
            label: label.map(str::to_string),
            open_on_create: settings.open_on_create,
        };
        self.db.set_setting(
            &format!("{SETTINGS_PREFIX}{workspace}"),
            &serde_json::to_string(&stored)?,
        )?;
        Ok(self.task_github_state(workspace))
    }

    /// Queues an issue for a task typed into Houston when its workspace's
    /// connector opens one for every new task. Imported and Slack-filed tasks
    /// already mirror an item and get none.
    pub(super) fn task_github_on_create(&self, row: &TaskRow) {
        let Some(workspace) = row.workspace.as_deref() else {
            return;
        };
        if row.created_by.starts_with(IMPORT_ACTOR_PREFIX) || row.created_by.starts_with("slack:") {
            return;
        }
        let settings = self.task_github_settings(workspace);
        if !(settings.enabled && settings.open_on_create) {
            return;
        }
        if let Err(e) = self.db.link_outbox_push(
            row.id,
            PROVIDER,
            &format!("{OPEN_ISSUE}:{}", row.id),
            OPEN_ISSUE,
            "{}",
            now_unix_ms(),
        ) {
            tracing::warn!("github: queueing an issue for task {}: {e:#}", row.id);
        }
    }

    /// The explicit "Open GitHub issue" on one task: queued like any write,
    /// then sent now so the reply carries the outcome.
    pub fn task_github_open_issue(&self, id: i64) -> Result<proto::ServerMsg> {
        let operation = "task_github_open_issue";
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        let key = Self::task_key(row.number);
        let Some(workspace) = row.workspace.clone() else {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "task {key} has no workspace (expected a task in a workspace whose GitHub \
                     Issues connector is on)"
                ),
            ));
        };
        if !self.task_github_settings(&workspace).enabled {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "the GitHub Issues connector of workspace {workspace:?} is off (expected it \
                     on in Settings ▸ Tasks)"
                ),
            ));
        }
        if let Some(link) = self
            .db
            .task_links(id)?
            .into_iter()
            .find(|link| link.provider == PROVIDER)
        {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "task {key} already has GitHub issue {} (expected a task without one)",
                    link.external_id
                ),
            ));
        }
        let repo = match Self::task_github_repo(&workspace) {
            Ok(repo) => repo,
            Err(e) => return Ok(Self::task_invalid(Some(id), operation, format!("{e:#}"))),
        };
        self.db.link_outbox_push(
            id,
            PROVIDER,
            &format!("{OPEN_ISSUE}:{id}"),
            OPEN_ISSUE,
            "{}",
            now_unix_ms(),
        )?;
        if let Err(e) = self.task_github_flush(&workspace, &repo, Some(id)) {
            return Ok(Self::task_invalid(Some(id), operation, format!("{e:#}")));
        }
        let revision = self.db.task(id)?.map_or(row.revision, |t| t.revision);
        Ok(proto::ServerMsg::TaskChanged {
            workspace: Some(workspace),
            id,
            revision,
        })
    }

    /// One poll of every workspace whose connector is on.
    pub fn task_github_tick(&self) {
        let workspaces = match self.workspace_list() {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("github: listing workspaces: {e:#}");
                return;
            }
        };
        for workspace in workspaces {
            if self.task_github_settings(&workspace.path).enabled {
                self.task_github_sync(&workspace.path);
            }
        }
    }

    /// Syncs one workspace and records the outcome Settings ▸ Tasks shows.
    pub fn task_github_sync(&self, workspace: &str) {
        let result = self.task_github_sync_inner(workspace);
        let error = result.err().map(|e| format!("{e:#}"));
        if let Some(error) = &error {
            tracing::warn!("github: syncing {workspace:?}: {error}");
        }
        let state = SyncState {
            last_sync_at_ms: Some(now_unix_ms()),
            error,
        };
        match serde_json::to_string(&state) {
            Ok(raw) => {
                if let Err(e) = self
                    .db
                    .set_setting(&format!("{STATE_PREFIX}{workspace}"), &raw)
                {
                    tracing::warn!("github: recording the sync of {workspace:?}: {e:#}");
                }
            }
            Err(e) => tracing::warn!("github: serializing the sync state: {e}"),
        }
        self.broadcast_control(&self.task_github_state(workspace));
    }

    fn task_github_sync_inner(&self, workspace: &str) -> Result<()> {
        let settings = self.task_github_settings(workspace);
        let repo = Self::task_github_repo(workspace)?;
        // Writes go first, so an issue Houston just opened is linked before
        // the label poll lists it.
        self.task_github_derive(workspace, &repo)?;
        let flushed = self.task_github_flush(workspace, &repo, None);
        let mut filters = Vec::new();
        if let Some(label) = &settings.label {
            filters.push(format!("labels={label}"));
        }
        filters.push(format!(
            "assignee={}",
            issues::viewer(Path::new(workspace))?
        ));
        for filter in filters {
            self.task_github_import(workspace, &repo, &filter)?;
        }
        flushed
    }

    fn task_github_import(&self, workspace: &str, repo: &Repo, filter: &str) -> Result<()> {
        let key = format!("{ETAG_PREFIX}{workspace}\n{filter}");
        let etag = self.db.get_setting(&key)?;
        match issues::list_open(Path::new(workspace), repo, filter, etag.as_deref())? {
            Page::NotModified => Ok(()),
            Page::Fetched { etag, issues } => {
                for issue in issues {
                    self.task_github_file(workspace, repo, &issue)?;
                }
                // Stored only once every issue is filed, so a failure re-reads.
                if let Some(etag) = etag {
                    self.db.set_setting(&key, &etag)?;
                }
                Ok(())
            }
        }
    }

    /// Files one issue as a backlog task with its link, or refreshes the
    /// snapshot of an issue already linked. The task's text is the user's once
    /// filed: a changed issue only moves the link's hash and revision.
    fn task_github_file(&self, workspace: &str, repo: &Repo, issue: &Issue) -> Result<()> {
        let external_id = repo.issue_id(issue.number);
        let hash = issues::body_hash(&issue.title, &issue.body);
        let now = now_unix_ms();
        if let Some(link) = self.db.task_link_by_external(PROVIDER, &external_id)? {
            self.db
                .task_link_refreshed(link.id, now, &hash, Some(&issue.updated_at))?;
            return Ok(());
        }
        let existing = self.db.task_count("all")?;
        if existing >= proto::TASKS_PER_WORKSPACE {
            bail!(
                "importing {external_id} refused: the backlog holds {existing} tasks, at \
                 TASKS_PER_WORKSPACE ({})",
                proto::TASKS_PER_WORKSPACE
            );
        }
        let mut title = truncate_chars(issue.title.trim(), proto::TASK_TITLE_MAX);
        if title.is_empty() {
            title = format!("Issue #{}", issue.number);
        }
        let description = truncate_bytes(issue.body.trim(), proto::TASK_DESCRIPTION_MAX);
        let acceptance: Vec<String> = issues::acceptance_from_body(&issue.body)
            .into_iter()
            .take(proto::ACCEPTANCE_ITEMS_PER_TASK as usize)
            .map(|item| truncate_chars(&item, proto::TASK_TITLE_MAX))
            .collect();
        let actor = format!("{IMPORT_ACTOR_PREFIX}{}", issue.author);
        let created = self.db.create_linked_task(
            &TaskWrite {
                workspace: Some(workspace),
                title: &title,
                description: &description,
                status: proto::TaskStatus::Backlog,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: &actor,
                now_ms: now,
                acceptance: &acceptance,
            },
            &TaskLinkWrite {
                task_id: 0,
                provider: PROVIDER,
                external_id: &external_id,
                url: Some(&issue.url),
                fetched_at_ms: Some(now),
                body_hash: Some(&hash),
                remote_rev: Some(&issue.updated_at),
            },
        )?;
        if let Some(row) = created {
            tracing::info!(
                "github: filed {external_id} as {}",
                Self::task_key(row.number)
            );
            self.broadcast_control(&proto::ServerMsg::TaskChanged {
                workspace: row.workspace,
                id: row.id,
                revision: row.revision,
            });
        }
        Ok(())
    }

    /// Queues the comment each handed-back run of a linked task owes its
    /// issue, keyed by run so a state seen on every poll is queued once.
    fn task_github_derive(&self, workspace: &str, repo: &Repo) -> Result<()> {
        let now = now_unix_ms();
        for link in self.db.task_links_of(PROVIDER)? {
            let Some(number) = issues::issue_number(repo, &link.external_id) else {
                continue;
            };
            let Some(task) = self.db.task(link.task_id)? else {
                continue;
            };
            if task.workspace.as_deref() != Some(workspace) {
                continue;
            }
            for run in self.db.task_runs(task.id, proto::RUNS_PER_TASK)? {
                if run.kind != proto::TaskRunKind::Implementation
                    || run.state != proto::TaskRunState::HandedBack
                {
                    continue;
                }
                let Some(branch) = run.branch.as_deref() else {
                    continue;
                };
                let payload = serde_json::json!({
                    "number": number,
                    "branch": branch,
                    "worktree": run.worktree_path,
                    "pr_url": run.pr_url,
                })
                .to_string();
                self.db.link_outbox_push(
                    task.id,
                    PROVIDER,
                    &format!("handback:{}", run.id),
                    COMMENT,
                    &payload,
                    now,
                )?;
            }
        }
        Ok(())
    }

    /// Sends the workspace's pending writes (or only `only`'s); a failure is
    /// counted on its row and the first one is answered.
    fn task_github_flush(&self, workspace: &str, repo: &Repo, only: Option<i64>) -> Result<()> {
        let mut first_error = None;
        for row in self.db.link_outbox_pending(PROVIDER)? {
            if only.is_some_and(|id| id != row.task_id) {
                continue;
            }
            let Some(task) = self.db.task(row.task_id)? else {
                self.db.link_outbox_sent(row.id, now_unix_ms())?;
                continue;
            };
            if task.workspace.as_deref() != Some(workspace) {
                continue;
            }
            let sent = match row.kind.as_str() {
                OPEN_ISSUE => self.task_github_send_issue(workspace, repo, &task),
                COMMENT => self.task_github_send_comment(workspace, repo, &task, &row.payload),
                other => Err(anyhow::anyhow!(
                    "outbox row {} has kind {other:?} (expected {OPEN_ISSUE} or {COMMENT})",
                    row.id
                )),
            };
            match sent {
                Ok(()) => self.db.link_outbox_sent(row.id, now_unix_ms())?,
                Err(e) => {
                    let message = format!("{e:#}");
                    self.db.link_outbox_failed(row.id, &message)?;
                    first_error.get_or_insert(e);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn task_github_send_issue(&self, workspace: &str, repo: &Repo, task: &TaskRow) -> Result<()> {
        if self
            .db
            .task_links(task.id)?
            .iter()
            .any(|link| link.provider == PROVIDER)
        {
            return Ok(());
        }
        let key = Self::task_key(task.number);
        let mut body = task.description.trim().to_string();
        let acceptance = self.db.task_acceptance(task.id)?;
        if !acceptance.is_empty() {
            body.push_str("\n\n## Acceptance\n\n");
            for item in &acceptance {
                body.push_str(&format!("- [ ] {}\n", item.text));
            }
        }
        body.push_str(&format!("\n\n_Filed from Houston task {key}._\n"));
        let label = self.task_github_settings(workspace).label;
        let (number, url) = issues::create_issue(
            Path::new(workspace),
            repo,
            task.title.trim(),
            &body,
            label.as_deref(),
        )?;
        let external_id = repo.issue_id(number);
        let now = now_unix_ms();
        self.db.task_link_insert(&TaskLinkWrite {
            task_id: task.id,
            provider: PROVIDER,
            external_id: &external_id,
            url: Some(&url),
            fetched_at_ms: Some(now),
            body_hash: Some(&issues::body_hash(task.title.trim(), &body)),
            remote_rev: None,
        })?;
        if let Some(link) = self.db.task_link_by_external(PROVIDER, &external_id)? {
            self.db.task_link_synced(link.id, now)?;
        }
        self.db.record_task_history(
            task.id,
            GITHUB_ACTOR,
            "github_issue_opened",
            &serde_json::json!({ "link": external_id }).to_string(),
            now,
        )?;
        self.broadcast_control(&proto::ServerMsg::TaskChanged {
            workspace: task.workspace.clone(),
            id: task.id,
            revision: task.revision,
        });
        Ok(())
    }

    fn task_github_send_comment(
        &self,
        workspace: &str,
        repo: &Repo,
        task: &TaskRow,
        payload: &str,
    ) -> Result<()> {
        let v: serde_json::Value = serde_json::from_str(payload)
            .with_context(|| format!("comment payload {payload:?} is not JSON"))?;
        let number = v["number"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .with_context(|| format!("comment payload {payload:?} names no issue number"))?;
        let branch = v["branch"].as_str().unwrap_or("unknown");
        let pull_request = v["pr_url"].as_str().map(str::to_string).or_else(|| {
            let worktree = v["worktree"].as_str()?;
            match crate::gh::pr_for_checkout(Path::new(worktree)) {
                crate::gh::PrLookup::Found(facts) => Some(facts.url),
                _ => None,
            }
        });
        let body = format!(
            "Houston: {} was handed back for review.\n\n- Branch: `{branch}`\n- Pull request: {}\n",
            Self::task_key(task.number),
            pull_request.as_deref().unwrap_or("none yet")
        );
        issues::comment(Path::new(workspace), repo, number, &body)?;
        if let Some(link) = self
            .db
            .task_link_by_external(PROVIDER, &repo.issue_id(number))?
        {
            self.db.task_link_synced(link.id, now_unix_ms())?;
        }
        Ok(())
    }

    /// Polls every minute while a client is connected and every five minutes
    /// otherwise; a workspace with the connector off costs one settings read.
    pub async fn task_github_loop(self: Arc<Self>) {
        loop {
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.task_github_tick()).await;
            let idle = self.visibility.lock().expect("visibility lock").is_empty();
            let wait = if idle {
                proto::TASK_GITHUB_POLL_IDLE_MS
            } else {
                proto::TASK_GITHUB_POLL_ACTIVE_MS
            };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    }
}

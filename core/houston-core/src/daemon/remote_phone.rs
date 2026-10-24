//! What a paired phone reads beyond a pane's screen and feed, and what a manage
//! device does to panes and git. Each call reuses the desktop handler's function;
//! this module picks the pane's directory, bounds the answer and shapes it.
use std::path::{Path, PathBuf};

use houston_protocol as proto;
use serde_json::{json, Value};

use super::{now_ms, CreateParams, Daemon};
use crate::remote::feed::{mask, Change};
use crate::remote::{
    self, ApiError, CHANGES_FILES_MAX, COMMIT_MESSAGE_MAX_CHARS, DIFF_MAX_BYTES, DIFF_MAX_LINES,
    PR_LIST_MAX, SPAWNABLE_KINDS, SPAWN_MODEL_MAX_CHARS, TASKS_MAX,
};

/// The kinds a device may spawn, as the error text lists them.
fn spawnable_list() -> String {
    SPAWNABLE_KINDS
        .iter()
        .map(|k| crate::db::wire_name(k).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(", ")
}

fn kind_slug(kind: proto::AgentKind) -> String {
    crate::db::wire_name(&kind).unwrap_or_else(|_| format!("{kind:?}").to_lowercase())
}

fn internal(context: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(format!("{context}: {e:#}"))
}

/// A `git status` letter, as a diff tool shows it.
fn state_letter(state: proto::GitFileState) -> &'static str {
    match state {
        proto::GitFileState::Modified => "M",
        proto::GitFileState::Added => "A",
        proto::GitFileState::Deleted => "D",
        proto::GitFileState::Renamed => "R",
        proto::GitFileState::Untracked => "?",
        proto::GitFileState::Conflicted => "U",
    }
}

fn check_state(state: proto::PrCheckState) -> &'static str {
    match state {
        proto::PrCheckState::Passing => "passed",
        proto::PrCheckState::Failing => "failed",
        proto::PrCheckState::Skipped => "skipped",
        // An unrecognised state blocks a merge, so a device must not read it as done.
        proto::PrCheckState::Queued
        | proto::PrCheckState::Running
        | proto::PrCheckState::Unknown => "pending",
    }
}

fn checks_summary(checks: Option<proto::PrChecks>) -> &'static str {
    match checks {
        Some(proto::PrChecks::Passing) => "passing",
        Some(proto::PrChecks::Failing) => "failing",
        Some(proto::PrChecks::Running) => "running",
        Some(proto::PrChecks::None) | None => "none",
    }
}

fn pr_state(state: &str) -> String {
    state.to_ascii_lowercase()
}

fn review(decision: Option<&str>) -> Value {
    decision
        .filter(|d| !d.is_empty())
        .map(|d| Value::String(d.to_ascii_lowercase()))
        .unwrap_or(Value::Null)
}

/// One changed file of a pane's checkout, with the path git reported.
struct Changed {
    raw: String,
    file: proto::GitFileStatus,
}

/// The facts `/changes` reports, kept whole so `commit` and `diff` can check a
/// request against exactly what the device was shown.
struct Changes {
    dir: PathBuf,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<Changed>,
}

impl Changes {
    /// A file named by the path the device saw (masked) or by git's own.
    fn find(&self, asked: &str) -> Option<&Changed> {
        self.files
            .iter()
            .find(|c| c.raw == asked || mask(&c.raw) == asked)
    }
}

/// What a device asks to open: the validated fields of `POST /api/sessions`.
#[derive(Debug, Clone)]
pub struct RemoteSpawn {
    pub kind: proto::AgentKind,
    pub workspace: String,
    pub model: Option<String>,
    pub effort: Option<proto::ChatEffort>,
    pub profile: Option<u32>,
    pub worktree: Option<String>,
    pub prompt: Option<String>,
}

impl Daemon {
    fn remote_pane_info(&self, id: u32) -> Result<proto::SessionInfo, ApiError> {
        let session = self.remote_target(id)?;
        let mut info = session.snapshot_info();
        self.apply_recorded_checkout(&mut info);
        Ok(info)
    }

    /// The directory the pane works in: its checkout root, else its cwd.
    fn remote_pane_dir(&self, id: u32) -> Result<PathBuf, ApiError> {
        let info = self.remote_pane_info(id)?;
        let dir = info
            .checkout
            .as_ref()
            .map(|c| c.root.clone())
            .or(info.checkout_root.clone())
            .unwrap_or_else(|| info.cwd.clone());
        let dir = PathBuf::from(dir);
        if !dir.is_dir() {
            return Err(ApiError::NotFound(format!(
                "pane {id}'s directory {} no longer exists: restart the pane or close it",
                dir.display()
            )));
        }
        Ok(dir)
    }

    fn remote_changes_of(&self, id: u32) -> Result<Changes, ApiError> {
        let dir = self.remote_pane_dir(id)?;
        let is_repo = crate::git::probe_repo(&dir).map_err(|e| internal("reading git", e))?;
        if !is_repo {
            return Err(ApiError::Conflict(format!(
                "pane {id} works in {}, which is not a git repository: it has no changes to list",
                dir.display()
            )));
        }
        let statuses = crate::git::status(&dir).map_err(|e| internal("reading git status", e))?;
        let sync = crate::git::sync(&dir);
        Ok(Changes {
            dir,
            branch: sync.branch,
            upstream: sync.upstream,
            ahead: sync.ahead,
            behind: sync.behind,
            files: statuses
                .into_iter()
                .map(|file| Changed {
                    raw: file.path.clone(),
                    file,
                })
                .collect(),
        })
    }

    /// `GET /api/sessions/{id}/changes`: the checkout's `git status`.
    pub fn remote_changes(&self, id: u32) -> Result<Value, ApiError> {
        let changes = self.remote_changes_of(id)?;
        let truncated = changes.files.len() > CHANGES_FILES_MAX;
        let files: Vec<Value> = changes
            .files
            .iter()
            .take(CHANGES_FILES_MAX)
            .map(|c| {
                json!({
                    "path": mask(&c.raw),
                    "status": state_letter(c.file.status),
                    "added": c.file.added,
                    "removed": c.file.deleted,
                    "staged": c.file.staged,
                    "sensitive": c.file.is_sensitive,
                })
            })
            .collect();
        Ok(json!({
            "branch": changes.branch.as_deref().map(mask),
            "upstream": changes.upstream.as_deref().map(mask),
            "ahead": changes.ahead,
            "behind": changes.behind,
            "files": files,
            "truncated": truncated,
            "limit": CHANGES_FILES_MAX,
            "total": changes.files.len(),
        }))
    }

    /// `GET /api/sessions/{id}/diff?path=`: one file `/changes` lists, masked and bounded.
    pub fn remote_diff(&self, id: u32, path: &str) -> Result<Value, ApiError> {
        let changes = self.remote_changes_of(id)?;
        let listed = changes.files.iter().take(CHANGES_FILES_MAX);
        let Some(changed) = listed
            .into_iter()
            .find(|c| c.raw == path || mask(&c.raw) == path)
        else {
            return Err(ApiError::BadRequest(format!(
                "path {path:?} is not a changed file of pane {id}: expected a path listed by \
                 /api/sessions/{id}/changes"
            )));
        };
        if changed.file.is_sensitive {
            return Err(ApiError::Forbidden(format!(
                "path {path:?} looks like a secret file: its diff is never sent to a device"
            )));
        }
        let diff = crate::git::diff(&changes.dir, Some(&changed.raw), None)
            .map_err(|e| internal("reading the diff", e))?;
        let masked = mask(&diff.patch);
        let (text, cut) = bound_diff(&masked);
        Ok(json!({
            "path": mask(&changed.raw),
            "diff": text,
            "truncated": diff.truncated || cut,
            "limit_bytes": DIFF_MAX_BYTES,
            "limit_lines": DIFF_MAX_LINES,
        }))
    }

    /// `GET /api/sessions/{id}/pr`: the pull request of the pane's branch.
    pub fn remote_pr(&self, id: u32) -> Result<Value, ApiError> {
        let dir = self.remote_pane_dir(id)?;
        // No follow-up request would replace a seed here, so the phone skips the store.
        let status = crate::gh::pr_status_cached(&dir);
        let Some(pr) = status.pr else {
            let mut body = json!({ "pr": null });
            if let Some(hint) = status.hint {
                body["hint"] = json!(mask(&hint));
            }
            return Ok(body);
        };
        let mut body = json!({
            "number": pr.number,
            "title": mask(&pr.title),
            "url": mask(&pr.url),
            "state": pr_state(&pr.state),
            "draft": pr.is_draft,
            "review": review(pr.review_decision.as_deref()),
            "checks": { "passed": null, "failed": null, "pending": null, "items": [] },
        });
        match crate::pull_requests::read_core(
            &dir,
            Some(pr.number),
            proto::PullRequestLinkSource::Detected,
            None,
        ) {
            Ok((_link, detail, _owner)) => {
                let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
                let items: Vec<Value> = detail
                    .checks
                    .iter()
                    .map(|c| {
                        let state = check_state(c.state);
                        match state {
                            "passed" => passed += 1,
                            "failed" => failed += 1,
                            "pending" => pending += 1,
                            _ => {}
                        }
                        json!({ "name": mask(&c.name), "state": state })
                    })
                    .collect();
                body["checks"] = json!({ "passed": passed, "failed": failed, "pending": pending, "items": items });
            }
            Err(e) => {
                tracing::debug!("remote pr checks for pane {id}: {e:#}");
                body["checks"]["summary"] = json!(checks_summary(Some(pr.checks)));
            }
        }
        Ok(body)
    }

    /// `GET /api/workspaces`: registered workspaces with their branch and dirtiness.
    pub fn remote_workspaces(&self) -> Result<Value, ApiError> {
        let rows = self
            .db
            .list_workspaces()
            .map_err(|e| internal("reading workspaces", e))?;
        let out: Vec<Value> = rows
            .into_iter()
            .map(|w| {
                let dir = Path::new(&w.path);
                let repo = dir.is_dir() && crate::git::probe_repo(dir).unwrap_or(false);
                let branch = repo.then(|| crate::git::sync(dir).branch).flatten();
                let dirty = repo
                    && crate::git::status(dir)
                        .map(|f| !f.is_empty())
                        .unwrap_or(false);
                json!({
                    "name": mask(&w.name),
                    "path": mask(&w.path),
                    "branch": branch.as_deref().map(mask),
                    "dirty": dirty,
                })
            })
            .collect();
        Ok(Value::Array(out))
    }

    fn remote_registered_workspace(&self, path: &str) -> Result<proto::Workspace, ApiError> {
        let rows = self
            .db
            .list_workspaces()
            .map_err(|e| internal("reading workspaces", e))?;
        rows.into_iter().find(|w| w.path == path).ok_or_else(|| {
            ApiError::NotFound(format!(
                "no workspace has path {path:?}: expected a path from /api/workspaces"
            ))
        })
    }

    /// `GET /api/workspaces/prs?path=`: open pull requests; the flag says the list was cut.
    pub fn remote_workspace_prs(&self, path: &str) -> Result<(Value, bool), ApiError> {
        let workspace = self.remote_registered_workspace(path)?;
        let list = crate::gh::pr_list(
            Path::new(&workspace.path),
            proto::PrListState::Open,
            proto::PrListInvolvement::All,
            None,
            PR_LIST_MAX,
            proto::PrSort::Updated,
        )
        .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        let items: Vec<Value> = list
            .items
            .iter()
            .take(PR_LIST_MAX as usize)
            .map(|pr| {
                json!({
                    "number": pr.number,
                    "title": mask(&pr.title),
                    "url": mask(&pr.url),
                    "state": "open",
                    "draft": pr.is_draft,
                    "review": review(pr.review_decision.as_deref()),
                    "checks": {
                        "passed": null, "failed": null, "pending": null,
                        "summary": checks_summary(pr.checks),
                    },
                })
            })
            .collect();
        Ok((Value::Array(items), list.truncated))
    }

    /// `GET /api/tasks?workspace=`: tasks still open, newest first.
    pub fn remote_tasks(&self, workspace: &str) -> Result<(Value, bool), ApiError> {
        let workspace = self.remote_registered_workspace(workspace)?;
        let msg = self
            .task_snapshot(&workspace.path)
            .map_err(|e| internal("reading tasks", e))?;
        let proto::ServerMsg::TaskSnapshot { tasks, .. } = msg else {
            return Err(ApiError::Internal(
                "reading tasks: the daemon answered with something other than a task snapshot"
                    .to_string(),
            ));
        };
        let open: Vec<&proto::TaskSummary> = tasks
            .iter()
            .filter(|t| {
                t.archived_at_ms.is_none()
                    && !matches!(
                        t.status,
                        proto::TaskStatus::Done | proto::TaskStatus::Canceled
                    )
            })
            .collect();
        let truncated = open.len() > TASKS_MAX;
        let items: Vec<Value> = open
            .into_iter()
            .take(TASKS_MAX)
            .map(|t| {
                let pane = t.open_run.as_ref().and_then(|run| run.session_id);
                let status = crate::db::wire_name(&t.status).unwrap_or_default();
                json!({
                    "id": t.id,
                    "key": t.key,
                    "title": mask(&t.title),
                    "state": if pane.is_some() { "running" } else { status.as_str() },
                    "status": status,
                    "pane": pane,
                })
            })
            .collect();
        Ok((Value::Array(items), truncated))
    }

    /// The usage cache a device reads: today's cost by provider.
    fn remote_usage_compute(&self) -> Result<Value, ApiError> {
        let now = crate::usage::time::now_ms();
        let since = crate::usage::time::local_midnight_ms(now);
        let msg = self
            .usage_summary_filtered(since, now + crate::usage::time::HOUR_MS, false, None)
            .map_err(|e| internal("reading usage", e))?;
        let proto::ServerMsg::UsageSummary { buckets, .. } = msg else {
            return Err(ApiError::Internal(
                "reading usage: the daemon answered with something other than a usage summary"
                    .to_string(),
            ));
        };
        let mut total = 0.0;
        let mut by_provider: Vec<(proto::UsageProvider, f64)> = Vec::new();
        for bucket in buckets.iter().filter(|b| b.hour_start_ms >= since) {
            total += bucket.cost_usd;
            match by_provider.iter_mut().find(|(p, _)| *p == bucket.provider) {
                Some((_, cost)) => *cost += bucket.cost_usd,
                None => by_provider.push((bucket.provider, bucket.cost_usd)),
            }
        }
        let cents = |v: f64| (v * 100.0).round() / 100.0;
        Ok(json!({
            "today": {
                "cost_usd": cents(total),
                "by_provider": by_provider.iter().map(|(p, cost)| json!({
                    "kind": crate::db::wire_name(p).unwrap_or_default(),
                    "cost_usd": cents(*cost),
                })).collect::<Vec<_>>(),
            },
            // Houston reads no plan-limit windows from any provider, so there is nothing to list.
            "limits": [],
        }))
    }

    /// Recomputes the usage cache on a blocking thread; one recompute at a time.
    pub fn remote_usage_refresh(&self) {
        let Some(_running) = self.remote.usage_begin() else {
            return;
        };
        match self.remote_usage_compute() {
            Ok(value) => self.remote.usage_store(value),
            Err(e) => tracing::warn!("remote usage refresh failed: {e}"),
        }
    }

    /// `GET /api/usage` from the cache: `stale` when it is older than its
    /// freshness window, `None` when nothing was ever computed.
    pub fn remote_usage_cached(&self) -> Option<Value> {
        self.remote.usage_read()
    }

    /// `GET /api/spawn-options`.
    pub fn remote_spawn_options(&self) -> Result<Value, ApiError> {
        let workspaces = self
            .db
            .list_workspaces()
            .map_err(|e| internal("reading workspaces", e))?;
        let models = self.model_catalog.model_options();
        let profiles = match self.agent_profile_state() {
            proto::ServerMsg::AgentProfileState { profiles, .. } => profiles,
            _ => Vec::new(),
        };
        let providers: Vec<Value> = SPAWNABLE_KINDS
            .iter()
            .map(|&kind| {
                let presence = self.cli_presence(kind);
                let kind_models: Vec<&str> = models
                    .iter()
                    .filter(|m| m.provider == kind)
                    .map(|m| m.id.as_str())
                    .collect();
                let efforts = crate::launch::effort_args(kind, proto::ChatEffort::Low)
                    .is_ok()
                    .then(|| {
                        [
                            proto::ChatEffort::Low,
                            proto::ChatEffort::Medium,
                            proto::ChatEffort::High,
                            proto::ChatEffort::Xhigh,
                            proto::ChatEffort::Max,
                        ]
                        .map(|e| e.cli_value())
                    });
                let mut accounts = vec![json!({ "id": null, "name": "Default" })];
                accounts.extend(
                    profiles
                        .iter()
                        .filter(|p| p.agent == kind)
                        .map(|p| json!({ "id": p.id, "name": mask(&p.name) })),
                );
                json!({
                    "kind": kind_slug(kind),
                    "installed": presence.present,
                    "version": presence.version,
                    "models": (!kind_models.is_empty()).then_some(kind_models),
                    "efforts": efforts,
                    "accounts": accounts,
                })
            })
            .collect();
        Ok(json!({
            "providers": providers,
            "workspaces": workspaces.iter().map(|w| json!({
                "name": mask(&w.name),
                "path": mask(&w.path),
            })).collect::<Vec<_>>(),
        }))
    }

    /// Checks a spawn request against what a device may open, naming each refusal.
    pub fn remote_spawn_check(&self, request: &RemoteSpawn) -> Result<PathBuf, ApiError> {
        if !SPAWNABLE_KINDS.contains(&request.kind) {
            return Err(ApiError::BadRequest(format!(
                "kind {:?} cannot be opened from a device: expected one of {}",
                kind_slug(request.kind),
                spawnable_list()
            )));
        }
        let workspace = self.remote_registered_workspace(&request.workspace)?;
        if let Some(model) = &request.model {
            let chars = model.chars().count();
            if chars > SPAWN_MODEL_MAX_CHARS || model.trim().is_empty() {
                return Err(ApiError::BadRequest(format!(
                    "model {model:?} is {chars} characters: expected 1 to {SPAWN_MODEL_MAX_CHARS} \
                     non-blank characters, or null for the provider's default"
                )));
            }
        }
        if let Some(prompt) = &request.prompt {
            remote::validate_input_text(prompt)
                .map_err(|e| ApiError::BadRequest(format!("prompt is not valid: {e}")))?;
        }
        if let Some(slug) = &request.worktree {
            crate::worktrees::validate_slug(slug)
                .map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;
        }
        if let Some(id) = request.profile {
            let known = self
                .db
                .agent_profile_agent(id)
                .map_err(|e| internal("reading profiles", e))?;
            let slug = crate::db::wire_name(&request.kind).unwrap_or_default();
            if known.as_deref() != Some(slug.as_str()) {
                return Err(ApiError::BadRequest(format!(
                    "profile {id} is not an account of {slug}: expected an id from \
                     /api/spawn-options for that provider, or null"
                )));
            }
        }
        Ok(PathBuf::from(workspace.path))
    }

    /// `POST /api/sessions`: the desktop's `SessionCreate` path, without auto-approve.
    pub fn remote_spawn(
        self: &std::sync::Arc<Self>,
        request: RemoteSpawn,
    ) -> Result<u32, ApiError> {
        let workspace = self.remote_spawn_check(&request)?;
        let project_dir = match &request.worktree {
            Some(slug) => {
                let (tree, _warnings) = self
                    .git_worktree_create(&workspace, slug, None)
                    .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
                tree.path
            }
            None => workspace,
        };
        let info = self
            .create_session(CreateParams {
                agent: request.kind,
                project_dir,
                cmd: None,
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: true,
                auto_approve: false,
                acp: None,
                profile: request
                    .profile
                    .map(|id| proto::ProfileChoice::Profile { id }),
                prompt: request.prompt,
                model: request.model,
                effort: request.effort,
            })
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(info.id)
    }

    /// `POST /api/sessions/{id}/rename`; an empty title restores the automatic name.
    pub fn remote_rename(&self, id: u32, title: &str) -> Result<(), ApiError> {
        self.remote_target(id)?;
        let result = if title.trim().is_empty() {
            self.reset_title(id)
        } else {
            self.rename(id, title)
        };
        result.map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(())
    }

    /// `POST /api/sessions/{id}/respawn`: restart, resuming the conversation when there is one.
    pub fn remote_respawn(self: &std::sync::Arc<Self>, id: u32) -> Result<(), ApiError> {
        self.remote_target(id)?;
        self.respawn_with(
            id,
            true,
            None,
            None,
            false,
            super::RespawnConversation::Resume,
        )
        .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(())
    }

    pub fn remote_sleep(&self, id: u32) -> Result<(), ApiError> {
        self.remote_target(id)?;
        self.sleep_session(id)
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(())
    }

    pub fn remote_wake(self: &std::sync::Arc<Self>, id: u32) -> Result<(), ApiError> {
        self.remote_target(id)?;
        self.wake_session(id)
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(())
    }

    /// `POST /api/sessions/{id}/close`; `confirm` must be the pane id as a string.
    /// A pane with live children is refused by the desktop's own check.
    pub fn remote_close(
        self: &std::sync::Arc<Self>,
        id: u32,
        confirm: &str,
    ) -> Result<(), ApiError> {
        if confirm != id.to_string() {
            return Err(ApiError::BadRequest(format!(
                "confirm {confirm:?} does not match pane {id}: send {{\"confirm\":\"{id}\"}} to close it"
            )));
        }
        self.remote_target(id)?;
        self.session_close_checked(id, false)
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        self.remote.emit(Change::Sessions);
        Ok(())
    }

    /// `POST /api/sessions/{id}/commit`: every tracked change, or exactly `paths`.
    /// Files staged outside the selection and secret-looking files refuse it.
    pub fn remote_commit(
        &self,
        id: u32,
        message: &str,
        paths: Option<&[String]>,
    ) -> Result<Value, ApiError> {
        let message = message.trim();
        let chars = message.chars().count();
        if chars == 0 || chars > COMMIT_MESSAGE_MAX_CHARS {
            return Err(ApiError::BadRequest(format!(
                "commit message is {chars} characters: expected 1 to {COMMIT_MESSAGE_MAX_CHARS}"
            )));
        }
        let changes = self.remote_changes_of(id)?;
        let selected: Vec<&Changed> = match paths {
            None => changes
                .files
                .iter()
                .filter(|c| c.file.status != proto::GitFileState::Untracked)
                .collect(),
            Some(paths) => {
                if paths.is_empty() || paths.len() > CHANGES_FILES_MAX {
                    return Err(ApiError::BadRequest(format!(
                        "paths has {} entries: expected 1 to {CHANGES_FILES_MAX} paths listed by \
                         /api/sessions/{id}/changes, or null for every tracked change",
                        paths.len()
                    )));
                }
                let mut out = Vec::with_capacity(paths.len());
                for path in paths {
                    let Some(changed) = changes.find(path) else {
                        return Err(ApiError::BadRequest(format!(
                            "path {path:?} is not a changed file of pane {id}: expected paths \
                             listed by /api/sessions/{id}/changes"
                        )));
                    };
                    out.push(changed);
                }
                out
            }
        };
        let mut unexpected: Vec<String> = changes
            .files
            .iter()
            .filter(|c| c.file.staged && !selected.iter().any(|s| s.raw == c.raw))
            .map(|c| mask(&c.raw))
            .collect();
        if !unexpected.is_empty() {
            unexpected.truncate(5);
            return Err(ApiError::Conflict(format!(
                "already staged on the computer and not in this request: {}; include them in \
                 `paths` or unstage them there before committing from a device",
                unexpected.join(", ")
            )));
        }
        if let Some(secret) = selected.iter().find(|c| c.file.is_sensitive) {
            return Err(ApiError::Forbidden(format!(
                "path {:?} looks like a secret file: commit it from the computer",
                mask(&secret.raw)
            )));
        }
        if selected.is_empty() {
            return Err(ApiError::Conflict(format!(
                "pane {id} has no changes to commit: expected at least one changed file in \
                 /api/sessions/{id}/changes"
            )));
        }
        let stage: Vec<String> = selected.iter().map(|c| c.raw.clone()).collect();
        crate::git::stage(&changes.dir, &stage)
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        let done = crate::git::commit(&changes.dir, message, false)
            .map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        Ok(json!({ "sha": done.sha, "summary": mask(&done.summary) }))
    }

    /// `POST /api/sessions/{id}/push`.
    pub fn remote_git_push(&self, id: u32) -> Result<Value, ApiError> {
        let dir = self.remote_pane_dir(id)?;
        let summary = crate::git::push(&dir).map_err(|e| ApiError::Conflict(format!("{e:#}")))?;
        tracing::info!(
            "git push in {} for pane {id} from a device: {summary}",
            dir.display()
        );
        Ok(json!({ "ok": true, "summary": mask(&summary) }))
    }

    /// The pane's title, empty once it is gone.
    pub fn remote_pane_title(&self, id: u32) -> String {
        self.remote_pane_info(id)
            .map(|info| info.title)
            .unwrap_or_default()
    }

    /// Records a device's mutation in the activity feed, for the computer and other devices.
    pub fn remote_record_action(&self, id: u32, action: &'static str, device: &str, title: String) {
        self.remote
            .feed
            .activity_action(id, action, device, &title, now_ms());
    }
}

/// Cuts a diff at the byte and line limits on a line boundary.
fn bound_diff(text: &str) -> (String, bool) {
    let mut out = String::new();
    for (lines, line) in text.split_inclusive('\n').enumerate() {
        if lines >= DIFF_MAX_LINES || out.len() + line.len() > DIFF_MAX_BYTES {
            return (out, true);
        }
        out.push_str(line);
    }
    (out, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_is_cut_on_a_line_boundary_at_the_byte_limit() {
        let line = "x".repeat(99) + "\n";
        let text = line.repeat(DIFF_MAX_BYTES / 100 + 50);
        let (out, cut) = bound_diff(&text);
        assert!(cut);
        assert!(out.len() <= DIFF_MAX_BYTES && out.ends_with('\n'));
        assert_eq!(bound_diff("a\nb\n"), ("a\nb\n".to_string(), false));
    }

    #[test]
    fn a_diff_is_cut_at_the_line_limit() {
        let text = "\n".repeat(DIFF_MAX_LINES + 10);
        let (out, cut) = bound_diff(&text);
        assert!(cut);
        assert_eq!(out.len(), DIFF_MAX_LINES);
    }
}

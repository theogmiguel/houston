//! The review-request queue: a global, opt-in poll of the pull requests GitHub
//! says the operator was asked to review, deterministic triage into tiers, and
//! an optional read-only review pane. No LLM here, and no request while off.

use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::{now_unix_ms, CreateParams, Daemon};
use crate::db::{ReviewRequestRow, ReviewRequestWrite};

const MODE_KEY: &str = "review_requests_mode";
const PRIMED_KEY: &str = "review_requests_primed";
const LAST_TICK_KEY: &str = "review_requests_last_tick_ms";
const NOTE_KEY: &str = "review_requests_note";

/// One search page. Triaged requests outside a registered workspace are still
/// listed, so the page must cover the account's real queue.
const SEARCH_LIMIT: u32 = 100;

impl Daemon {
    pub fn review_requests_mode(&self) -> proto::ReviewRequestMode {
        match self.db.get_setting(MODE_KEY) {
            Ok(Some(raw)) => {
                crate::db::from_wire::<proto::ReviewRequestMode>(&raw).unwrap_or_else(|| {
                    tracing::warn!(
                        "review_requests mode {raw:?} is unknown (expected off, notify or review); using off"
                    );
                    proto::ReviewRequestMode::Off
                })
            }
            Ok(None) => proto::ReviewRequestMode::Off,
            Err(e) => {
                tracing::warn!("reading the review-request mode: {e:#}; using off");
                proto::ReviewRequestMode::Off
            }
        }
    }

    pub fn review_requests_set(&self, mode: proto::ReviewRequestMode) -> Result<proto::ServerMsg> {
        let previous = self.review_requests_mode();
        if previous == proto::ReviewRequestMode::Off && mode != proto::ReviewRequestMode::Off {
            // The next tick absorbs what was already open instead of
            // notifying about a backlog the operator has seen.
            self.db.set_setting(PRIMED_KEY, "0")?;
        }
        self.db
            .set_setting(MODE_KEY, &crate::db::wire_name(&mode)?)?;
        if mode == proto::ReviewRequestMode::Off {
            self.db.set_setting(NOTE_KEY, "")?;
        }
        let state = self.review_requests_state();
        self.broadcast_control(&state);
        Ok(state)
    }

    /// Dismiss or reopen one request. Both are visible decisions, and reopening
    /// leaves the row for the next tick to review again when the mode allows it.
    pub fn review_request_decide(
        &self,
        id: i64,
        state: proto::ReviewRequestState,
    ) -> Result<proto::ServerMsg> {
        if self.db.review_request(id)?.is_none() {
            bail!("no review request has id {id}; expected one of the listed request ids");
        }
        self.db.review_request_set_state(id, state, None)?;
        let reply = self.review_requests_state();
        self.broadcast_control(&reply);
        Ok(reply)
    }

    pub fn review_requests_state(&self) -> proto::ServerMsg {
        let mode = self.review_requests_mode();
        let now = now_unix_ms();
        let paused_until_ms = self.pr_reads.paused_until(now);
        let note = self
            .db
            .get_setting(NOTE_KEY)
            .ok()
            .flatten()
            .filter(|note| !note.trim().is_empty());
        let items = self
            .db
            .review_requests(proto::REVIEW_REQUESTS_MAX)
            .unwrap_or_default()
            .into_iter()
            .map(|row| {
                let provider = row.provider.or_else(|| {
                    row.workspace
                        .as_deref()
                        .map(|workspace| self.tasks_start_agent(workspace))
                });
                proto::ReviewRequest {
                    id: row.id,
                    host: row.host,
                    repo: row.repo,
                    number: row.number,
                    title: row.title,
                    author: row.author,
                    url: row.url,
                    head_sha: row.head_sha,
                    tier: row.tier,
                    reasons: row.reasons,
                    state: row.state,
                    workspace: row.workspace,
                    provider,
                }
            })
            .collect();
        proto::ServerMsg::ReviewRequests {
            mode,
            items,
            paused_until_ms,
            note,
        }
    }

    fn note_review_requests(&self, note: impl Into<String>) {
        let note = note.into();
        if let Err(e) = self.db.set_setting(NOTE_KEY, &note) {
            tracing::warn!("review requests: recording a note: {e:#}");
            return;
        }
        tracing::warn!("review requests: {note}");
        let state = self.review_requests_state();
        self.broadcast_control(&state);
    }

    pub async fn review_request_loop(self: Arc<Self>) {
        let mut last_tick = Instant::now();
        loop {
            if self.review_requests_mode() == proto::ReviewRequestMode::Off {
                tokio::time::sleep(Duration::from_secs(30)).await;
                last_tick = Instant::now();
                continue;
            }
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.review_request_tick()).await;
            let now = Instant::now();
            let gap = now.duration_since(last_tick);
            last_tick = now;
            let base = proto::REVIEW_REQUEST_POLL_MS;
            // One immediate catch-up tick after a sleep or a long stall, then
            // the normal interval with ±20 % jitter.
            let interval = if gap
                > Duration::from_millis(
                    base.saturating_mul(proto::REVIEW_REQUEST_CATCH_UP_FACTOR),
                )
            {
                1_000
            } else {
                let span = (base / 5).max(1);
                let jitter = crate::usage::time::now_ms().unsigned_abs() % (span * 2);
                base.saturating_sub(span).saturating_add(jitter)
            };
            tokio::time::sleep(Duration::from_millis(interval)).await;
        }
    }

    /// One poll and triage pass. Returns without a network call while the mode
    /// is off; a pause leaves the queue visible and skips the call.
    pub fn review_request_tick(self: &Arc<Self>) {
        if self.review_requests_mode() == proto::ReviewRequestMode::Off {
            return;
        }
        let now = now_unix_ms();
        if let Some(until_ms) = self.pr_reads.paused_until(now) {
            self.note_review_requests(crate::pull_requests::shared::pause_text(until_ms));
            return;
        }
        let workspaces = self.github_workspaces();
        let Some((poll_dir, _)) = workspaces.first() else {
            let bitbucket = self
                .workspace_list()
                .unwrap_or_default()
                .iter()
                .any(|workspace| {
                    matches!(
                        crate::forge::resolve(Path::new(&workspace.path)),
                        crate::forge::ForgeResolution::Ready(crate::forge::Forge::Bitbucket { .. })
                    )
                });
            self.note_review_requests(if bitbucket {
                "Bitbucket review-request polling is not implemented; GitHub only"
            } else {
                "no registered workspace has a GitHub remote; review requests cannot be polled"
            });
            return;
        };
        let requests = match crate::gh::search_review_requested_prs(poll_dir, SEARCH_LIMIT) {
            Ok(requests) => requests,
            Err(e) => {
                let text = format!("{e:#}");
                if crate::gh::is_rate_limited(&text) {
                    let until = self
                        .pr_reads
                        .pause(now, &text, || crate::gh::rate_limit_reset(poll_dir, now));
                    self.note_review_requests(crate::pull_requests::shared::pause_text(until));
                } else if looks_like_auth_refusal(&text) {
                    self.note_review_requests(format!(
                        "credential invalid or expired: {text}; Settings > Accounts signs gh in again"
                    ));
                } else {
                    self.note_review_requests(format!(
                        "the review-request search did not run: {text}"
                    ));
                }
                return;
            }
        };
        let primed = self.db.get_setting(PRIMED_KEY).ok().flatten().as_deref() == Some("1");
        let mut changed = false;
        for request in requests {
            if request.is_draft {
                continue;
            }
            // A head already in the queue needs no second triage or notice.
            match self.db.review_request_exists(
                "github.com",
                &request.repo,
                request.number,
                &request.head_sha,
            ) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(
                        "review requests: checking {}#{}: {e:#}",
                        request.repo,
                        request.number
                    );
                    continue;
                }
            }
            let matched = workspaces
                .iter()
                .find(|(_, repo)| repo.eq_ignore_ascii_case(&request.repo))
                .cloned();
            let provider = matched
                .as_ref()
                .map(|(dir, _)| self.tasks_start_agent(&dir.display().to_string()));
            let (tier, reasons) = if !primed {
                (
                    proto::ReviewTier::B,
                    vec!["absorbed on first run; a new push is triaged".to_string()],
                )
            } else if let Some((dir, _)) = &matched {
                match self.triage_request(dir, request.number) {
                    Ok(verdict) => (verdict.tier, verdict.reasons),
                    Err(e) => (
                        proto::ReviewTier::B,
                        vec![format!("triage did not run: {e:#}")],
                    ),
                }
            } else {
                (
                    proto::ReviewTier::B,
                    vec![format!("no workspace for {}", request.repo)],
                )
            };
            let workspace_path = matched.as_ref().map(|(dir, _)| dir.display().to_string());
            let write = ReviewRequestWrite {
                host: "github.com",
                repo: &request.repo,
                number: request.number,
                head_sha: &request.head_sha,
                title: &request.title,
                author: &request.author,
                url: &request.url,
                tier,
                reasons: &reasons,
                workspace: workspace_path.as_deref(),
                provider,
                absorbed: !primed,
            };
            let (row, inserted) = match self.db.review_request_seen(&write, now) {
                Ok(result) => result,
                Err(e) => {
                    tracing::warn!(
                        "review requests: recording {}#{}: {e:#}",
                        request.repo,
                        request.number
                    );
                    continue;
                }
            };
            if !inserted {
                continue;
            }
            changed = true;
            if primed {
                self.broadcast_control(&proto::ServerMsg::ReviewRequestNotice {
                    id: row.id,
                    repo: row.repo.clone(),
                    number: row.number,
                    title: row.title.clone(),
                    tier: row.tier,
                });
            }
        }
        if !primed {
            let _ = self.db.set_setting(PRIMED_KEY, "1");
        }
        let _ = self.db.set_setting(LAST_TICK_KEY, &now.to_string());
        self.settle_reviewing_requests();
        if self.review_requests_mode() == proto::ReviewRequestMode::Review {
            self.spawn_pending_reviews();
        }
        if changed {
            let state = self.review_requests_state();
            self.broadcast_control(&state);
        }
    }

    fn triage_request(&self, dir: &Path, number: u32) -> Result<crate::review_triage::Verdict> {
        let _ = crate::git::fetch(dir);
        let facts = crate::gh::review_request_facts(dir, number)?;
        Ok(crate::review_triage::triage(&crate::review_triage::Facts {
            files: facts
                .files
                .into_iter()
                .map(
                    |(path, additions, deletions)| crate::review_triage::FileFacts {
                        path,
                        additions,
                        deletions,
                    },
                )
                .collect(),
            base: facts.base,
            ci_green: facts.ci_green,
        }))
    }

    fn github_workspaces(&self) -> Vec<(PathBuf, String)> {
        let mut out: Vec<(PathBuf, String)> = Vec::new();
        for workspace in self.workspace_list().unwrap_or_default() {
            let dir = PathBuf::from(&workspace.path);
            let Some(url) = crate::git::remote_url(&dir) else {
                continue;
            };
            if !matches!(
                crate::forge::resolve_url(&url),
                crate::forge::ForgeResolution::Ready(crate::forge::Forge::GitHub)
            ) {
                continue;
            }
            let Some((owner, name)) = crate::gh::split_repository(&url) else {
                continue;
            };
            let repo = format!("{owner}/{name}");
            if out
                .iter()
                .any(|(_, known)| known.eq_ignore_ascii_case(&repo))
            {
                continue;
            }
            out.push((dir, repo));
        }
        out
    }

    /// A review pane that exited makes its request `reviewed`; a dismissed one
    /// keeps its decision.
    fn settle_reviewing_requests(&self) {
        let rows = match self.db.review_requests(proto::REVIEW_REQUESTS_MAX) {
            Ok(rows) => rows,
            Err(_) => return,
        };
        for row in rows {
            if row.state != proto::ReviewRequestState::Reviewing {
                continue;
            }
            let Some(session) = row.session_id else {
                let _ = self.db.review_request_set_state(
                    row.id,
                    proto::ReviewRequestState::Reviewed,
                    None,
                );
                continue;
            };
            if !self.session_live(session) {
                if let Ok(true) = self.db.review_request_set_state(
                    row.id,
                    proto::ReviewRequestState::Reviewed,
                    Some(session),
                ) {
                    tracing::info!(
                        "review requests: {}#{} finished reviewing",
                        row.repo,
                        row.number
                    );
                }
            }
        }
    }

    fn session_live(&self, id: u32) -> bool {
        let sessions = self.sessions.lock().expect("sessions lock");
        sessions
            .get(&id)
            .is_some_and(|session| session.state.lock().expect("state lock").is_live())
    }

    fn spawn_pending_reviews(self: &Arc<Self>) {
        let rows = match self.db.review_requests(proto::REVIEW_REQUESTS_MAX) {
            Ok(rows) => rows,
            Err(_) => return,
        };
        for row in rows {
            if row.state != proto::ReviewRequestState::New {
                continue;
            }
            // The first poll after enabling only records the backlog; spending a
            // reviewer on every already-open request is the operator's choice.
            if row.absorbed {
                continue;
            }
            if row.tier == proto::ReviewTier::A {
                continue;
            }
            let Some(workspace) = row.workspace.as_deref() else {
                continue;
            };
            let provider = row
                .provider
                .unwrap_or_else(|| self.tasks_start_agent(workspace));
            if !spawnable(provider) {
                self.note_review_requests(format!(
                    "{}#{} was not opened: the workspace default task agent {provider:?} cannot be started",
                    row.repo, row.number
                ));
                continue;
            }
            match self.spawn_review_request_pane(&row, workspace, provider) {
                Ok(session) => {
                    let _ = self.db.review_request_set_state(
                        row.id,
                        proto::ReviewRequestState::Reviewing,
                        Some(session),
                    );
                    self.note_review_requests(format!(
                        "{}#{} opened a read-only review pane (session {session})",
                        row.repo, row.number
                    ));
                    let state = self.review_requests_state();
                    self.broadcast_control(&state);
                }
                Err(e) => {
                    self.note_review_requests(format!(
                        "{}#{} was not opened: {e:#}",
                        row.repo, row.number
                    ));
                }
            }
        }
    }

    fn spawn_review_request_pane(
        self: &Arc<Self>,
        row: &ReviewRequestRow,
        workspace: &str,
        provider: proto::AgentKind,
    ) -> Result<u32> {
        let project = PathBuf::from(workspace);
        if !project.is_dir() {
            bail!("workspace {workspace} is not a directory");
        }
        let branch = format!(
            "houston/review-{}-{}-{}",
            crate::git::ref_slug(&row.repo),
            row.number,
            &row.head_sha[..row.head_sha.len().min(8)]
        );
        crate::git::fetch_ref(
            &project,
            &format!("pull/{}/head:refs/heads/{branch}", row.number),
        )
        .context("fetching the pull request head")?;
        let slug = format!(
            "review-{}-{}-{}",
            crate::git::ref_slug(&row.repo),
            row.number,
            &row.head_sha[..row.head_sha.len().min(8)]
        );
        let dest = crate::worktrees::default_path(self.state_dir(), workspace, &slug);
        if let Some(parent) = dest.parent() {
            crate::worktrees::ensure_ignored(parent)?;
        }
        let _ = crate::worktrees::prune(&project);
        crate::worktrees::create_detached(&project, &branch, &dest)
            .context("opening the read-only review worktree")?;
        if let Ok(common) = crate::git::checkout_facts(&project)
            .common_dir
            .ok_or_else(|| anyhow::anyhow!("no git common directory"))
        {
            let _ = self
                .db
                .managed_worktree_record(&crate::db::ManagedWorktreeRow {
                    path: dest.display().to_string(),
                    repo_common_dir: common,
                    branch: branch.clone(),
                    base_branch: crate::git::default_base(&project),
                    provenance: crate::db::WorktreeProvenance::PaneSpawn,
                    created_by_session: None,
                    created_at_ms: now_unix_ms(),
                    bytes: None,
                    measured_at_ms: None,
                });
        }
        let focus = self.tasks_review_focus(workspace);
        let brief = review_request_brief(row, &focus);
        let info = self
            .create_session(CreateParams {
                agent: provider,
                project_dir: dest,
                cmd: None,
                cols: 120,
                rows: 32,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: Some(brief),
                model: None,
                effort: None,
            })
            .context("opening the review pane")?;
        Ok(info.id)
    }
}

fn spawnable(agent: proto::AgentKind) -> bool {
    matches!(
        agent,
        proto::AgentKind::Claude
            | proto::AgentKind::Codex
            | proto::AgentKind::Antigravity
            | proto::AgentKind::Opencode
            | proto::AgentKind::Zcode
    )
}

fn looks_like_auth_refusal(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("http 401")
        || lower.contains("http 403")
        || lower.contains("bad credentials")
        || lower.contains("authentication")
        || lower.contains("not logged")
        || lower.contains("gh auth login")
}

fn review_request_brief(row: &ReviewRequestRow, focus: &proto::TaskReviewFocus) -> String {
    let tier = match row.tier {
        proto::ReviewTier::A => "A",
        proto::ReviewTier::B => "B",
        proto::ReviewTier::C => "C",
    };
    let focus = match focus {
        proto::TaskReviewFocus::Bugs => "bugs and regressions first",
        proto::TaskReviewFocus::Security => {
            "security: authorization, injection, secrets and trust boundaries"
        }
        proto::TaskReviewFocus::Performance => "performance: hot paths and unbounded work",
        proto::TaskReviewFocus::Full => {
            "a full review: bugs, security, performance, tests and maintainability"
        }
    };
    format!(
        "Review pull request {} at head {}.\n\
         \n\
         This is a read-only review. Do not post anything to the forge, do not comment, do not \
         approve or request changes, and do not push. Report findings in this pane only; the \
         operator decides what happens next.\n\
         \n\
         Tier {tier}: {}\n\
         Focus: {focus}.\n",
        row.url,
        row.head_sha,
        row.reasons.join("; ")
    )
}

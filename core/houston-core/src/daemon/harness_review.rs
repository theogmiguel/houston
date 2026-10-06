//! Harness review runs as the Harness view sees them: one review row per run
//! of a workspace's review routine, filled by the run's own `harness_publish`.
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use serde_json::json;

use super::{now_unix_ms, Daemon};
use crate::db::TaskWrite;

/// The hand-back's one line, as `pane_submit` bounds its own summary.
const SUMMARY_MAX_CHARS: usize = 200;
const HARNESS_TASK_ACTOR: &str = "houston:harness";

impl Daemon {
    pub fn harness_state(&self, workspace: &str) -> Result<proto::ServerMsg> {
        let routine = match self.db.harness_routine_id(workspace)? {
            Some(id) => self.db.routine(id)?.map(Self::routine_row_to_wire),
            None => None,
        };
        let reviews = self
            .db
            .list_harness_reviews(workspace, proto::HARNESS_REVIEWS_PAGE)?
            .into_iter()
            .map(|r| proto::HarnessReview {
                id: r.id,
                workspace: r.workspace,
                routine_id: r.routine_id,
                run_id: r.run_id,
                session_id: r.session_id,
                status: r.status,
                started_at_ms: r.started_at_ms,
                ended_at_ms: r.ended_at_ms,
                run_dir: r.run_dir,
                window: r.window,
                sessions: r.sessions,
                prompts: r.prompts,
                cost_usd: r.cost_usd,
                finding_count: r.finding_count,
                summary: r.summary,
                error: r.error,
            })
            .collect();
        Ok(proto::ServerMsg::HarnessState {
            workspace: workspace.to_string(),
            routine,
            reviews,
            findings: self.harness_findings(workspace)?,
            models: self.model_catalog.model_options(),
            provider_coverage: self.harness_provider_coverage(workspace)?,
        })
    }

    /// One finding per key, from the newest review that raised it. A decision
    /// taken before that review published is a decision on older evidence, so
    /// the finding reopens as `recurred`.
    fn harness_findings(&self, workspace: &str) -> Result<Vec<proto::HarnessFinding>> {
        let decisions: HashMap<String, (proto::HarnessFindingState, i64, String)> = self
            .db
            .harness_decisions(workspace)?
            .into_iter()
            .map(|d| (d.key, (d.state, d.decided_at_ms, d.decided_by)))
            .collect();
        let latest_review_id = self
            .db
            .latest_published_harness_review(workspace)?
            .unwrap_or(0);
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for row in self.db.harness_findings(workspace)? {
            if !seen.insert(row.finding.key.clone()) {
                continue;
            }
            let (state, decided_at_ms, recurred) = match decisions.get(&row.finding.key) {
                Some((state, at, _)) if *at >= row.review_ended_at_ms => (*state, Some(*at), false),
                Some(_) => (proto::HarnessFindingState::Open, None, true),
                None => (proto::HarnessFindingState::Open, None, false),
            };
            let links = self.db.harness_finding_tasks(workspace, &row.finding.key)?;
            let selected_task = links
                .iter()
                .find(|link| {
                    !matches!(
                        link.status,
                        proto::TaskStatus::Done | proto::TaskStatus::Canceled
                    )
                })
                .or_else(|| links.first());
            let verification = self
                .db
                .latest_harness_verification(workspace, &row.finding.key)?;
            let last_seen_review_id = latest_review_id.max(row.review_id);
            let has_newer_open_task = selected_task.is_some_and(|task| {
                !matches!(
                    task.status,
                    proto::TaskStatus::Done | proto::TaskStatus::Canceled
                ) && verification
                    .as_ref()
                    .is_none_or(|v| task.created_at_ms > v.review_ended_at_ms)
            });
            let latest_review_did_not_raise = latest_review_id > row.review_id
                && verification
                    .as_ref()
                    .is_none_or(|v| latest_review_id > v.review_id);
            let phase = if state == proto::HarnessFindingState::Resolved {
                proto::HarnessFindingPhase::Resolved
            } else if state == proto::HarnessFindingState::Dismissed {
                proto::HarnessFindingPhase::Dismissed
            } else if has_newer_open_task {
                proto::HarnessFindingPhase::Fixing
            } else if latest_review_did_not_raise {
                proto::HarnessFindingPhase::NotSeen
            } else if let Some(v) = verification.as_ref() {
                match v.verdict {
                    proto::HarnessVerdict::Gone => proto::HarnessFindingPhase::Resolved,
                    proto::HarnessVerdict::StillPresent => proto::HarnessFindingPhase::Open,
                    proto::HarnessVerdict::Inconclusive => {
                        proto::HarnessFindingPhase::AwaitingVerification
                    }
                }
            } else if let Some(task) = selected_task {
                if task.status == proto::TaskStatus::Done {
                    proto::HarnessFindingPhase::AwaitingVerification
                } else if task.status != proto::TaskStatus::Canceled {
                    proto::HarnessFindingPhase::Fixing
                } else if last_seen_review_id > row.review_id {
                    proto::HarnessFindingPhase::NotSeen
                } else {
                    proto::HarnessFindingPhase::Open
                }
            } else if last_seen_review_id > row.review_id {
                proto::HarnessFindingPhase::NotSeen
            } else {
                proto::HarnessFindingPhase::Open
            };
            let f = row.finding;
            let quotes = verification
                .as_ref()
                .filter(|v| v.verdict == proto::HarnessVerdict::StillPresent)
                .map(|v| v.evidence.clone())
                .filter(|quotes| !quotes.is_empty())
                .unwrap_or(f.quotes);
            out.push(proto::HarnessFinding {
                review_id: row.review_id,
                key: f.key,
                title: f.title,
                category: f.category,
                confidence: f.confidence,
                sessions: f.sessions,
                count: f.count,
                quotes,
                recommendation_kind: f.recommendation_kind,
                target: f.target,
                recommendation: f.recommendation,
                apply_prompt: f.apply_prompt,
                state,
                decided_at_ms,
                recurred,
                phase,
                task: selected_task.map(|task| proto::HarnessFindingTask {
                    task_id: task.task_id,
                    key: Self::task_key(task.task_number),
                    status: task.status,
                    landed_at_ms: task.landed_at_ms,
                }),
                verification: verification.map(|v| proto::HarnessVerification {
                    review_id: v.review_id,
                    verdict: v.verdict,
                    sessions_after: v.sessions_after,
                    quotes: v.evidence,
                }),
                last_seen_review_id,
            });
        }
        Ok(out)
    }

    fn harness_provider_coverage(
        &self,
        workspace: &str,
    ) -> Result<Vec<proto::HarnessProviderCoverage>> {
        let Some(review) = self
            .db
            .list_harness_reviews(workspace, proto::HARNESS_REVIEWS_PAGE)?
            .into_iter()
            .find(|r| r.status == proto::HarnessReviewStatus::Published)
        else {
            return Ok(Vec::new());
        };
        let Some((since, until)) = review.window else {
            return Ok(Vec::new());
        };
        let since = crate::harness::window::parse_day(&since)?;
        let until = crate::harness::window::parse_day(&until)? + crate::harness::window::DAY_MS;
        Ok(self
            .db
            .harness_unread_session_counts(workspace, since, until)?
            .into_iter()
            .map(|(agent, sessions)| proto::HarnessProviderCoverage { agent, sessions })
            .collect())
    }

    pub fn harness_overview(&self) -> Result<proto::ServerMsg> {
        let mut rows = Vec::new();
        for workspace in self.db.harness_workspaces()? {
            let findings = self.harness_findings(&workspace)?;
            let seen_review_id = self.db.harness_seen_review_id(&workspace)?;
            let mut row = proto::HarnessAttention {
                workspace: workspace.clone(),
                open: 0,
                fixing: 0,
                awaiting_verification: 0,
                not_seen: 0,
                resolved: 0,
                dismissed: 0,
                latest_published_review_id: self.db.latest_published_harness_review(&workspace)?,
                seen_review_id,
                attention: 0,
            };
            for finding in findings {
                match finding.phase {
                    proto::HarnessFindingPhase::Open => row.open += 1,
                    proto::HarnessFindingPhase::Fixing => row.fixing += 1,
                    proto::HarnessFindingPhase::AwaitingVerification => {
                        row.awaiting_verification += 1
                    }
                    proto::HarnessFindingPhase::NotSeen => row.not_seen += 1,
                    proto::HarnessFindingPhase::Resolved => row.resolved += 1,
                    proto::HarnessFindingPhase::Dismissed => row.dismissed += 1,
                }
                if finding.last_seen_review_id > seen_review_id
                    && matches!(
                        finding.phase,
                        proto::HarnessFindingPhase::Open
                            | proto::HarnessFindingPhase::NotSeen
                            | proto::HarnessFindingPhase::AwaitingVerification
                    )
                {
                    row.attention += 1;
                }
            }
            rows.push(row);
        }
        Ok(proto::ServerMsg::HarnessOverview { rows })
    }

    pub fn harness_seen(&self, workspace: &str, review_id: u32) -> Result<()> {
        let latest = self
            .db
            .latest_published_harness_review(workspace)?
            .unwrap_or(0);
        self.db
            .advance_harness_seen_review_id(workspace, review_id.min(latest))?;
        self.broadcast_harness_changed(workspace);
        Ok(())
    }

    pub fn harness_fix_task(
        self: &std::sync::Arc<Self>,
        workspace: &str,
        key: &str,
        agent: Option<proto::AgentKind>,
        start: bool,
        prompt: Option<&str>,
    ) -> Result<proto::ServerMsg> {
        let refuse = |kind, message: String| proto::ServerMsg::TaskRefused {
            id: None,
            kind,
            limit: None,
            requested: None,
            expected: None,
            actual: None,
            message,
        };
        if key.is_empty()
            || key.len() > 80
            || !key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Ok(refuse(proto::TaskErrorKind::Invalid, format!("harness_fix_task refused: key {key:?} (expected lowercase kebab-case, at most 80 characters)")));
        }
        if !self.workspace_list()?.iter().any(|w| w.path == workspace) {
            return Ok(refuse(proto::TaskErrorKind::Invalid, format!("harness_fix_task refused: workspace {workspace:?} is not registered (expected a registered workspace path)")));
        }
        let access = self.tasks_access(workspace);
        if access != proto::TasksAccess::Write {
            let (actual, kind) = match access {
                proto::TasksAccess::Off => ("off", proto::TaskErrorKind::AccessOff),
                proto::TasksAccess::Read => ("read", proto::TaskErrorKind::ReadOnly),
                proto::TasksAccess::Write => unreachable!(),
            };
            return Ok(refuse(kind, format!("harness_fix_task refused: tasks access for workspace {workspace:?} is {actual} (actual: {actual}, expected write); change Settings ▸ Tasks")));
        }
        let Some(finding) = self
            .db
            .harness_findings(workspace)?
            .into_iter()
            .find(|f| f.finding.key == key)
        else {
            return Ok(refuse(proto::TaskErrorKind::Invalid, format!("harness_fix_task refused: key {key:?} is not a finding in workspace {workspace:?} (expected a published finding key)")));
        };
        let task_count = self.db.task_count("all")?;
        if task_count >= proto::TASKS_PER_WORKSPACE {
            return Ok(proto::ServerMsg::TaskRefused {
                id: None,
                kind: proto::TaskErrorKind::Limit,
                limit: Some(proto::TASKS_PER_WORKSPACE),
                requested: Some(u64::from(task_count) + 1),
                expected: None,
                actual: Some(i64::from(task_count)),
                message: format!("harness_fix_task refused: backlog has {task_count} tasks; limit is {} for this operation", proto::TASKS_PER_WORKSPACE),
            });
        }
        let apply_prompt = prompt.unwrap_or(&finding.finding.apply_prompt);
        let title = format!("Harness: {}", finding.finding.title);
        let previous_task = self
            .db
            .harness_finding_tasks(workspace, key)?
            .first()
            .map(|task| Self::task_key(task.task_number));
        let previous = previous_task
            .as_ref()
            .map(|task| format!("Previous fix task: {task}\n"))
            .unwrap_or_default();
        let description = format!(
            "Finding: {key}\nReview: #{}\n{previous}Recommendation: {}\nTarget: {}\nApply prompt: {}",
            finding.review_id, finding.finding.recommendation, finding.finding.target, apply_prompt
        );
        let title_len = title.chars().count();
        let description_len = description.chars().count();
        if title_len > proto::TASK_TITLE_MAX || description_len > proto::TASK_DESCRIPTION_MAX {
            return Ok(refuse(
                proto::TaskErrorKind::Invalid,
                format!(
                    "harness_fix_task refused for key {key:?}: generated title has {title_len} characters (limit {}), and description has {description_len} characters (limit {})",
                    proto::TASK_TITLE_MAX,
                    proto::TASK_DESCRIPTION_MAX,
                ),
            ));
        }
        let acceptance = vec![format!(
            "{} contains the recommended change for finding {key}.",
            finding.finding.target
        )];
        let (created, existing) = self.db.create_harness_task(
            &TaskWrite {
                workspace: Some(workspace),
                title: &title,
                description: &description,
                status: proto::TaskStatus::Todo,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: HARNESS_TASK_ACTOR,
                now_ms: now_unix_ms(),
                acceptance: &acceptance,
            },
            key,
            finding.review_id,
        )?;
        let Some(task) = created else {
            let number = existing.expect("create_harness_task returns either a task or a conflict");
            let task_key = Self::task_key(number);
            return Ok(refuse(proto::TaskErrorKind::Busy, format!("harness_fix_task refused for finding {key:?}: open fix task {task_key} already exists (expected no open linked fix task)")));
        };
        let changed = proto::ServerMsg::TaskChanged {
            workspace: Some(workspace.to_string()),
            id: task.id,
            revision: task.revision,
        };
        if start {
            let agent = agent.unwrap_or_else(|| self.tasks_start_agent(workspace));
            match self.task_start(task.id, agent, None)? {
                msg @ proto::ServerMsg::TaskChanged { .. } => self.broadcast_control(&msg),
                msg @ proto::ServerMsg::TaskRunChanged { .. } => self.broadcast_control(&msg),
                refused @ proto::ServerMsg::TaskRefused { .. } => self.broadcast_control(&refused),
                _ => {}
            }
        }
        self.broadcast_harness_changed(workspace);
        Ok(changed)
    }

    /// The preset routine, with the provider, model, cadence and switch the
    /// Harness view chose. Answers `routines` to broadcast, or a refusal.
    pub fn harness_routine_create(
        &self,
        workspace: &str,
        engine: proto::AgentKind,
        model: Option<String>,
        effort: Option<proto::ChatEffort>,
        cadence: proto::Cadence,
        enabled: bool,
    ) -> Result<proto::ServerMsg> {
        if !Path::new(workspace).is_dir() {
            bail!("harness review refused: workspace {workspace:?} is not a directory");
        }
        if let Some(id) = self.db.harness_routine_id(workspace)? {
            bail!(
                "workspace {workspace} already has its Harness review routine (routine {id}); \
                 change it instead of creating another"
            );
        }
        let p = crate::routines::harness_review_preset(workspace);
        let name = (1..=proto::ROUTINES_TOTAL)
            .map(|n| match n {
                1 => p.name.clone(),
                n => format!("{} {n}", p.name),
            })
            .find(|name| {
                !self
                    .db
                    .routine_name_taken(&crate::routines::fold_name(name), None)
                    .unwrap_or(true)
            })
            .ok_or_else(|| anyhow!("every Harness review routine name for {workspace} is taken"))?;
        let msg = self.routine_create_impl(
            &name,
            &p.prompt,
            cadence,
            Some(p.workspace_id),
            engine,
            model,
            effort,
            Some(p.permission_mode),
            Some(p.isolate),
            enabled,
        )?;
        if let proto::ServerMsg::Routines { routines, .. } = &msg {
            let folded = crate::routines::fold_name(&name);
            let created = routines
                .iter()
                .find(|r| crate::routines::fold_name(&r.name) == folded)
                .ok_or_else(|| {
                    anyhow!("the Harness review routine {name:?} was not listed after creation")
                })?;
            self.db.set_harness_routine(workspace, created.id)?;
            self.broadcast_harness_changed(workspace);
        }
        Ok(msg)
    }

    pub fn harness_report(&self, review_id: u32) -> Result<proto::ServerMsg> {
        let review = self
            .db
            .harness_review(review_id)?
            .ok_or_else(|| anyhow!("no harness review with id {review_id}"))?;
        let path = Path::new(&review.run_dir).join("report.md");
        let file = std::fs::File::open(&path)
            .with_context(|| format!("review {review_id} has no report at {}", path.display()))?;
        let cap = proto::HARNESS_REPORT_MAX_BYTES;
        let mut bytes = Vec::new();
        file.take(cap as u64 + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("reading {}", path.display()))?;
        let truncated = bytes.len() > cap;
        bytes.truncate(cap);
        Ok(proto::ServerMsg::HarnessReport {
            review_id,
            markdown: String::from_utf8_lossy(&bytes).into_owned(),
            truncated,
        })
    }

    pub fn harness_decide(
        &self,
        workspace: &str,
        key: &str,
        state: proto::HarnessFindingState,
    ) -> Result<()> {
        if !self.db.harness_finding_exists(workspace, key)? {
            bail!("no finding with key {key:?} in the harness reviews of {workspace}");
        }
        self.db
            .set_harness_decision(workspace, key, state, now_unix_ms())?;
        self.broadcast_harness_changed(workspace);
        Ok(())
    }

    fn broadcast_harness_changed(&self, workspace: &str) {
        self.broadcast_control(&proto::ServerMsg::HarnessChanged {
            workspace: workspace.to_string(),
        });
    }

    /// The in-flight run whose pane is `session`, as (routine, run).
    fn routine_run_of_pane(&self, session: u32) -> Option<(u32, u32)> {
        self.routine_runs
            .lock()
            .expect("routine run lock")
            .iter()
            .find(|(_, run)| run.session_id == Some(session))
            .map(|(routine, run)| (*routine, run.run_id))
    }

    /// Whether `session` is the pane of a Harness review run still in flight:
    /// the only pane `harness_publish` is offered to.
    pub(crate) fn is_harness_review_pane(&self, session: u32) -> bool {
        self.routine_run_of_pane(session)
            .is_some_and(|(_, run)| matches!(self.db.harness_review_by_run(run), Ok(Some(_))))
    }

    /// Stores the run's `findings.json` and points the view at its
    /// `report.md`. Returns the note the agent is shown.
    pub fn harness_publish(&self, caller: u32, summary: Option<String>) -> Result<String> {
        let refused = || {
            anyhow!(
                "harness_publish refused: pane {caller} is not a Harness review run in flight; \
                 only the pane Houston opened for a Harness review publishes, before its turn ends"
            )
        };
        let (_, run_id) = self.routine_run_of_pane(caller).ok_or_else(refused)?;
        let review = self.db.harness_review_by_run(run_id)?.ok_or_else(refused)?;
        let dir = Path::new(&review.run_dir);
        let findings_path = dir.join("findings.json");
        let report_path = dir.join("report.md");
        if !report_path.is_file() {
            bail!(
                "harness_publish refused: {} does not exist; write report.md and findings.json \
                 into the run directory first",
                report_path.display()
            );
        }
        let size = std::fs::metadata(&findings_path)
            .with_context(|| {
                format!(
                    "harness_publish refused: reading {}",
                    findings_path.display()
                )
            })?
            .len();
        if size > crate::harness::findings::FINDINGS_MAX_BYTES {
            bail!(
                "harness_publish refused: {} is {size} bytes, over the {} byte cap",
                findings_path.display(),
                crate::harness::findings::FINDINGS_MAX_BYTES
            );
        }
        let body = std::fs::read_to_string(&findings_path)
            .with_context(|| format!("reading {}", findings_path.display()))?;
        let linked_tasks: HashMap<String, Vec<(String, i64, u32)>> = self
            .db
            .harness_findings(&review.workspace)?
            .into_iter()
            .map(|row| {
                let key = row.finding.key;
                self.db
                    .harness_finding_tasks(&review.workspace, &key)
                    .map(|tasks| {
                        (
                            key,
                            tasks
                                .into_iter()
                                .map(|task| {
                                    (
                                        Self::task_key(task.task_number),
                                        task.task_id,
                                        task.sessions_since_landed,
                                    )
                                })
                                .collect(),
                        )
                    })
            })
            .collect::<Result<_>>()?;
        let parsed = crate::harness::findings::parse_with_links(&body, &linked_tasks)?;
        let summary = summary
            .map(|s| crate::orchestrate::sanitize_handoff_text(s.trim()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{} findings", parsed.findings.len()));
        let summary: String = summary.chars().take(SUMMARY_MAX_CHARS).collect();
        self.db.publish_harness_review(
            review.id,
            &crate::db::HarnessPublication {
                window: parsed
                    .window
                    .as_ref()
                    .map(|(a, b)| (a.as_str(), b.as_str())),
                sessions: parsed.sessions,
                prompts: parsed.prompts,
                cost_usd: parsed.cost_usd,
                summary: &summary,
                findings: &parsed.findings,
                verifications: &parsed.verifications,
            },
            now_unix_ms(),
        )?;
        for verification in &parsed.verifications {
            let note = match verification.verdict {
                proto::HarnessVerdict::Gone => Some(format!(
                    "Harness review {} verified finding {} as gone.",
                    review.id, verification.key
                )),
                proto::HarnessVerdict::StillPresent => Some(format!(
                    "Harness review {} found finding {} still present; evidence is available in Harness.",
                    review.id, verification.key
                )),
                proto::HarnessVerdict::Inconclusive => None,
            };
            if let Some(note) = note {
                match self.task_comment_as(
                    None,
                    verification.task_id,
                    &note,
                    HARNESS_TASK_ACTOR,
                    "harness_verification",
                ) {
                    Ok(msg @ proto::ServerMsg::TaskChanged { .. }) => self.broadcast_control(&msg),
                    Ok(proto::ServerMsg::TaskRefused { message, .. }) => tracing::warn!(
                        "Harness verification comment for task {} refused: {message}",
                        verification.task_id
                    ),
                    Ok(_) => {}
                    Err(e) => tracing::warn!(
                        "writing Harness verification comment for task {}: {e:#}",
                        verification.task_id
                    ),
                }
            }
        }
        self.broadcast_harness_changed(&review.workspace);
        Ok(format!(
            "published {} findings from {}; the operator reads them in Houston's Harness view. \
             Your work is done: end your turn.",
            parsed.findings.len(),
            dir.display()
        ))
    }

    /// Opens the review row of a Harness routine's run. `dir` is where the
    /// pane starts; `None` for a run refused before it had one.
    pub(super) fn harness_review_start(
        &self,
        row: &crate::db::RoutineRow,
        run_id: u32,
        dir: Option<&str>,
        now: i64,
    ) {
        let workspace = match self.db.harness_workspace_of_routine(row.id) {
            Ok(Some(ws)) => ws,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("reading routine {}'s harness mapping: {e:#}", row.id);
                return;
            }
        };
        let run_dir = match dir {
            Some(dir) => match self.harness_prepare_run_dir(&workspace, Path::new(dir), run_id) {
                Ok(path) => path.to_string_lossy().into_owned(),
                Err(e) => {
                    tracing::warn!("preparing harness review run {run_id}'s directory: {e:#}");
                    String::new()
                }
            },
            None => String::new(),
        };
        if let Err(e) = self
            .db
            .create_harness_review(&workspace, row.id, run_id, &run_dir, now)
        {
            tracing::warn!("recording harness review run {run_id}: {e:#}");
            return;
        }
        self.broadcast_harness_changed(&workspace);
    }

    /// Creates the run directory and writes `decisions.json`: the findings
    /// earlier reviews raised and the operator's decision on each.
    pub fn harness_prepare_run_dir(
        &self,
        workspace: &str,
        pane_dir: &Path,
        run_id: u32,
    ) -> Result<std::path::PathBuf> {
        let dir = crate::harness::prepare_run_dir(pane_dir, &format!("r{run_id}"))?;
        let findings = self
            .harness_findings(workspace)?
            .into_iter()
            .map(|f| {
                let linked_tasks = self.db.harness_finding_tasks(workspace, &f.key)?;
                Ok(json!({
                    "key": f.key,
                    "title": f.title,
                    "state": f.state,
                    "decided_at": f.decided_at_ms.map(crate::harness::window::format_ms),
                    "linked_tasks": linked_tasks.iter().map(|task| json!({
                        "task": Self::task_key(task.task_number),
                        "status": task.status,
                        "landed_at_ms": task.landed_at_ms,
                        "sessions_since_landed": task.sessions_since_landed,
                    })).collect::<Vec<_>>(),
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        let path = dir.join("decisions.json");
        let body = serde_json::to_string_pretty(&json!({
            "schema": 2,
            "minimum_sessions_after_landing": crate::harness::findings::MIN_SESSIONS_AFTER_LANDING,
            "findings": findings
        }))?;
        std::fs::write(&path, body + "\n")
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(dir)
    }

    pub(super) fn harness_review_session(&self, run_id: u32, session: u32) {
        if let Err(e) = self.db.set_harness_review_session(run_id, session) {
            tracing::warn!("recording harness review run {run_id}'s pane: {e:#}");
        }
    }

    /// A run that ends without publishing leaves a failed review, never a
    /// review that looks finished.
    pub(super) fn harness_review_settle(&self, run_id: u32, error: Option<&str>) {
        let Ok(Some(review)) = self.db.harness_review_by_run(run_id) else {
            return;
        };
        let why = match error {
            Some(e) => format!("the run ended without publishing: {e}"),
            None => "the run ended without publishing: its agent never called harness_publish"
                .to_string(),
        };
        match self.db.fail_harness_review(run_id, &why, now_unix_ms()) {
            Ok(true) => self.broadcast_harness_changed(&review.workspace),
            Ok(false) => {}
            Err(e) => tracing::warn!("closing harness review run {run_id}: {e:#}"),
        }
    }
}

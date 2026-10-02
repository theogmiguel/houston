//! The Tasks view: a per-workspace backlog a user (and, once slice 2 lands, an
//! agent) reads and edits over the control wire. Every refusal is a typed
//! `TaskRefused`, so a client can tell a stale edit from a cap or the switch.
use anyhow::{bail, Result};
use houston_protocol as proto;

use super::{now_unix_ms, Daemon};
use crate::db::{
    TaskAcceptanceRow, TaskCommentRow, TaskHistoryRow, TaskQuery, TaskRow, TaskRunRow,
    TaskSummaryRow, TaskUpdate, TaskWrite,
};

/// The display prefix of a task number; `HOU-1`, `HOU-2`, ...
const TASK_KEY_PREFIX: &str = "HOU";

/// The per-workspace settings key holding off | read | write.
const TASKS_ACCESS_SETTING_PREFIX: &str = "tasks_access:";

/// The actor every control-wire write records. Agent writes arrive with their
/// own provenance through the task tools, not this one.
const USER_ACTOR: &str = "user";

/// The provenance prefix of an agent write: `agent:<codename> (<role>)`.
const AGENT_ACTOR_PREFIX: &str = "agent:";

/// `task_list`'s page size when the caller names none; one answer an agent can
/// read in a turn without paging a whole workspace into its context.
pub(crate) const TASK_LIST_DEFAULT: u32 = 20;

/// The largest `task_list` page; above this the caller must narrow the query
/// instead of asking for the whole backlog in one tool result.
pub(crate) const TASK_LIST_MAX: u32 = 100;

/// The agent-facing filters of one `task_list` call.
pub struct TaskListQuery<'a> {
    pub status: Option<proto::TaskStatus>,
    pub ready: bool,
    pub mine: bool,
    pub query: Option<&'a str>,
    pub limit: Option<u32>,
}

/// The new state one update is about to write, as the history diff compares it.
struct TaskNew<'a> {
    title: &'a str,
    description: &'a str,
    status: proto::TaskStatus,
    priority: proto::TaskPriority,
    parent_id: Option<i64>,
    ref_url: Option<&'a str>,
    acceptance: Option<(usize, usize)>,
}

impl Daemon {
    pub fn task_key(number: u32) -> String {
        format!("{TASK_KEY_PREFIX}-{number}")
    }

    /// The workspace's Tasks access; a missing or unreadable value is `write`,
    /// the documented default. The setting gates agents and this wire alike.
    pub fn tasks_access(&self, workspace: &str) -> proto::TasksAccess {
        let key = format!("{TASKS_ACCESS_SETTING_PREFIX}{workspace}");
        match self.db.get_setting(&key) {
            Ok(Some(raw)) => match crate::db::from_wire::<proto::TasksAccess>(&raw) {
                Some(access) => access,
                None => {
                    tracing::warn!(
                        "workspace {workspace:?} has tasks access {raw:?} (expected off, read or \
                         write); using write"
                    );
                    proto::TasksAccess::Write
                }
            },
            Ok(None) => proto::TasksAccess::Write,
            Err(e) => {
                tracing::warn!("reading {key:?}: {e:#}; using write");
                proto::TasksAccess::Write
            }
        }
    }

    fn task_refused(
        id: Option<i64>,
        kind: proto::TaskErrorKind,
        limit: Option<u32>,
        requested: Option<u64>,
        expected: Option<i64>,
        actual: Option<i64>,
        message: String,
    ) -> proto::ServerMsg {
        proto::ServerMsg::TaskRefused {
            id,
            kind,
            limit,
            requested,
            expected,
            actual,
            message,
        }
    }

    fn task_not_found(id: i64, operation: &str) -> proto::ServerMsg {
        Self::task_refused(
            Some(id),
            proto::TaskErrorKind::NotFound,
            None,
            None,
            None,
            None,
            format!("{operation} refused: no task with id {id}"),
        )
    }

    fn task_invalid(id: Option<i64>, operation: &str, message: String) -> proto::ServerMsg {
        Self::task_refused(
            id,
            proto::TaskErrorKind::Invalid,
            None,
            None,
            None,
            None,
            format!("{operation} refused: {message}"),
        )
    }

    /// Names the operation, the limit and the actual size, so a client can
    /// show all three without parsing the field that tripped.
    fn task_limit_refused(
        id: Option<i64>,
        operation: &str,
        limit: u32,
        actual: u64,
        unit: &str,
    ) -> proto::ServerMsg {
        Self::task_refused(
            id,
            proto::TaskErrorKind::Limit,
            Some(limit),
            Some(actual),
            None,
            None,
            format!("{operation} refused: {actual} {unit} is over the limit of {limit} {unit}"),
        )
    }

    fn task_conflict_refused(
        row: &TaskRow,
        operation: &str,
        expected: i64,
        actual: i64,
    ) -> proto::ServerMsg {
        Self::task_refused(
            Some(row.id),
            proto::TaskErrorKind::Conflict,
            None,
            None,
            Some(expected),
            Some(actual),
            format!(
                "{operation} refused: task {} expected revision {expected}, actual revision \
                 {actual}",
                Self::task_key(row.number)
            ),
        )
    }

    /// The access refusal. `write` says whether the operation needed write
    /// access; both arms name Settings ▸ Tasks and the setting's actual value.
    fn task_access_refused(
        id: Option<i64>,
        workspace: &str,
        access: proto::TasksAccess,
        write: bool,
        operation: &str,
    ) -> proto::ServerMsg {
        let (kind, needed, actual) = match (access, write) {
            (proto::TasksAccess::Off, _) => {
                (proto::TaskErrorKind::AccessOff, "read or write", "off")
            }
            (_, true) => (proto::TaskErrorKind::ReadOnly, "write", "read"),
            (_, false) => unreachable!("a read is refused only when access is off"),
        };
        Self::task_refused(
            id,
            kind,
            None,
            None,
            None,
            None,
            format!(
                "{operation} refused: tasks access for workspace {workspace:?} is {actual} \
                 (actual: {actual}, expected {needed}); change Settings ▸ Tasks"
            ),
        )
    }

    fn task_summary_to_wire(row: TaskSummaryRow) -> proto::TaskSummary {
        proto::TaskSummary {
            key: Self::task_key(row.number),
            id: row.id,
            workspace: row.workspace,
            number: row.number,
            title: row.title,
            status: row.status,
            priority: row.priority,
            parent_id: row.parent_id,
            ref_url: row.ref_url,
            revision: row.revision,
            created_by: row.created_by,
            created_at_ms: row.created_at_ms,
            updated_at_ms: row.updated_at_ms,
            archived_at_ms: row.archived_at_ms,
            acceptance_checked: row.acceptance_checked,
            acceptance_total: row.acceptance_total,
        }
    }

    fn task_to_wire(row: TaskRow) -> proto::Task {
        proto::Task {
            key: Self::task_key(row.number),
            id: row.id,
            workspace: row.workspace,
            number: row.number,
            title: row.title,
            description: row.description,
            status: row.status,
            priority: row.priority,
            parent_id: row.parent_id,
            ref_url: row.ref_url,
            revision: row.revision,
            created_by: row.created_by,
            created_at_ms: row.created_at_ms,
            updated_at_ms: row.updated_at_ms,
            archived_at_ms: row.archived_at_ms,
        }
    }

    fn task_acceptance_to_wire(row: TaskAcceptanceRow) -> proto::TaskAcceptanceItem {
        proto::TaskAcceptanceItem {
            id: row.id,
            position: row.position,
            text: row.text,
            checked_at_ms: row.checked_at_ms,
            checked_by: row.checked_by,
        }
    }

    fn task_comment_to_wire(row: TaskCommentRow) -> proto::TaskComment {
        proto::TaskComment {
            id: row.id,
            body: row.body,
            author: row.author,
            created_at_ms: row.created_at_ms,
        }
    }

    fn task_history_to_wire(row: TaskHistoryRow) -> proto::TaskHistoryEntry {
        proto::TaskHistoryEntry {
            id: row.id,
            actor: row.actor,
            action: row.action,
            changes: row.changes,
            created_at_ms: row.created_at_ms,
        }
    }

    fn task_run_to_wire(row: TaskRunRow) -> proto::TaskRun {
        proto::TaskRun {
            id: row.id,
            task_id: row.task_id,
            attempt: row.attempt,
            kind: row.kind,
            state: row.state,
            provider: row.provider,
            reviewer: row.reviewer,
            session_id: row.session_id,
            delegation_id: row.delegation_id,
            worktree_path: row.worktree_path,
            branch: row.branch,
            base_commit: row.base_commit,
            initial_revision: row.initial_revision,
            summary: row.summary,
            started_at_ms: row.started_at_ms,
            ended_at_ms: row.ended_at_ms,
        }
    }

    pub fn task_snapshot(&self, workspace: &str) -> Result<proto::ServerMsg> {
        let access = self.tasks_access(workspace);
        if access == proto::TasksAccess::Off {
            return Ok(Self::task_access_refused(
                None,
                workspace,
                access,
                false,
                "task_snapshot",
            ));
        }
        let tasks = self
            .db
            .list_tasks(workspace, proto::TASKS_PER_WORKSPACE)?
            .into_iter()
            .map(Self::task_summary_to_wire)
            .collect();
        Ok(proto::ServerMsg::TaskSnapshot {
            workspace: workspace.to_string(),
            tasks,
            counts: self.db.task_counts(workspace)?,
        })
    }

    pub fn task_get(&self, id: i64) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, "task_get"));
        };
        let access = self.tasks_access(&row.workspace);
        if access == proto::TasksAccess::Off {
            return Ok(Self::task_access_refused(
                Some(id),
                &row.workspace,
                access,
                false,
                "task_get",
            ));
        }
        let acceptance = self
            .db
            .task_acceptance(id)?
            .into_iter()
            .map(Self::task_acceptance_to_wire)
            .collect();
        let comments = self
            .db
            .task_comments(id, proto::COMMENTS_PER_TASK)?
            .into_iter()
            .map(Self::task_comment_to_wire)
            .collect();
        let history = self
            .db
            .task_history(id, proto::TASK_HISTORY_PAGE)?
            .into_iter()
            .map(Self::task_history_to_wire)
            .collect();
        let runs = self
            .db
            .task_runs(id, proto::RUNS_PER_TASK)?
            .into_iter()
            .map(Self::task_run_to_wire)
            .collect();
        Ok(proto::ServerMsg::TaskDetail {
            task: Self::task_to_wire(row),
            acceptance,
            comments,
            history,
            runs,
        })
    }

    /// A title, trimmed; empty is invalid and over the cap is a limit refusal.
    fn clean_task_title(
        id: Option<i64>,
        operation: &str,
        raw: &str,
    ) -> std::result::Result<String, Box<proto::ServerMsg>> {
        let title = raw.trim();
        if title.is_empty() {
            return Err(Box::new(Self::task_invalid(
                id,
                operation,
                "a title cannot be empty (expected 1..=TASK_TITLE_MAX characters)".to_string(),
            )));
        }
        let chars = title.chars().count();
        if chars > proto::TASK_TITLE_MAX {
            return Err(Box::new(Self::task_limit_refused(
                id,
                operation,
                proto::TASK_TITLE_MAX as u32,
                chars as u64,
                "chars",
            )));
        }
        Ok(title.to_string())
    }

    /// The acceptance list, trimmed; empty items and the item cap are refused
    /// by name.
    fn clean_acceptance(
        id: Option<i64>,
        operation: &str,
        raw: &[String],
    ) -> std::result::Result<Vec<String>, Box<proto::ServerMsg>> {
        if raw.len() > proto::ACCEPTANCE_ITEMS_PER_TASK as usize {
            return Err(Box::new(Self::task_limit_refused(
                id,
                operation,
                proto::ACCEPTANCE_ITEMS_PER_TASK,
                raw.len() as u64,
                "items",
            )));
        }
        let mut items = Vec::with_capacity(raw.len());
        for item in raw {
            let text = item.trim();
            if text.is_empty() {
                return Err(Box::new(Self::task_invalid(
                    id,
                    operation,
                    "an acceptance item cannot be empty (expected non-empty text)".to_string(),
                )));
            }
            let chars = text.chars().count();
            if chars > proto::TASK_TITLE_MAX {
                return Err(Box::new(Self::task_limit_refused(
                    id,
                    operation,
                    proto::TASK_TITLE_MAX as u32,
                    chars as u64,
                    "chars in one acceptance item",
                )));
            }
            items.push(text.to_string());
        }
        Ok(items)
    }

    fn check_task_description(
        id: Option<i64>,
        operation: &str,
        description: &str,
    ) -> std::result::Result<(), Box<proto::ServerMsg>> {
        if description.len() > proto::TASK_DESCRIPTION_MAX {
            return Err(Box::new(Self::task_limit_refused(
                id,
                operation,
                proto::TASK_DESCRIPTION_MAX as u32,
                description.len() as u64,
                "bytes",
            )));
        }
        Ok(())
    }

    /// Refuses a parent that does not exist in the workspace, is the task
    /// itself, or closes a parent cycle through it.
    fn check_task_parent(
        &self,
        id: Option<i64>,
        workspace: &str,
        parent_id: i64,
        operation: &str,
    ) -> Result<Option<proto::ServerMsg>> {
        let parent = self.db.task(parent_id)?;
        if parent.is_none_or(|p| p.workspace != workspace) {
            return Ok(Some(Self::task_invalid(
                id,
                operation,
                format!(
                    "parent task {parent_id} does not exist in workspace {workspace:?} \
                     (expected an id of that workspace)"
                ),
            )));
        }
        if Some(parent_id) == id {
            return Ok(Some(Self::task_refused(
                id,
                proto::TaskErrorKind::Cycle,
                None,
                None,
                None,
                None,
                format!(
                    "{operation} refused: task {parent_id} cannot be its own parent (expected a \
                     different parent id)"
                ),
            )));
        }
        let mut hops = 0u32;
        let mut current = Some(parent_id);
        while let Some(pid) = current {
            if Some(pid) == id {
                return Ok(Some(Self::task_refused(
                    id,
                    proto::TaskErrorKind::Cycle,
                    None,
                    None,
                    None,
                    None,
                    format!(
                        "{operation} refused: parent {parent_id} is a descendant of task {pid} \
                         (a parent cycle)"
                    ),
                )));
            }
            hops += 1;
            if hops > proto::TASKS_PER_WORKSPACE {
                return Ok(Some(Self::task_invalid(
                    id,
                    operation,
                    format!(
                        "parent chain from {parent_id} is longer than TASKS_PER_WORKSPACE \
                         ({}); the parent rows are corrupt",
                        proto::TASKS_PER_WORKSPACE
                    ),
                )));
            }
            current = self.db.task(pid)?.and_then(|t| t.parent_id);
        }
        Ok(None)
    }

    /// The JSON diff stored in history for an update; only moved fields.
    fn task_changes_json(row: &TaskRow, next: &TaskNew<'_>) -> String {
        let mut changes = serde_json::Map::new();
        if row.title != next.title {
            changes.insert(
                "title".into(),
                serde_json::json!({ "from": row.title, "to": next.title }),
            );
        }
        if row.description != next.description {
            changes.insert(
                "description".into(),
                serde_json::json!({ "from": row.description, "to": next.description }),
            );
        }
        if row.status != next.status {
            changes.insert(
                "status".into(),
                serde_json::json!({ "from": row.status, "to": next.status }),
            );
        }
        if row.priority != next.priority {
            changes.insert(
                "priority".into(),
                serde_json::json!({ "from": row.priority, "to": next.priority }),
            );
        }
        if row.parent_id != next.parent_id {
            changes.insert(
                "parent_id".into(),
                serde_json::json!({ "from": row.parent_id, "to": next.parent_id }),
            );
        }
        if row.ref_url.as_deref() != next.ref_url {
            changes.insert(
                "ref_url".into(),
                serde_json::json!({ "from": row.ref_url, "to": next.ref_url }),
            );
        }
        if let Some((from, to)) = next.acceptance {
            changes.insert(
                "acceptance".into(),
                serde_json::json!({ "from": from, "to": to }),
            );
        }
        serde_json::Value::Object(changes).to_string()
    }

    /// The provenance one agent write records: `agent:<codename> (<role>)`.
    /// A child is refused here — task tools are for top-level panes only,
    /// whatever door the caller reached them through.
    pub fn task_actor(&self, session: u32) -> Result<String> {
        if let Some(parent) = self.parent_of(session) {
            bail!(
                "task tools are offered only to a top-level pane; pane {session} was spawned by \
                 pane {parent} and its scope is the brief (report back with pane_submit)"
            );
        }
        let info = self.orchestrate_whoami(session)?;
        let codename = if info.codename.trim().is_empty() {
            info.title.clone()
        } else {
            info.codename.clone()
        };
        let role = match self.tool_role_of(session) {
            crate::orchestrate::ToolRole::Operator => "operator",
            crate::orchestrate::ToolRole::Orchestrator { .. } => "orchestrator",
            crate::orchestrate::ToolRole::Leaf => {
                bail!(
                    "task tools are offered only to a top-level pane; pane {session} is a leaf \
                     child and its scope is the brief (report back with pane_submit)"
                )
            }
        };
        Ok(format!("{AGENT_ACTOR_PREFIX}{codename} ({role})"))
    }

    /// One task's display key, for tool results that only have the id.
    pub fn task_key_of(&self, id: i64) -> Result<Option<String>> {
        Ok(self.db.task(id)?.map(|row| Self::task_key(row.number)))
    }

    /// Resolves `HOU-<n>` through the workspace's counter. `Ok(None)` is an
    /// unknown key; a malformed key is refused naming the expected shape.
    pub fn task_id_for_key(&self, workspace: &str, key: &str) -> Result<Option<i64>> {
        let trimmed = key.trim();
        let number = trimmed
            .strip_prefix(&format!("{TASK_KEY_PREFIX}-"))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "task key {key:?} is not a task key; expected {TASK_KEY_PREFIX}-<number>, \
                     for example {TASK_KEY_PREFIX}-1"
                )
            })?
            .parse::<u32>()
            .map_err(|e| {
                anyhow::anyhow!(
                    "task key {key:?} has no numeric task number; expected {TASK_KEY_PREFIX}-<number>, \
                     for example {TASK_KEY_PREFIX}-1 ({e})"
                )
            })?;
        Ok(self.db.task_by_number(workspace, number)?.map(|row| row.id))
    }

    /// Runs one `task_list` for the calling pane: access, caps and filters.
    pub fn task_list(
        &self,
        workspace: &str,
        session: u32,
        filter: &TaskListQuery<'_>,
    ) -> Result<proto::ServerMsg> {
        let access = self.tasks_access(workspace);
        if access == proto::TasksAccess::Off {
            return Ok(Self::task_access_refused(
                None,
                workspace,
                access,
                false,
                "task_list",
            ));
        }
        let limit = filter.limit.unwrap_or(TASK_LIST_DEFAULT);
        if limit > TASK_LIST_MAX {
            return Ok(Self::task_limit_refused(
                None,
                "task_list",
                TASK_LIST_MAX,
                u64::from(limit),
                "tasks per call",
            ));
        }
        let mine = if filter.mine {
            Some(self.task_actor(session)?)
        } else {
            None
        };
        let tasks = self
            .db
            .query_tasks(
                workspace,
                &TaskQuery {
                    status: filter.status,
                    ready: filter.ready,
                    mine: mine.as_deref(),
                    query: filter.query,
                    limit,
                },
            )?
            .into_iter()
            .map(Self::task_summary_to_wire)
            .collect();
        Ok(proto::ServerMsg::TaskSnapshot {
            workspace: workspace.to_string(),
            tasks,
            counts: self.db.task_counts(workspace)?,
        })
    }

    /// The highest-priority ready task, as a one-task snapshot (empty when
    /// nothing is ready).
    pub fn task_next(&self, workspace: &str) -> Result<proto::ServerMsg> {
        let access = self.tasks_access(workspace);
        if access == proto::TasksAccess::Off {
            return Ok(Self::task_access_refused(
                None,
                workspace,
                access,
                false,
                "task_next",
            ));
        }
        let tasks = self
            .db
            .ready_tasks(workspace, 1)?
            .into_iter()
            .map(Self::task_summary_to_wire)
            .collect();
        Ok(proto::ServerMsg::TaskSnapshot {
            workspace: workspace.to_string(),
            tasks,
            counts: self.db.task_counts(workspace)?,
        })
    }

    /// Creates (`id` absent) or updates (`id` present, `expected_revision`
    /// required) one task, attributed to `actor`. The wire and the agent tools
    /// share this one path, including every refusal.
    pub fn task_save_as(
        &self,
        workspace: &str,
        id: Option<i64>,
        expected_revision: Option<i64>,
        patch: proto::TaskPatch,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let access = self.tasks_access(workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                id, workspace, access, true, operation,
            ));
        }
        match id {
            Some(id) => self.task_update(workspace, id, expected_revision, patch, actor, operation),
            None => self.task_create(workspace, patch, actor, operation),
        }
    }

    fn task_create(
        &self,
        workspace: &str,
        patch: proto::TaskPatch,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(raw_title) = patch.title.as_deref() else {
            return Ok(Self::task_invalid(
                None,
                operation,
                "a new task needs a title (expected a non-empty title)".to_string(),
            ));
        };
        let title = match Self::clean_task_title(None, operation, raw_title) {
            Ok(t) => t,
            Err(msg) => return Ok(*msg),
        };
        let description = patch.description.unwrap_or_default();
        if let Err(msg) = Self::check_task_description(None, operation, &description) {
            return Ok(*msg);
        }
        let acceptance = match Self::clean_acceptance(
            None,
            operation,
            patch.acceptance.as_deref().unwrap_or(&[]),
        ) {
            Ok(items) => items,
            Err(msg) => return Ok(*msg),
        };
        let parent_id = patch.parent_id.flatten();
        if let Some(parent_id) = parent_id {
            if let Some(msg) = self.check_task_parent(None, workspace, parent_id, operation)? {
                return Ok(msg);
            }
        }
        let existing = u64::from(self.db.task_count(workspace)?);
        if existing >= u64::from(proto::TASKS_PER_WORKSPACE) {
            return Ok(Self::task_limit_refused(
                None,
                operation,
                proto::TASKS_PER_WORKSPACE,
                existing + 1,
                "tasks",
            ));
        }
        let row = self.db.create_task(&TaskWrite {
            workspace,
            title: &title,
            description: &description,
            status: patch.status.unwrap_or(proto::TaskStatus::Backlog),
            priority: patch.priority.unwrap_or(proto::TaskPriority::None),
            parent_id,
            ref_url: patch.ref_url.flatten().as_deref(),
            created_by: actor,
            now_ms: now_unix_ms(),
            acceptance: &acceptance,
        })?;
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id: row.id,
            revision: row.revision,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn task_update(
        &self,
        workspace: &str,
        id: i64,
        expected_revision: Option<i64>,
        patch: proto::TaskPatch,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        if row.workspace != workspace {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "task {id} belongs to workspace {:?}, not {workspace:?} (expected the task's \
                     own workspace)",
                    row.workspace
                ),
            ));
        }
        let Some(expected_revision) = expected_revision else {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "expected_revision is required to update task {} (got none)",
                    Self::task_key(row.number)
                ),
            ));
        };
        if row.revision != expected_revision {
            return Ok(Self::task_conflict_refused(
                &row,
                operation,
                expected_revision,
                row.revision,
            ));
        }

        let title = match patch.title.as_deref() {
            Some(raw) => match Self::clean_task_title(Some(id), operation, raw) {
                Ok(t) => t,
                Err(msg) => return Ok(*msg),
            },
            None => row.title.clone(),
        };
        let description = patch.description.unwrap_or_else(|| row.description.clone());
        if let Err(msg) = Self::check_task_description(Some(id), operation, &description) {
            return Ok(*msg);
        }
        let status = patch.status.unwrap_or(row.status);
        let priority = patch.priority.unwrap_or(row.priority);
        let parent_id = patch.parent_id.unwrap_or(row.parent_id);
        if let Some(parent_id) = parent_id {
            if let Some(msg) = self.check_task_parent(Some(id), workspace, parent_id, operation)? {
                return Ok(msg);
            }
        }
        let ref_url = patch.ref_url.unwrap_or_else(|| row.ref_url.clone());
        let ref_url = ref_url.as_deref();
        let acceptance = match patch.acceptance.as_deref() {
            Some(raw) => match Self::clean_acceptance(Some(id), operation, raw) {
                Ok(items) => Some(items),
                Err(msg) => return Ok(*msg),
            },
            None => None,
        };
        let acceptance_change = acceptance.as_ref().map(|items| {
            let from = self.db.task_acceptance(id).map(|a| a.len()).unwrap_or(0);
            (from, items.len())
        });
        let changes = Self::task_changes_json(
            &row,
            &TaskNew {
                title: &title,
                description: &description,
                status,
                priority,
                parent_id,
                ref_url,
                acceptance: acceptance_change,
            },
        );
        let applied = self.db.update_task(&TaskUpdate {
            id,
            expected_revision,
            title: &title,
            description: &description,
            status,
            priority,
            parent_id,
            ref_url,
            acceptance: acceptance.as_deref(),
            actor,
            action: "update",
            changes: &changes,
            now_ms: now_unix_ms(),
        })?;
        if !applied {
            let actual = self
                .db
                .task(id)?
                .map(|t| t.revision)
                .unwrap_or(row.revision);
            return Ok(Self::task_conflict_refused(
                &row,
                operation,
                expected_revision,
                actual,
            ));
        }
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id,
            revision: row.revision + 1,
        })
    }

    /// The wire's own save: user-attributed, operation `task_save`.
    pub fn task_save(
        &self,
        workspace: &str,
        id: Option<i64>,
        expected_revision: Option<i64>,
        patch: proto::TaskPatch,
    ) -> Result<proto::ServerMsg> {
        self.task_save_as(
            workspace,
            id,
            expected_revision,
            patch,
            USER_ACTOR,
            "task_save",
        )
    }

    /// `task_get` scoped to the calling workspace: a task of another workspace
    /// is reported as not found rather than read.
    pub fn task_get_in(&self, workspace: &str, id: i64) -> Result<proto::ServerMsg> {
        match self.db.task(id)? {
            Some(row) if row.workspace == workspace => self.task_get(id),
            _ => Ok(Self::task_not_found(id, "task_get")),
        }
    }

    /// Records one comment attributed to `actor`. `workspace` of `Some` scopes
    /// an agent caller; `None` is the unscoped control wire.
    pub fn task_comment_as(
        &self,
        workspace: Option<&str>,
        id: i64,
        body: &str,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        if workspace.is_some_and(|workspace| row.workspace != workspace) {
            return Ok(Self::task_not_found(id, operation));
        }
        let access = self.tasks_access(&row.workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                Some(id),
                &row.workspace,
                access,
                true,
                operation,
            ));
        }
        if body.trim().is_empty() {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                "a comment cannot be empty (expected non-empty body)".to_string(),
            ));
        }
        if body.len() > proto::TASK_COMMENT_MAX {
            return Ok(Self::task_limit_refused(
                Some(id),
                operation,
                proto::TASK_COMMENT_MAX as u32,
                body.len() as u64,
                "bytes",
            ));
        }
        let count = u64::from(self.db.task_comment_count(id)?);
        if count >= u64::from(proto::COMMENTS_PER_TASK) {
            return Ok(Self::task_limit_refused(
                Some(id),
                operation,
                proto::COMMENTS_PER_TASK,
                count + 1,
                "comments",
            ));
        }
        self.db.add_task_comment(id, body, actor, now_unix_ms())?;
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id,
            revision: row.revision + 1,
        })
    }

    pub fn task_comment(&self, id: i64, body: &str) -> Result<proto::ServerMsg> {
        self.task_comment_as(None, id, body, USER_ACTOR, "task_comment")
    }

    pub fn task_check_as(
        &self,
        workspace: Option<&str>,
        id: i64,
        item: i64,
        checked: bool,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        if workspace.is_some_and(|workspace| row.workspace != workspace) {
            return Ok(Self::task_not_found(id, operation));
        }
        let access = self.tasks_access(&row.workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                Some(id),
                &row.workspace,
                access,
                true,
                operation,
            ));
        }
        let found = self
            .db
            .set_task_acceptance_checked(id, item, checked, actor, now_unix_ms())?;
        if !found {
            return Ok(Self::task_refused(
                Some(id),
                proto::TaskErrorKind::NotFound,
                None,
                None,
                None,
                None,
                format!(
                    "{operation} refused: task {} has no acceptance item {item}",
                    Self::task_key(row.number)
                ),
            ));
        }
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id,
            revision: row.revision + 1,
        })
    }

    pub fn task_check(&self, id: i64, item: i64, checked: bool) -> Result<proto::ServerMsg> {
        self.task_check_as(None, id, item, checked, USER_ACTOR, "task_check")
    }

    /// Takes a task: backlog or todo moves to in progress, with the caller's
    /// session recorded in history. An in-progress task is already taken, so
    /// claiming it again is a no-op rather than a conflict.
    pub fn task_claim(
        &self,
        workspace: &str,
        id: i64,
        session: u32,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        if row.workspace != workspace {
            return Ok(Self::task_not_found(id, operation));
        }
        let access = self.tasks_access(&row.workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                Some(id),
                &row.workspace,
                access,
                true,
                operation,
            ));
        }
        if row.archived_at_ms.is_some() {
            return Ok(Self::task_invalid(
                Some(id),
                operation,
                format!(
                    "task {} is archived (expected an active task)",
                    Self::task_key(row.number)
                ),
            ));
        }
        match row.status {
            proto::TaskStatus::Backlog | proto::TaskStatus::Todo => {}
            proto::TaskStatus::InProgress => {
                return Ok(proto::ServerMsg::TaskChanged {
                    workspace: row.workspace,
                    id,
                    revision: row.revision,
                })
            }
            other => {
                let actual = crate::db::wire_name(&other)?;
                return Ok(Self::task_invalid(
                    Some(id),
                    operation,
                    format!(
                        "task {} is {actual} (expected backlog, todo or in_progress)",
                        Self::task_key(row.number)
                    ),
                ));
            }
        }
        let changes = serde_json::json!({
            "status": { "from": row.status, "to": proto::TaskStatus::InProgress },
            "session": session,
        })
        .to_string();
        let applied = self.db.update_task(&TaskUpdate {
            id,
            expected_revision: row.revision,
            title: &row.title,
            description: &row.description,
            status: proto::TaskStatus::InProgress,
            priority: row.priority,
            parent_id: row.parent_id,
            ref_url: row.ref_url.as_deref(),
            acceptance: None,
            actor,
            action: "claim",
            changes: &changes,
            now_ms: now_unix_ms(),
        })?;
        if !applied {
            let actual = self
                .db
                .task(id)?
                .map(|t| t.revision)
                .unwrap_or(row.revision);
            return Ok(Self::task_conflict_refused(
                &row,
                operation,
                row.revision,
                actual,
            ));
        }
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id,
            revision: row.revision + 1,
        })
    }

    /// Hands a task back: the summary becomes a comment and the task moves to
    /// in review. The caller's session is recorded alongside the status move.
    pub fn task_handback(
        &self,
        workspace: &str,
        id: i64,
        summary: &str,
        session: u32,
        actor: &str,
        operation: &str,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        if row.workspace != workspace {
            return Ok(Self::task_not_found(id, operation));
        }
        let access = self.tasks_access(workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                Some(id),
                workspace,
                access,
                true,
                operation,
            ));
        }
        match row.status {
            proto::TaskStatus::Done | proto::TaskStatus::Canceled => {
                return Ok(Self::task_invalid(
                    Some(id),
                    operation,
                    format!(
                        "task {} is {} (expected an open task)",
                        Self::task_key(row.number),
                        crate::db::wire_name(&row.status)?
                    ),
                ));
            }
            _ => {}
        }
        let comment = self.task_comment_as(Some(workspace), id, summary, actor, operation)?;
        if matches!(comment, proto::ServerMsg::TaskRefused { .. }) {
            return Ok(comment);
        }
        let Some(updated) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, operation));
        };
        let changes = Self::task_changes_json(
            &updated,
            &TaskNew {
                title: &updated.title,
                description: &updated.description,
                status: proto::TaskStatus::InReview,
                priority: updated.priority,
                parent_id: updated.parent_id,
                ref_url: updated.ref_url.as_deref(),
                acceptance: None,
            },
        );
        let changes = Self::with_session(&changes, session);
        let applied = self.db.update_task(&TaskUpdate {
            id,
            expected_revision: updated.revision,
            title: &updated.title,
            description: &updated.description,
            status: proto::TaskStatus::InReview,
            priority: updated.priority,
            parent_id: updated.parent_id,
            ref_url: updated.ref_url.as_deref(),
            acceptance: None,
            actor,
            action: "handback",
            changes: &changes,
            now_ms: now_unix_ms(),
        })?;
        if !applied {
            let actual = self
                .db
                .task(id)?
                .map(|t| t.revision)
                .unwrap_or(updated.revision);
            return Ok(Self::task_conflict_refused(
                &updated,
                operation,
                updated.revision,
                actual,
            ));
        }
        Ok(proto::ServerMsg::TaskChanged {
            workspace: updated.workspace,
            id,
            revision: updated.revision + 1,
        })
    }

    fn with_session(changes: &str, session: u32) -> String {
        let mut value: serde_json::Value = serde_json::from_str(changes).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            object.insert("session".into(), serde_json::json!(session));
        }
        value.to_string()
    }

    pub fn task_archive(
        &self,
        id: i64,
        archived: bool,
        expected_revision: i64,
    ) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.task(id)? else {
            return Ok(Self::task_not_found(id, "task_archive"));
        };
        let access = self.tasks_access(&row.workspace);
        if access != proto::TasksAccess::Write {
            return Ok(Self::task_access_refused(
                Some(id),
                &row.workspace,
                access,
                true,
                "task_archive",
            ));
        }
        if row.revision != expected_revision {
            return Ok(Self::task_conflict_refused(
                &row,
                "task_archive",
                expected_revision,
                row.revision,
            ));
        }
        let applied = self.db.set_task_archived(
            id,
            expected_revision,
            archived,
            USER_ACTOR,
            now_unix_ms(),
        )?;
        if !applied {
            let actual = self
                .db
                .task(id)?
                .map(|t| t.revision)
                .unwrap_or(row.revision);
            return Ok(Self::task_conflict_refused(
                &row,
                "task_archive",
                expected_revision,
                actual,
            ));
        }
        Ok(proto::ServerMsg::TaskChanged {
            workspace: row.workspace,
            id,
            revision: row.revision + 1,
        })
    }

    pub fn tasks_access_state(&self, workspace: &str) -> proto::ServerMsg {
        proto::ServerMsg::TasksAccess {
            workspace: workspace.to_string(),
            access: self.tasks_access(workspace),
        }
    }

    pub fn tasks_access_set(
        &self,
        workspace: &str,
        access: proto::TasksAccess,
    ) -> Result<proto::ServerMsg> {
        let key = format!("{TASKS_ACCESS_SETTING_PREFIX}{workspace}");
        self.db.set_setting(&key, &crate::db::wire_name(&access)?)?;
        // The access switch decides which task tools an agent is offered, so
        // open tool lists in the workspace must be re-read.
        self.mcp_notify.tools_changed_in(workspace);
        Ok(self.tasks_access_state(workspace))
    }
}

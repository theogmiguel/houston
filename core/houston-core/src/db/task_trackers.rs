use super::Db;
use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use rusqlite::{params, OptionalExtension};
use sha2::Digest;
use std::collections::BTreeMap;

pub(super) fn migrate(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_external_links (
            task_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            fetched_at_ms INTEGER,
            body_hash TEXT,
            remote_rev TEXT,
            synced_at_ms INTEGER,
            source TEXT NOT NULL DEFAULT 'source',
            snapshot TEXT NOT NULL,
            sync_state TEXT NOT NULL DEFAULT 'current',
            PRIMARY KEY(task_id, provider, external_id, source)
        );
        CREATE INDEX IF NOT EXISTS idx_task_external_links_task ON task_external_links(task_id);
        CREATE TABLE IF NOT EXISTS task_tracker_settings (
            workspace TEXT NOT NULL,
            provider TEXT NOT NULL,
            settings TEXT NOT NULL,
            PRIMARY KEY(workspace, provider)
        );
        CREATE TABLE IF NOT EXISTS task_tracker_database_identity (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            namespace TEXT NOT NULL UNIQUE
        );
        INSERT OR IGNORE INTO task_tracker_database_identity(singleton, namespace) VALUES (1, lower(hex(randomblob(16))));
        CREATE TABLE IF NOT EXISTS task_tracker_poll_state (
            workspace TEXT NOT NULL,
            provider TEXT NOT NULL,
            cursor TEXT NOT NULL,
            last_sync_at_ms INTEGER,
            last_error TEXT,
            PRIMARY KEY(workspace, provider)
        );
        CREATE TABLE IF NOT EXISTS task_tracker_refresh_cursor (
            workspace TEXT NOT NULL,
            provider TEXT NOT NULL,
            after_external_id TEXT,
            PRIMARY KEY(workspace, provider)
        );
        CREATE TABLE IF NOT EXISTS backlog_project_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            changes TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_tracker_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace TEXT NOT NULL,
            task_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            action TEXT NOT NULL,
            revision INTEGER NOT NULL,
            payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            receipt TEXT,
            UNIQUE(task_id, provider, action, revision)
        );",
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTrackerOutboxRow {
    pub id: i64,
    pub workspace: String,
    pub task_id: i64,
    pub provider: proto::TaskTrackerProvider,
    pub action: String,
    pub revision: i64,
    pub payload: String,
    pub attempts: u32,
    pub last_error: Option<String>,
}

impl Db {
    pub fn task_tracker_database_namespace(&self) -> Result<String> {
        Ok(self.conn.lock().expect("sqlite lock").query_row(
            "SELECT namespace FROM task_tracker_database_identity WHERE singleton=1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn task_tracker_poll_cursor(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
    ) -> Result<crate::task_trackers::TrackerPollCursor> {
        let conn = self.conn.lock().expect("sqlite lock");
        let cursor: Option<String> = conn
            .query_row(
                "SELECT cursor FROM task_tracker_poll_state WHERE workspace=?1 AND provider=?2",
                params![workspace, provider_name(provider)],
                |row| row.get(0),
            )
            .optional()?;
        match cursor {
            Some(json) => serde_json::from_str(&json).context("parsing task tracker poll cursor"),
            None => Ok(Default::default()),
        }
    }

    pub fn task_tracker_external_task(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
        external_id: &str,
    ) -> Result<Option<i64>> {
        Ok(self.conn.lock().expect("sqlite lock").query_row(
            "SELECT l.task_id FROM task_external_links l JOIN backlog_tasks t ON t.id=l.task_id
             WHERE t.workspace=?1 AND l.provider=?2 AND l.external_id=?3 AND l.source='source' LIMIT 1",
            params![workspace, provider_name(provider), external_id],
            |row| row.get(0),
        ).optional()?)
    }

    pub fn task_tracker_refresh_cursor(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
    ) -> Result<Option<String>> {
        Ok(self.conn.lock().expect("sqlite lock").query_row(
            "SELECT after_external_id FROM task_tracker_refresh_cursor WHERE workspace=?1 AND provider=?2",
            params![workspace, provider_name(provider)],
            |row| row.get(0),
        ).optional()?.flatten())
    }

    pub fn task_tracker_refresh_cursor_set(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
        after_external_id: Option<&str>,
    ) -> Result<()> {
        self.conn.lock().expect("sqlite lock").execute(
            "INSERT INTO task_tracker_refresh_cursor(workspace, provider, after_external_id) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace, provider) DO UPDATE SET after_external_id=excluded.after_external_id",
            params![workspace, provider_name(provider), after_external_id],
        )?;
        Ok(())
    }

    pub fn task_tracker_linked_external_ids(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
        after_external_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT l.external_id FROM task_external_links l
             JOIN backlog_tasks t ON t.id=l.task_id
             WHERE t.workspace=?1 AND l.provider=?2 AND l.source='source'
               AND (?3 IS NULL OR l.external_id>?3)
             ORDER BY l.external_id LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                workspace,
                provider_name(provider),
                after_external_id,
                limit.min(100)
            ],
            |row| row.get(0),
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading linked tracker page IDs")
    }

    pub fn task_tracker_poll_state_set(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
        cursor: &crate::task_trackers::TrackerPollCursor,
        synced_at_ms: i64,
        error: Option<&str>,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO task_tracker_poll_state(workspace, provider, cursor, last_sync_at_ms, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(workspace, provider) DO UPDATE SET cursor=excluded.cursor,
                 last_sync_at_ms=excluded.last_sync_at_ms, last_error=excluded.last_error",
            params![workspace, provider_name(provider), serde_json::to_string(cursor)?, synced_at_ms, error],
        )?;
        tx.execute(
            "UPDATE task_tracker_settings SET settings=json_set(settings, '$.last_sync_at_ms', ?1, '$.last_error', ?2)
             WHERE workspace=?3 AND provider=?4",
            params![synced_at_ms, error, workspace, provider_name(provider)],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn task_tracker_import_remote(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
        record: &crate::task_trackers::RemoteTaskSnapshot,
        fetched_at_ms: i64,
    ) -> Result<i64> {
        const TITLE_MAX_BYTES: usize = 200;
        const DESCRIPTION_MAX_BYTES: usize = 32_000;
        let title = record
            .fields
            .get("title")
            .context("remote task is missing title")?;
        let description = record
            .fields
            .get("description")
            .map(String::as_str)
            .unwrap_or("");
        let status = record
            .fields
            .get("status")
            .map(String::as_str)
            .unwrap_or("todo");
        if title.trim().is_empty() || title.len() > TITLE_MAX_BYTES {
            bail!("remote task title must be non-empty and at most {TITLE_MAX_BYTES} bytes");
        }
        if description.len() > DESCRIPTION_MAX_BYTES {
            bail!(
                "remote task description is {} bytes, over the {DESCRIPTION_MAX_BYTES}-byte limit",
                description.len()
            );
        }
        let task_status: proto::TaskStatus = serde_json::from_str(&format!("\"{status}\""))
            .with_context(|| {
                format!("remote task status {status:?} is not a Houston task status")
            })?;
        if let Some(project) = &record.project {
            if project.external_id.len() > 512
                || project.url.len() > 2048
                || project.title.len() > 500
                || project.description.len() > 32_000
            {
                bail!("remote project snapshot exceeds the bounded ID, URL, title, or description limit");
            }
        }
        let body = serde_json::to_string(&(record.fields.clone(), record.project.clone()))?;
        if body.len() > crate::task_trackers::SNAPSHOT_MAX_BYTES {
            bail!(
                "remote task snapshot is {} bytes, over the {}-byte limit",
                body.len(),
                crate::task_trackers::SNAPSHOT_MAX_BYTES
            );
        }

        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn.transaction()?;
        let existing: Option<i64> = tx.query_row(
            "SELECT l.task_id FROM task_external_links l JOIN backlog_tasks t ON t.id=l.task_id
             WHERE t.workspace=?1 AND l.provider=?2 AND l.external_id=?3 AND l.source='source' LIMIT 1",
            params![workspace, provider_name(provider), record.external_id], |row| row.get(0),
        ).optional()?;
        let previous_snapshot = if let Some(task_id) = existing {
            let json: String = tx.query_row(
                "SELECT snapshot FROM task_external_links WHERE task_id=?1 AND provider=?2 AND external_id=?3 AND source='source'",
                params![task_id, provider_name(provider), record.external_id], |row| row.get(0),
            )?;
            Some(serde_json::from_str::<proto::TaskTrackerSnapshot>(&json)?)
        } else {
            None
        };
        let id = if let Some(task_id) = existing {
            let live: (String, String, String, i64) = tx.query_row(
                "SELECT title, description, status, revision FROM backlog_tasks WHERE id=?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let (old_title, old_description, old_status, _revision) = live;
            let previous_snapshot = previous_snapshot
                .as_ref()
                .context("existing tracker link omitted its snapshot")?;
            let local = [
                ("title", old_title.as_str()),
                ("description", old_description.as_str()),
                ("status", old_status.as_str()),
            ];
            let mut resolved = BTreeMap::new();
            let mut next_base = previous_snapshot.base.clone();
            let mut conflicts = Vec::new();
            for (field, live_value) in local {
                let remote_value = record
                    .fields
                    .get(field)
                    .map(String::as_str)
                    .unwrap_or(live_value);
                let base_value = previous_snapshot.base.get(field).cloned();
                let base = base_value.as_deref().unwrap_or(live_value);
                if let Some(previous_conflict) = previous_snapshot
                    .conflicts
                    .iter()
                    .find(|conflict| conflict.field == field)
                {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: field.into(),
                        base: previous_conflict.base.clone(),
                        local: live_value.into(),
                        remote: remote_value.into(),
                    });
                    resolved.insert(field.to_string(), live_value.to_string());
                } else if remote_value == live_value {
                    next_base.insert(field.to_string(), remote_value.to_string());
                    resolved.insert(field.to_string(), live_value.to_string());
                } else if remote_value != base {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: field.into(),
                        base: base.into(),
                        local: live_value.into(),
                        remote: remote_value.into(),
                    });
                    resolved.insert(field.to_string(), live_value.to_string());
                } else {
                    resolved.insert(field.to_string(), live_value.to_string());
                }
            }
            let snapshot: String = tx.query_row(
                "SELECT snapshot FROM task_external_links WHERE task_id=?1 AND provider=?2 AND external_id=?3 AND source='source'",
                params![task_id, provider_name(provider), record.external_id], |row| row.get(0),
            )?;
            let mut snapshot: proto::TaskTrackerSnapshot = serde_json::from_str(&snapshot)?;
            let old_snapshot = snapshot.clone();
            snapshot.base = next_base;
            snapshot.remote = record.fields.clone();
            snapshot.local = resolved;
            snapshot.conflicts = conflicts;
            snapshot.project_external_id = record.project.as_ref().map(|project| {
                crate::task_trackers::project_external_key(provider, &project.external_id)
            });
            snapshot.project = record.project.clone();
            if snapshot.base != old_snapshot.base
                || snapshot.local != old_snapshot.local
                || snapshot.remote != old_snapshot.remote
                || snapshot.conflicts != old_snapshot.conflicts
                || snapshot.project_external_id != old_snapshot.project_external_id
                || snapshot.project != old_snapshot.project
            {
                snapshot.revision += 1;
            }
            let sync_state = tracker_snapshot_state(&snapshot);
            let (body_hash,): (String,) = (format!("{:x}", sha2::Sha256::digest(body.as_bytes())),);
            tx.execute(
                "UPDATE task_external_links SET url=?1, fetched_at_ms=?2, body_hash=?3, remote_rev=?4, synced_at_ms=?2, snapshot=?5, sync_state=?6
                 WHERE task_id=?7 AND provider=?8 AND external_id=?9 AND source='source'",
                params![record.url, fetched_at_ms, body_hash, record.remote_rev, serde_json::to_string(&snapshot)?,
                    serde_json::to_string(&sync_state)?, task_id, provider_name(provider), record.external_id],
            )?;
            task_id
        } else {
            tx.execute(
                "UPDATE backlog_task_counters SET next_number=next_number+1 WHERE workspace='all'",
                [],
            )?;
            let number: i64 = tx.query_row(
                "SELECT next_number-1 FROM backlog_task_counters WHERE workspace='all'",
                [],
                |row| row.get(0),
            )?;
            let task_status = serde_json::to_value(task_status)?
                .as_str()
                .context("serializing imported task status")?
                .to_string();
            tx.execute(
                "INSERT INTO backlog_tasks(workspace, number, title, description, status, priority, revision, created_by, created_at, updated_at, ref_url)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, ?7, ?7, ?8)",
                params![workspace, number, title, description, task_status,
                    format!("tracker:{}", provider_name(provider)), fetched_at_ms, record.url],
            )?;
            let task_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO backlog_task_history(task_id, actor, action, changes, created_at) VALUES (?1, ?2, 'tracker_import', '{}', ?3)",
                params![task_id, format!("tracker:{}", provider_name(provider)), fetched_at_ms],
            )?;
            let body_hash = format!("{:x}", sha2::Sha256::digest(body.as_bytes()));
            let snapshot = proto::TaskTrackerSnapshot {
                base: record.fields.clone(),
                local: record.fields.clone(),
                remote: record.fields.clone(),
                conflicts: vec![],
                revision: 1,
                project_external_id: record.project.as_ref().map(|project| {
                    crate::task_trackers::project_external_key(provider, &project.external_id)
                }),
                project: record.project.clone(),
            };
            tx.execute(
                "INSERT INTO task_external_links(task_id,provider,external_id,url,fetched_at_ms,body_hash,remote_rev,synced_at_ms,source,snapshot,sync_state)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?5,'source',?8,?9)",
                params![task_id, provider_name(provider), record.external_id, record.url, fetched_at_ms, body_hash, record.remote_rev, serde_json::to_string(&snapshot)?, serde_json::to_string(&proto::TaskTrackerSyncState::Current)?],
            )?;
            task_id
        };
        self.sync_imported_project(
            &tx,
            workspace,
            id,
            existing.is_none(),
            provider,
            record.project.as_ref(),
            previous_snapshot.as_ref(),
            fetched_at_ms,
        )?;
        tx.commit()?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_imported_project(
        &self,
        tx: &rusqlite::Transaction<'_>,
        workspace: &str,
        task_id: i64,
        created_task: bool,
        provider: proto::TaskTrackerProvider,
        incoming: Option<&proto::TaskTrackerProjectSnapshot>,
        previous_snapshot: Option<&proto::TaskTrackerSnapshot>,
        now_ms: i64,
    ) -> Result<()> {
        let Some(incoming) = incoming else {
            return Ok(());
        };
        let external_id =
            crate::task_trackers::project_external_key(provider, &incoming.external_id);
        let previous_project = previous_snapshot.and_then(|snapshot| snapshot.project.as_ref());
        let previous_base = previous_snapshot
            .filter(|snapshot| {
                snapshot.project_external_id.as_deref() == Some(external_id.as_str())
            })
            .and_then(|snapshot| {
                snapshot
                    .base
                    .get("project.description")
                    .map(String::as_str)
                    .or_else(|| {
                        snapshot
                            .project
                            .as_ref()
                            .map(|project| project.description.as_str())
                    })
            })
            .unwrap_or("");
        type ImportedProjectRow = (i64, String, Option<String>, Option<String>, i64);
        let existing: Option<ImportedProjectRow> = tx
            .query_row(
                "SELECT id, name, external_url, tracker_description, revision FROM backlog_projects
             WHERE workspace=?1 AND project_external_id=?2 AND archived_at IS NULL",
                params![workspace, external_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let (project_id, local_title, local_description, project_conflicts) = match existing {
            None => {
                validate_external_project_identity(&external_id)?;
                tx.execute(
                    "INSERT INTO backlog_projects(workspace,name,external_url,project_external_id,tracker_description,local_decisions,revision,updated_at)
                     VALUES (?1,?2,?3,?4,?5,'[]',1,?6)",
                    params![workspace, incoming.title, incoming.url, external_id, incoming.description, now_ms],
                )?;
                let project_id = tx.last_insert_rowid();
                let changes = serde_json::json!({"tracker_description":{"old":null,"new":incoming.description},"external_url":{"old":null,"new":incoming.url}}).to_string();
                tx.execute(
                    "INSERT INTO backlog_project_history(project_id,actor,action,changes,created_at) VALUES (?1,?2,'tracker_import',?3,?4)",
                    params![project_id, format!("tracker:{}", provider_name(provider)), changes, now_ms],
                )?;
                (
                    project_id,
                    incoming.title.clone(),
                    incoming.description.clone(),
                    Vec::new(),
                )
            }
            Some((project_id, name, _url, local, _revision)) => {
                let local_title = name;
                let mut local_description = local.unwrap_or_default();
                let remote_description = incoming.description.as_str();
                let mut conflicts = Vec::new();
                let title_base = previous_project
                    .map(|project| project.title.as_str())
                    .unwrap_or(local_title.as_str());
                if let Some(previous_conflict) = previous_snapshot.and_then(|snapshot| {
                    snapshot
                        .conflicts
                        .iter()
                        .find(|conflict| conflict.field == "project.title")
                }) {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: "project.title".into(),
                        base: previous_conflict.base.clone(),
                        local: local_title.clone(),
                        remote: incoming.title.clone(),
                    });
                } else if incoming.title != local_title && incoming.title != title_base {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: "project.title".into(),
                        base: title_base.into(),
                        local: local_title.clone(),
                        remote: incoming.title.clone(),
                    });
                }
                if let Some(previous_conflict) = previous_snapshot.and_then(|snapshot| {
                    snapshot
                        .conflicts
                        .iter()
                        .find(|conflict| conflict.field == "project.description")
                }) {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: "project.description".into(),
                        base: previous_conflict.base.clone(),
                        local: local_description.clone(),
                        remote: remote_description.into(),
                    });
                } else if remote_description != local_description
                    && remote_description != previous_base
                {
                    conflicts.push(proto::TaskTrackerFieldConflict {
                        field: "project.description".into(),
                        base: previous_base.into(),
                        local: local_description.clone(),
                        remote: remote_description.into(),
                    });
                }
                if remote_description == local_description {
                    local_description = remote_description.to_string();
                }
                (project_id, local_title, local_description, conflicts)
            }
        };

        let mut project_identity_conflict = None;
        let domain: Option<(String, Option<i64>)> = tx
            .query_row(
                "SELECT kind, project_id FROM backlog_task_domain WHERE task_id=?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match domain {
            None => {
                tx.execute(
                    "INSERT INTO backlog_task_domain(task_id,kind,project_id,user_status_override) VALUES (?1,'delivery',?2,0)",
                    params![task_id, project_id],
                )?;
                if !created_task {
                    let revision = bump_tracker_task_revision(
                        tx,
                        task_id,
                        now_ms,
                        "tracker_project_assigned",
                        &serde_json::json!({"project_id":{"old":null,"new":project_id}}),
                    )?;
                    let _ = revision;
                }
            }
            Some((kind, current_project_id)) if current_project_id == Some(project_id) => {
                let _ = kind;
            }
            Some((_kind, current_project_id)) if current_project_id.is_none() && !created_task => {
                tx.execute(
                    "UPDATE backlog_task_domain SET project_id=?1, approved_task_revision=NULL, planning_session_id=NULL, planning_task_revision=NULL WHERE task_id=?2",
                    params![project_id, task_id],
                )?;
                bump_tracker_task_revision(
                    tx,
                    task_id,
                    now_ms,
                    "tracker_project_assigned",
                    &serde_json::json!({"project_id":{"old":null,"new":project_id}}),
                )?;
            }
            Some((_kind, current_project_id)) => {
                let local_identity = if let Some(id) = current_project_id {
                    tx.query_row(
                        "SELECT project_external_id FROM backlog_projects WHERE id=?1",
                        [id],
                        |row| row.get::<_, Option<String>>(0),
                    )?
                    .unwrap_or_else(|| format!("local:{id}"))
                } else {
                    String::new()
                };
                let previous_identity_conflict = previous_snapshot.and_then(|snapshot| {
                    snapshot
                        .conflicts
                        .iter()
                        .find(|conflict| conflict.field == "project.identity")
                });
                let identity_base = previous_identity_conflict
                    .map(|conflict| conflict.base.clone())
                    .or_else(|| {
                        previous_snapshot
                            .and_then(|snapshot| snapshot.base.get("project.identity").cloned())
                    })
                    .unwrap_or_default();
                if let Some(conflict) = previous_identity_conflict {
                    project_identity_conflict = Some(proto::TaskTrackerFieldConflict {
                        field: "project.identity".into(),
                        base: conflict.base.clone(),
                        local: local_identity,
                        remote: external_id.clone(),
                    });
                } else if external_id != identity_base {
                    project_identity_conflict = Some(proto::TaskTrackerFieldConflict {
                        field: "project.identity".into(),
                        base: identity_base,
                        local: local_identity,
                        remote: external_id.clone(),
                    });
                }
            }
        }

        let mut link: proto::TaskExternalLink = tx.query_row(
            "SELECT task_id,provider,external_id,url,fetched_at_ms,body_hash,remote_rev,synced_at_ms,source,snapshot,sync_state
             FROM task_external_links WHERE task_id=?1 AND provider=?2 AND source='source' ORDER BY external_id LIMIT 1",
            params![task_id, provider_name(provider)], link_from_row,
        )?;
        let old_snapshot = link.snapshot.clone();
        link.snapshot.project_external_id = Some(external_id.clone());
        let mut remote_project = incoming.clone();
        remote_project.external_id = external_id.clone();
        link.snapshot.project = Some(remote_project);
        link.snapshot
            .local
            .insert("project.title".into(), local_title.clone());
        link.snapshot
            .remote
            .insert("project.title".into(), incoming.title.clone());
        let project_title_base = project_conflicts
            .iter()
            .find(|conflict| conflict.field == "project.title")
            .map(|conflict| conflict.base.clone())
            .unwrap_or_else(|| incoming.title.clone());
        link.snapshot
            .base
            .insert("project.title".into(), project_title_base);
        link.snapshot
            .local
            .insert("project.description".into(), local_description.clone());
        link.snapshot
            .remote
            .insert("project.description".into(), incoming.description.clone());
        let prior_project_base = if project_conflicts
            .iter()
            .any(|conflict| conflict.field == "project.description")
        {
            previous_base.to_string()
        } else {
            incoming.description.clone()
        };
        link.snapshot
            .base
            .insert("project.description".into(), prior_project_base);
        let local_identity = project_identity_conflict
            .as_ref()
            .map(|conflict| conflict.local.clone())
            .unwrap_or_else(|| external_id.clone());
        link.snapshot
            .local
            .insert("project.identity".into(), local_identity);
        link.snapshot
            .remote
            .insert("project.identity".into(), external_id);
        let identity_base = project_identity_conflict
            .as_ref()
            .map(|conflict| conflict.base.clone())
            .or_else(|| {
                previous_snapshot
                    .and_then(|snapshot| snapshot.base.get("project.identity").cloned())
            })
            .unwrap_or_else(|| {
                link.snapshot
                    .project_external_id
                    .clone()
                    .unwrap_or_default()
            });
        link.snapshot
            .base
            .insert("project.identity".into(), identity_base);
        link.snapshot.conflicts.retain(|conflict| {
            conflict.field != "project.title"
                && conflict.field != "project.description"
                && conflict.field != "project.identity"
        });
        link.snapshot.conflicts.extend(project_conflicts);
        if let Some(conflict) = project_identity_conflict {
            link.snapshot.conflicts.push(conflict);
        }
        if link.snapshot.base != old_snapshot.base
            || link.snapshot.local != old_snapshot.local
            || link.snapshot.remote != old_snapshot.remote
            || link.snapshot.conflicts != old_snapshot.conflicts
            || link.snapshot.project_external_id != old_snapshot.project_external_id
            || link.snapshot.project != old_snapshot.project
        {
            link.snapshot.revision += 1;
        }
        link.sync_state = tracker_snapshot_state(&link.snapshot);
        tx.execute(
            "UPDATE task_external_links SET snapshot=?1,sync_state=?2 WHERE task_id=?3 AND provider=?4 AND external_id=?5 AND source='source'",
            params![serde_json::to_string(&link.snapshot)?, serde_json::to_string(&link.sync_state)?, task_id, provider_name(provider), link.external_id],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn task_tracker_outbox_enqueue(
        &self,
        workspace: &str,
        task_id: i64,
        provider: proto::TaskTrackerProvider,
        action: &str,
        revision: i64,
        payload: &str,
        now_ms: i64,
    ) -> Result<bool> {
        if payload.len() > 65_536 {
            bail!(
                "task tracker outbox payload is {} bytes, over the 65536-byte limit",
                payload.len()
            );
        }
        let conn = self.conn.lock().expect("sqlite lock");
        let changed = conn.execute(
            "INSERT OR IGNORE INTO task_tracker_outbox(workspace, task_id, provider, action, revision, payload, next_attempt_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![workspace, task_id, provider_name(provider), action, revision, payload, now_ms],
        )?;
        if changed == 1 {
            return Ok(true);
        }
        if matches!(action, "delivery_close" | "close_delivery") {
            let revived = conn.execute(
                "UPDATE task_tracker_outbox SET payload=?1, attempts=0, next_attempt_at_ms=?2, last_error=NULL, receipt=NULL
                 WHERE task_id=?3 AND provider=?4 AND action=?5 AND revision=?6 AND receipt=?7",
                params![payload, now_ms, task_id, provider_name(provider), action, revision, r#"{"superseded":true}"#],
            )?;
            return Ok(revived == 1);
        }
        Ok(false)
    }

    /// Called by task-domain transitions after their task transaction commits.
    /// Eligibility is decided here so task mutation code does not need provider rules.
    pub fn enqueue_task_tracker_action(
        &self,
        task_id: i64,
        action: &str,
        revision: i64,
        now_ms: i64,
    ) -> Result<()> {
        if !matches!(
            action,
            "created" | "updated" | "handed_back" | "merged" | "delivery_rolled_up"
        ) {
            bail!("unknown task tracker transition action {action:?}");
        }
        type TrackerTaskRow = (Option<String>, u32, String, String, String, Option<i64>);
        let task: Option<TrackerTaskRow> = self.conn.lock().expect("sqlite lock").query_row(
            "SELECT workspace, number, title, description, status, parent_id FROM backlog_tasks WHERE id=?1 AND revision=?2",
            params![task_id, revision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?;
        let Some((workspace, _number, _title, _description, _status, parent_id)) = task else {
            bail!("task {task_id} is missing or no longer at expected revision {revision}");
        };
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let domain: Option<(String, Option<i64>, bool)> = self.conn.lock().expect("sqlite lock").query_row(
            "SELECT kind, project_id, user_status_override FROM backlog_task_domain WHERE task_id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        ).optional()?;
        let Some((kind, project_id, _user_status_override)) = domain else {
            return Ok(());
        };
        let settings = self.task_tracker_enabled_settings()?;
        for settings in settings
            .into_iter()
            .filter(|settings| settings.workspace == workspace)
        {
            let (target_task_id, target_workspace, target_status, target_revision, target_override) =
                if kind == "slice" && matches!(action, "handed_back" | "merged") {
                    let Some(parent_id) = parent_id else {
                        continue;
                    };
                    let delivery: Option<(Option<String>, String, i64, bool)> = self.conn.lock().expect("sqlite lock").query_row(
                    "SELECT t.workspace,t.status,t.revision,d.user_status_override FROM backlog_tasks t JOIN backlog_task_domain d ON d.task_id=t.id WHERE t.id=?1 AND d.kind='delivery'",
                    [parent_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, i64>(3)? != 0)),
                ).optional()?;
                    let Some((Some(delivery_workspace), status, delivery_revision, override_done)) =
                        delivery
                    else {
                        continue;
                    };
                    (
                        parent_id,
                        delivery_workspace,
                        status,
                        delivery_revision,
                        override_done,
                    )
                } else {
                    let task_state: (String, i64, bool) = self.conn.lock().expect("sqlite lock").query_row(
                    "SELECT t.status,t.revision,COALESCE(d.user_status_override,0) FROM backlog_tasks t LEFT JOIN backlog_task_domain d ON d.task_id=t.id WHERE t.id=?1",
                    [task_id], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
                )?;
                    (
                        task_id,
                        workspace.clone(),
                        task_state.0,
                        task_state.1,
                        task_state.2,
                    )
                };
            if target_workspace != settings.workspace {
                continue;
            }
            let links = self.task_external_links(target_task_id)?;
            let slice_links = if target_task_id != task_id {
                self.task_external_links(task_id)?
            } else {
                Vec::new()
            };
            let source = links.iter().find(|link| {
                link.provider == settings.provider
                    && link.source == proto::TaskExternalLinkSource::Source
            });
            if matches!(action, "created" | "updated")
                && kind == "delivery"
                && project_id.is_some()
                && source.is_none()
                && settings.provider == proto::TaskTrackerProvider::GithubIssues
            {
                let namespace = self.task_tracker_database_namespace()?;
                let marker = format!("delivery-{namespace}-{task_id}");
                let payload = serde_json::json!({
                    "delivery_marker": marker,
                    "task_identity": format!("houston-task-{namespace}-{task_id}"),
                    "title": self.task(task_id)?.map(|task| task.title).unwrap_or_default(),
                    "description": self.task(task_id)?.map(|task| task.description).unwrap_or_default(),
                });
                self.task_tracker_outbox_enqueue(
                    &workspace,
                    task_id,
                    settings.provider,
                    "create",
                    revision,
                    &payload.to_string(),
                    now_ms,
                )?;
                continue;
            }
            let Some(source) = source else {
                continue;
            };
            match action {
                "updated" => {
                    let status_changed = self.conn.lock().expect("sqlite lock").query_row(
                        "SELECT changes FROM backlog_task_history WHERE task_id=?1 ORDER BY id DESC LIMIT 1",
                        [task_id], |row| row.get::<_, String>(0),
                    ).optional()?.and_then(|changes| serde_json::from_str::<serde_json::Value>(&changes).ok())
                        .is_some_and(|changes| changes.get("status").is_some());
                    if !status_changed {
                        continue;
                    }
                    let payload = match settings.provider {
                        proto::TaskTrackerProvider::GithubIssues => {
                            let Some(issue_number) = source
                                .external_id
                                .rsplit_once('#')
                                .and_then(|(_, number)| number.parse::<u64>().ok())
                            else {
                                continue;
                            };
                            serde_json::json!({"issue_number":issue_number,"task_identity":format!("houston-task-{}-{target_task_id}", self.task_tracker_database_namespace()?),"status":target_status,"revision":target_revision})
                        }
                        proto::TaskTrackerProvider::Notion => {
                            serde_json::json!({"external_id":source.external_id,"status":target_status})
                        }
                        proto::TaskTrackerProvider::Slack => continue,
                    };
                    self.task_tracker_outbox_enqueue(
                        &workspace,
                        task_id,
                        settings.provider,
                        "status",
                        revision,
                        &payload.to_string(),
                        now_ms,
                    )?;
                    if kind == "delivery"
                        && settings.provider == proto::TaskTrackerProvider::GithubIssues
                        && target_status == "done"
                        && target_override
                    {
                        let issue_number = payload["issue_number"]
                            .as_u64()
                            .context("delivery Source omitted its issue number")?;
                        let close = serde_json::json!({"issue_number":issue_number,"delivery_task_id":target_task_id,"authorized_by_daemon":true,"all_children_done":false,"user_override":true});
                        self.task_tracker_outbox_enqueue(
                            &workspace,
                            target_task_id,
                            settings.provider,
                            "delivery_close",
                            target_revision,
                            &close.to_string(),
                            now_ms,
                        )?;
                    }
                }
                "handed_back" => {
                    let slice = self
                        .task(task_id)?
                        .context("handed-back Slice disappeared")?;
                    let summary = self
                        .task_tracker_latest_summary(task_id)?
                        .unwrap_or_else(|| slice.description.clone());
                    let summary = format!("{}: {}", slice.title, summary);
                    match settings.provider {
                        proto::TaskTrackerProvider::GithubIssues => {
                            let Some(issue_number) = source
                                .external_id
                                .rsplit_once('#')
                                .and_then(|(_, number)| number.parse::<u64>().ok())
                            else {
                                continue;
                            };
                            let namespace = self.task_tracker_database_namespace()?;
                            let identity = format!("houston-task-{namespace}-{target_task_id}");
                            let status_payload = serde_json::json!({"delivery_task_id":target_task_id,"issue_number":issue_number,"task_identity":identity,"status":target_status,"revision":target_revision});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "status",
                                revision,
                                &status_payload.to_string(),
                                now_ms,
                            )?;
                            let summary_payload = serde_json::json!({"delivery_task_id":target_task_id,"issue_number":issue_number,"task_identity":format!("houston-task-{namespace}-{task_id}"),"summary":summary,"revision":revision});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "summary_comment",
                                revision,
                                &summary_payload.to_string(),
                                now_ms,
                            )?;
                        }
                        proto::TaskTrackerProvider::Notion => {
                            let status_payload = serde_json::json!({"delivery_task_id":target_task_id,"external_id":source.external_id,"status":target_status});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "status",
                                revision,
                                &status_payload.to_string(),
                                now_ms,
                            )?;
                            let summary_payload = serde_json::json!({"delivery_task_id":target_task_id,"external_id":source.external_id,"task_identity":format!("houston-task-{}-{task_id}", self.task_tracker_database_namespace()?),"revision":revision,"summary":summary});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "handback_summary",
                                revision,
                                &summary_payload.to_string(),
                                now_ms,
                            )?;
                        }
                        proto::TaskTrackerProvider::Slack => {}
                    }
                    let pr_url = slice_links
                        .iter()
                        .find(|link| {
                            link.provider == settings.provider
                                && link.source == proto::TaskExternalLinkSource::PullRequest
                        })
                        .map(|link| link.url.clone())
                        .or(self.task_tracker_latest_pr_url(task_id)?);
                    if let Some(pr_url) = pr_url {
                        let payload = match settings.provider {
                            proto::TaskTrackerProvider::GithubIssues => {
                                let Some(issue_number) = source
                                    .external_id
                                    .rsplit_once('#')
                                    .and_then(|(_, number)| number.parse::<u64>().ok())
                                else {
                                    continue;
                                };
                                serde_json::json!({"delivery_task_id":target_task_id,"issue_number":issue_number,"task_identity":format!("houston-task-{}-{task_id}", self.task_tracker_database_namespace()?),"url":pr_url,"revision":revision})
                            }
                            proto::TaskTrackerProvider::Notion => {
                                serde_json::json!({"delivery_task_id":target_task_id,"external_id":source.external_id,"url":pr_url})
                            }
                            proto::TaskTrackerProvider::Slack => continue,
                        };
                        let operation =
                            if settings.provider == proto::TaskTrackerProvider::GithubIssues {
                                "pr_reference"
                            } else {
                                "pull_request_url"
                            };
                        self.task_tracker_outbox_enqueue(
                            &workspace,
                            task_id,
                            settings.provider,
                            operation,
                            revision,
                            &payload.to_string(),
                            now_ms,
                        )?;
                    }
                }
                "merged" => {
                    let slice = self.task(task_id)?.context("merged Slice disappeared")?;
                    let summary = self
                        .task_tracker_latest_summary(task_id)?
                        .unwrap_or_else(|| slice.description.clone());
                    let summary = format!("{}: {}", slice.title, summary);
                    match settings.provider {
                        proto::TaskTrackerProvider::GithubIssues => {
                            let Some(issue_number) = source
                                .external_id
                                .rsplit_once('#')
                                .and_then(|(_, number)| number.parse::<u64>().ok())
                            else {
                                continue;
                            };
                            let payload = serde_json::json!({"delivery_task_id":target_task_id,"issue_number":issue_number,"task_identity":format!("houston-task-{}-{task_id}", self.task_tracker_database_namespace()?),"summary":summary,"revision":revision});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "summary_comment",
                                revision,
                                &payload.to_string(),
                                now_ms,
                            )?;
                        }
                        proto::TaskTrackerProvider::Notion => {
                            let payload = serde_json::json!({"delivery_task_id":target_task_id,"external_id":source.external_id,"task_identity":format!("houston-task-{}-{task_id}", self.task_tracker_database_namespace()?),"revision":revision,"summary":summary});
                            self.task_tracker_outbox_enqueue(
                                &workspace,
                                task_id,
                                settings.provider,
                                "handback_summary",
                                revision,
                                &payload.to_string(),
                                now_ms,
                            )?;
                        }
                        proto::TaskTrackerProvider::Slack => {}
                    }
                    let pr_url = slice_links
                        .iter()
                        .find(|link| {
                            link.provider == settings.provider
                                && link.source == proto::TaskExternalLinkSource::PullRequest
                        })
                        .map(|link| link.url.clone())
                        .or(self.task_tracker_latest_pr_url(task_id)?);
                    if let Some(pr_url) = pr_url {
                        let payload = match settings.provider {
                            proto::TaskTrackerProvider::GithubIssues => {
                                let Some(issue_number) = source
                                    .external_id
                                    .rsplit_once('#')
                                    .and_then(|(_, number)| number.parse::<u64>().ok())
                                else {
                                    continue;
                                };
                                serde_json::json!({"delivery_task_id":target_task_id,"issue_number":issue_number,"task_identity":format!("houston-task-{}-{task_id}", self.task_tracker_database_namespace()?),"url":pr_url,"revision":revision})
                            }
                            proto::TaskTrackerProvider::Notion => {
                                serde_json::json!({"delivery_task_id":target_task_id,"external_id":source.external_id,"url":pr_url})
                            }
                            proto::TaskTrackerProvider::Slack => continue,
                        };
                        self.task_tracker_outbox_enqueue(
                            &workspace,
                            task_id,
                            settings.provider,
                            if settings.provider == proto::TaskTrackerProvider::GithubIssues {
                                "pr_reference"
                            } else {
                                "pull_request_url"
                            },
                            revision,
                            &payload.to_string(),
                            now_ms,
                        )?;
                    }
                }
                "delivery_rolled_up" if kind == "delivery" => {
                    let (slice_total, slice_done): (u32, u32) = self.conn.lock().expect("sqlite lock").query_row(
                        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END),0)
                         FROM backlog_tasks t JOIN backlog_task_domain d ON d.task_id=t.id
                         WHERE t.parent_id=?1 AND d.kind='slice'",
                        [task_id], |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                    let all_done = slice_total > 0 && slice_done == slice_total;
                    if settings.provider == proto::TaskTrackerProvider::GithubIssues
                        && (all_done || target_status == "done" && target_override)
                    {
                        let Some(issue_number) = source
                            .external_id
                            .rsplit_once('#')
                            .and_then(|(_, number)| number.parse::<u64>().ok())
                        else {
                            continue;
                        };
                        let payload = serde_json::json!({"issue_number":issue_number,"delivery_task_id":task_id,"authorized_by_daemon":true,"all_children_done":all_done,"user_override":!all_done && target_status == "done" && target_override});
                        self.task_tracker_outbox_enqueue(
                            &workspace,
                            task_id,
                            settings.provider,
                            "delivery_close",
                            target_revision,
                            &payload.to_string(),
                            now_ms,
                        )?;
                    } else if settings.provider == proto::TaskTrackerProvider::Notion {
                        let payload = serde_json::json!({"external_id":source.external_id,"status":target_status});
                        self.task_tracker_outbox_enqueue(
                            &workspace,
                            task_id,
                            settings.provider,
                            "status",
                            target_revision,
                            &payload.to_string(),
                            now_ms,
                        )?;
                    }
                }
                "created" | "delivery_rolled_up" => {}
                _ => unreachable!(),
            }
        }
        Ok(())
    }

    fn task_tracker_latest_summary(&self, task_id: i64) -> Result<Option<String>> {
        Ok(self.conn.lock().expect("sqlite lock").query_row(
            "SELECT summary FROM backlog_task_runs WHERE task_id=?1 AND summary IS NOT NULL ORDER BY id DESC LIMIT 1",
            [task_id], |row| row.get(0),
        ).optional()?)
    }

    fn task_tracker_latest_pr_url(&self, task_id: i64) -> Result<Option<String>> {
        Ok(self.conn.lock().expect("sqlite lock").query_row(
            "SELECT pr_url FROM backlog_task_runs WHERE task_id=?1 AND pr_url IS NOT NULL ORDER BY id DESC LIMIT 1",
            [task_id], |row| row.get(0),
        ).optional()?.flatten())
    }

    pub fn task_tracker_outbox_pending(
        &self,
        now_ms: i64,
        limit: u32,
    ) -> Result<Vec<TaskTrackerOutboxRow>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT id, workspace, task_id, provider, action, revision, payload, attempts, last_error
             FROM task_tracker_outbox WHERE receipt IS NULL AND next_attempt_at_ms <= ?1 ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![now_ms, limit.min(100)], |r| {
            let p: String = r.get(3)?;
            Ok(TaskTrackerOutboxRow {
                id: r.get(0)?,
                workspace: r.get(1)?,
                task_id: r.get(2)?,
                provider: parse_provider(&p)?,
                action: r.get(4)?,
                revision: r.get(5)?,
                payload: r.get(6)?,
                attempts: r.get::<_, u32>(7)?,
                last_error: r.get(8)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading pending task tracker outbox rows")
    }

    pub fn task_tracker_outbox_sent(&self, id: i64, receipt: &str, now_ms: i64) -> Result<()> {
        self.conn.lock().expect("sqlite lock").execute(
            "UPDATE task_tracker_outbox SET receipt=?1, last_error=NULL, next_attempt_at_ms=?2 WHERE id=?3 AND receipt IS NULL",
            params![receipt, now_ms, id],
        )?;
        Ok(())
    }

    pub fn task_tracker_enabled_settings(
        &self,
    ) -> Result<Vec<proto::TaskTrackerWorkspaceSettings>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn
            .prepare("SELECT settings FROM task_tracker_settings ORDER BY workspace, provider")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let settings = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        settings
            .into_iter()
            .map(|json| {
                serde_json::from_str::<proto::TaskTrackerWorkspaceSettings>(&json)
                    .context("parsing task tracker settings")
            })
            .filter_map(|result| match result {
                Ok(settings) if settings.enabled => Some(Ok(settings)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect()
    }

    pub fn task_tracker_outbox_current_payload(
        &self,
        row: &TaskTrackerOutboxRow,
    ) -> Result<Option<serde_json::Value>> {
        let Some(task) = self.task(row.task_id)? else {
            return Ok(None);
        };
        if task.workspace.as_deref() != Some(row.workspace.as_str()) {
            return Ok(None);
        }
        let mut payload: serde_json::Value =
            serde_json::from_str(&row.payload).context("parsing tracker outbox payload")?;
        let target_task_id = payload
            .get("delivery_task_id")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(row.task_id);
        let Some(target_task) = self.task(target_task_id)? else {
            return Ok(None);
        };
        match row.action.as_str() {
            "create" | "delivery_open" | "open_delivery" => {
                payload["title"] = serde_json::Value::String(target_task.title.clone());
                payload["description"] = serde_json::Value::String(target_task.description.clone());
            }
            "status" | "status_comment" => {
                payload["status"] = serde_json::to_value(target_task.status)?;
                payload["revision"] = serde_json::json!(target_task.revision);
                if row.provider == proto::TaskTrackerProvider::Notion {
                    let source =
                        self.task_external_links(target_task_id)?
                            .into_iter()
                            .find(|link| {
                                link.provider == row.provider
                                    && link.source == proto::TaskExternalLinkSource::Source
                            });
                    let Some(source) = source else {
                        return Ok(None);
                    };
                    payload["external_id"] = serde_json::Value::String(source.external_id);
                }
            }
            "summary_comment" | "handback_summary" => {
                if let Some(summary) = self.task_tracker_latest_summary(row.task_id)? {
                    let summary = if target_task_id != row.task_id {
                        format!("{}: {summary}", task.title)
                    } else {
                        summary
                    };
                    payload["summary"] = serde_json::Value::String(summary);
                }
            }
            "pr_reference" | "pull_request_url" => {
                let link = self
                    .task_external_links(row.task_id)?
                    .into_iter()
                    .find(|link| {
                        link.provider == row.provider
                            && link.source == proto::TaskExternalLinkSource::PullRequest
                    });
                let url = link
                    .map(|link| link.url)
                    .or(self.task_tracker_latest_pr_url(row.task_id)?);
                let Some(url) = url else {
                    return Ok(None);
                };
                payload["url"] = serde_json::Value::String(url);
                if row.provider == proto::TaskTrackerProvider::Notion {
                    payload["external_id"] = serde_json::Value::String(
                        self.task_external_links(target_task_id)?
                            .into_iter()
                            .find(|link| {
                                link.provider == row.provider
                                    && link.source == proto::TaskExternalLinkSource::Source
                            })
                            .map(|link| link.external_id)
                            .unwrap_or_default(),
                    );
                }
            }
            "delivery_close" | "close_delivery" => {
                if target_task.status != proto::TaskStatus::Done {
                    return Ok(None);
                }
                let readiness: Option<(String, bool)> = self.conn.lock().expect("sqlite lock").query_row(
                    "SELECT d.kind, d.user_status_override FROM backlog_task_domain d WHERE d.task_id=?1",
                    [row.task_id], |result| Ok((result.get(0)?, result.get::<_, i64>(1)? != 0)),
                ).optional()?;
                let Some((kind, user_override)) = readiness else {
                    return Ok(None);
                };
                if kind != "delivery" {
                    return Ok(None);
                }
                let (total, done): (u32, u32) = self.conn.lock().expect("sqlite lock").query_row(
                    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END),0)
                     FROM backlog_tasks t JOIN backlog_task_domain d ON d.task_id=t.id
                     WHERE t.parent_id=?1 AND d.kind='slice'",
                    [row.task_id],
                    |result| Ok((result.get(0)?, result.get(1)?)),
                )?;
                let all_done = total > 0 && done == total;
                let user_override = target_task.status == proto::TaskStatus::Done && user_override;
                if !all_done && !user_override {
                    return Ok(None);
                }
                let issue_number = payload
                    .get("issue_number")
                    .and_then(serde_json::Value::as_u64)
                    .context("delivery close outbox payload is missing its source issue number")?;
                payload = serde_json::json!({
                    "issue_number": issue_number,
                    "authorized_by_daemon": true,
                    "all_children_done": all_done,
                    "user_override": user_override && !all_done,
                });
            }
            _ => {}
        }
        Ok(Some(payload))
    }

    pub fn task_tracker_outbox_failed(&self, id: i64, error: &str, now_ms: i64) -> Result<()> {
        let row: Option<(u32, String, String)> = self.conn.lock().expect("sqlite lock").query_row(
            "SELECT attempts, workspace, provider FROM task_tracker_outbox WHERE id=?1 AND receipt IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        let Some((attempts, workspace, provider)) = row else {
            return Ok(());
        };
        let delay = 1_000_i64
            .saturating_mul(2_i64.saturating_pow(attempts.min(12)))
            .min(3_600_000);
        let message: String = error.chars().take(1024).collect();
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE task_tracker_outbox SET attempts=attempts+1, last_error=?1, next_attempt_at_ms=?2 WHERE id=?3 AND receipt IS NULL",
            params![message, now_ms.saturating_add(delay), id],
        )?;
        tx.execute(
            "UPDATE task_tracker_settings SET settings=json_set(settings, '$.last_error', ?1) WHERE workspace=?2 AND provider=?3",
            params![message, workspace, provider],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn task_external_links(&self, task_id: i64) -> Result<Vec<proto::TaskExternalLink>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state
             FROM task_external_links WHERE task_id = ?1 ORDER BY provider, external_id, source",
        )?;
        let rows = stmt.query_map([task_id], link_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("reading external task links")
    }

    pub fn task_has_unresolved_tracker_conflicts(&self, task_id: i64) -> Result<bool> {
        Ok(self
            .task_external_links(task_id)?
            .iter()
            .any(|link| !link.snapshot.conflicts.is_empty()))
    }

    pub fn tracker_conflicts(&self) -> Result<Vec<proto::TaskExternalLink>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state
             FROM task_external_links WHERE snapshot LIKE '%\"conflicts\":%' ORDER BY task_id, provider",
        )?;
        let rows = stmt.query_map([], link_from_row)?;
        let mut links = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        links.retain(|link| !link.snapshot.conflicts.is_empty());
        Ok(links)
    }

    pub fn task_tracker_settings(
        &self,
        workspace: &str,
    ) -> Result<Vec<proto::TaskTrackerWorkspaceSettings>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT settings FROM task_tracker_settings WHERE workspace = ?1 ORDER BY provider",
        )?;
        let rows = stmt.query_map([workspace], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("reading task tracker settings")
    }

    pub fn set_task_tracker_settings(
        &self,
        settings: &proto::TaskTrackerWorkspaceSettings,
    ) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        self.conn.lock().expect("sqlite lock").execute(
            "INSERT INTO task_tracker_settings(workspace, provider, settings) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace, provider) DO UPDATE SET settings=excluded.settings",
            params![settings.workspace, provider_name(settings.provider), json],
        )?;
        Ok(())
    }

    pub fn task_tracker_setting(
        &self,
        workspace: &str,
        provider: proto::TaskTrackerProvider,
    ) -> Result<Option<proto::TaskTrackerWorkspaceSettings>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let json: Option<String> = conn
            .query_row(
                "SELECT settings FROM task_tracker_settings WHERE workspace=?1 AND provider=?2",
                params![workspace, provider_name(provider)],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|s| serde_json::from_str(&s).context("parsing saved task tracker settings"))
            .transpose()
    }

    pub fn task_external_link_upsert(&self, link: &proto::TaskExternalLink) -> Result<()> {
        let snapshot = serde_json::to_string(&link.snapshot)?;
        if snapshot.len() > 65536 {
            bail!(
                "task tracker snapshot is {} bytes, over the 65536-byte limit",
                snapshot.len()
            );
        }
        let state = serde_json::to_string(&link.sync_state)?;
        self.conn.lock().expect("sqlite lock").execute(
            "INSERT INTO task_external_links(task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(task_id, provider, external_id, source) DO UPDATE SET url=excluded.url, fetched_at_ms=excluded.fetched_at_ms,
             body_hash=excluded.body_hash, remote_rev=excluded.remote_rev, synced_at_ms=excluded.synced_at_ms, snapshot=excluded.snapshot, sync_state=excluded.sync_state",
            params![link.task_id, provider_name(link.provider), link.external_id, link.url, link.fetched_at_ms,
                link.body_hash, link.remote_rev, link.synced_at_ms, source_name(link.source), snapshot, state],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn task_tracker_write_receipt(
        &self,
        task_id: i64,
        provider: proto::TaskTrackerProvider,
        action: &str,
        external_id: Option<&str>,
        url: Option<&str>,
        remote_rev: Option<&str>,
        now_ms: i64,
    ) -> Result<bool> {
        let source = match action {
            "create" | "delivery_open" | "open_delivery" => proto::TaskExternalLinkSource::Source,
            "pr_reference" | "pull_request_url" => proto::TaskExternalLinkSource::PullRequest,
            _ => return Ok(false),
        };
        let external_id = if source == proto::TaskExternalLinkSource::PullRequest {
            url.or(external_id)
        } else {
            external_id.or(url)
        }
        .context("tracker write receipt needs an external ID or URL")?;
        let url = url.unwrap_or(external_id);
        let existing = self.task_external_links(task_id)?.into_iter().find(|link| {
            link.provider == provider && link.external_id == external_id && link.source == source
        });
        let mut link = if let Some(link) = existing {
            link
        } else {
            let fields = if source == proto::TaskExternalLinkSource::Source {
                let task = self
                    .task(task_id)?
                    .context("tracker receipt task was not found")?;
                BTreeMap::from([
                    ("title".to_string(), task.title),
                    ("description".to_string(), task.description),
                    (
                        "status".to_string(),
                        serde_json::to_value(task.status)?
                            .as_str()
                            .context("serializing task status")?
                            .to_string(),
                    ),
                ])
            } else {
                BTreeMap::new()
            };
            let snapshot = proto::TaskTrackerSnapshot {
                base: fields.clone(),
                local: fields.clone(),
                remote: fields,
                conflicts: vec![],
                revision: 1,
                project_external_id: None,
                project: None,
            };
            proto::TaskExternalLink {
                task_id,
                provider,
                external_id: external_id.to_string(),
                url: url.to_string(),
                fetched_at_ms: None,
                body_hash: None,
                remote_rev: None,
                synced_at_ms: None,
                source,
                snapshot,
                sync_state: proto::TaskTrackerSyncState::Current,
            }
        };
        link.url = url.to_string();
        link.fetched_at_ms = Some(now_ms);
        if let Some(remote_rev) = remote_rev {
            link.remote_rev = Some(remote_rev.to_string());
        }
        link.synced_at_ms = Some(now_ms);
        self.task_external_link_upsert(&link)?;
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn task_tracker_conflict_resolve(
        &self,
        task_id: i64,
        expected_task_revision: i64,
        expected_project_revision: Option<i64>,
        provider: proto::TaskTrackerProvider,
        external_id: &str,
        field: &str,
        expected_revision: i64,
        resolution: &proto::TaskTrackerConflictResolution,
    ) -> Result<Option<proto::TaskExternalLink>> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn.transaction()?;
        let mut link: proto::TaskExternalLink = tx.query_row(
            "SELECT task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state
             FROM task_external_links WHERE task_id=?1 AND provider=?2 AND external_id=?3 AND source='source'",
            params![task_id, provider_name(provider), external_id], link_from_row,
        ).optional()?.context("external task link was not found")?;
        if link.snapshot.revision != expected_revision {
            bail!(
                "task tracker conflict revision is stale (expected {}, received {})",
                link.snapshot.revision,
                expected_revision
            );
        }
        if !matches!(
            field,
            "title"
                | "description"
                | "status"
                | "project.title"
                | "project.description"
                | "project.identity"
        ) {
            bail!("task tracker conflict field {field:?} is not a supported task field");
        }
        let live: (String, String, String, i64, Option<String>) = tx.query_row(
            "SELECT title, description, status, revision, workspace FROM backlog_tasks WHERE id=?1",
            [task_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).optional()?.context("linked task was not found")?;
        let (old_title, old_description, old_status, task_revision, workspace) = live;
        if task_revision != expected_task_revision {
            bail!(
                "task revision is stale (current {}, received {})",
                task_revision,
                expected_task_revision
            );
        }
        let conflict = link
            .snapshot
            .conflicts
            .iter()
            .position(|c| c.field == field)
            .context("the requested field has no unresolved tracker conflict")?;
        let mut item = link.snapshot.conflicts.remove(conflict);
        if matches!(field, "project.title" | "project.description") {
            let project_id: Option<i64> = tx
                .query_row(
                    "SELECT project_id FROM backlog_task_domain WHERE task_id=?1",
                    [task_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            let project_id = project_id.context("linked task has no assigned Project")?;
            let (project_name, tracker_description, project_revision): (
                String,
                Option<String>,
                i64,
            ) = tx
                .query_row(
                    "SELECT name, tracker_description, revision FROM backlog_projects
                 WHERE id=?1 AND workspace=?2 AND archived_at IS NULL",
                    params![project_id, workspace.as_deref().unwrap_or_default()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .context("assigned Project is missing or archived")?;
            let expected_project_revision = expected_project_revision
                .context("Project field resolution requires expected_project_revision")?;
            if project_revision != expected_project_revision {
                bail!("Project revision is stale (current {project_revision}, received {expected_project_revision})");
            }
            let live_value = if field == "project.title" {
                project_name
            } else {
                tracker_description.unwrap_or_default()
            };
            item.local = live_value.clone();
            let resolved = match resolution {
                proto::TaskTrackerConflictResolution::Local => live_value.clone(),
                proto::TaskTrackerConflictResolution::Remote => item.remote.clone(),
                proto::TaskTrackerConflictResolution::Custom { value } => value.clone(),
            };
            let max_bytes = if field == "project.title" {
                500
            } else {
                32_000
            };
            if resolved.trim().is_empty() || resolved.len() > max_bytes {
                bail!("resolved {field} must be non-empty and at most {max_bytes} bytes");
            }
            if resolved != live_value {
                let sql = if field == "project.title" {
                    "UPDATE backlog_projects SET name=?1, revision=revision+1, updated_at=?2 WHERE id=?3 AND workspace=?4 AND revision=?5"
                } else {
                    "UPDATE backlog_projects SET tracker_description=?1, revision=revision+1, updated_at=?2 WHERE id=?3 AND workspace=?4 AND revision=?5"
                };
                let changed = tx.execute(
                    sql,
                    params![
                        resolved,
                        now_unix_ms(),
                        project_id,
                        workspace.as_deref().unwrap_or_default(),
                        expected_project_revision
                    ],
                )?;
                if changed != 1 {
                    bail!("Project revision changed while resolving tracker conflict");
                }
                let key = if field == "project.title" {
                    "name"
                } else {
                    "tracker_description"
                };
                let changes = serde_json::Value::Object(serde_json::Map::from_iter([(
                    key.to_string(),
                    serde_json::json!({"old":live_value,"new":resolved}),
                )]))
                .to_string();
                tx.execute(
                    "INSERT INTO backlog_project_history(project_id,actor,action,changes,created_at) VALUES (?1,?2,'tracker_conflict_resolved',?3,?4)",
                    params![project_id, format!("tracker:{}", provider_name(provider)), changes, now_unix_ms()],
                )?;
            }
            link.snapshot
                .local
                .insert(field.to_string(), resolved.clone());
            link.snapshot
                .base
                .insert(field.to_string(), item.remote.clone());
            link.snapshot.remote.insert(field.to_string(), item.remote);
            link.snapshot
                .conflicts
                .retain(|conflict| conflict.field != field);
            link.snapshot.revision += 1;
            link.sync_state = tracker_snapshot_state(&link.snapshot);
            tx.execute(
                "UPDATE task_external_links SET snapshot=?1,sync_state=?2 WHERE task_id=?3 AND provider=?4 AND external_id=?5 AND source='source'",
                params![serde_json::to_string(&link.snapshot)?, serde_json::to_string(&link.sync_state)?, task_id, provider_name(provider), external_id],
            )?;
            tx.commit()?;
            return Ok(Some(link));
        }
        if field == "project.identity" {
            let (kind, current_project_id): (String, Option<i64>) = tx
                .query_row(
                    "SELECT kind, project_id FROM backlog_task_domain WHERE task_id=?1",
                    [task_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .context("task has no Delivery/Project assignment to resolve")?;
            if kind != "delivery" {
                bail!("project.identity conflicts can only be resolved on Delivery tasks");
            }
            let current_project_id =
                current_project_id.context("Delivery has no current Project assignment")?;
            let (current_identity, project_revision): (String, i64) = tx.query_row(
                "SELECT COALESCE(project_external_id, ''), revision FROM backlog_projects WHERE id=?1 AND workspace=?2 AND archived_at IS NULL",
                params![current_project_id, workspace.as_deref().unwrap_or_default()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).optional()?.context("assigned Project is missing or archived")?;
            let expected_project_revision = expected_project_revision
                .context("project.identity resolution requires expected_project_revision")?;
            if project_revision != expected_project_revision {
                bail!("Project revision is stale (current {project_revision}, received {expected_project_revision})");
            }
            let current_identity = if current_identity.is_empty() {
                format!("local:{current_project_id}")
            } else {
                current_identity
            };
            item.local = current_identity;
            let desired_identity = match resolution {
                proto::TaskTrackerConflictResolution::Local => item.local.clone(),
                proto::TaskTrackerConflictResolution::Remote => item.remote.clone(),
                proto::TaskTrackerConflictResolution::Custom { value } => value.clone(),
            };
            let desired_project_id: i64 = if matches!(
                resolution,
                proto::TaskTrackerConflictResolution::Local
            ) {
                current_project_id
            } else {
                tx.query_row(
                    "SELECT id FROM backlog_projects WHERE workspace=?1 AND project_external_id=?2 AND archived_at IS NULL",
                    params![workspace.as_deref().unwrap_or_default(), desired_identity], |row| row.get(0),
                ).optional()?.context("selected tracker Project identity does not exist in this workspace")?
            };
            if desired_project_id != current_project_id {
                tx.execute(
                    "UPDATE backlog_task_domain SET project_id=?1, approved_task_revision=NULL, planning_session_id=NULL, planning_task_revision=NULL WHERE task_id=?2",
                    params![desired_project_id, task_id],
                )?;
                bump_tracker_task_revision(
                    &tx,
                    task_id,
                    now_unix_ms(),
                    "tracker_project_conflict_resolved",
                    &serde_json::json!({"project_id":{"old":current_project_id,"new":desired_project_id}}),
                )?;
            }
            link.snapshot
                .local
                .insert(field.to_string(), desired_identity.clone());
            link.snapshot
                .base
                .insert(field.to_string(), item.remote.clone());
            link.snapshot
                .conflicts
                .retain(|conflict| conflict.field != field);
            link.snapshot.revision += 1;
            link.sync_state = tracker_snapshot_state(&link.snapshot);
            tx.execute(
                "UPDATE task_external_links SET snapshot=?1,sync_state=?2 WHERE task_id=?3 AND provider=?4 AND external_id=?5 AND source='source'",
                params![serde_json::to_string(&link.snapshot)?, serde_json::to_string(&link.sync_state)?, task_id, provider_name(provider), external_id],
            )?;
            tx.commit()?;
            return Ok(Some(link));
        }
        let live_value = match field {
            "title" => old_title.as_str(),
            "description" => old_description.as_str(),
            "status" => old_status.as_str(),
            _ => unreachable!(),
        };
        item.local = live_value.to_string();
        let resolved = match resolution {
            proto::TaskTrackerConflictResolution::Local => live_value.to_string(),
            proto::TaskTrackerConflictResolution::Remote => item.remote.clone(),
            proto::TaskTrackerConflictResolution::Custom { value } => value.clone(),
        };
        if field == "status"
            && serde_json::from_str::<proto::TaskStatus>(&format!("\"{resolved}\"")).is_err()
        {
            bail!("resolved task status {resolved:?} is invalid");
        }
        let (new_title, new_description, new_status) = match field {
            "title" => (
                resolved.clone(),
                old_description.clone(),
                old_status.clone(),
            ),
            "description" => (old_title.clone(), resolved.clone(), old_status.clone()),
            "status" => (old_title.clone(), old_description.clone(), resolved.clone()),
            _ => unreachable!(),
        };
        let changed = new_title != old_title
            || new_description != old_description
            || new_status != old_status;
        let next_task_revision = if changed {
            task_revision + 1
        } else {
            task_revision
        };
        if changed {
            let changes = serde_json::Value::Object(serde_json::Map::from_iter([(
                field.to_string(),
                serde_json::json!({"old": live_value, "new": resolved}),
            )]))
            .to_string();
            let updated = tx.execute(
                "UPDATE backlog_tasks SET title=?1, description=?2, status=?3, revision=revision+1, updated_at=?4 WHERE id=?5 AND revision=?6",
                params![new_title, new_description, new_status, now_unix_ms(), task_id, expected_task_revision],
            )?;
            if updated != 1 {
                bail!("task revision changed while resolving tracker conflict (expected {expected_task_revision})");
            }
            tx.execute(
                "INSERT INTO backlog_task_history(task_id, actor, action, changes, created_at) VALUES (?1, ?2, 'tracker_conflict_resolved', ?3, ?4)",
                params![task_id, format!("tracker:{}", provider_name(provider)), changes, now_unix_ms()],
            )?;
        }
        if field == "status" {
            tx.execute(
                "UPDATE backlog_task_domain SET user_status_override=?1 WHERE task_id=?2",
                params![
                    if matches!(resolution, proto::TaskTrackerConflictResolution::Remote) {
                        0_i64
                    } else {
                        1_i64
                    },
                    task_id
                ],
            )?;
        }
        let writeback = field == "status"
            && !matches!(resolution, proto::TaskTrackerConflictResolution::Remote);
        if writeback {
            if let Some(workspace) = workspace.as_deref() {
                let (action, payload) = match provider {
                    proto::TaskTrackerProvider::GithubIssues => {
                        let issue_number = external_id
                            .rsplit_once('#')
                            .and_then(|(_, number)| number.parse::<u64>().ok());
                        let Some(issue_number) = issue_number else {
                            bail!("GitHub source link {external_id:?} has no numeric issue number");
                        };
                        (
                            "status",
                            serde_json::json!({"issue_number":issue_number,"task_identity":format!("houston-task-{}-{task_id}", database_namespace_tx(&tx)?),"status":resolved,"revision":next_task_revision}),
                        )
                    }
                    proto::TaskTrackerProvider::Notion => (
                        "status",
                        serde_json::json!({"external_id":external_id,"status":resolved}),
                    ),
                    proto::TaskTrackerProvider::Slack => ("", serde_json::Value::Null),
                };
                if action.is_empty() {
                    bail!("Slack source links do not accept tracker status writeback");
                }
                tx.execute(
                    "INSERT OR IGNORE INTO task_tracker_outbox(workspace, task_id, provider, action, revision, payload, next_attempt_at_ms)
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (
                       SELECT 1 FROM task_tracker_settings WHERE workspace=?1 AND provider=?3 AND json_extract(settings, '$.enabled')=1
                     )",
                    params![workspace, task_id, provider_name(provider), action, next_task_revision, payload.to_string(), now_unix_ms()],
                )?;
            }
        }
        link.snapshot
            .local
            .insert(field.to_string(), resolved.clone());
        link.snapshot.base.insert(field.to_string(), item.remote);
        link.snapshot.revision += 1;
        link.sync_state = tracker_snapshot_state(&link.snapshot);
        tx.execute("UPDATE task_external_links SET snapshot=?1, sync_state=?2 WHERE task_id=?3 AND provider=?4 AND external_id=?5 AND source='source'",
            params![serde_json::to_string(&link.snapshot)?, serde_json::to_string(&link.sync_state)?, task_id, provider_name(provider), external_id])?;
        tx.commit()?;
        Ok(Some(link))
    }
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn database_namespace_tx(tx: &rusqlite::Transaction<'_>) -> Result<String> {
    Ok(tx.query_row(
        "SELECT namespace FROM task_tracker_database_identity WHERE singleton=1",
        [],
        |row| row.get(0),
    )?)
}

fn tracker_snapshot_state(snapshot: &proto::TaskTrackerSnapshot) -> proto::TaskTrackerSyncState {
    if !snapshot.conflicts.is_empty() {
        proto::TaskTrackerSyncState::Diverged
    } else if snapshot.local.iter().any(|(field, local)| {
        snapshot
            .remote
            .get(field)
            .is_some_and(|remote| remote != local)
    }) {
        proto::TaskTrackerSyncState::Pending
    } else {
        proto::TaskTrackerSyncState::Current
    }
}

fn validate_external_project_identity(external_id: &str) -> Result<()> {
    let mut parts = external_id.split(':');
    let provider = parts.next().unwrap_or_default();
    let remote_context = parts.next().unwrap_or_default();
    let remote_id = parts.next().unwrap_or_default();
    if provider.is_empty() || remote_context.is_empty() || remote_id.is_empty() {
        bail!("project_external_id {external_id:?} is not provider-qualified (expected provider:remote-context:id)");
    }
    Ok(())
}

fn bump_tracker_task_revision(
    tx: &rusqlite::Transaction<'_>,
    task_id: i64,
    now_ms: i64,
    action: &str,
    changes: &serde_json::Value,
) -> Result<i64> {
    let revision: i64 = tx.query_row(
        "SELECT revision FROM backlog_tasks WHERE id=?1",
        [task_id],
        |row| row.get(0),
    )?;
    let changed = tx.execute(
        "UPDATE backlog_tasks SET revision=revision+1, updated_at=?1 WHERE id=?2 AND revision=?3",
        params![now_ms, task_id, revision],
    )?;
    if changed != 1 {
        bail!("task {task_id} changed while applying tracker project metadata");
    }
    tx.execute(
        "INSERT INTO backlog_task_history(task_id,actor,action,changes,created_at) VALUES (?1,'houston:tracker',?2,?3,?4)",
        params![task_id, action, changes.to_string(), now_ms],
    )?;
    Ok(revision + 1)
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<proto::TaskExternalLink> {
    let provider: String = row.get(1)?;
    let source: String = row.get(8)?;
    let snapshot: String = row.get(9)?;
    let sync_state: String = row.get(10)?;
    Ok(proto::TaskExternalLink {
        task_id: row.get(0)?,
        provider: parse_provider(&provider)?,
        external_id: row.get(2)?,
        url: row.get(3)?,
        fetched_at_ms: row.get(4)?,
        body_hash: row.get(5)?,
        remote_rev: row.get(6)?,
        synced_at_ms: row.get(7)?,
        source: serde_json::from_str(&format!("\"{source}\""))
            .map_err(|e| conversion_error(8, e))?,
        snapshot: serde_json::from_str(&snapshot).map_err(|e| conversion_error(9, e))?,
        sync_state: serde_json::from_str(&sync_state).map_err(|e| conversion_error(10, e))?,
    })
}

fn conversion_error(column: usize, e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
}
fn provider_name(p: proto::TaskTrackerProvider) -> &'static str {
    match p {
        proto::TaskTrackerProvider::GithubIssues => "github_issues",
        proto::TaskTrackerProvider::Notion => "notion",
        proto::TaskTrackerProvider::Slack => "slack",
    }
}
fn parse_provider(p: &str) -> rusqlite::Result<proto::TaskTrackerProvider> {
    match p {
        "github_issues" => Ok(proto::TaskTrackerProvider::GithubIssues),
        "notion" => Ok(proto::TaskTrackerProvider::Notion),
        "slack" => Ok(proto::TaskTrackerProvider::Slack),
        _ => Err(conversion_error(
            1,
            serde_json::from_str::<proto::TaskTrackerProvider>(&format!("\"{p}\"")).unwrap_err(),
        )),
    }
}
fn source_name(s: proto::TaskExternalLinkSource) -> &'static str {
    match s {
        proto::TaskExternalLinkSource::Source => "source",
        proto::TaskExternalLinkSource::PullRequest => "pull_request",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn link(task_id: i64) -> proto::TaskExternalLink {
        let mut base = BTreeMap::new();
        base.insert("title".into(), "Original".into());
        let mut local = BTreeMap::new();
        local.insert("title".into(), "Local edit".into());
        let mut remote = BTreeMap::new();
        remote.insert("title".into(), "Remote edit".into());
        proto::TaskExternalLink {
            task_id,
            provider: proto::TaskTrackerProvider::GithubIssues,
            external_id: "owner/repo#12".into(),
            url: "https://github.com/owner/repo/issues/12".into(),
            fetched_at_ms: Some(10),
            body_hash: Some("hash".into()),
            remote_rev: Some("etag-1".into()),
            synced_at_ms: Some(10),
            source: proto::TaskExternalLinkSource::Source,
            snapshot: proto::TaskTrackerSnapshot {
                base,
                local,
                remote,
                conflicts: vec![proto::TaskTrackerFieldConflict {
                    field: "title".into(),
                    base: "Original".into(),
                    local: "Local edit".into(),
                    remote: "Remote edit".into(),
                }],
                revision: 3,
                project_external_id: None,
                project: None,
            },
            sync_state: proto::TaskTrackerSyncState::Diverged,
        }
    }

    #[test]
    fn task_links_preserve_field_conflicts_and_require_current_revision_to_resolve() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker.sqlite")).unwrap();
        let local_title = "Local edit";
        let row = db
            .create_task(&super::super::TaskWrite {
                workspace: Some("/tmp/workspace"),
                title: local_title,
                description: "Current task description",
                status: proto::TaskStatus::Todo,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: "test",
                now_ms: 10,
                acceptance: &[],
            })
            .unwrap();
        let link = link(row.id);
        db.task_external_link_upsert(&link).unwrap();

        assert!(db.task_has_unresolved_tracker_conflicts(row.id).unwrap());
        let read = db.task_external_links(row.id).unwrap();
        assert_eq!(read, vec![link.clone()]);
        assert_eq!(db.tracker_conflicts().unwrap(), vec![link.clone()]);

        let stale_task = db.task_tracker_conflict_resolve(
            row.id,
            0,
            None,
            link.provider,
            &link.external_id,
            "title",
            3,
            &proto::TaskTrackerConflictResolution::Remote,
        );
        assert!(stale_task.is_err());
        assert_eq!(db.task(row.id).unwrap().unwrap().title, local_title);
        assert!(db.task_has_unresolved_tracker_conflicts(row.id).unwrap());

        let stale = db.task_tracker_conflict_resolve(
            row.id,
            1,
            None,
            link.provider,
            &link.external_id,
            "title",
            2,
            &proto::TaskTrackerConflictResolution::Remote,
        );
        assert!(stale.is_err());
        assert!(db.task_has_unresolved_tracker_conflicts(row.id).unwrap());

        let resolved = db
            .task_tracker_conflict_resolve(
                row.id,
                1,
                None,
                link.provider,
                &link.external_id,
                "title",
                3,
                &proto::TaskTrackerConflictResolution::Remote,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            resolved.snapshot.local.get("title").map(String::as_str),
            Some("Remote edit")
        );
        assert!(resolved.snapshot.conflicts.is_empty());
        assert!(!db.task_has_unresolved_tracker_conflicts(row.id).unwrap());
        let updated_task = db.task(row.id).unwrap().unwrap();
        assert_eq!(updated_task.title, "Remote edit");
        assert_eq!(updated_task.revision, 2);
        assert_eq!(db.task_history(row.id, 10).unwrap().len(), 2);
        assert_eq!(db.task_external_links(row.id).unwrap(), vec![resolved]);
        assert!(
            db.task_tracker_outbox_pending(20, 10).unwrap().is_empty(),
            "choosing the remote value needs no writeback"
        );
    }

    #[test]
    fn local_resolution_uses_live_task_text_and_enqueues_writeback_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-live-local.sqlite")).unwrap();
        let row = db
            .create_task(&super::super::TaskWrite {
                workspace: Some("/tmp/workspace"),
                title: "Local edit",
                description: "Description",
                status: proto::TaskStatus::Todo,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: "test",
                now_ms: 10,
                acceptance: &[],
            })
            .unwrap();
        let link = link(row.id);
        db.task_external_link_upsert(&link).unwrap();
        let latest = super::super::TaskUpdate {
            workspace: Some("/tmp/workspace"),
            id: row.id,
            expected_revision: 1,
            title: "Newer local edit",
            description: "Description",
            status: proto::TaskStatus::Todo,
            priority: proto::TaskPriority::None,
            parent_id: None,
            ref_url: None,
            acceptance: None,
            actor: "user",
            action: "update",
            changes: "{}",
            now_ms: 11,
        };
        assert!(db.update_task(&latest).unwrap());
        assert!(db
            .task_tracker_conflict_resolve(
                row.id,
                2,
                None,
                link.provider,
                &link.external_id,
                "title",
                3,
                &proto::TaskTrackerConflictResolution::Local,
            )
            .unwrap()
            .is_some());
        let updated = db.task(row.id).unwrap().unwrap();
        assert_eq!(updated.title, "Newer local edit");
        assert_eq!(updated.revision, 2);
        let resolved_link = db.task_external_links(row.id).unwrap().remove(0);
        assert_eq!(
            resolved_link
                .snapshot
                .local
                .get("title")
                .map(String::as_str),
            Some("Newer local edit")
        );
        assert!(resolved_link.snapshot.conflicts.is_empty());
        let outbox = db.task_tracker_outbox_pending(i64::MAX, 10).unwrap();
        assert!(
            outbox.is_empty(),
            "title writes are outside the coarse delivery writeback contract"
        );
    }

    #[test]
    fn resolving_status_refreshes_live_value_and_enqueues_provider_specific_writeback() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-status-resolution.sqlite")).unwrap();
        let row = db
            .create_task(&super::super::TaskWrite {
                workspace: Some("/tmp/workspace"),
                title: "Task",
                description: "Description",
                status: proto::TaskStatus::Todo,
                priority: proto::TaskPriority::None,
                parent_id: None,
                ref_url: None,
                created_by: "test",
                now_ms: 10,
                acceptance: &[],
            })
            .unwrap();
        let mut link = link(row.id);
        link.snapshot.conflicts = vec![proto::TaskTrackerFieldConflict {
            field: "status".into(),
            base: "todo".into(),
            local: "in_progress".into(),
            remote: "done".into(),
        }];
        link.snapshot.base.insert("status".into(), "todo".into());
        link.snapshot
            .local
            .insert("status".into(), "in_progress".into());
        link.snapshot.remote.insert("status".into(), "done".into());
        db.task_external_link_upsert(&link).unwrap();
        db.set_task_tracker_settings(&proto::TaskTrackerWorkspaceSettings {
            workspace: "/tmp/workspace".into(),
            provider: proto::TaskTrackerProvider::GithubIssues,
            enabled: true,
            github_repository: Some("owner/repo".into()),
            github_label: Some("import".into()),
            github_assigned_user: None,
            notion_data_source_id: None,
            notion_title_property_id: None,
            notion_description_property_id: None,
            notion_status_property_id: None,
            notion_assignee_property_id: None,
            notion_project_relation_property_id: None,
            notion_assignee_user_id: None,
            notion_active_status_values: vec![],
            notion_projects_data_source_id: None,
            notion_project_title_property_id: None,
            notion_project_description_property_id: None,
            notion_pr_url_property_id: None,
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: None,
                in_progress: None,
                in_review: None,
                done: None,
                canceled: None,
            },
            has_credential: false,
            last_sync_at_ms: None,
            last_error: None,
        })
        .unwrap();

        db.task_tracker_conflict_resolve(
            row.id,
            1,
            None,
            link.provider,
            &link.external_id,
            "status",
            link.snapshot.revision,
            &proto::TaskTrackerConflictResolution::Local,
        )
        .unwrap();
        let outbox = db.task_tracker_outbox_pending(i64::MAX, 10).unwrap();
        assert_eq!(outbox.len(), 1);
        assert_eq!(outbox[0].action, "status");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&outbox[0].payload).unwrap(),
            serde_json::json!({
                "issue_number": 12,
                "revision": 1,
                "status": "todo",
                "task_identity": format!(
                    "houston-task-{}-{}",
                    db.task_tracker_database_namespace().unwrap(),
                    row.id
                )
            })
        );
    }

    #[test]
    fn workspace_tracker_settings_round_trip_current_values() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-settings.sqlite")).unwrap();
        let settings = proto::TaskTrackerWorkspaceSettings {
            workspace: "/workspace".into(),
            provider: proto::TaskTrackerProvider::GithubIssues,
            enabled: true,
            github_repository: Some("org/repo".into()),
            github_label: Some("houston".into()),
            github_assigned_user: None,
            notion_data_source_id: None,
            notion_title_property_id: None,
            notion_description_property_id: None,
            notion_status_property_id: None,
            notion_assignee_property_id: None,
            notion_project_relation_property_id: None,
            notion_assignee_user_id: None,
            notion_active_status_values: vec![],
            has_credential: false,
            last_sync_at_ms: Some(42),
            last_error: None,
            notion_projects_data_source_id: None,
            notion_project_title_property_id: None,
            notion_project_description_property_id: None,
            notion_pr_url_property_id: None,
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: None,
                in_progress: None,
                in_review: None,
                done: None,
                canceled: None,
            },
        };
        db.set_task_tracker_settings(&settings).unwrap();
        assert_eq!(
            db.task_tracker_settings("/workspace").unwrap(),
            vec![settings]
        );
    }

    #[test]
    fn tracker_outbox_deduplicates_and_keeps_inspectable_retry_state() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-outbox.sqlite")).unwrap();
        assert!(db
            .task_tracker_outbox_enqueue(
                "/workspace",
                7,
                proto::TaskTrackerProvider::Notion,
                "status",
                4,
                r#"{"status":"Done"}"#,
                100
            )
            .unwrap());
        assert!(!db
            .task_tracker_outbox_enqueue(
                "/workspace",
                7,
                proto::TaskTrackerProvider::Notion,
                "status",
                4,
                r#"{"status":"Done"}"#,
                100
            )
            .unwrap());
        let row = db.task_tracker_outbox_pending(100, 10).unwrap().remove(0);
        db.task_tracker_outbox_failed(row.id, "temporary failure", 100)
            .unwrap();
        assert!(db
            .task_tracker_outbox_pending(1_099, 10)
            .unwrap()
            .is_empty());
        let retry = db.task_tracker_outbox_pending(1_100, 10).unwrap().remove(0);
        assert_eq!(retry.attempts, 1);
        assert_eq!(retry.last_error.as_deref(), Some("temporary failure"));
        db.task_tracker_outbox_sent(retry.id, "remote-page-id", 1_100)
            .unwrap();
        assert!(db
            .task_tracker_outbox_pending(10_000, 10)
            .unwrap()
            .is_empty());
    }
}

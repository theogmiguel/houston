use super::Db;
use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use rusqlite::{params, OptionalExtension};

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
    pub fn task_tracker_outbox_enqueue(&self, workspace: &str, task_id: i64, provider: proto::TaskTrackerProvider, action: &str, revision: i64, payload: &str, now_ms: i64) -> Result<bool> {
        if payload.len() > 65_536 { bail!("task tracker outbox payload is {} bytes, over the 65536-byte limit", payload.len()); }
        let changed = self.conn.lock().expect("sqlite lock").execute(
            "INSERT OR IGNORE INTO task_tracker_outbox(workspace, task_id, provider, action, revision, payload, next_attempt_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![workspace, task_id, provider_name(provider), action, revision, payload, now_ms],
        )?;
        Ok(changed == 1)
    }

    pub fn task_tracker_outbox_pending(&self, now_ms: i64, limit: u32) -> Result<Vec<TaskTrackerOutboxRow>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT id, workspace, task_id, provider, action, revision, payload, attempts, last_error
             FROM task_tracker_outbox WHERE receipt IS NULL AND next_attempt_at_ms <= ?1 ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![now_ms, limit.min(100)], |r| {
            let p: String = r.get(3)?;
            Ok(TaskTrackerOutboxRow { id:r.get(0)?, workspace:r.get(1)?, task_id:r.get(2)?, provider:parse_provider(&p)?, action:r.get(4)?, revision:r.get(5)?, payload:r.get(6)?, attempts:r.get::<_,u32>(7)?, last_error:r.get(8)? })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("reading pending task tracker outbox rows")
    }

    pub fn task_tracker_outbox_sent(&self, id: i64, receipt: &str, now_ms: i64) -> Result<()> {
        self.conn.lock().expect("sqlite lock").execute(
            "UPDATE task_tracker_outbox SET receipt=?1, last_error=NULL, next_attempt_at_ms=?2 WHERE id=?3 AND receipt IS NULL",
            params![receipt, now_ms, id],
        )?;
        Ok(())
    }

    pub fn task_tracker_outbox_failed(&self, id: i64, error: &str, now_ms: i64) -> Result<()> {
        let row: Option<(u32,)> = self.conn.lock().expect("sqlite lock").query_row(
            "SELECT attempts FROM task_tracker_outbox WHERE id=?1 AND receipt IS NULL", [id], |r| Ok((r.get(0)?,)),
        ).optional()?;
        let Some((attempts,)) = row else { return Ok(()); };
        let delay = 1_000_i64.saturating_mul(2_i64.saturating_pow(attempts.min(12))).min(3_600_000);
        self.conn.lock().expect("sqlite lock").execute(
            "UPDATE task_tracker_outbox SET attempts=attempts+1, last_error=?1, next_attempt_at_ms=?2 WHERE id=?3 AND receipt IS NULL",
            params![error.chars().take(1024).collect::<String>(), now_ms.saturating_add(delay), id],
        )?;
        Ok(())
    }

    pub fn task_external_links(&self, task_id: i64) -> Result<Vec<proto::TaskExternalLink>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare(
            "SELECT task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state
             FROM task_external_links WHERE task_id = ?1 ORDER BY provider, external_id, source",
        )?;
        let rows = stmt.query_map([task_id], link_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().context("reading external task links")
    }

    pub fn task_has_unresolved_tracker_conflicts(&self, task_id: i64) -> Result<bool> {
        Ok(self.task_external_links(task_id)?.iter().any(|link| !link.snapshot.conflicts.is_empty()))
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

    pub fn task_tracker_settings(&self, workspace: &str) -> Result<Vec<proto::TaskTrackerWorkspaceSettings>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let mut stmt = conn.prepare("SELECT settings FROM task_tracker_settings WHERE workspace = ?1 ORDER BY provider")?;
        let rows = stmt.query_map([workspace], |row| row.get::<_, String>(0))?;
        rows.map(|row| serde_json::from_str(&row?).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))))
            .collect::<rusqlite::Result<Vec<_>>>().context("reading task tracker settings")
    }

    pub fn set_task_tracker_settings(&self, settings: &proto::TaskTrackerWorkspaceSettings) -> Result<()> {
        let json = serde_json::to_string(settings)?;
        self.conn.lock().expect("sqlite lock").execute(
            "INSERT INTO task_tracker_settings(workspace, provider, settings) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace, provider) DO UPDATE SET settings=excluded.settings",
            params![settings.workspace, provider_name(settings.provider), json],
        )?;
        Ok(())
    }

    pub fn task_tracker_setting(&self, workspace: &str, provider: proto::TaskTrackerProvider) -> Result<Option<proto::TaskTrackerWorkspaceSettings>> {
        let conn = self.conn.lock().expect("sqlite lock");
        let json: Option<String> = conn.query_row(
            "SELECT settings FROM task_tracker_settings WHERE workspace=?1 AND provider=?2",
            params![workspace, provider_name(provider)], |row| row.get(0),
        ).optional()?;
        json.map(|s| serde_json::from_str(&s).context("parsing saved task tracker settings")).transpose()
    }

    pub fn task_external_link_upsert(&self, link: &proto::TaskExternalLink) -> Result<()> {
        let snapshot = serde_json::to_string(&link.snapshot)?;
        if snapshot.len() > 65536 { bail!("task tracker snapshot is {} bytes, over the 65536-byte limit", snapshot.len()); }
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

    pub fn task_tracker_conflict_resolve(
        &self, task_id: i64, provider: proto::TaskTrackerProvider, external_id: &str,
        field: &str, expected_revision: i64, resolution: &proto::TaskTrackerConflictResolution,
    ) -> Result<Option<proto::TaskExternalLink>> {
        let mut conn = self.conn.lock().expect("sqlite lock");
        let tx = conn.transaction()?;
        let mut link: proto::TaskExternalLink = tx.query_row(
            "SELECT task_id, provider, external_id, url, fetched_at_ms, body_hash, remote_rev, synced_at_ms, source, snapshot, sync_state
             FROM task_external_links WHERE task_id=?1 AND provider=?2 AND external_id=?3 AND source='source'",
            params![task_id, provider_name(provider), external_id], link_from_row,
        ).optional()?.context("external task link was not found")?;
        if link.snapshot.revision != expected_revision {
            bail!("task tracker conflict revision is stale (expected {}, received {})", link.snapshot.revision, expected_revision);
        }
        let conflict = link.snapshot.conflicts.iter().position(|c| c.field == field).context("the requested field has no unresolved tracker conflict")?;
        let item = link.snapshot.conflicts.remove(conflict);
        let resolved = match resolution {
            proto::TaskTrackerConflictResolution::Local => item.local,
            proto::TaskTrackerConflictResolution::Remote => item.remote,
            proto::TaskTrackerConflictResolution::Custom { value } => value.clone(),
        };
        link.snapshot.local.insert(field.to_string(), resolved.clone());
        link.snapshot.base.insert(field.to_string(), resolved);
        link.snapshot.revision += 1;
        link.sync_state = if link.snapshot.conflicts.is_empty() { proto::TaskTrackerSyncState::Current } else { proto::TaskTrackerSyncState::Diverged };
        tx.execute("UPDATE task_external_links SET snapshot=?1, sync_state=?2 WHERE task_id=?3 AND provider=?4 AND external_id=?5 AND source='source'",
            params![serde_json::to_string(&link.snapshot)?, serde_json::to_string(&link.sync_state)?, task_id, provider_name(provider), external_id])?;
        tx.commit()?;
        Ok(Some(link))
    }
}

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<proto::TaskExternalLink> {
    let provider: String = row.get(1)?;
    let source: String = row.get(8)?;
    let snapshot: String = row.get(9)?;
    let sync_state: String = row.get(10)?;
    Ok(proto::TaskExternalLink {
        task_id: row.get(0)?, provider: parse_provider(&provider)?, external_id: row.get(2)?, url: row.get(3)?,
        fetched_at_ms: row.get(4)?, body_hash: row.get(5)?, remote_rev: row.get(6)?, synced_at_ms: row.get(7)?,
        source: serde_json::from_str(&format!("\"{source}\"")).map_err(|e| conversion_error(8, e))?,
        snapshot: serde_json::from_str(&snapshot).map_err(|e| conversion_error(9, e))?,
        sync_state: serde_json::from_str(&sync_state).map_err(|e| conversion_error(10, e))?,
    })
}

fn conversion_error(column: usize, e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
}
fn provider_name(p: proto::TaskTrackerProvider) -> &'static str { match p { proto::TaskTrackerProvider::GithubIssues => "github_issues", proto::TaskTrackerProvider::Notion => "notion", proto::TaskTrackerProvider::Slack => "slack" } }
fn parse_provider(p: &str) -> rusqlite::Result<proto::TaskTrackerProvider> { match p { "github_issues" => Ok(proto::TaskTrackerProvider::GithubIssues), "notion" => Ok(proto::TaskTrackerProvider::Notion), "slack" => Ok(proto::TaskTrackerProvider::Slack), _ => Err(conversion_error(1, serde_json::from_str::<proto::TaskTrackerProvider>(&format!("\"{p}\"")).unwrap_err())) } }
fn source_name(s: proto::TaskExternalLinkSource) -> &'static str { match s { proto::TaskExternalLinkSource::Source => "source", proto::TaskExternalLinkSource::PullRequest => "pull_request" } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn link() -> proto::TaskExternalLink {
        let mut base = BTreeMap::new();
        base.insert("title".into(), "Original".into());
        let mut local = BTreeMap::new();
        local.insert("title".into(), "Local edit".into());
        let mut remote = BTreeMap::new();
        remote.insert("title".into(), "Remote edit".into());
        proto::TaskExternalLink {
            task_id: 7,
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
                    field: "title".into(), base: "Original".into(), local: "Local edit".into(), remote: "Remote edit".into(),
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
        let link = link();
        db.task_external_link_upsert(&link).unwrap();

        assert!(db.task_has_unresolved_tracker_conflicts(7).unwrap());
        let read = db.task_external_links(7).unwrap();
        assert_eq!(read, vec![link.clone()]);
        assert_eq!(db.tracker_conflicts().unwrap(), vec![link.clone()]);

        let stale = db.task_tracker_conflict_resolve(
            7, link.provider, &link.external_id, "title", 2, &proto::TaskTrackerConflictResolution::Remote,
        );
        assert!(stale.is_err());
        assert!(db.task_has_unresolved_tracker_conflicts(7).unwrap());

        let resolved = db.task_tracker_conflict_resolve(
            7, link.provider, &link.external_id, "title", 3, &proto::TaskTrackerConflictResolution::Remote,
        ).unwrap().unwrap();
        assert_eq!(resolved.snapshot.local.get("title").map(String::as_str), Some("Remote edit"));
        assert!(resolved.snapshot.conflicts.is_empty());
        assert!(!db.task_has_unresolved_tracker_conflicts(7).unwrap());
        assert_eq!(db.task_external_links(7).unwrap(), vec![resolved]);
    }

    #[test]
    fn workspace_tracker_settings_round_trip_current_values() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-settings.sqlite")).unwrap();
        let settings = proto::TaskTrackerWorkspaceSettings {
            workspace: "/workspace".into(), provider: proto::TaskTrackerProvider::GithubIssues, enabled: true,
            github_repository: Some("org/repo".into()), github_label: Some("houston".into()), github_assigned_user: None,
            notion_data_source_id: None, notion_title_property_id: None, notion_description_property_id: None,
            notion_status_property_id: None, notion_assignee_property_id: None, notion_project_relation_property_id: None,
            notion_assignee_user_id: None,
            notion_active_status_values: vec![], has_credential: false, last_sync_at_ms: Some(42), last_error: None,
            notion_projects_data_source_id: None, notion_project_title_property_id: None,
            notion_project_description_property_id: None, notion_pr_url_property_id: None,
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: None, in_progress: None, in_review: None, done: None, canceled: None,
            },
        };
        db.set_task_tracker_settings(&settings).unwrap();
        assert_eq!(db.task_tracker_settings("/workspace").unwrap(), vec![settings]);
    }

    #[test]
    fn tracker_outbox_deduplicates_and_keeps_inspectable_retry_state() {
        let temp = tempfile::tempdir().unwrap();
        let db = Db::open(&temp.path().join("tracker-outbox.sqlite")).unwrap();
        assert!(db.task_tracker_outbox_enqueue("/workspace", 7, proto::TaskTrackerProvider::Notion, "status", 4, r#"{"status":"Done"}"#, 100).unwrap());
        assert!(!db.task_tracker_outbox_enqueue("/workspace", 7, proto::TaskTrackerProvider::Notion, "status", 4, r#"{"status":"Done"}"#, 100).unwrap());
        let row = db.task_tracker_outbox_pending(100, 10).unwrap().remove(0);
        db.task_tracker_outbox_failed(row.id, "temporary failure", 100).unwrap();
        assert!(db.task_tracker_outbox_pending(1_999, 10).unwrap().is_empty());
        let retry = db.task_tracker_outbox_pending(2_100, 10).unwrap().remove(0);
        assert_eq!(retry.attempts, 1);
        assert_eq!(retry.last_error.as_deref(), Some("temporary failure"));
        db.task_tracker_outbox_sent(retry.id, "remote-page-id", 2_100).unwrap();
        assert!(db.task_tracker_outbox_pending(10_000, 10).unwrap().is_empty());
    }
}

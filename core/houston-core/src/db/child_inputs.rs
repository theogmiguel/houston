use super::*;

// Match the report cap so one provider cannot create an unbounded set of live asks.
const CHILD_INPUT_PENDING_MAX: u32 = crate::orchestrate::WORKER_REPORT_PENDING_MAX;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "delegations",
        "input_generation",
        "input_generation INTEGER NOT NULL DEFAULT 0",
    )?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS child_input_requests (
        id TEXT PRIMARY KEY,
        child_session INTEGER NOT NULL,
        source_key TEXT,
        request_json TEXT NOT NULL,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS child_input_pending ON child_input_requests(child_session, resolved_at);
    CREATE UNIQUE INDEX IF NOT EXISTS child_input_source ON child_input_requests(child_session, source_key) WHERE source_key IS NOT NULL;")?;
    add_column_if_missing(
        conn,
        "child_input_requests",
        "deny_attempted_at",
        "deny_attempted_at INTEGER",
    )?;
    // Older direct-to-user permission ownership had no escalation evidence.
    conn.execute("UPDATE child_input_requests SET owner = 'orchestrator', request_json = json_set(request_json, '$.owner', 'orchestrator')
        WHERE kind = 'permission' AND owner = 'user' AND resolved_at IS NULL AND json_extract(request_json, '$.escalation_reason') IS NULL", [])?;
    conn.execute("UPDATE delegations SET state = 'asked_orchestrator' WHERE state = 'needs_input'
        AND EXISTS (SELECT 1 FROM child_input_requests i WHERE i.child_session = delegations.child_session AND i.resolved_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM child_input_requests i WHERE i.child_session = delegations.child_session AND i.resolved_at IS NULL AND i.owner = 'user')", [])?;
    // Existing durable dialogue survives upgrade with the same message identity.
    Ok(())
}

pub(super) fn project(conn: &Connection, child: u32, now: u64) -> Result<()> {
    let owner: Option<String> = conn.query_row(
        "SELECT owner FROM child_input_requests WHERE child_session = ?1 AND resolved_at IS NULL
         ORDER BY CASE owner WHEN 'user' THEN 0 ELSE 1 END,
                  CASE kind WHEN 'permission' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1",
        [child], |r| r.get(0),
    ).optional()?;
    conn.execute("UPDATE delegations SET state = CASE
         WHEN ?2 = 'user' THEN 'needs_input'
         WHEN ?2 = 'orchestrator' THEN 'asked_orchestrator'
         WHEN state IN ('asked_orchestrator', 'needs_input') THEN 'working'
         ELSE state END, cleanup_after = CASE WHEN ?2 IS NOT NULL THEN NULL ELSE cleanup_after END,
         updated_at = ?3 WHERE child_session = ?1 AND state NOT IN ('done', 'failed', 'cancelled', 'unknown')",
        rusqlite::params![child, owner, now as i64])?;
    Ok(())
}

pub(super) fn insert(
    conn: &Connection,
    child: u32,
    source: Option<&str>,
    request: &proto::ChildInputRequest,
    now: u64,
) -> Result<()> {
    let pending: u32 = conn.query_row("SELECT COUNT(*) FROM child_input_requests WHERE child_session = ?1 AND resolved_at IS NULL", [child], |r| r.get(0))?;
    anyhow::ensure!(pending < CHILD_INPUT_PENDING_MAX,
        "input request refused: CHILD_INPUT_PENDING_MAX is {CHILD_INPUT_PENDING_MAX}; child {child} has {pending} pending asks; requested one more ask");
    conn.execute("INSERT INTO child_input_requests (id, child_session, source_key, request_json, owner, kind, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![request.id, child, source, serde_json::to_string(request)?, wire_name(&request.owner)?, wire_name(&request.kind)?, now as i64])?;
    // Completed identities retain a bounded replay window; generations never rewind.
    conn.execute("DELETE FROM child_input_requests WHERE resolved_at IS NOT NULL AND id IN (
        SELECT id FROM child_input_requests WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT -1 OFFSET 4096)", [])?;
    project(conn, child, now)
}

pub(super) fn resolve(conn: &Connection, child: u32, id: &str, now: u64) -> Result<bool> {
    let changed = conn.execute("UPDATE child_input_requests SET resolved_at = ?3 WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL", rusqlite::params![child, id, now as i64])? != 0;
    project(conn, child, now)?;
    Ok(changed)
}

/// The worker has moved on: resolves its open report asks on `request_id` and returns
/// the inbox rows it closed. A question the parent has not read yet keeps its row, so
/// the parent still sees what was asked next to the progress that followed.
pub(super) fn supersede_report_asks(
    tx: &rusqlite::Transaction<'_>,
    child: u32,
    request_id: u32,
    now: u64,
) -> Result<Vec<i64>> {
    let mut stmt = tx.prepare(
        "SELECT i.id, p.id, p.delivered_at IS NOT NULL FROM child_input_requests i
         JOIN pane_inbox p ON i.id = 'report:' || p.id
         WHERE i.child_session = ?1 AND i.source_key IS NULL AND i.resolved_at IS NULL
           AND p.from_session = ?1 AND p.request_id = ?2 AND p.kind IN ('question', 'blocked')",
    )?;
    let asks = stmt
        .query_map(rusqlite::params![child, request_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut closed_rows = Vec::new();
    for (ask, message, delivered) in asks {
        resolve(tx, child, &ask, now)?;
        if delivered
            && tx.execute(
                "UPDATE pane_inbox SET resolved_at = ?2, reason = 'superseded_by_worker'
                 WHERE id = ?1 AND resolved_at IS NULL",
                rusqlite::params![message, now as i64],
            )? != 0
        {
            closed_rows.push(message);
        }
    }
    Ok(closed_rows)
}

impl Db {
    pub fn child_input_pending_provider_sources(&self, child: u32) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut statement = conn.prepare(
            "SELECT source_key FROM child_input_requests
            WHERE child_session = ?1 AND source_key IS NOT NULL AND resolved_at IS NULL",
        )?;
        let sources = statement
            .query_map([child], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(sources)
    }

    pub fn child_input_request_by_id(
        &self,
        child: u32,
        id: &str,
    ) -> Result<Option<proto::ChildInputRequest>> {
        let conn = self.conn.lock().expect("db lock");
        let json: Option<String> = conn.query_row(
            "SELECT request_json FROM child_input_requests WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL",
            rusqlite::params![child, id], |r| r.get(0),
        ).optional()?;
        json.map(|json| serde_json::from_str(&json).map_err(Into::into))
            .transpose()
    }

    pub fn child_input_request(&self, child: u32) -> Result<Option<proto::ChildInputRequest>> {
        let conn = self.conn.lock().expect("db lock");
        let json: Option<String> = conn.query_row("SELECT request_json FROM child_input_requests
            WHERE child_session = ?1 AND resolved_at IS NULL
            ORDER BY CASE owner WHEN 'user' THEN 0 ELSE 1 END, CASE kind WHEN 'permission' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1", [child], |r| r.get(0)).optional()?;
        json.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }

    pub fn child_permission_deny_attempted(&self, child: u32, id: &str) -> Result<bool> {
        Ok(self.conn.lock().expect("db lock").query_row("SELECT EXISTS (SELECT 1 FROM child_input_requests WHERE child_session = ?1 AND id = ?2 AND deny_attempted_at IS NOT NULL)", rusqlite::params![child, id], |r| r.get(0))?)
    }

    pub fn child_permission_claim_deny(&self, child: u32, id: &str, now: u64) -> Result<bool> {
        Ok(self.conn.lock().expect("db lock").execute("UPDATE child_input_requests SET deny_attempted_at = ?3
            WHERE child_session = ?1 AND id = ?2 AND kind = 'permission' AND owner = 'orchestrator' AND resolved_at IS NULL AND deny_attempted_at IS NULL",
            rusqlite::params![child, id, now as i64])? != 0)
    }

    pub fn child_permission_retry_zero_write(&self, child: u32, id: &str) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE child_input_requests SET deny_attempted_at = NULL WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL", rusqlite::params![child, id])?;
        Ok(())
    }

    pub fn child_permission_source(&self, child: u32, id: &str) -> Result<Option<String>> {
        Ok(self.conn.lock().expect("db lock").query_row("SELECT source_key FROM child_input_requests WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL AND kind = 'permission'", rusqlite::params![child, id], |r| r.get(0)).optional()?.flatten())
    }

    pub fn child_permission_request(&self, child: u32) -> Result<Option<proto::ChildInputRequest>> {
        let conn = self.conn.lock().expect("db lock");
        let json: Option<String> = conn
            .query_row(
                "SELECT request_json FROM child_input_requests
            WHERE child_session = ?1 AND resolved_at IS NULL AND kind = 'permission'
            ORDER BY created_at, rowid LIMIT 1",
                [child],
                |r| r.get(0),
            )
            .optional()?;
        json.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }

    pub fn child_input_permission_details(
        &self,
        child: u32,
        id: &str,
        permission: proto::PermissionInputDetails,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let json: Option<String> = tx.query_row("SELECT request_json FROM child_input_requests WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL AND kind = 'permission'", rusqlite::params![child, id], |r| r.get(0)).optional()?;
        if let Some(json) = json {
            let mut request: proto::ChildInputRequest = serde_json::from_str(&json)?;
            request.permission = Some(permission);
            tx.execute("UPDATE child_input_requests SET request_json = ?3 WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL", rusqlite::params![child, id, serde_json::to_string(&request)?])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn child_input_open_provider(
        &self,
        child: u32,
        source: &str,
        kind: proto::ChildInputKind,
        owner: proto::ChildInputOwner,
        reason: Option<String>,
        now: u64,
    ) -> Result<(proto::ChildInputRequest, bool)> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let generated = source.starts_with("Generated") || source.starts_with("unclassified:");
        if let Some((json, resolved)) = tx.query_row("SELECT request_json, resolved_at FROM child_input_requests WHERE child_session = ?1 AND source_key = ?2", rusqlite::params![child, source], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))).optional()? {
            if resolved.is_none() || !generated {
                let mut existing: proto::ChildInputRequest = serde_json::from_str(&json)?;
                if resolved.is_none() && kind == proto::ChildInputKind::Permission && (existing.kind != kind || (existing.owner == proto::ChildInputOwner::Orchestrator && owner == proto::ChildInputOwner::User)) {
                    existing.kind = kind;
                    if owner == proto::ChildInputOwner::User { existing.owner = owner; }
                    if reason.is_some() { existing.reason = reason; }
                    tx.execute("UPDATE child_input_requests SET request_json = ?3, kind = 'permission', owner = ?4 WHERE child_session = ?1 AND source_key = ?2 AND resolved_at IS NULL", rusqlite::params![child, source, serde_json::to_string(&existing)?, wire_name(&existing.owner)?])?;
                    project(&tx, child, now)?;
                    tx.commit()?;
                    return Ok((existing, true));
                }
                return Ok((existing, false));
            }
            tx.execute("UPDATE child_input_requests SET source_key = NULL WHERE child_session = ?1 AND source_key = ?2 AND resolved_at IS NOT NULL", rusqlite::params![child, source])?;
        }
        let generation: u64 = tx.query_row("UPDATE delegations SET input_generation = input_generation + 1 WHERE child_session = ?1 RETURNING input_generation", [child], |r| r.get(0))?;
        let request = proto::ChildInputRequest {
            id: format!("provider:{child}:{generation}"),
            kind,
            owner,
            reason,
            permission: None,
            escalation_reason: None,
            escalation_detail: None,
        };
        insert(&tx, child, Some(source), &request, now)?;
        tx.commit()?;
        Ok((request, true))
    }

    pub fn child_input_sources_already_resolved(
        &self,
        child: u32,
        sources: &[String],
    ) -> Result<bool> {
        if sources.is_empty() {
            return Ok(false);
        }
        let conn = self.conn.lock().expect("db lock");
        for source in sources {
            let resolved: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM child_input_requests WHERE child_session = ?1 AND source_key = ?2 AND resolved_at IS NOT NULL)", rusqlite::params![child, source], |r| r.get(0))?;
            if !resolved {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn child_input_resolve_sources(
        &self,
        child: u32,
        sources: &[String],
        now: u64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        for source in sources {
            tx.execute("UPDATE child_input_requests SET resolved_at = ?3 WHERE child_session = ?1 AND source_key = ?2 AND resolved_at IS NULL", rusqlite::params![child, source, now as i64])?;
        }
        project(&tx, child, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn child_input_resolve_provider(&self, child: u32, now: u64) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        tx.execute("UPDATE child_input_requests SET resolved_at = ?2 WHERE child_session = ?1 AND source_key IS NOT NULL AND resolved_at IS NULL", rusqlite::params![child, now as i64])?;
        tx.execute("UPDATE pane_inbox SET resolved_at = ?2, reason = 'block_ended' WHERE from_session = ?1 AND kind = 'needs_input' AND resolved_at IS NULL", rusqlite::params![child, now as i64])?;
        project(&tx, child, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn child_input_resolve_intervention(&self, child: u32, id: &str, now: u64) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        resolve(&tx, child, id, now)?;
        if let Some(message) = id
            .strip_prefix("report:")
            .and_then(|id| id.parse::<i64>().ok())
        {
            tx.execute("UPDATE pane_inbox SET resolved_at = ?3, reason = 'user_intervention' WHERE id = ?1 AND from_session = ?2 AND resolved_at IS NULL", rusqlite::params![message, child, now as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Operator dismissal of a worker-reported ask. Provider-sourced asks (permission and
    /// native prompts) are refused: they clear on provider evidence, and dismissing one
    /// would hide a prompt that is still blocking the pane. `Ok(None)` means no open ask.
    pub fn child_input_dismiss(
        &self,
        child: u32,
        id: &str,
        now: u64,
    ) -> Result<Option<proto::ChildInputRequest>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let found: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT request_json, source_key FROM child_input_requests
                 WHERE child_session = ?1 AND id = ?2 AND resolved_at IS NULL",
                rusqlite::params![child, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((json, source)) = found else {
            return Ok(None);
        };
        let request: proto::ChildInputRequest = serde_json::from_str(&json)?;
        anyhow::ensure!(
            source.is_none(),
            "dismiss refused: input {id} of child {child} is a provider {:?} prompt; expected a worker-reported question or blocker; answer it in the pane, where the provider clears it",
            request.kind
        );
        resolve(&tx, child, id, now)?;
        if let Some(message) = id
            .strip_prefix("report:")
            .and_then(|id| id.parse::<i64>().ok())
        {
            tx.execute(
                "UPDATE pane_inbox SET resolved_at = ?3, reason = 'operator_dismissed'
                 WHERE id = ?1 AND from_session = ?2 AND resolved_at IS NULL",
                rusqlite::params![message, child, now as i64],
            )?;
        }
        tx.commit()?;
        Ok(Some(request))
    }

    /// Closes the ask behind a question row the operator resolved from the inbox.
    pub fn child_input_resolve_report(&self, child: u32, message: i64, now: u64) -> Result<bool> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let changed = resolve(&tx, child, &format!("report:{message}"), now)?;
        tx.commit()?;
        Ok(changed)
    }

    pub fn child_input_resolve_notices(&self, child: u32, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE pane_inbox SET resolved_at = ?2, reason = 'awaiting_user_permission' WHERE from_session = ?1 AND kind = 'needs_input' AND resolved_at IS NULL", rusqlite::params![child, now as i64])?;
        Ok(())
    }

    pub fn child_input_project(&self, child: u32, now: u64) -> Result<()> {
        project(&self.conn.lock().expect("db lock"), child, now)
    }

    pub fn child_input_escalate(
        &self,
        child: u32,
        expected: &proto::ChildInputRequest,
        reason: proto::ChildInputEscalationReason,
        detail: Option<String>,
        now: u64,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let mut request = expected.clone();
        request.owner = proto::ChildInputOwner::User;
        request.escalation_reason = Some(reason);
        request.escalation_detail = detail;
        let changed = tx.execute("UPDATE child_input_requests SET owner = 'user', request_json = ?3
            WHERE child_session = ?1 AND id = ?2 AND owner = 'orchestrator' AND resolved_at IS NULL
            AND EXISTS (SELECT 1 FROM delegations WHERE child_session = ?1 AND state NOT IN ('done','failed','cancelled','unknown'))",
            rusqlite::params![child, expected.id, serde_json::to_string(&request)?])? != 0;
        project(&tx, child, now)?;
        tx.commit()?;
        Ok(changed)
    }

    pub fn child_inputs_owned_by_parent(
        &self,
        parent: u32,
    ) -> Result<Vec<(u32, proto::ChildInputRequest)>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare("SELECT i.child_session, i.request_json FROM child_input_requests i JOIN delegations d ON d.child_session = i.child_session
            WHERE d.parent_session = ?1 AND i.owner = 'orchestrator' AND i.resolved_at IS NULL AND d.state NOT IN ('done','failed','cancelled','unknown') ORDER BY i.created_at, i.rowid")?;
        let rows = stmt
            .query_map([parent], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(child, json)| Ok((child, serde_json::from_str(&json)?)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_input_generations_and_ownership_survive_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.db");
        let first_id;
        {
            let db = Db::open(&path).unwrap();
            db.delegation_create(1, 2, None, "work", 100).unwrap();
            let (first, created) = db
                .child_input_open_provider(
                    2,
                    "ToolUseId(first)",
                    proto::ChildInputKind::Question,
                    proto::ChildInputOwner::Orchestrator,
                    Some("Which fixture?".into()),
                    101,
                )
                .unwrap();
            assert!(created);
            first_id = first.id.clone();
            assert_eq!(first_id, "provider:2:1");
            assert!(db
                .child_input_escalate(
                    2,
                    &first,
                    proto::ChildInputEscalationReason::Explicit,
                    Some("User decision".into()),
                    102
                )
                .unwrap());
            assert!(!db
                .child_input_escalate(
                    2,
                    &first,
                    proto::ChildInputEscalationReason::ParentTurnEnded,
                    None,
                    103
                )
                .unwrap());
        }
        let db = Db::open(&path).unwrap();
        let input = db.child_input_request(2).unwrap().unwrap();
        assert_eq!(input.id, first_id);
        assert_eq!(input.owner, proto::ChildInputOwner::User);
        assert_eq!(input.escalation_detail.as_deref(), Some("User decision"));
        assert_eq!(
            db.delegation_for_child(2).unwrap().unwrap().state,
            "needs_input"
        );
        db.child_input_resolve_sources(2, &["ToolUseId(first)".into()], 104)
            .unwrap();
        assert!(!db
            .child_input_escalate(
                2,
                &input,
                proto::ChildInputEscalationReason::Explicit,
                None,
                105
            )
            .unwrap());
        assert!(db.child_input_request(2).unwrap().is_none());
        let (_, replay_created) = db
            .child_input_open_provider(
                2,
                "ToolUseId(first)",
                proto::ChildInputKind::Question,
                proto::ChildInputOwner::Orchestrator,
                None,
                106,
            )
            .unwrap();
        assert!(
            !replay_created,
            "a late replay of an answered native request cannot reopen it"
        );
        let (next, _) = db
            .child_input_open_provider(
                2,
                "ToolUseId(second)",
                proto::ChildInputKind::Question,
                proto::ChildInputOwner::Orchestrator,
                None,
                107,
            )
            .unwrap();
        assert_eq!(next.id, "provider:2:2");
        assert_eq!(
            db.delegation_for_child(2).unwrap().unwrap().state,
            "asked_orchestrator"
        );
    }

    #[test]
    fn permission_priority_then_resolution_exposes_the_next_live_ask() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("input.db")).unwrap();
        db.delegation_create(1, 2, None, "work", 100).unwrap();
        let (question, _) = db
            .child_input_open_provider(
                2,
                "q",
                proto::ChildInputKind::Question,
                proto::ChildInputOwner::Orchestrator,
                None,
                101,
            )
            .unwrap();
        let (permission, _) = db
            .child_input_open_provider(
                2,
                "p",
                proto::ChildInputKind::Permission,
                proto::ChildInputOwner::Orchestrator,
                None,
                102,
            )
            .unwrap();
        db.child_input_escalate(
            2,
            &permission,
            proto::ChildInputEscalationReason::Explicit,
            Some("Operator consent".into()),
            102,
        )
        .unwrap();
        assert_eq!(
            db.child_input_request(2).unwrap().unwrap().id,
            permission.id
        );
        db.child_input_resolve_sources(2, &["p".into()], 103)
            .unwrap();
        assert_eq!(db.child_input_request(2).unwrap().unwrap().id, question.id);
        assert_eq!(
            db.delegation_for_child(2).unwrap().unwrap().state,
            "asked_orchestrator"
        );
        db.child_input_resolve_sources(2, &["q".into()], 104)
            .unwrap();
        assert_eq!(
            db.delegation_for_child(2).unwrap().unwrap().state,
            "working"
        );
    }
    #[test]
    fn denial_attempt_receipt_survives_reopen_and_zero_write_reset_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input.db");
        let id;
        {
            let db = Db::open(&path).unwrap();
            db.delegation_create(1, 2, None, "work", 100).unwrap();
            let (input, _) = db
                .child_input_open_provider(
                    2,
                    "deny",
                    proto::ChildInputKind::Permission,
                    proto::ChildInputOwner::Orchestrator,
                    None,
                    101,
                )
                .unwrap();
            id = input.id;
            assert!(db.child_permission_claim_deny(2, &id, 102).unwrap());
            assert!(!db.child_permission_claim_deny(2, &id, 103).unwrap());
        }
        let db = Db::open(&path).unwrap();
        assert!(db.child_permission_deny_attempted(2, &id).unwrap());
        assert!(db.child_input_request(2).unwrap().is_some());
        db.child_permission_retry_zero_write(2, &id).unwrap();
        assert!(db.child_permission_claim_deny(2, &id, 104).unwrap());
        db.child_input_resolve_sources(2, &["deny".into()], 105)
            .unwrap();
        assert!(!db.child_permission_claim_deny(2, &id, 106).unwrap());
        assert!(db.child_permission_deny_attempted(2, &id).unwrap());
    }
}

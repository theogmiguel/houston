//! Suspected defects: what an agent reported or a detector saw, deduplicated by
//! destination and title. Decisions live in `harness_decisions`, so the same
//! dismiss/resolve and recurrence rules apply to both kinds of finding.
use anyhow::Result;
use houston_protocol as proto;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::{from_wire, wire_name, Db};

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS suspected_defects (
            workspace TEXT NOT NULL,
            key TEXT NOT NULL,
            source TEXT NOT NULL,
            detector TEXT,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            evidence TEXT NOT NULL,
            destination TEXT NOT NULL,
            reporter_session INTEGER,
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            count INTEGER NOT NULL,
            issue_url TEXT,
            PRIMARY KEY (workspace, key)
        );
        CREATE INDEX IF NOT EXISTS idx_suspected_defects_workspace
            ON suspected_defects(workspace, last_seen_ms DESC);",
    )?;
    Ok(())
}

/// What one report or detector adds to the store.
pub struct DefectInput {
    pub workspace: String,
    pub source: proto::DefectSource,
    pub detector: Option<String>,
    pub title: String,
    pub description: String,
    pub evidence: Vec<String>,
    pub destination: proto::DefectDestination,
    pub reporter_session: Option<u32>,
}

pub struct DefectRecord {
    pub key: String,
    pub count: u32,
    pub first_seen_ms: i64,
    /// True when this call opened the row, false when it only added an occurrence.
    pub inserted: bool,
}

#[derive(Debug, Clone)]
pub struct DefectRow {
    pub workspace: String,
    pub key: String,
    pub source: proto::DefectSource,
    pub detector: Option<String>,
    pub title: String,
    pub description: String,
    pub evidence: Vec<String>,
    pub destination: proto::DefectDestination,
    pub reporter_session: Option<u32>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub count: u32,
    pub issue_url: Option<String>,
}

/// `defect-<detector-or-agent>-<8 hex>` over the destination and the normalized
/// lowercase title, so repeats dedupe and increment one row.
pub fn defect_key(
    source: proto::DefectSource,
    detector: Option<&str>,
    destination: proto::DefectDestination,
    title: &str,
) -> Result<String> {
    let normalized = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let label = match (source, detector) {
        (proto::DefectSource::Detector, Some(name)) => name.to_string(),
        _ => "agent".to_string(),
    };
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{normalized}", wire_name(&destination)?));
    let digest = format!("{:x}", hasher.finalize());
    Ok(format!("defect-{label}-{}", &digest[..8]))
}

impl Db {
    /// One occurrence of a defect. Creates the row or increments its count, and
    /// prunes the oldest decided row when the workspace is full.
    pub fn record_defect(
        &self,
        input: &DefectInput,
        now_ms: i64,
        verb: &str,
    ) -> Result<DefectRecord> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let record = record_in(&tx, input, now_ms, verb)?;
        tx.commit()?;
        Ok(record)
    }

    /// An agent's `pane_report finding`: the same occurrence record, but the
    /// worker's report cap is checked and the receipt finishes with the tool result.
    pub fn record_agent_finding(
        &self,
        input: &DefectInput,
        receipt: &crate::db::MessageReceipt,
        now: u64,
    ) -> Result<(serde_json::Value, DefectRecord)> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        if let Some(result) = receipt.begin(&tx, now)? {
            let key = result
                .get("key")
                .and_then(|k| k.as_str())
                .unwrap_or_default()
                .to_string();
            return Ok((
                result,
                DefectRecord {
                    key,
                    count: 0,
                    first_seen_ms: 0,
                    inserted: false,
                },
            ));
        }
        let pending: u32 = tx.query_row(
            "SELECT COUNT(*) FROM pane_inbox WHERE from_session = ?1
             AND resolved_at IS NULL
             AND (kind IN ('question', 'blocked') OR (kind = 'progress' AND delivered_at IS NULL))",
            [input.reporter_session.unwrap_or_default()],
            |r| r.get(0),
        )?;
        let cap = crate::orchestrate::WORKER_REPORT_PENDING_MAX;
        anyhow::ensure!(
            pending < cap,
            "report refused: WORKER_REPORT_PENDING_MAX is {cap}; worker has {pending} pending reports; requested one more pane_report finding"
        );
        let record = record_in(&tx, input, now as i64, "pane_report finding")?;
        let result = serde_json::json!({
            "recorded": true,
            "key": record.key,
            "count": record.count,
            "note": "Stored as a suspected defect; this does not open an inbox row or finish the request."
        });
        receipt.finish(&tx, &result)?;
        tx.commit()?;
        Ok((result, record))
    }

    pub fn defects(&self, workspace: &str) -> Result<Vec<DefectRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT workspace, key, source, detector, title, description, evidence, \
             destination, reporter_session, first_seen_ms, last_seen_ms, count, issue_url \
             FROM suspected_defects WHERE workspace = ?1 \
             ORDER BY last_seen_ms DESC, key",
        )?;
        let rows = stmt
            .query_map([workspace], |r| {
                let key: String = r.get(1)?;
                let source: String = r.get(2)?;
                let destination: String = r.get(7)?;
                Ok(DefectRow {
                    workspace: r.get(0)?,
                    key: key.clone(),
                    source: from_wire::<proto::DefectSource>(&source).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            format!("defect {key:?} has unknown source {source:?} (expected agent or detector)").into(),
                        )
                    })?,
                    detector: r.get(3)?,
                    title: r.get(4)?,
                    description: r.get(5)?,
                    evidence: json_list(&r.get::<_, String>(6)?),
                    destination: from_wire::<proto::DefectDestination>(&destination).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            7,
                            rusqlite::types::Type::Text,
                            format!("defect {key:?} has unknown destination {destination:?} (expected houston or workspace)").into(),
                        )
                    })?,
                    reporter_session: r.get(8)?,
                    first_seen_ms: r.get(9)?,
                    last_seen_ms: r.get(10)?,
                    count: r.get(11)?,
                    issue_url: r.get(12)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn defect(&self, workspace: &str, key: &str) -> Result<Option<DefectRow>> {
        Ok(self.defects(workspace)?.into_iter().find(|d| d.key == key))
    }

    pub fn defect_exists(&self, workspace: &str, key: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        let found: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM suspected_defects WHERE workspace = ?1 AND key = ?2)",
            rusqlite::params![workspace, key],
            |r| r.get(0),
        )?;
        Ok(found)
    }

    pub fn defect_workspaces(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt =
            conn.prepare("SELECT DISTINCT workspace FROM suspected_defects ORDER BY workspace")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn set_defect_issue_url(&self, workspace: &str, key: &str, url: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE suspected_defects SET issue_url = ?3 WHERE workspace = ?1 AND key = ?2",
            rusqlite::params![workspace, key, url],
        )?;
        Ok(())
    }

    /// Delivered replies to `worker`'s own questions, with the question body:
    /// `(question id, reply id, question body)`, newest reply first.
    pub fn delivered_replies_for(&self, worker: u32) -> Result<Vec<(i64, i64, String)>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT q.id, r.id, q.body FROM pane_inbox r \
             JOIN pane_inbox q ON q.id = r.reply_to \
             WHERE r.to_session = ?1 AND r.kind = 'reply' AND r.delivered_at IS NOT NULL \
             AND q.from_session = ?1 AND q.kind IN ('question', 'blocked') \
             ORDER BY r.id DESC LIMIT 32",
        )?;
        let rows = stmt
            .query_map([worker], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}

fn record_in(
    tx: &rusqlite::Transaction<'_>,
    input: &DefectInput,
    now_ms: i64,
    verb: &str,
) -> Result<DefectRecord> {
    let key = defect_key(
        input.source,
        input.detector.as_deref(),
        input.destination,
        &input.title,
    )?;
    let existing: Option<(String, i64, i64)> = tx
        .query_row(
            "SELECT evidence, count, first_seen_ms FROM suspected_defects \
             WHERE workspace = ?1 AND key = ?2",
            rusqlite::params![input.workspace, key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let now_ms = now_ms.max(0);
    let inserted = existing.is_none();
    let (evidence, count, first_seen_ms) = match existing {
        Some((raw, count, first_seen_ms)) => {
            let mut merged = json_list(&raw);
            for item in &input.evidence {
                if merged.len()
                    >= usize::try_from(proto::SUSPECTED_DEFECT_EVIDENCE_MAX).unwrap_or(10)
                {
                    break;
                }
                if !merged.contains(item) {
                    merged.push(item.clone());
                }
            }
            (
                merged,
                u32::try_from(count).unwrap_or(u32::MAX).saturating_add(1),
                first_seen_ms,
            )
        }
        None => {
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM suspected_defects WHERE workspace = ?1",
                [&input.workspace],
                |r| r.get(0),
            )?;
            let max = i64::from(proto::SUSPECTED_DEFECTS_PER_WORKSPACE_MAX);
            if count >= max {
                let oldest: Option<String> = tx
                    .query_row(
                        "SELECT d.key FROM suspected_defects d \
                         JOIN harness_decisions h ON h.workspace = d.workspace AND h.key = d.key \
                         WHERE d.workspace = ?1 ORDER BY h.decided_at_ms ASC LIMIT 1",
                        [&input.workspace],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(oldest) = oldest else {
                    anyhow::bail!(
                        "refusing to record a suspected defect from {verb}: the workspace holds {count} defects and its limit is {max}; decide one before reporting more"
                    );
                };
                tx.execute(
                    "DELETE FROM suspected_defects WHERE workspace = ?1 AND key = ?2",
                    rusqlite::params![input.workspace, oldest],
                )?;
            }
            let mut initial: Vec<String> = Vec::new();
            for item in &input.evidence {
                if initial.len()
                    >= usize::try_from(proto::SUSPECTED_DEFECT_EVIDENCE_MAX).unwrap_or(10)
                {
                    break;
                }
                if !initial.contains(item) {
                    initial.push(item.clone());
                }
            }
            (initial, 1, now_ms)
        }
    };
    let evidence = serde_json::to_string(&evidence)?;
    tx.execute(
        "INSERT INTO suspected_defects
            (workspace, key, source, detector, title, description, evidence, destination,
             reporter_session, first_seen_ms, last_seen_ms, count, issue_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)
         ON CONFLICT(workspace, key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            evidence = excluded.evidence,
            last_seen_ms = excluded.last_seen_ms,
            count = excluded.count",
        rusqlite::params![
            input.workspace,
            key,
            wire_name(&input.source)?,
            input.detector,
            input.title,
            input.description,
            evidence,
            wire_name(&input.destination)?,
            input.reporter_session,
            first_seen_ms,
            now_ms,
            count,
        ],
    )?;
    Ok(DefectRecord {
        key,
        count,
        first_seen_ms,
        inserted,
    })
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(workspace: &str, title: &str, destination: proto::DefectDestination) -> DefectInput {
        DefectInput {
            workspace: workspace.into(),
            source: proto::DefectSource::Agent,
            detector: None,
            title: title.into(),
            description: String::new(),
            evidence: Vec::new(),
            destination,
            reporter_session: Some(1),
        }
    }

    #[test]
    fn the_key_uses_the_destination_and_a_normalized_title() {
        let spaced = defect_key(
            proto::DefectSource::Agent,
            None,
            proto::DefectDestination::Houston,
            "A  broken\tThing",
        )
        .unwrap();
        let plain = defect_key(
            proto::DefectSource::Agent,
            None,
            proto::DefectDestination::Houston,
            "a broken thing",
        )
        .unwrap();
        assert_eq!(spaced, plain);
        assert!(spaced.starts_with("defect-agent-"), "{spaced}");
        assert_eq!(spaced.len(), "defect-agent-".len() + 8);
        assert_ne!(
            spaced,
            defect_key(
                proto::DefectSource::Agent,
                None,
                proto::DefectDestination::Workspace,
                "a broken thing",
            )
            .unwrap()
        );
        assert_ne!(
            spaced,
            defect_key(
                proto::DefectSource::Detector,
                Some("reply_reasked"),
                proto::DefectDestination::Houston,
                "a broken thing",
            )
            .unwrap()
        );
    }

    #[test]
    fn a_full_workspace_prunes_its_oldest_decided_row() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let max = proto::SUSPECTED_DEFECTS_PER_WORKSPACE_MAX;
        let mut keys = Vec::new();
        for n in 0..max {
            let record = db
                .record_defect(
                    &input(
                        "/ws",
                        &format!("defect {n}"),
                        proto::DefectDestination::Houston,
                    ),
                    i64::from(n),
                    "test",
                )
                .unwrap();
            keys.push(record.key);
        }
        db.set_harness_decision_by(
            "/ws",
            &keys[0],
            proto::HarnessFindingState::Dismissed,
            10_000,
            "user",
        )
        .unwrap();
        let fresh = db
            .record_defect(
                &input("/ws", "one more defect", proto::DefectDestination::Houston),
                i64::from(max) + 1,
                "test",
            )
            .unwrap();
        assert_eq!(
            db.defects("/ws").unwrap().len(),
            usize::try_from(max).unwrap()
        );
        assert!(
            !db.defect_exists("/ws", &keys[0]).unwrap(),
            "the decided row made room"
        );
        assert!(db.defect_exists("/ws", &fresh.key).unwrap());
    }
}

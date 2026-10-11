use super::*;
use anyhow::{anyhow, ensure};
use rusqlite::params;

// A channel keeps at most 256MiB of instruction bodies; each origin can retain
// only sixteen active intents so an unattended producer cannot grow its queue.
pub const INSTRUCTION_BODY_MAX: usize = 64 * 1024;
pub const INSTRUCTION_ACTIVE_MAX: i64 = 16;
pub const INSTRUCTION_RETAINED_MAX: i64 = 4096;

pub(crate) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS prompt_intents (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        origin INTEGER NOT NULL,
        target_origin INTEGER NOT NULL,
        target INTEGER NOT NULL,
        client_request_id TEXT,
        arguments_digest TEXT NOT NULL,
        context TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        request_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        hold_reason TEXT,
        touched INTEGER NOT NULL DEFAULT 0,
        adopted INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        dispatch_prompt_id TEXT,
        interrupt_sent INTEGER NOT NULL DEFAULT 0,
        restart_ready INTEGER NOT NULL DEFAULT 0,
        UNIQUE(origin, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS prompt_intents_target ON prompt_intents(target, sequence);",
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct InstructionRow {
    pub sequence: i64,
    pub origin: u32,
    pub target: u32,
    pub context: String,
    pub info: proto::InstructionInfo,
    pub body: String,
    pub touched: bool,
    pub adopted: bool,
    pub completed: bool,
    pub dispatch_prompt_id: Option<String>,
    pub interrupt_sent: bool,
    pub restart_ready: bool,
}

impl InstructionRow {
    pub fn acceptance(&self) -> proto::InstructionAcceptance {
        proto::InstructionAcceptance {
            instruction_id: self.info.id.clone(),
            accepted: true,
            state: self.info.state,
            request_id: self.info.request_id,
            hold_reason: self.info.hold_reason.clone(),
        }
    }
}

const SELECT: &str = "SELECT sequence, id, origin, target, context, mode, state, body,
    request_id, created_at, updated_at, hold_reason, touched, adopted, completed,
    dispatch_prompt_id, interrupt_sent, restart_ready FROM prompt_intents";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InstructionRow> {
    fn decode<T: serde::de::DeserializeOwned>(
        row: &rusqlite::Row<'_>,
        index: usize,
    ) -> rusqlite::Result<T> {
        let value: String = row.get(index)?;
        serde_json::from_value(serde_json::Value::String(value)).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    }
    let body: String = row.get(7)?;
    Ok(InstructionRow {
        sequence: row.get(0)?,
        origin: row.get(2)?,
        target: row.get(3)?,
        context: row.get(4)?,
        info: proto::InstructionInfo {
            id: row.get(1)?,
            mode: decode(row, 5)?,
            state: decode(row, 6)?,
            request_id: row.get(8)?,
            preview: body.chars().take(480).collect(),
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            hold_reason: row.get(11)?,
        },
        body,
        touched: row.get(12)?,
        adopted: row.get(13)?,
        completed: row.get(14)?,
        dispatch_prompt_id: row.get(15)?,
        interrupt_sent: row.get(16)?,
        restart_ready: row.get(17)?,
    })
}

fn name<T: serde::Serialize>(value: T) -> Result<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("instruction enum: expected a string"))
}

fn get(conn: &Connection, id: &str) -> Result<Option<InstructionRow>> {
    Ok(conn
        .query_row(&format!("{SELECT} WHERE id=?1"), [id], map_row)
        .optional()?)
}

impl Db {
    pub fn instruction_retry(&self, receipt: &MessageReceipt) -> Result<Option<InstructionRow>> {
        let Some(key) = &receipt.key else {
            return Ok(None);
        };
        let conn = self.conn.lock().expect("db lock");
        let existing: Option<(String, String)> = conn.query_row(
            "SELECT id, arguments_digest FROM prompt_intents WHERE origin=?1 AND client_request_id=?2",
            params![receipt.caller,key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let Some((id, digest)) = existing else {
            return Ok(None);
        };
        ensure!(digest == receipt.digest, "client_request_id {key:?} reused with different arguments; expected original pane_prompt request");
        get(&conn, &id)
    }

    pub fn instruction_accept(
        &self,
        target: u32,
        context: &str,
        mode: proto::InstructionMode,
        body: &str,
        receipt: &MessageReceipt,
        now: u64,
    ) -> Result<InstructionRow> {
        ensure!(body.len() <= INSTRUCTION_BODY_MAX,
            "instruction body has {} bytes; limit {INSTRUCTION_BODY_MAX}; accepting prompt for session {target} refused", body.len());
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        if let Some(key) = &receipt.key {
            let existing: Option<(String, String)> = tx.query_row(
                "SELECT id, arguments_digest FROM prompt_intents WHERE origin=?1 AND client_request_id=?2",
                params![receipt.caller, key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
            if let Some((id, digest)) = existing {
                ensure!(digest == receipt.digest, "client_request_id {key:?} reused with different arguments; expected the original pane_prompt request");
                return get(&tx, &id)?
                    .ok_or_else(|| anyhow!("instruction {id}: retained body missing"));
            }
            // An accepted legacy receipt contains no durable body. Never reconstruct
            // its delivery from retry arguments or send those arguments again.
            let legacy: Option<(String, String)> = tx.query_row(
                "SELECT operation, arguments_digest FROM orchestration_receipts WHERE caller=?1 AND client_request_id=?2",
                params![receipt.caller, key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
            if let Some((operation, digest)) = legacy {
                ensure!(operation == "pane_prompt" && digest == receipt.digest,
                    "client_request_id {key:?} reused with different arguments or operation; expected the original {operation} request");
                anyhow::bail!("client_request_id {key:?}: legacy accepted receipt has no retained instruction body; delivery unknown, automatic replay refused; inspect the pane before creating a new intent");
            }
        }
        let target_origin = serde_json::from_str::<serde_json::Value>(context)?["origin"]
            .as_u64()
            .ok_or_else(|| anyhow!("instruction context: expected numeric origin"))?;
        let active: i64 = tx.query_row("SELECT count(*) FROM prompt_intents WHERE target_origin=?1 AND (state IN ('queued','held_after_recovery','uncertain') OR (state='delivered' AND completed=0))", [target_origin], |row| row.get(0))?;
        ensure!(active < INSTRUCTION_ACTIVE_MAX,
            "origin {target_origin} has {active} active instructions; limit {INSTRUCTION_ACTIVE_MAX}; accepting prompt for session {target} refused");
        let count: i64 =
            tx.query_row("SELECT count(*) FROM prompt_intents", [], |row| row.get(0))?;
        if count >= INSTRUCTION_RETAINED_MAX {
            let prune: Vec<(String, u32, Option<String>)> = tx.prepare("SELECT id, origin, client_request_id FROM prompt_intents WHERE state='cancelled' OR (state='delivered' AND completed=1) ORDER BY sequence LIMIT ?1")?
                .query_map([count - INSTRUCTION_RETAINED_MAX + 1], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
            ensure!(!prune.is_empty(), "channel has {count} retained instructions; limit {INSTRUCTION_RETAINED_MAX}; accepting prompt refused");
            for (id, origin, key) in prune {
                tx.execute("DELETE FROM orchestration_receipts WHERE caller=?1 AND client_request_id=?2 AND operation='pane_prompt'", params![origin,key])?;
                tx.execute("DELETE FROM prompt_intents WHERE id=?1", [id])?;
            }
        }
        if let Some(key) = &receipt.key {
            super::begin_orchestration_receipt(
                &tx,
                receipt.caller,
                key,
                "pane_prompt",
                &receipt.digest,
                now,
            )?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO prompt_intents(id,origin,target,client_request_id,arguments_digest,context,mode,state,body,created_at,updated_at,target_origin) VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8,?9,?9,?10)",
            params![id,receipt.caller,target,receipt.key,receipt.digest,context,name(mode)?,body,now,target_origin])?;
        receipt.finish(&tx, &serde_json::json!({"instruction_id":id}))?;
        let accepted = get(&tx, &id)?.expect("inserted instruction exists");
        tx.commit()?;
        Ok(accepted)
    }

    pub fn instruction_row(&self, id: &str) -> Result<Option<InstructionRow>> {
        get(&self.conn.lock().expect("db lock"), id)
    }

    pub fn instruction_rows(&self, target: u32) -> Result<Vec<InstructionRow>> {
        let conn = self.conn.lock().expect("db lock");
        let preview_select = SELECT.replace("state, body,", "state, substr(body,1,480),");
        let rows = conn
            .prepare(&format!(
                "{preview_select} WHERE target=?1 ORDER BY sequence"
            ))?
            .query_map([target], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn instruction_recover(&self, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "UPDATE prompt_intents SET state=CASE WHEN touched=0 THEN 'held_after_recovery' ELSE 'uncertain' END,
             hold_reason=CASE WHEN touched=0 THEN 'daemon restarted; explicit resume and exact context validation required' ELSE 'daemon restarted during PTY delivery; delivery unknown, cancel before creating a new intent' END,
             updated_at=?1 WHERE state='queued' OR (state='uncertain' AND touched=1)", [now])?;
        Ok(())
    }

    pub fn instruction_pending(&self, target: u32) -> Result<bool> {
        Ok(self.conn.lock().expect("db lock").query_row("SELECT EXISTS(SELECT 1 FROM prompt_intents WHERE target=?1 AND (state IN ('queued','held_after_recovery','uncertain') OR (state='delivered' AND completed=0)))", [target], |row| row.get(0))?)
    }

    pub fn instruction_set_state(
        &self,
        id: &str,
        state: proto::InstructionState,
        reason: Option<&str>,
        now: u64,
    ) -> Result<()> {
        self.conn.lock().expect("db lock").execute(
            "UPDATE prompt_intents SET state=?2,hold_reason=?3,updated_at=?4 WHERE id=?1",
            params![id, name(state)?, reason, now],
        )?;
        Ok(())
    }

    pub fn instruction_begin_write(
        &self,
        id: &str,
        request: Option<u32>,
        old_prompt_id: Option<&str>,
        now: u64,
    ) -> Result<()> {
        let changed = self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET touched=1,state='uncertain',request_id=?2,dispatch_prompt_id=?3,hold_reason='PTY write begun; outcome not yet recorded',updated_at=?4 WHERE id=?1 AND state='queued'", params![id,request,old_prompt_id,now])?;
        ensure!(
            changed == 1,
            "instruction {id}: expected untouched queued intent before PTY write"
        );
        Ok(())
    }

    pub fn instruction_unwritten(&self, id: &str, reason: &str, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET state='queued',touched=interrupt_sent,request_id=NULL,hold_reason=?2,updated_at=?3 WHERE id=?1", params![id,reason,now])?;
        Ok(())
    }

    pub fn instruction_interrupt_written(&self, id: &str, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET state='queued',interrupt_sent=1,hold_reason='waiting for authoritative idle after interrupt',updated_at=?2 WHERE id=?1", params![id,now])?;
        Ok(())
    }

    pub fn instruction_restart_ready(&self, target: u32, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET restart_ready=1,updated_at=?2 WHERE target=?1 AND state='queued' AND interrupt_sent=1", params![target,now])?;
        Ok(())
    }

    pub fn instruction_adopt(&self, id: &str, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET adopted=1,hold_reason='waiting for authoritative completion',updated_at=?2 WHERE id=?1 AND state='delivered'", params![id,now])?;
        Ok(())
    }

    pub fn instruction_complete(&self, id: &str, now: u64) -> Result<()> {
        self.conn.lock().expect("db lock").execute("UPDATE prompt_intents SET completed=1,hold_reason=NULL,updated_at=?2 WHERE id=?1 AND state='delivered' AND adopted=1", params![id,now])?;
        Ok(())
    }

    pub fn instruction_interrupt_staged(
        &self,
        child: u32,
        round: u32,
        now: u64,
    ) -> Result<Vec<i64>> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        let ids: Vec<i64> = tx.prepare("SELECT id FROM pane_inbox WHERE from_session=?1 AND request_id=?2 AND kind='result' AND ready_at IS NULL AND resolved_at IS NULL")?
            .query_map(params![child,round], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        tx.execute("UPDATE pane_inbox SET ready_at=?3,provisional=0,reason='interrupted' WHERE from_session=?1 AND request_id=?2 AND kind='result' AND ready_at IS NULL AND resolved_at IS NULL", params![child,round,now])?;
        tx.execute(
            "UPDATE delegations SET cleanup_after=NULL WHERE child_session=?1",
            [child],
        )?;
        tx.commit()?;
        Ok(ids)
    }
}

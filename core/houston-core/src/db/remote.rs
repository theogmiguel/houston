//! Devices paired for remote access. Only the SHA-256 of each bearer token is
//! stored; revoking a device deletes its row.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};

use super::Db;

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS remote_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER
        );",
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDeviceRow {
    pub id: i64,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteDeviceRow> {
    Ok(RemoteDeviceRow {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get::<_, i64>(2)? as u64,
        last_seen_at: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
    })
}

impl Db {
    /// Writes several settings in one transaction, so a failure leaves none changed.
    pub fn set_settings_atomic(&self, pairs: &[(&str, &str)]) -> Result<()> {
        let mut conn = self.conn.lock().expect("db lock");
        let tx = conn.transaction()?;
        for (key, value) in pairs {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, value],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn remote_device_insert(&self, name: &str, token_hash: &str, now_ms: u64) -> Result<i64> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "INSERT INTO remote_devices (name, token_hash, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![name, token_hash, now_ms as i64],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn remote_device_by_hash(&self, token_hash: &str) -> Result<Option<RemoteDeviceRow>> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn
            .query_row(
                "SELECT id, name, created_at, last_seen_at FROM remote_devices
                 WHERE token_hash = ?1",
                rusqlite::params![token_hash],
                row,
            )
            .optional()?)
    }

    pub fn remote_devices(&self) -> Result<Vec<RemoteDeviceRow>> {
        let conn = self.conn.lock().expect("db lock");
        let mut stmt = conn
            .prepare("SELECT id, name, created_at, last_seen_at FROM remote_devices ORDER BY id")?;
        let rows = stmt
            .query_map([], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn remote_device_touch(&self, id: i64, now_ms: u64) -> Result<()> {
        let conn = self.conn.lock().expect("db lock");
        conn.execute(
            "UPDATE remote_devices SET last_seen_at = ?2 WHERE id = ?1",
            rusqlite::params![id, now_ms as i64],
        )?;
        Ok(())
    }

    /// Returns whether a row was deleted.
    pub fn remote_device_delete(&self, id: i64) -> Result<bool> {
        let conn = self.conn.lock().expect("db lock");
        Ok(conn.execute(
            "DELETE FROM remote_devices WHERE id = ?1",
            rusqlite::params![id],
        )? > 0)
    }
}

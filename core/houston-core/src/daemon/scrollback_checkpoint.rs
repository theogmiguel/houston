//! Periodic scrollback checkpoints bound what a daemon crash loses to one interval of
//! output. Only rings with output since their last write are rewritten, so idle panes
//! cost nothing. See docs/internals/daemon.md.
use std::sync::Arc;
use std::time::Duration;

use super::Daemon;

/// A dirty ring rewrites its whole file (up to 4 MiB), so the interval trades crash
/// loss against write volume; 30 s keeps a busy pane under ~140 KiB/s of writes.
pub(super) const SCROLLBACK_CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);

impl Daemon {
    /// Writes each ring with output since its last write and returns how many files
    /// were written. Shutdown and handoff run their own full checkpoint, so this pass
    /// stands aside while either is in progress.
    pub fn checkpoint_dirty_scrollback(&self) -> usize {
        let standing_aside = || self.is_shutting_down() || self.is_handing_off();
        if standing_aside() {
            return 0;
        }
        let _guard = self.checkpoint_lock.lock().expect("checkpoint lock");
        if standing_aside() {
            return 0;
        }
        let ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect();
        let mut written = 0;
        for id in ids {
            match self.persist_scrollback_inner(id, true) {
                Ok(true) => written += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!(
                    "periodic checkpoint: persisting scrollback of session {id}: {e:#} — the \
                     previous file stays in place and the next pass retries"
                ),
            }
        }
        written
    }

    pub async fn scrollback_checkpoint_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(SCROLLBACK_CHECKPOINT_INTERVAL).await;
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.checkpoint_dirty_scrollback()).await;
        }
    }
}

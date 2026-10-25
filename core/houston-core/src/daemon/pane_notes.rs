//! The one-line status note an agent writes on its own pane with `pane_note`, shown on
//! the rail card. Persisted with the session row and dropped with the session.
use std::sync::OnceLock;

use anyhow::{bail, Result};
use houston_protocol as proto;
use regex::Regex;

use super::{now_ms, Daemon};

/// Unicode General_Category=Format (Cf): bidi overrides and isolates, zero-width
/// marks. Invisible characters must not reach the rail card.
fn format_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\p{Cf}").unwrap())
}

/// One line of text: whitespace runs (newlines included) become one space, control
/// characters and Unicode format characters (bidi overrides, zero-width marks)
/// are dropped, and the result is refused past the byte limit.
pub(crate) fn note_text(raw: &str) -> Result<String> {
    let text = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let text = format_re().replace_all(&text, "").into_owned();
    if text.is_empty() {
        bail!(
            "pane note is empty; expected 1 to {} bytes of text, or `clear` to remove the note",
            proto::PANE_NOTE_MAX_BYTES
        );
    }
    if text.len() > proto::PANE_NOTE_MAX_BYTES {
        bail!(
            "pane note is {} bytes; the limit is {} bytes (PANE_NOTE_MAX_BYTES), so shorten it",
            text.len(),
            proto::PANE_NOTE_MAX_BYTES
        );
    }
    Ok(text)
}

impl Daemon {
    fn note_known_session(&self, session: u32) -> Result<()> {
        let known = self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&session)
            || self.dead.lock().expect("dead lock").contains_key(&session);
        if !known {
            bail!("unknown session id {session} (expected an active or restored session)");
        }
        Ok(())
    }

    /// Writes `session`'s note, replacing any earlier one.
    pub fn pane_note_set(
        &self,
        session: u32,
        text: &str,
        phase: Option<proto::PanePhase>,
    ) -> Result<proto::PaneNote> {
        let note = proto::PaneNote {
            text: note_text(text)?,
            phase,
            at_ms: now_ms() as i64,
        };
        self.note_known_session(session)?;
        self.db.update_session_note(session, Some(&note))?;
        self.notes
            .lock()
            .expect("notes lock")
            .insert(session, note.clone());
        self.broadcast_control(&proto::ServerMsg::SessionNote {
            session,
            note: Some(note.clone()),
        });
        Ok(note)
    }

    /// Removes `session`'s note; true when there was one.
    pub fn pane_note_clear(&self, session: u32) -> Result<bool> {
        self.note_known_session(session)?;
        self.db.update_session_note(session, None)?;
        let had = self
            .notes
            .lock()
            .expect("notes lock")
            .remove(&session)
            .is_some();
        self.broadcast_control(&proto::ServerMsg::SessionNote {
            session,
            note: None,
        });
        Ok(had)
    }

    /// What `pane_note` and `hs-pane note` ask for: write `text` (with `phase`), or `clear`.
    pub fn pane_note_request(
        &self,
        session: u32,
        text: Option<&str>,
        phase: Option<proto::PanePhase>,
        clear: bool,
    ) -> Result<serde_json::Value> {
        match (text, clear) {
            (Some(_), true) => bail!("pane_note got both `text` and `clear`; pass one of them"),
            (None, false) => bail!(
                "pane_note needs `text` (at most {} bytes) or `clear: true`",
                proto::PANE_NOTE_MAX_BYTES
            ),
            (None, true) => Ok(serde_json::json!({ "cleared": self.pane_note_clear(session)? })),
            (Some(text), false) => {
                Ok(serde_json::json!({ "note": self.pane_note_set(session, text, phase)? }))
            }
        }
    }

    pub(super) fn note_of(&self, session: u32) -> Option<proto::PaneNote> {
        self.notes
            .lock()
            .expect("notes lock")
            .get(&session)
            .cloned()
    }

    /// A pane's info is snapshotted without its note, so every update carries it here.
    pub(super) fn broadcast_session_updated(&self, mut info: proto::SessionInfo) {
        info.note = self.note_of(info.id);
        self.broadcast_control(&proto::ServerMsg::SessionUpdated { info });
    }

    /// A closed or respawned pane's note goes with it; the row it was saved on is closed.
    pub(super) fn forget_note(&self, session: u32) {
        self.notes.lock().expect("notes lock").remove(&session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_one_line_and_bounded() {
        assert_eq!(
            note_text("  fix in\nplace;\trunning tests ").unwrap(),
            "fix in place; running tests"
        );
        assert!(note_text(" \n ")
            .unwrap_err()
            .to_string()
            .contains("pane note is empty"));
        let at_limit = "x".repeat(proto::PANE_NOTE_MAX_BYTES);
        assert_eq!(note_text(&at_limit).unwrap(), at_limit);
        let over = "é".repeat(proto::PANE_NOTE_MAX_BYTES / 2 + 1);
        let error = note_text(&over).unwrap_err().to_string();
        assert!(error.contains("514 bytes"), "{error}");
        assert!(error.contains("the limit is 512 bytes"), "{error}");
    }

    #[test]
    fn a_note_strips_invisible_format_characters() {
        // U+202E reorders and U+2066 isolates following text; U+FEFF is a
        // zero-width no-break space. A note of only format characters is empty.
        assert_eq!(
            note_text("fix\u{202e}in\u{2066} place\u{feff}").unwrap(),
            "fixin place"
        );
        assert!(note_text("\u{202e}\u{200d}")
            .unwrap_err()
            .to_string()
            .contains("pane note is empty"));
    }
}

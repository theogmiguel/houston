//! Antigravity publishes no last-assistant-message field in its hook payloads;
//! its own `transcriptPath` JSONL — never a path Houston builds — is the only
//! place that text lives. Reads the last assistant entry only, from a bounded
//! tail of the file; any error is `None`, and an entry wholly before the tail
//! window is not guessed at.

/// A few MiB of tail: the turn-end hook fires right after the assistant entry
/// is appended, so the newest one is always near the end of the file.
const TAIL_BYTES: u64 = 8 * 1024 * 1024;

pub fn antigravity_last_message_from_transcript(path: &str) -> Option<String> {
    let text = crate::context_window::read_tail(std::path::Path::new(path), TAIL_BYTES)?;
    let mut last = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = entry
            .get("role")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("type").and_then(|v| v.as_str()));
        if role != Some("assistant") {
            continue;
        }
        if let Some(body) = entry
            .get("content")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("text").and_then(|v| v.as_str()))
        {
            last = Some(body.to_string());
        }
    }
    last.map(|m| crate::orchestrate::cap_submit_body(&crate::sanitize::redact_secrets(&m).0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antigravity_transcript_reads_the_last_assistant_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            "{\"role\":\"user\",\"content\":\"hi\"}\n\
             {\"role\":\"assistant\",\"content\":\"first\"}\n\
             {\"role\":\"assistant\",\"content\":\"last\"}\n",
        )
        .unwrap();
        assert_eq!(
            antigravity_last_message_from_transcript(path.to_str().unwrap()),
            Some("last".to_string())
        );
    }

    #[test]
    fn antigravity_transcript_tolerates_the_type_text_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, "{\"type\":\"assistant\",\"text\":\"PONG\"}\n").unwrap();
        assert_eq!(
            antigravity_last_message_from_transcript(path.to_str().unwrap()),
            Some("PONG".to_string())
        );
    }

    #[test]
    fn antigravity_transcript_read_failure_is_none_not_a_guess() {
        assert_eq!(
            antigravity_last_message_from_transcript("/does/not/exist.jsonl"),
            None
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, "{\"role\":\"user\",\"content\":\"hi\"}\n").unwrap();
        assert_eq!(
            antigravity_last_message_from_transcript(path.to_str().unwrap()),
            None
        );
    }

    fn padding_beyond_the_tail() -> String {
        let filler = format!(
            "{{\"role\":\"user\",\"content\":\"{}\"}}\n",
            "x".repeat(1024)
        );
        filler.repeat((TAIL_BYTES as usize / filler.len()) + 1)
    }

    #[test]
    fn a_transcript_past_the_tail_keeps_the_last_entry_not_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"role\":\"assistant\",\"content\":\"oldest\"}}\n{}{{\"role\":\"assistant\",\"content\":\"newest\"}}\n",
                padding_beyond_the_tail()
            ),
        )
        .unwrap();
        assert_eq!(
            antigravity_last_message_from_transcript(path.to_str().unwrap()),
            Some("newest".to_string())
        );
    }

    #[test]
    fn an_assistant_entry_before_the_tail_window_is_none_not_a_guess() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"role\":\"assistant\",\"content\":\"only\"}}\n{}",
                padding_beyond_the_tail()
            ),
        )
        .unwrap();
        assert_eq!(
            antigravity_last_message_from_transcript(path.to_str().unwrap()),
            None
        );
    }
}

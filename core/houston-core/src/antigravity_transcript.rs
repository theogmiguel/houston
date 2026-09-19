//! Antigravity publishes no last-assistant-message field in its hook payloads;
//! its own `transcriptPath` JSONL — never a path Houston builds — is the only
//! place that text lives. Reads the last assistant entry only; any error is `None`.
pub fn antigravity_last_message_from_transcript(path: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
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
}

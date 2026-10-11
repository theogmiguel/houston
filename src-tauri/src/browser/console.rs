use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;

// 256 entries of at most 4096 characters bound page-controlled memory per surface.
pub const MAX_MESSAGES: usize = 256;
const MAX_TEXT_CHARS: usize = 4096;
// Allows JSON escaping of capped text while bounding bridge payloads.
pub const MAX_RAW_MESSAGE_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: u64,
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct Buffer {
    next_id: u64,
    entries: VecDeque<Message>,
}

impl Buffer {
    pub fn push(&mut self, value: &Value) {
        let Some(level) = value.get("level").and_then(Value::as_str) else {
            return;
        };
        if !matches!(level, "log" | "debug" | "info" | "warn" | "error") {
            return;
        }
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            return;
        };
        self.next_id += 1;
        if self.entries.len() == MAX_MESSAGES {
            self.entries.pop_front();
        }
        self.entries.push_back(Message {
            id: self.next_id,
            level: level.into(),
            text: text.chars().take(MAX_TEXT_CHARS).collect(),
        });
    }

    pub fn read(&self, level: Option<&str>, since: u64, limit: usize) -> Vec<Message> {
        self.entries
            .iter()
            .filter(|m| m.id > since && level.is_none_or(|l| m.level == l))
            .take(limit)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn console_ring_bounds_text_and_entries_and_filters_incrementally() {
        let mut buffer = Buffer::default();
        for n in 0..300 {
            buffer.push(
                &json!({"level": if n % 2 == 0 {"warn"} else {"log"}, "text": "é".repeat(5000)}),
            );
        }
        let rows = buffer.read(None, 0, MAX_MESSAGES);
        assert_eq!(rows.len(), MAX_MESSAGES);
        assert_eq!(rows[0].id, 45);
        assert_eq!(rows[0].text.chars().count(), MAX_TEXT_CHARS);
        let filtered = buffer.read(Some("warn"), 290, 2);
        assert_eq!(
            filtered.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![291, 293]
        );
    }
}

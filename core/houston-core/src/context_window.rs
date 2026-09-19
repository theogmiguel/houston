//! Claude context occupancy, read from the CLI's own transcript. The daemon
//! learns the path from the hook payload it already receives; only integers,
//! the model id and the reset flag cross this boundary.

use std::path::Path;

/// How much of a transcript the daemon reads per turn. The latest assistant
/// record is appended near the end, so a bounded tail is enough and keeps the
/// read off the terminal hot path.
const TAIL_BYTES: u64 = 8 * 1024 * 1024;

/// One reading of a session's context, newest event wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeReading {
    pub used_tokens: u64,
    pub model: String,
    /// The newest event was a compaction boundary; `used_tokens` is post-compaction.
    pub reset: bool,
}

pub fn read_claude_context(path: &Path) -> Option<ClaudeReading> {
    let contents = read_tail(path, TAIL_BYTES)?;
    latest_claude_reading(&contents)
}

/// Scan transcript JSONL for the newest usage or compaction event. Claude
/// repeats one message's `usage` across its content blocks, so the last record
/// is the occupancy and there is no summing here.
pub fn latest_claude_reading(contents: &str) -> Option<ClaudeReading> {
    // Newest event wins, and it is near the end: scan backwards and stop at the
    // first matching record, so a large tail costs a substring scan, not a full
    // parse of every line. The cheap filter keeps serde off unrelated records.
    for line in contents.lines().rev() {
        if !(line.contains("\"usage\"") || line.contains("compact_boundary")) {
            continue;
        }
        let Ok(root) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = root.get("type").and_then(|v| v.as_str());
        if kind == Some("system")
            && root.get("subtype").and_then(|v| v.as_str()) == Some("compact_boundary")
        {
            let Some(post) = root
                .get("compactMetadata")
                .and_then(|m| m.get("postTokens"))
                .and_then(|n| n.as_u64())
            else {
                continue;
            };
            return Some(ClaudeReading {
                used_tokens: post,
                model: String::new(),
                reset: true,
            });
        }
        if kind != Some("assistant")
            || root.get("isSidechain").and_then(|v| v.as_bool()) == Some(true)
        {
            continue;
        }
        let Some(message) = root.get("message").and_then(|v| v.as_object()) else {
            continue;
        };
        let Some(usage) = message.get("usage").and_then(|v| v.as_object()) else {
            continue;
        };
        let get = |key: &str| usage.get(key).and_then(|n| n.as_u64()).unwrap_or(0);
        let used_tokens = get("input_tokens")
            .saturating_add(get("cache_read_input_tokens"))
            .saturating_add(get("cache_creation_input_tokens"));
        let model = message
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Some(ClaudeReading {
            used_tokens,
            model,
            reset: false,
        });
    }
    None
}

/// The documented context window for a Claude model id, or `None` when the id is
/// not recognised. A `None` denominator means the UI shows absolute tokens only.
pub fn model_window(model: &str) -> Option<u64> {
    if model.is_empty() {
        return None;
    }
    let m = model.to_ascii_lowercase();
    // Families Anthropic documents as 1M-context. Substring keys use the
    // transcript's hyphenated spelling (e.g. `claude-opus-4-8`).
    const ONE_M: [&str; 8] = [
        "fable-5",
        "mythos-5",
        "opus-5",
        "opus-4-8",
        "opus-4-7",
        "opus-4-6",
        "sonnet-5",
        "sonnet-4-6",
    ];
    if ONE_M.iter().any(|k| m.contains(k)) {
        return Some(1_000_000);
    }
    if m.starts_with("claude-") {
        return Some(200_000);
    }
    None
}

/// Whole-number percentage, floored so a value just under the window never
/// reads as 100. The caller renders a distinct near-limit state instead.
pub fn percent_used(used: u64, window: u64) -> u8 {
    if window == 0 {
        return 0;
    }
    (used.saturating_mul(100) / window).min(100) as u8
}

/// At or above 80 percent of a known window. The threshold is ours, not the
/// provider's: the transcript carries no auto-compact ceiling.
pub fn near_limit(used: u64, window: Option<u64>) -> bool {
    window.is_some_and(|w| w > 0 && used.saturating_mul(100) >= w.saturating_mul(80))
}

fn read_tail(path: &Path, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return Some(text);
    }
    // The window may have split a line; drop the leading partial one.
    Some(drop_leading_partial(&text))
}

/// A tail that begins mid-line: everything after the first newline, or empty
/// when the window holds no complete line.
fn drop_leading_partial(text: &str) -> String {
    text.find('\n')
        .map(|pos| text[pos + 1..].to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(usage: &str) -> String {
        format!(r#"{{"type":"assistant","message":{{"model":"claude-opus-4-8","usage":{usage}}}}}"#)
    }

    #[test]
    fn takes_the_newest_assistant_usage_not_a_sum() {
        let body = format!(
            "{}\n{}\n",
            assistant(
                r#"{"input_tokens":10,"cache_read_input_tokens":90,"cache_creation_input_tokens":5}"#
            ),
            assistant(
                r#"{"input_tokens":4,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}"#
            ),
        );
        let reading = latest_claude_reading(&body).unwrap();
        assert_eq!(reading.used_tokens, 104);
        assert!(!reading.reset);
        assert_eq!(reading.model, "claude-opus-4-8");
    }

    #[test]
    fn skips_sidechain_assistant_records() {
        let body = format!(
            "{}\n{}\n",
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":9999,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
        );
        let reading = latest_claude_reading(&body).unwrap();
        assert_eq!(
            reading.used_tokens, 1000,
            "a subagent's window is not the pane's"
        );
    }

    #[test]
    fn a_compaction_boundary_after_usage_resets_to_post_tokens() {
        let body = format!(
            "{}\n{}\n",
            assistant(
                r#"{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}"#
            ),
            r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":180000,"postTokens":12000}}"#,
        );
        let reading = latest_claude_reading(&body).unwrap();
        assert_eq!(reading.used_tokens, 12000);
        assert!(reading.reset);
    }

    #[test]
    fn known_models_get_a_window() {
        assert_eq!(model_window("claude-opus-4-8"), Some(1_000_000));
        assert_eq!(model_window("claude-sonnet-4-5"), Some(200_000));
    }

    #[test]
    fn window_table_is_table_driven() {
        let one_million = [
            "claude-fable-5-1",
            "claude-mythos-5-1",
            "claude-fable-5",
            "claude-mythos-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
        ];
        for model in one_million {
            assert_eq!(model_window(model), Some(1_000_000), "{model}");
        }
        assert_eq!(model_window("claude-sonnet-4-5"), Some(200_000));
        assert_eq!(model_window("gpt-5.6-sol"), None);
    }

    #[test]
    fn unknown_model_has_no_percentage() {
        assert_eq!(model_window("gpt-5.6-sol"), None);
        assert_eq!(model_window(""), None);
    }

    #[test]
    fn absence_paths_return_none() {
        assert!(latest_claude_reading("").is_none());
        assert!(latest_claude_reading(r#"{"type":"user","message":{}}"#).is_none());
        assert!(
            latest_claude_reading(r#"{"type":"assistant","message":{"model":"m"}}"#).is_none(),
            "an assistant record with no usage is not a reading"
        );
        assert!(
            latest_claude_reading(r#"{"type":"system","subtype":"compact_boundary"}"#).is_none(),
            "a boundary with no postTokens is not a reading"
        );
        let dir = tempfile::tempdir().unwrap();
        assert!(read_claude_context(&dir.path().join("missing.jsonl")).is_none());
    }

    #[test]
    fn partial_first_line_is_dropped() {
        assert_eq!(drop_leading_partial("alf-line\n{\"ok\":1}"), "{\"ok\":1}");
        assert_eq!(drop_leading_partial("no newline here"), "");
    }

    #[test]
    fn near_limit_at_eighty_percent() {
        assert!(near_limit(160, Some(200)));
        assert!(!near_limit(159, Some(200)));
        assert!(!near_limit(1, None));
    }

    #[test]
    fn percent_is_floored_never_a_rounded_hundred() {
        assert_eq!(percent_used(199, 200), 99);
        assert_eq!(percent_used(200, 200), 100);
    }
}

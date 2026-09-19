use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use houston_protocol as proto;

use super::transcripts::{
    codex_line_is_relevant, might_carry_usage, parse_claude_line, parse_codex_line, CodexScanState,
    UsageRecord,
};

/// A usage record is well under 2 KiB; a line an order of magnitude past that is
/// tool output or an embedded image, which carries no usage and costs a JSON
/// parse to prove it.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct TranscriptFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Default)]
pub struct Listing {
    pub files: Vec<TranscriptFile>,
    pub skipped: u32,
    pub unreadable_dirs: u32,
    pub root_exists: bool,
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The mtime prefilter is conservative: a transcript is append-only, so a file
/// whose mtime predates the window holds no record inside it, while one inside
/// may still be mostly older — those are dropped later, by exact instant.
pub fn list_transcripts(root: &Path, since_ms: i64) -> Listing {
    let mut listing = Listing {
        root_exists: root.is_dir(),
        ..Default::default()
    };
    if !listing.root_exists {
        return listing;
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            listing.unreadable_dirs += 1;
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified = mtime_ms(&meta);
            if modified < since_ms {
                listing.skipped += 1;
                continue;
            }
            listing.files.push(TranscriptFile {
                path,
                size: meta.len(),
                mtime_ms: modified,
            });
        }
    }
    listing.files.sort_by(|a, b| a.path.cmp(&b.path));
    listing
}

/// `None` when the file could not be read at all, distinct from an empty vec:
/// the cache must not memoise a transient failure under `(size, mtime)`, which
/// for a finished session would hide that usage forever.
pub fn read_records(path: &Path, provider: proto::UsageProvider) -> Option<Vec<UsageRecord>> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut records = Vec::new();
    let mut codex_state = CodexScanState::new();
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return None,
        }
        if buf.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };

        match provider {
            proto::UsageProvider::Claude => {
                if !might_carry_usage(line, provider) {
                    continue;
                }
                if let Some(record) = parse_claude_line(line) {
                    records.push(record);
                }
            }
            proto::UsageProvider::Codex => {
                if !codex_line_is_relevant(line) {
                    continue;
                }
                if let Some(record) = parse_codex_line(line, &mut codex_state) {
                    records.push(record);
                }
            }
        }
    }
    Some(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[cfg(unix)]
    fn set_mtime(path: &Path, ms: i64) {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let tv = libc::timeval {
            tv_sec: ms / 1000,
            tv_usec: ((ms % 1000) * 1000) as libc::suseconds_t,
        };
        let times = [tv, tv];
        // SAFETY: `c` is a valid NUL-terminated CString and `times` has the
        // two entries `utimes` reads; both outlive the call.
        let rc = unsafe { libc::utimes(c.as_ptr(), times.as_ptr()) };
        assert_eq!(rc, 0, "utimes failed on {}", path.display());
    }

    #[test]
    fn a_missing_root_is_reported_not_raised() {
        let dir = tempfile::tempdir().unwrap();
        let listing = list_transcripts(&dir.path().join("never-ran"), 0);
        assert!(!listing.root_exists);
        assert!(listing.files.is_empty());
    }

    #[test]
    fn walks_nested_projects_and_takes_only_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("proj-a/one.jsonl"), "{}\n");
        write(&dir.path().join("proj-b/nested/two.jsonl"), "{}\n");
        write(&dir.path().join("proj-b/notes.md"), "hi\n");
        write(&dir.path().join("proj-b/three.jsonl.tmp"), "{}\n");
        let listing = list_transcripts(dir.path(), 0);
        assert!(listing.root_exists);
        assert_eq!(listing.files.len(), 2);
        assert!(listing
            .files
            .iter()
            .all(|f| f.path.extension().unwrap() == "jsonl"));
    }

    #[cfg(unix)]
    #[test]
    fn the_mtime_prefilter_skips_files_that_cannot_reach_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.jsonl");
        let new = dir.path().join("new.jsonl");
        write(&old, "{}\n");
        write(&new, "{}\n");
        set_mtime(&old, 1_000_000);
        set_mtime(&new, 9_000_000);
        let listing = list_transcripts(dir.path(), 5_000_000);
        assert_eq!(listing.skipped, 1);
        assert_eq!(listing.files.len(), 1);
        assert_eq!(listing.files[0].path, new);
        assert_eq!(listing.files[0].mtime_ms, 9_000_000);
    }

    #[test]
    fn an_empty_transcript_is_an_empty_vec_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.jsonl");
        write(&path, "");
        assert_eq!(
            read_records(&path, proto::UsageProvider::Claude),
            Some(Vec::new())
        );
    }

    #[test]
    fn an_absent_transcript_is_a_failure_not_an_empty_vec() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_records(&dir.path().join("gone.jsonl"), proto::UsageProvider::Claude).is_none()
        );
    }

    #[test]
    fn reads_a_claude_transcript_past_noise_and_a_giant_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let giant = format!(
            r#"{{"type":"assistant","blob":"{}"}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        let body = format!(
            "{}\n{}\n{}\n{}\n",
            r#"{"type":"user","message":{"content":"hello"}}"#,
            giant,
            r#"tool output that is not json at all"#,
            r#"{"type":"assistant","timestamp":"2026-08-27T10:00:00Z","sessionId":"s1","requestId":"r1","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20}}}"#
        );
        write(&path, &body);
        let records = read_records(&path, proto::UsageProvider::Claude).expect("readable");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].totals.output_tokens, 20);
        assert!(records[0].dedupe_key.is_some());
    }

    #[test]
    fn reads_a_codex_rollout_carrying_the_model_forward() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let body = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","timestamp":"2026-08-27T10:00:00Z","payload":{"id":"sess_1"}}"#,
            r#"{"type":"turn_context","timestamp":"2026-08-27T10:00:01Z","payload":{"model":"gpt-5-codex"}}"#,
            r#"{"type":"event_msg","timestamp":"2026-08-27T10:00:05Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":900,"output_tokens":200}}}}"#
        );
        write(&path, &body);
        let records = read_records(&path, proto::UsageProvider::Codex).expect("readable");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].model, "gpt-5-codex");
        assert_eq!(records[0].session_id, "sess_1");
        assert_eq!(records[0].totals.uncached_input_tokens, 100);
    }
}

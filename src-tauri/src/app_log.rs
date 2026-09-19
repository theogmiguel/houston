use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;

use serde::Serialize;
use serde_json::Value;

use crate::watchdog::clocks::{Clocks, SystemClocks};

pub const SCHEMA_VERSION: u32 = 1;

// Bounded so a caller cannot wedge an unbounded tag into the record position; the
// longest real tag is 18 bytes, so 64 leaves headroom while still catching an
// obviously wrong value passed where a tag was expected.
pub const SOURCE_MAX_BYTES: usize = 64;

pub const MESSAGE_MAX_BYTES: usize = 1024;

pub const PAYLOAD_MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Truncation {
    pub limit_bytes: usize,
    pub actual_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub schema: u32,
    pub ts_wall: u64,
    pub source: String,
    pub message: String,
    pub payload: Option<Value>,
    pub message_truncation: Option<Truncation>,
    pub payload_truncation: Option<Truncation>,
}

fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub fn build_record(
    source: String,
    message: String,
    payload: Option<Value>,
) -> Result<Record, String> {
    if source.is_empty() || source.len() > SOURCE_MAX_BYTES {
        return Err(format!(
            "system_log_debug: source must be a non-empty string of at most \
             {SOURCE_MAX_BYTES} bytes, got {source:?} ({} bytes)",
            source.len()
        ));
    }

    let (message, message_truncation) = if message.len() > MESSAGE_MAX_BYTES {
        let actual_bytes = message.len();
        let truncated = truncate_utf8(&message, MESSAGE_MAX_BYTES).to_string();
        (
            truncated,
            Some(Truncation {
                limit_bytes: MESSAGE_MAX_BYTES,
                actual_bytes,
            }),
        )
    } else {
        (message, None)
    };

    let (payload, payload_truncation) = match payload {
        Some(value) => {
            let serialized =
                serde_json::to_string(&value).expect("serde_json::Value serializes infallibly");
            if serialized.len() > PAYLOAD_MAX_BYTES {
                (
                    None,
                    Some(Truncation {
                        limit_bytes: PAYLOAD_MAX_BYTES,
                        actual_bytes: serialized.len(),
                    }),
                )
            } else {
                (Some(value), None)
            }
        }
        None => (None, None),
    };

    Ok(Record {
        schema: SCHEMA_VERSION,
        ts_wall: SystemClocks.sample().wall_ms,
        source,
        message,
        payload,
        message_truncation,
        payload_truncation,
    })
}

// Bounded so a stalled disk turns into a reported number of dropped records rather
// than unbounded memory growth. Sized against a 12-pane flood plus the other source
// tags, and a full queue is reported, never silently dropped.
const QUEUE_CAPACITY: usize = 32;

// The disk write never runs on the caller's thread: `system_log_debug` is a non-async
// command Tauri runs on the receiving (GTK main) thread, so a blocking write there is
// exactly the stall the watchdog detects. One channel, one writer thread.
pub struct AppDebugSink {
    tx: mpsc::SyncSender<Record>,
    dropped: AtomicU64,
    dropping: AtomicBool,
}

struct Writer {
    path: PathBuf,
    file: Option<BufWriter<File>>,
    complained: bool,
}

impl Writer {
    fn new(path: PathBuf) -> Self {
        let file = Self::open(&path);
        if file.is_none() {
            eprintln!(
                "houston-tauri: app debug log cannot open its file at {} (expected a \
                 writable path in the channel state dir); falling back to stderr",
                path.display()
            );
        }
        Self {
            path,
            file,
            complained: false,
        }
    }

    fn open(path: &Path) -> Option<BufWriter<File>> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(BufWriter::new)
    }

    fn write(&mut self, record: &Record) {
        let line = match serde_json::to_string(record) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("houston-tauri: app debug record is not serialisable: {err}");
                return;
            }
        };
        if let Some(file) = self.file.as_mut() {
            if writeln!(file, "{line}").is_ok() && file.flush().is_ok() {
                return;
            }
            self.file = None;
        }
        if !self.complained {
            self.complained = true;
            eprintln!(
                "houston-tauri: app debug log at {} became unwritable; records continue on \
                 stderr only",
                self.path.display()
            );
        }
        eprintln!("houston-app-debug {line}");
    }
}

impl AppDebugSink {
    pub fn new(path: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel(QUEUE_CAPACITY);
        let mut writer = Writer::new(path);
        if let Err(err) = std::thread::Builder::new()
            .name("tr-app-log".into())
            .spawn(move || {
                while let Ok(record) = rx.recv() {
                    writer.write(&record);
                }
            })
        {
            eprintln!("houston-tauri: app debug log writer thread failed to spawn: {err}");
        }
        Self {
            tx,
            dropped: AtomicU64::new(0),
            dropping: AtomicBool::new(false),
        }
    }

    pub fn write(&self, record: &Record) {
        match self.tx.try_send(record.clone()) {
            Ok(()) => {
                self.dropping.store(false, Ordering::Relaxed);
            }
            Err(mpsc::TrySendError::Full(_)) => {
                let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if !self.dropping.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "houston-tauri: app debug log queue is full (capacity \
                         {QUEUE_CAPACITY} records); dropping records until the writer thread \
                         catches up, {dropped} dropped so far"
                    );
                }
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                eprintln!(
                    "houston-tauri: app debug log writer thread is gone; record continues \
                     on stderr only"
                );
                match serde_json::to_string(record) {
                    Ok(line) => eprintln!("houston-app-debug {line}"),
                    Err(err) => {
                        eprintln!("houston-tauri: app debug record is not serialisable: {err}")
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn system_log_debug(
    state: tauri::State<'_, AppDebugSink>,
    source: String,
    message: String,
    payload: Option<Value>,
) -> Result<(), String> {
    let record = build_record(source, message, payload)?;
    state.write(&record);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn wait_for(path: &Path, deadline: Duration, pred: impl Fn(&str) -> bool) -> String {
        let start = Instant::now();
        loop {
            let text = std::fs::read_to_string(path).unwrap_or_default();
            if pred(&text) || start.elapsed() > deadline {
                return text;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn rejects_an_empty_source() {
        let err = build_record(String::new(), "hi".into(), None).unwrap_err();
        assert!(
            err.contains("non-empty"),
            "error should name the shape: {err}"
        );
    }

    #[test]
    fn rejects_a_source_over_the_byte_cap() {
        let source = "x".repeat(SOURCE_MAX_BYTES + 1);
        let err = build_record(source.clone(), "hi".into(), None).unwrap_err();
        assert!(
            err.contains(&SOURCE_MAX_BYTES.to_string()),
            "error should name the limit: {err}"
        );
        assert!(
            err.contains(&(SOURCE_MAX_BYTES + 1).to_string()),
            "error should name the actual size: {err}"
        );
    }

    #[test]
    fn accepts_a_source_at_exactly_the_cap() {
        let source = "x".repeat(SOURCE_MAX_BYTES);
        build_record(source, "hi".into(), None).expect("boundary value must be accepted");
    }

    #[test]
    fn truncates_an_oversized_message_and_says_so() {
        let message = "m".repeat(MESSAGE_MAX_BYTES + 10);
        let record = build_record("terminal-transport".into(), message, None).unwrap();
        assert_eq!(record.message.len(), MESSAGE_MAX_BYTES);
        let truncation = record
            .message_truncation
            .expect("must record the truncation");
        assert_eq!(truncation.limit_bytes, MESSAGE_MAX_BYTES);
        assert_eq!(truncation.actual_bytes, MESSAGE_MAX_BYTES + 10);
    }

    #[test]
    fn truncation_never_splits_a_multi_byte_character() {
        let message = "あ".repeat(MESSAGE_MAX_BYTES);
        let record = build_record("terminal-transport".into(), message, None).unwrap();
        assert!(record.message.len() < MESSAGE_MAX_BYTES);
        assert!(
            record.message.len().is_multiple_of(3),
            "must end on a whole character"
        );
        assert!(record.message_truncation.is_some());
    }

    #[test]
    fn a_message_at_exactly_the_cap_is_not_truncated() {
        let message = "m".repeat(MESSAGE_MAX_BYTES);
        let record = build_record("terminal-transport".into(), message, None).unwrap();
        assert!(record.message_truncation.is_none());
    }

    #[test]
    fn drops_an_oversized_payload_and_says_so() {
        let big = Value::String("p".repeat(PAYLOAD_MAX_BYTES + 100));
        let record = build_record("terminal-transport".into(), "hi".into(), Some(big)).unwrap();
        assert!(
            record.payload.is_none(),
            "oversized payload must be dropped, not partially kept"
        );
        let truncation = record.payload_truncation.expect("must record the drop");
        assert_eq!(truncation.limit_bytes, PAYLOAD_MAX_BYTES);
        assert!(truncation.actual_bytes > PAYLOAD_MAX_BYTES);
    }

    #[test]
    fn keeps_a_payload_within_the_cap() {
        let payload = serde_json::json!({ "session": 3, "class": "bulk" });
        let record = build_record(
            "terminal-transport".into(),
            "hi".into(),
            Some(payload.clone()),
        )
        .unwrap();
        assert_eq!(record.payload, Some(payload));
        assert!(record.payload_truncation.is_none());
    }

    #[test]
    fn the_written_line_has_exactly_the_documented_key_set() {
        let dir = std::env::temp_dir().join(format!("tr-app-log-keys-{}", std::process::id()));
        let path = dir.join("app-debug.ndjson");
        let _ = std::fs::remove_file(&path);
        let sink = AppDebugSink::new(path.clone());
        let record = build_record(
            "terminal-transport".into(),
            "hi".into(),
            Some(serde_json::json!({"a": 1})),
        )
        .unwrap();
        sink.write(&record);
        let text = wait_for(&path, Duration::from_secs(2), |t| !t.trim().is_empty());
        let line = text.lines().next().expect("one line written");
        let v: Value = serde_json::from_str(line).expect("valid JSON");
        let mut keys: Vec<&str> = v
            .as_object()
            .expect("a JSON object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        keys.sort_unstable();
        let mut expected = vec![
            "schema",
            "ts_wall",
            "source",
            "message",
            "payload",
            "message_truncation",
            "payload_truncation",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected, "line was: {line}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sink_writes_one_parseable_line_per_record() {
        let dir = std::env::temp_dir().join(format!("tr-app-log-lines-{}", std::process::id()));
        let path = dir.join("app-debug.ndjson");
        let _ = std::fs::remove_file(&path);
        let sink = AppDebugSink::new(path.clone());
        let record = build_record("watchers".into(), "hello".into(), None).unwrap();
        sink.write(&record);
        sink.write(&record);
        let text = wait_for(&path, Duration::from_secs(2), |t| t.lines().count() >= 2);
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in lines {
            let v: Value = serde_json::from_str(line).expect("valid JSON");
            assert_eq!(v["schema"], SCHEMA_VERSION);
            assert_eq!(v["source"], "watchers");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_path_degrades_instead_of_failing() {
        let sink = AppDebugSink::new(PathBuf::from("/proc/tr-app-debug-cannot-exist/log.ndjson"));
        let record = build_record("install".into(), "hello".into(), None).unwrap();
        sink.write(&record);
    }

    #[test]
    fn system_log_debug_accepts_camel_case_argument_names() {
        let dir = std::env::temp_dir().join(format!("tr-app-log-ipc-{}", std::process::id()));
        let path = dir.join("app-debug.ndjson");
        let _ = std::fs::remove_file(&path);

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![system_log_debug])
            .manage(AppDebugSink::new(path.clone()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .expect("mock window builds");

        let response = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: "system_log_debug".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                    "source": "terminal-transport",
                    "message": "hello from camelCase args",
                    "payload": { "session": 1 }
                })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        assert!(
            response.is_ok(),
            "camelCase-shaped call must succeed: {response:?}"
        );

        let text = wait_for(&path, Duration::from_secs(2), |t| {
            t.contains("hello from camelCase args")
        });
        assert!(text.contains("hello from camelCase args"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_full_queue_does_not_block_and_records_the_drop() {
        let (tx, rx) = mpsc::sync_channel(2);
        let sink = AppDebugSink {
            tx,
            dropped: AtomicU64::new(0),
            dropping: AtomicBool::new(false),
        };
        let record = build_record("watchers".into(), "hello".into(), None).unwrap();

        sink.write(&record);
        sink.write(&record);
        assert_eq!(sink.dropped.load(Ordering::Relaxed), 0);

        let started = Instant::now();
        sink.write(&record);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "write() must not block on a full queue"
        );
        assert_eq!(
            sink.dropped.load(Ordering::Relaxed),
            1,
            "a dropped record must be counted, not silently discarded"
        );

        drop(rx.recv().expect("one record queued"));
        sink.write(&record);
        assert_eq!(
            sink.dropped.load(Ordering::Relaxed),
            1,
            "a successful send must not add to the drop count"
        );
    }

    #[test]
    fn a_disconnected_writer_degrades_instead_of_panicking() {
        let (tx, rx) = mpsc::sync_channel(QUEUE_CAPACITY);
        drop(rx);
        let sink = AppDebugSink {
            tx,
            dropped: AtomicU64::new(0),
            dropping: AtomicBool::new(false),
        };
        let record = build_record("install".into(), "hello".into(), None).unwrap();
        sink.write(&record);
    }
}

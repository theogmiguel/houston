use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::machine::TerminationReason;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Trigger {
    ProbeReturned {
        rtt_ms: u64,
    },
    ProbeFailed {
        consecutive: u32,
        responsive: bool,
    },
    BootTimeout,
    Suspend {
        suspended_ms: u64,
    },
    WallStep {
        step_ms: i64,
    },
    Starved {
        by_ms: u64,
    },
    WebProcessTerminated {
        #[serde(serialize_with = "termination_reason")]
        reason: TerminationReason,
    },
    Responsiveness {
        responsive: bool,
    },
    ProbeRttSummary {
        count: u32,
        min_ms: u64,
        p50_ms: u64,
        p99_ms: u64,
        max_ms: u64,
    },
    PaintReport {
        ok: bool,
        raf_gap_ms: u64,
    },
    ReloadRequested {
        reason: String,
    },
    RecoveryWithheld {
        reason: &'static str,
    },
    RecoveryStarted,
    RecoveryRung {
        rung: u8,
    },
    PromptIssued,
    PromptAnswered {
        timed_out: bool,
    },
    PromptDeclined,
    PromptStale,
    BudgetExhausted,
    LadderExhausted,
}

fn termination_reason<S: serde::Serializer>(
    reason: &TerminationReason,
    s: S,
) -> Result<S::Ok, S::Error> {
    s.serialize_str(reason.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThresholdCrossed {
    pub name: &'static str,
    pub value: u64,
    pub observed: u64,
}

impl ThresholdCrossed {
    pub fn new(name: &'static str, value: u64, observed: u64) -> Self {
        Self {
            name,
            value,
            observed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TransitionLog {
    pub state: &'static str,
    pub prev_state: &'static str,
    pub trigger: Trigger,
    pub threshold_crossed: Option<ThresholdCrossed>,
    pub probe_rtt_ms: Vec<u64>,
    pub incident_id: Option<u64>,
    pub incident_reason: Option<String>,
    pub suppressed: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub schema: u32,
    pub ts_wall: u64,
    pub ts_mono: u64,
    pub ts_boot: u64,
    #[serde(flatten)]
    pub transition: TransitionLog,
    pub session_ids: Vec<String>,
}

pub type SessionSource = Box<dyn Fn() -> Vec<String> + Send + Sync>;

pub trait Sink: Send + Sync {
    fn write(&self, record: &Record);
}

pub struct NdjsonSink {
    path: PathBuf,
    file: Mutex<Option<BufWriter<File>>>,
    complained: Mutex<bool>,
}

impl NdjsonSink {
    pub fn new(path: PathBuf) -> Self {
        let file = Self::open(&path);
        if file.is_none() {
            eprintln!(
                "houston-tauri: watchdog cannot open its log at {} (expected a writable path \
                 in the channel state dir); falling back to stderr",
                path.display()
            );
        }
        Self {
            path,
            file: Mutex::new(file),
            complained: Mutex::new(false),
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
}

impl Sink for NdjsonSink {
    fn write(&self, record: &Record) {
        let line = match serde_json::to_string(record) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("houston-tauri: watchdog record is not serialisable: {err}");
                return;
            }
        };
        let mut guard = match self.file.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(file) = guard.as_mut() {
            if writeln!(file, "{line}").is_ok() && file.flush().is_ok() {
                return;
            }
            *guard = None;
        }
        let mut complained = match self.complained.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !*complained {
            *complained = true;
            eprintln!(
                "houston-tauri: watchdog log at {} became unwritable; records continue on \
                 stderr only",
                self.path.display()
            );
        }
        eprintln!("houston-watchdog {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watchdog::machine::TerminationReason;

    fn transition() -> TransitionLog {
        TransitionLog {
            state: "unresponsive",
            prev_state: "suspect",
            trigger: Trigger::ProbeFailed {
                consecutive: 3,
                responsive: false,
            },
            threshold_crossed: Some(ThresholdCrossed::new("N_confirm", 3, 3)),
            probe_rtt_ms: vec![11, 22, 33],
            incident_id: Some(7),
            incident_reason: Some("js-hang".into()),
            suppressed: None,
        }
    }

    fn record() -> Record {
        Record {
            schema: SCHEMA_VERSION,
            ts_wall: 1_700_000_000_000,
            ts_mono: 12_345,
            ts_boot: 999_999,
            transition: transition(),
            session_ids: vec!["sess-a".into(), "sess-b".into()],
        }
    }

    #[test]
    fn every_field_the_spec_names_is_present_in_the_json() {
        let v: serde_json::Value = serde_json::to_value(record()).unwrap();
        for field in [
            "schema",
            "ts_wall",
            "ts_mono",
            "ts_boot",
            "state",
            "prev_state",
            "trigger",
            "threshold_crossed",
            "probe_rtt_ms",
            "session_ids",
            "incident_id",
            "incident_reason",
        ] {
            assert!(
                v.get(field).is_some(),
                "spec §5.4 field {field:?} missing: {v}"
            );
        }
    }

    #[test]
    fn a_crossed_threshold_records_the_limit_and_the_observation_separately() {
        let v = serde_json::to_value(record()).unwrap();
        let crossed = &v["threshold_crossed"];
        assert_eq!(crossed["name"], "N_confirm");
        assert_eq!(crossed["value"], 3);
        assert_eq!(crossed["observed"], 3);
    }

    #[test]
    fn the_trigger_is_tagged_by_kind() {
        let v = serde_json::to_value(record()).unwrap();
        assert_eq!(v["trigger"]["kind"], "probe-failed");
        assert_eq!(v["trigger"]["consecutive"], 3);
        assert_eq!(v["trigger"]["responsive"], false);
    }

    #[test]
    fn termination_reasons_serialise_to_their_spec_names() {
        for (reason, want) in [
            (TerminationReason::Crashed, "web-process-crashed"),
            (TerminationReason::ExceededMemoryLimit, "web-process-oom"),
            (TerminationReason::TerminatedByApi, "web-process-api"),
        ] {
            let t = Trigger::WebProcessTerminated { reason };
            let v = serde_json::to_value(t).unwrap();
            assert_eq!(v["reason"], want);
        }
    }

    #[test]
    fn a_withheld_recovery_names_its_gate() {
        let mut t = transition();
        t.trigger = Trigger::RecoveryWithheld {
            reason: "detect-only",
        };
        t.suppressed = Some("detect-only");
        let v = serde_json::to_value(t).unwrap();
        assert_eq!(v["trigger"]["kind"], "recovery-withheld");
        assert_eq!(v["suppressed"], "detect-only");
    }

    #[test]
    fn records_are_one_line_each_so_the_file_is_ndjson() {
        let line = serde_json::to_string(&record()).unwrap();
        assert!(!line.contains('\n'), "a record must not contain a newline");
    }

    #[test]
    fn the_sink_writes_one_parseable_line_per_record() {
        let dir = std::env::temp_dir().join(format!("tr-wd-test-{}", std::process::id()));
        let path = dir.join("watchdog.ndjson");
        let _ = std::fs::remove_file(&path);
        let sink = NdjsonSink::new(path.clone());
        sink.write(&record());
        sink.write(&record());
        let text = std::fs::read_to_string(&path).expect("log written");
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).expect("valid JSON");
            assert_eq!(v["schema"], SCHEMA_VERSION);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_path_degrades_instead_of_failing() {
        let sink = NdjsonSink::new(PathBuf::from("/proc/tr-watchdog-cannot-exist/log.ndjson"));
        sink.write(&record());
    }
}

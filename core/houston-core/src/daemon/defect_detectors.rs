//! Deterministic suspected-defect detectors. Each reads state the daemon already
//! owns and records at most five occurrences per workspace per UTC day; none
//! reads terminal text.
use houston_protocol as proto;

use super::{now_unix_ms, Daemon};
use crate::db::DefectInput;

/// A noisy detector should not fill a day's evidence with one broken checkout.
pub const DEFECT_DETECTOR_DAILY_CAP: u32 = 5;

/// The cap is a read-modify-write on one settings row, and a report, a reply and
/// a conflict tick can reach a detector on different threads. One lock covers
/// the check and the recorded occurrence so the cap cannot be exceeded.
static CAP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const DETECTOR_REPLY_REASKED: &str = "reply_reasked";
const DETECTOR_REPLY_REFUSED_RESOLVED: &str = "reply_refused_resolved";
const DETECTOR_CONFLICT_NOTE_MERGED_BRANCH: &str = "conflict_note_merged_branch";

/// `YYYY-MM-DD` in UTC, for the per-day cap and notice keys.
pub fn utc_day(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let (days, _) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// A report body as the comparison sees it: whitespace collapsed, case folded.
pub fn normalized_body(body: &str) -> String {
    body.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The newest delivered reply whose question body is the one reported again.
pub fn reasked_reply<'a>(
    replies: &'a [(i64, i64, String)],
    report_body: &str,
) -> Option<&'a (i64, i64, String)> {
    let wanted = normalized_body(report_body);
    if wanted.is_empty() {
        return None;
    }
    replies
        .iter()
        .find(|(_, _, question)| normalized_body(question) == wanted)
}

/// A merged or closed pull request for a branch a conflict note names.
pub fn merged_or_closed_pr(state: Option<(u32, proto::PullRequestState)>) -> Option<u32> {
    match state {
        Some((number, proto::PullRequestState::Merged | proto::PullRequestState::Closed)) => {
            Some(number)
        }
        _ => None,
    }
}

impl Daemon {
    /// True while this detector has recorded fewer than the daily cap.
    fn detector_cap_allows(&self, workspace: &str, detector: &str, now_ms: i64) -> bool {
        let day = utc_day(now_ms);
        let key = format!("defect_detector_day:{workspace}");
        let mut counts: std::collections::BTreeMap<String, u32> = self
            .db
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        // Keep one UTC day in the setting; yesterday's counters cannot matter.
        counts.retain(|k, _| k.ends_with(&format!("|{day}")));
        if let Ok(raw) = serde_json::to_string(&counts) {
            if let Err(e) = self.db.set_setting(&key, &raw) {
                tracing::warn!("suspected defects: pruning detector counters: {e:#}");
            }
        }
        counts
            .get(&format!("{detector}|{day}"))
            .copied()
            .unwrap_or(0)
            < DEFECT_DETECTOR_DAILY_CAP
    }

    fn note_detector_occurrence(&self, workspace: &str, detector: &str, now_ms: i64) {
        let day = utc_day(now_ms);
        let key = format!("defect_detector_day:{workspace}");
        let mut counts: std::collections::BTreeMap<String, u32> = self
            .db
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        counts.retain(|k, _| k.ends_with(&format!("|{day}")));
        *counts.entry(format!("{detector}|{day}")).or_insert(0) += 1;
        if let Ok(raw) = serde_json::to_string(&counts) {
            if let Err(e) = self.db.set_setting(&key, &raw) {
                tracing::warn!("suspected defects: recording detector {detector}: {e:#}");
            }
        }
    }

    /// One detector occurrence, bounded by the daily cap and the workspace's
    /// defect limit. Returns whether a row changed.
    pub(super) fn record_detector(
        &self,
        workspace: &str,
        detector: &str,
        title: &str,
        description: &str,
        evidence: Vec<String>,
    ) -> bool {
        let _cap = CAP_LOCK.lock().expect("defect detector cap lock");
        let now_ms = now_unix_ms();
        if !self.detector_cap_allows(workspace, detector, now_ms) {
            return false;
        }
        let mut input = DefectInput {
            workspace: workspace.to_string(),
            source: proto::DefectSource::Detector,
            detector: Some(detector.to_string()),
            title: title.to_string(),
            description: description.to_string(),
            evidence,
            destination: proto::DefectDestination::Houston,
            reporter_session: None,
        };
        self.redact_defect_input(&mut input);
        match self.db.record_defect(&input, now_ms, detector) {
            Ok(record) => {
                self.note_detector_occurrence(workspace, detector, now_ms);
                self.note_defect_recorded(workspace, &record);
                true
            }
            Err(e) => {
                tracing::warn!("defect detector {detector} in {workspace}: {e:#}");
                false
            }
        }
    }

    /// A worker received a delivered reply and then asked the same question again.
    pub(super) fn detect_reply_reasked(&self, workspace: &str, worker: u32, body: &str) -> bool {
        let Ok(replies) = self.db.delivered_replies_for(worker) else {
            return false;
        };
        let Some((question, reply, _)) = reasked_reply(&replies, body) else {
            return false;
        };
        self.record_detector(
            workspace,
            DETECTOR_REPLY_REASKED,
            "A worker re-asked a question after its reply was delivered",
            "The worker reported the same question again after Houston delivered an answer. The reply may have arrived without the text the worker needed.",
            vec![
                format!("question #{question}"),
                format!("delivered reply #{reply}"),
            ],
        )
    }

    /// A reply was refused because its question was already resolved or answered.
    pub(super) fn detect_reply_refused_resolved(&self, workspace: &str, message_id: i64) -> bool {
        self.record_detector(
            workspace,
            DETECTOR_REPLY_REFUSED_RESOLVED,
            "A pane reply was refused because its question was already resolved",
            "A parent answered a question Houston had already resolved, so the reply was refused. The worker may not have seen that its question was answered.",
            vec![format!("message #{message_id}")],
        )
    }

    /// A conflict note names a branch whose pull request already merged or closed.
    pub(super) fn detect_conflict_note_merged_branch(
        &self,
        workspace: &str,
        merged: &[(String, u32)],
    ) -> bool {
        if merged.is_empty() {
            return false;
        }
        let mut evidence: Vec<String> = merged
            .iter()
            .take(usize::try_from(proto::SUSPECTED_DEFECT_EVIDENCE_MAX).unwrap_or(10))
            .map(|(branch, pr)| format!("branch {branch}, PR #{pr}"))
            .collect();
        evidence.sort();
        evidence.dedup();
        self.record_detector(
            workspace,
            DETECTOR_CONFLICT_NOTE_MERGED_BRANCH,
            "A conflict note names a branch whose pull request already merged or closed",
            "Conflict prediction warned about a branch whose pull request the shared reader shows as merged or closed. The worktree is likely stale and the note is noise.",
            evidence,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_are_utc() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_792_936_078_000), "2026-10-25");
    }

    #[test]
    fn a_reasked_question_matches_after_normalizing_whitespace_and_case() {
        let replies = vec![(12, 99, "Where is  the   key?".to_string())];
        assert_eq!(
            reasked_reply(&replies, "where is the key?"),
            Some(&(12, 99, "Where is  the   key?".to_string()))
        );
        assert!(reasked_reply(&replies, "a different question").is_none());
        assert!(reasked_reply(&replies, "   ").is_none());
    }

    #[test]
    fn concurrent_occurrences_never_exceed_the_daily_cap() {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(crate::daemon::DaemonConfig::new(
            "defect-cap".into(),
            state.path().join("test.db"),
            crate::host_env::HostEnv::capture_with_home(state.path()),
        ))
        .unwrap();
        let workspace = "/ws";
        let title = "A worker re-asked a question after its reply was delivered";
        let mut threads = Vec::new();
        for _ in 0..8 {
            let daemon = std::sync::Arc::clone(&daemon);
            threads.push(std::thread::spawn(move || {
                daemon.record_detector(workspace, "reply_reasked", title, "d", Vec::new());
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let rows = daemon.suspected_defect_rows(workspace).unwrap();
        let row = rows
            .iter()
            .find(|row| row.detector.as_deref() == Some("reply_reasked"))
            .expect("a detector row");
        assert_eq!(
            row.count, DEFECT_DETECTOR_DAILY_CAP,
            "eight concurrent occurrences stop at the cap"
        );
    }

    #[test]
    fn a_detector_occurrence_is_stored_redacted() {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(crate::daemon::DaemonConfig::new(
            "defect-redaction".into(),
            state.path().join("test.db"),
            crate::host_env::HostEnv::capture_with_home(state.path()),
        ))
        .unwrap();
        let workspace = state.path().join("ws").display().to_string();
        let home = state.path().display().to_string();
        let token = "ghp_abcdefghijklmnopqrstuvwx";
        assert!(daemon.record_detector(
            &workspace,
            "reply_reasked",
            &format!("A worker re-asked from {home}/x"),
            &format!("saw GITHUB_TOKEN={token} in {workspace}/a.rs"),
            vec![format!("branch {token}, PR #1"), format!("{home}/notes")],
        ));
        let rows = daemon.suspected_defect_rows(&workspace).unwrap();
        let wire = serde_json::to_string(&rows).unwrap();
        assert!(!wire.contains(token), "{wire}");
        assert!(!wire.contains(&home), "{wire}");
        assert!(wire.contains("<workspace>/a.rs"), "{wire}");
    }

    #[test]
    fn only_merged_or_closed_pull_requests_are_noise() {
        assert_eq!(
            merged_or_closed_pr(Some((7, proto::PullRequestState::Merged))),
            Some(7)
        );
        assert_eq!(
            merged_or_closed_pr(Some((7, proto::PullRequestState::Closed))),
            Some(7)
        );
        assert_eq!(
            merged_or_closed_pr(Some((7, proto::PullRequestState::Open))),
            None
        );
        assert_eq!(merged_or_closed_pr(None), None);
    }
}

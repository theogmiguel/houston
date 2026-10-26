//! The suspected-defect verbs, their state as the Harness view sees it, and the
//! explicit issue draft/file flow. Nothing here reads terminal text.
use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use std::collections::HashMap;
use std::path::Path;

use super::{now_unix_ms, Daemon};
use crate::db::DefectRow;
use crate::defect_redaction;

impl Daemon {
    /// Redacts a defect's title, description and evidence before it is stored, so
    /// the database and the wire never hold a secret or the home directory. The
    /// draft redacts again, which leaves already-redacted text unchanged.
    pub(super) fn redact_defect_input(&self, input: &mut crate::db::DefectInput) {
        let env = self.env();
        let workspace = input.workspace.clone();
        let redact = |text: &str| defect_redaction::redact_here(&env, text, &workspace);
        input.title = redact(&input.title);
        input.description = redact(&input.description);
        for item in &mut input.evidence {
            *item = redact(item);
        }
    }

    /// A workspace's defects with the operator's decision applied. A decision
    /// older than the newest occurrence reopens the defect as `recurred`.
    pub fn suspected_defect_rows(&self, workspace: &str) -> Result<Vec<proto::SuspectedDefect>> {
        let decisions: HashMap<String, (proto::HarnessFindingState, i64)> = self
            .db
            .harness_decisions(workspace)?
            .into_iter()
            .filter(|d| {
                matches!(
                    d.state,
                    proto::HarnessFindingState::Dismissed | proto::HarnessFindingState::Resolved
                )
            })
            .map(|d| (d.key, (d.state, d.decided_at_ms)))
            .collect();
        Ok(self
            .db
            .defects(workspace)?
            .into_iter()
            .map(|row| {
                let decision = decisions.get(&row.key);
                let (state, decided_at_ms, recurred) = match decision {
                    Some((state, at)) if *at >= row.last_seen_ms => (*state, Some(*at), false),
                    Some(_) => (proto::HarnessFindingState::Open, None, true),
                    None => (proto::HarnessFindingState::Open, None, false),
                };
                proto::SuspectedDefect {
                    workspace: row.workspace,
                    key: row.key,
                    title: row.title,
                    source: row.source,
                    detector: row.detector,
                    evidence: row.evidence,
                    destination: row.destination,
                    count: row.count,
                    first_seen_ms: row.first_seen_ms,
                    last_seen_ms: row.last_seen_ms,
                    state,
                    recurred,
                    issue_url: row.issue_url,
                    decided_at_ms,
                }
            })
            .collect())
    }

    pub fn suspected_defects_reply(&self, workspace: &str) -> Result<proto::ServerMsg> {
        Ok(proto::ServerMsg::SuspectedDefects {
            workspace: workspace.to_string(),
            defects: self.suspected_defect_rows(workspace)?,
        })
    }

    pub fn defect_decide(
        &self,
        workspace: &str,
        key: &str,
        decision: proto::DefectDecision,
    ) -> Result<()> {
        if !self.db.defect_exists(workspace, key)? {
            bail!("no suspected defect with key {key:?} in {workspace}");
        }
        let now = now_unix_ms();
        match decision {
            proto::DefectDecision::Dismiss => self.db.set_harness_decision_by(
                workspace,
                key,
                proto::HarnessFindingState::Dismissed,
                now,
                "user",
            )?,
            proto::DefectDecision::NotABug => self.db.set_harness_decision_by(
                workspace,
                key,
                proto::HarnessFindingState::Dismissed,
                now,
                "not_a_bug",
            )?,
            proto::DefectDecision::Reopen => self.db.set_harness_decision_by(
                workspace,
                key,
                proto::HarnessFindingState::Open,
                now,
                "user",
            )?,
        }
        self.broadcast_defects(workspace);
        Ok(())
    }

    /// A row changed: refresh the view, and announce the first undecided defect
    /// of the UTC day once.
    pub(super) fn note_defect_recorded(&self, workspace: &str, _record: &crate::db::DefectRecord) {
        self.broadcast_defects(workspace);
        if let Err(e) = self.maybe_defect_notice(workspace) {
            tracing::warn!("suspected defects: notice for {workspace}: {e:#}");
        }
    }

    fn broadcast_defects(&self, workspace: &str) {
        match self.suspected_defects_reply(workspace) {
            Ok(msg) => self.broadcast_control(&msg),
            Err(e) => tracing::warn!("suspected defects: reading {workspace}: {e:#}"),
        }
    }

    fn maybe_defect_notice(&self, workspace: &str) -> Result<()> {
        let undecided: Vec<proto::SuspectedDefect> = self
            .suspected_defect_rows(workspace)?
            .into_iter()
            .filter(|d| d.state == proto::HarnessFindingState::Open)
            .collect();
        let Some(latest) = undecided.first() else {
            return Ok(());
        };
        let day = crate::daemon::defect_detectors::utc_day(now_unix_ms());
        let key = format!("defect_notice_day:{workspace}");
        if self.db.get_setting(&key)?.as_deref() == Some(day.as_str()) {
            return Ok(());
        }
        self.db.set_setting(&key, &day)?;
        self.broadcast_control(&proto::ServerMsg::DefectNotice {
            workspace: workspace.to_string(),
            count: u32::try_from(undecided.len()).unwrap_or(u32::MAX),
            title: latest.title.clone(),
        });
        Ok(())
    }

    /// The draft is read-only: one duplicate search and the account lookup, no
    /// issue. The title and body are redacted and bounded; the user edits them.
    pub fn defect_issue_draft(
        &self,
        workspace: &str,
        key: &str,
        request: u32,
    ) -> Result<proto::ServerMsg> {
        let row = self
            .db
            .defect(workspace, key)?
            .ok_or_else(|| anyhow!("no suspected defect with key {key:?} in {workspace}"))?;
        let repository = self.issue_destination(workspace, row.destination)?;
        let title = self.issue_title(&row, workspace);
        let body = self.issue_body(&row, workspace);
        let account = crate::gh::configured_login(Path::new(workspace));
        let now = now_unix_ms();
        // The duplicate search leaves the machine, so it sees the same redacted
        // words the draft does, never a value the title happens to carry.
        let query = search_words(&defect_redaction::redact_here(
            &self.env(),
            &row.title,
            workspace,
        ));
        let mut duplicates = Vec::new();
        let mut note = None;
        if let Some(until) = self.pr_reads.paused_until(now) {
            note = Some(search_pause_note(until));
        } else {
            match crate::gh::search_open_issues(
                Path::new(workspace),
                &repository,
                &query,
                proto::DEFECT_ISSUE_DUPLICATES_MAX,
            ) {
                Ok(items) => {
                    duplicates = items
                        .into_iter()
                        .take(usize::try_from(proto::DEFECT_ISSUE_DUPLICATES_MAX).unwrap_or(10))
                        .map(|item| proto::DefectIssueMatch {
                            number: item.number,
                            title: defect_redaction::redact_here(
                                &self.env(),
                                &item.title,
                                workspace,
                            ),
                            url: item.url,
                        })
                        .collect();
                }
                Err(e) => {
                    let text = format!("{e:#}");
                    if crate::gh::is_rate_limited(&text) {
                        let until = self.pr_reads.pause(now, &text, || {
                            crate::gh::rate_limit_reset(Path::new(workspace), now)
                        });
                        note = Some(search_pause_note(until));
                    } else {
                        note = Some(format!("the duplicate search did not run: {text}"));
                    }
                }
            }
        }
        let account_label = account
            .clone()
            .unwrap_or_else(|| "your signed-in gh account".to_string());
        let transmits = format!(
            "Sending this issue sends the title and body above to github.com/{repository} as {account_label}. The duplicate search asked github.com/{repository} for open issues matching {query:?}. Nothing else leaves this machine."
        );
        Ok(proto::ServerMsg::DefectIssueDraft {
            workspace: workspace.to_string(),
            key: key.to_string(),
            request,
            destination: row.destination,
            destination_repo: repository,
            account,
            title,
            body,
            transmits,
            duplicates,
            note,
        })
    }

    /// The only message that creates an issue or a comment. The title and body
    /// are redacted again here, whatever the client sent.
    #[allow(clippy::too_many_arguments)]
    pub fn defect_issue_file(
        &self,
        workspace: &str,
        key: &str,
        request: u32,
        title: &str,
        body: &str,
        destination_repo: &str,
        comment_on: Option<u32>,
    ) -> Result<proto::ServerMsg> {
        let row = self
            .db
            .defect(workspace, key)?
            .ok_or_else(|| anyhow!("no suspected defect with key {key:?} in {workspace}"))?;
        let expected = self.issue_destination(workspace, row.destination)?;
        let repository = destination_repo.trim();
        let (owner, name) = crate::gh::split_repository(repository).ok_or_else(|| {
            anyhow!(
                "destination_repo {destination_repo:?} is not `owner/name`; refusing to file the issue"
            )
        })?;
        let repository = format!("{owner}/{name}");
        if !repository.eq_ignore_ascii_case(&expected) {
            bail!(
                "destination_repo {repository:?} is not this defect's repository {expected:?}; refusing to file the issue"
            );
        }
        let title = defect_redaction::redact_here(&self.env(), title.trim(), workspace);
        let body = defect_redaction::redact_here(&self.env(), body.trim(), workspace);
        let title_max = usize::try_from(proto::DEFECT_ISSUE_TITLE_MAX).unwrap_or(256);
        let body_max = usize::try_from(proto::DEFECT_ISSUE_BODY_MAX).unwrap_or(60_000);
        let title_len = title.chars().count();
        let body_len = body.chars().count();
        if title_len == 0 || title_len > title_max {
            bail!(
                "defect_issue_file refused: title has {title_len} characters; expected 1..={title_max}"
            );
        }
        if body_len == 0 || body_len > body_max {
            bail!(
                "defect_issue_file refused: body has {body_len} characters; expected 1..={body_max}"
            );
        }
        let dir = Path::new(workspace);
        let (number, issue_url, note) = match comment_on {
            Some(number) => {
                let url = crate::gh::issue_comment(dir, &repository, number, &body)
                    .with_context(|| format!("commenting on {repository}#{number}"))?;
                (number, url, Some(format!("Commented on #{number}")))
            }
            None => {
                let (number, url) = crate::gh::issue_create(dir, &repository, &title, &body)
                    .with_context(|| format!("filing an issue in {repository}"))?;
                (number, url, None)
            }
        };
        self.db.set_defect_issue_url(workspace, key, &issue_url)?;
        self.db.set_harness_decision_by(
            workspace,
            key,
            proto::HarnessFindingState::Resolved,
            now_unix_ms(),
            "filed",
        )?;
        self.broadcast_defects(workspace);
        Ok(proto::ServerMsg::DefectIssueFiled {
            workspace: workspace.to_string(),
            key: key.to_string(),
            request,
            number,
            issue_url,
            note,
        })
    }

    fn issue_destination(
        &self,
        workspace: &str,
        destination: proto::DefectDestination,
    ) -> Result<String> {
        match destination {
            proto::DefectDestination::Houston => Ok(crate::updates::HOUSTON_REPOSITORY.to_string()),
            proto::DefectDestination::Workspace => {
                crate::forge::issue_repository(Path::new(workspace))
            }
        }
    }

    fn issue_title(&self, row: &DefectRow, workspace: &str) -> String {
        let scope = row.detector.as_deref().unwrap_or("harness");
        let raw = defect_redaction::redact_here(&self.env(), row.title.trim(), workspace);
        let title = if is_conventional(&raw) {
            raw
        } else {
            format!("fix({scope}): {raw}")
        };
        clip_chars(
            &title,
            usize::try_from(proto::DEFECT_ISSUE_TITLE_MAX).unwrap_or(256),
        )
    }

    fn issue_body(&self, row: &DefectRow, workspace: &str) -> String {
        let provenance = match (row.source, row.detector.as_deref()) {
            (proto::DefectSource::Detector, Some(detector)) => {
                format!("Detected by Houston's `{detector}` detector.")
            }
            _ => "Reported by an agent pane through `pane_report finding`.".to_string(),
        };
        let description = if row.description.trim().is_empty() {
            row.title.clone()
        } else {
            row.description.clone()
        };
        let mut body = format!("{description}\n\n## Evidence\n");
        if row.evidence.is_empty() {
            body.push_str("- none recorded\n");
        } else {
            for item in &row.evidence {
                body.push_str(&format!("- {item}\n"));
            }
        }
        body.push_str(&format!(
            "\n{provenance} Seen {} time{}; first seen {} and last seen {}.\n\n---\nFiled from Houston's suspected-defect review with a redacted draft.\n",
            row.count,
            if row.count == 1 { "" } else { "s" },
            utc_minute(row.first_seen_ms),
            utc_minute(row.last_seen_ms)
        ));
        let redacted = defect_redaction::redact_here(&self.env(), &body, workspace);
        clip_chars(
            &redacted,
            usize::try_from(proto::DEFECT_ISSUE_BODY_MAX).unwrap_or(60_000),
        )
    }
}

/// A rate-limit pause is shared with the pull request reads, but this drawer is
/// about the one duplicate search it would have made.
fn search_pause_note(until_ms: i64) -> String {
    format!(
        "GitHub rate limit reached; the duplicate search is paused until {}. No duplicates \
         are listed, and the draft can still be filed.",
        crate::usage::time::local_clock_from_ms(until_ms)
    )
}

/// A stored timestamp as the issue body reads it: UTC minutes, no raw epoch.
fn utc_minute(ms: i64) -> String {
    let rfc = crate::usage::time::format_rfc3339_utc(u64::try_from(ms.max(0)).unwrap_or(0));
    let stamp = rfc.get(..16).unwrap_or(&rfc).replace('T', " ");
    format!("{stamp} UTC")
}

fn is_conventional(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    [
        "feat(",
        "fix(",
        "chore(",
        "docs(",
        "refactor(",
        "test(",
        "perf(",
        "build(",
        "ci(",
        "revert(",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
        || [
            "feat:",
            "fix:",
            "chore:",
            "docs:",
            "refactor:",
            "test:",
            "perf:",
            "build:",
            "ci:",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let end = text
        .char_indices()
        .nth(max.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    format!("{}…", &text[..end])
}

/// Up to six significant title words, with the conventional prefix removed, so
/// `gh search issues` looks for the same defect rather than the verb.
fn search_words(title: &str) -> String {
    let title = title.trim();
    let subject = match (title.find(':'), title.find('(')) {
        (Some(colon), Some(open)) if open < colon => title[colon + 1..].trim(),
        (Some(colon), _) if colon < 20 => title[colon + 1..].trim(),
        _ => title,
    };
    let words: Vec<&str> = subject
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|word| word.chars().count() >= 4)
        .take(6)
        .collect();
    if words.is_empty() {
        subject
            .split_whitespace()
            .take(3)
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        words.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_becomes_a_conventional_issue_title_once() {
        assert!(is_conventional("fix(defects): a thing"));
        assert!(!is_conventional("A thing broke"));
        assert_eq!(
            search_words("fix(defects): worker re-asked the same question"),
            "worker re-asked same question"
        );
        assert_eq!(search_words("A thing broke"), "thing broke");
    }

    #[test]
    fn timestamps_read_as_utc_minutes() {
        assert_eq!(utc_minute(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc_minute(1_792_936_078_000), "2026-10-25 13:47 UTC");
    }

    #[test]
    fn clipping_is_utf8_safe() {
        assert_eq!(clip_chars("hello", 10), "hello");
        assert_eq!(clip_chars("héllo", 3), "hé…");
    }
}

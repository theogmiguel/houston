//! Proof of done: what a handback records on its run beyond the summary — the
//! pull request, the pushed commit, the verification commands that ran with
//! their trimmed output, an optional capture and what becomes permanent.
use std::path::Path;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;
use serde::Deserialize;

use super::tasks::pr_watch_number;
use super::Daemon;

const PR_WATCH_ACTOR: &str = "houston:pr-watch";

/// The run a proof landed on, and the note for missing verification.
pub(crate) type ProofOutcome = (Option<(i64, TaskProof)>, Option<String>);

/// What an agent hands back as evidence; every field is optional on the wire
/// and checked by `TaskProofInput::normalized`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskProofInput {
    /// A pull request number or URL.
    #[serde(default, deserialize_with = "string_or_number")]
    pub pr: Option<String>,
    #[serde(default)]
    pub pushed_sha: Option<String>,
    #[serde(default)]
    pub verification: Vec<proto::TaskVerification>,
    #[serde(default)]
    pub capture_path: Option<String>,
    #[serde(default)]
    pub permanent: Vec<String>,
}

fn string_or_number<'de, D>(d: D) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Option::<serde_json::Value>::deserialize(d)? {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        Some(other) => {
            return Err(serde::de::Error::custom(format!(
                "pr must be a pull request number or URL, got {other}"
            )))
        }
    })
}

/// The normalized proof, ready to store on the run.
pub struct TaskProof {
    pub pr_number: Option<u32>,
    pub pr_url: Option<String>,
    pub pushed_sha: Option<String>,
    pub evidence: proto::TaskRunEvidence,
}

impl TaskProof {
    pub fn is_empty(&self) -> bool {
        self.pr_number.is_none()
            && self.pushed_sha.is_none()
            && self.evidence.verification.is_empty()
            && self.evidence.capture_path.is_none()
            && self.evidence.permanent.is_empty()
    }
}

/// The command an acceptance item carries in backticks, which makes it
/// executable: the agent runs it and hands back its result.
pub(crate) fn acceptance_command(text: &str) -> Option<&str> {
    let start = text.find('`')? + 1;
    let len = text[start..].find('`')?;
    // Spaces only, as SQL `trim` does, so the ready query and this agree.
    Some(text[start..start + len].trim_matches(' ')).filter(|c| !c.is_empty())
}

/// Keeps the tail of a long output, where a failure usually is, and says
/// how much was dropped.
fn trim_output(output: &str) -> String {
    let output = crate::sanitize::redact_secrets(output.trim()).0;
    let max = proto::TASK_VERIFICATION_OUTPUT_MAX_BYTES;
    if output.len() <= max {
        return output;
    }
    let mut start = output.len() - max;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    format!("[{} earlier bytes trimmed]\n{}", start, &output[start..])
}

fn check_len(field: &str, value: &str, max: usize) -> Result<()> {
    if value.len() > max {
        bail!(
            "task_handback evidence: {field} is {} bytes, over the {max}-byte limit; shorten it",
            value.len()
        );
    }
    Ok(())
}

const PROOF_SHAPE: &str = "expected evidence {pr?: number or URL, pushed_sha?: hex commit, \
     verification: [{command, output, passed}], capture_path?: file, permanent?: [text]}";

impl TaskProofInput {
    /// Trims and bounds every field, resolving `capture_path` against the
    /// run's worktree. Refusals name the field, its size and the limit.
    pub fn normalized(self, worktree: Option<&Path>) -> Result<TaskProof> {
        let (pr_number, pr_url) = match self.pr.as_deref().map(str::trim) {
            None | Some("") => (None, None),
            Some(raw) => {
                let number = pr_watch_number(raw).map_err(|e| {
                    anyhow!("task_handback evidence: pr {raw:?}: {e:#}; {PROOF_SHAPE}")
                })?;
                let url = raw.contains("://").then(|| raw.to_string());
                (Some(number), url)
            }
        };
        let pushed_sha = match self.pushed_sha.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(sha) => {
                if !(7..=64).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                    bail!(
                        "task_handback evidence: pushed_sha {sha:?} is not a commit id (expected \
                         7 to 64 hex digits)"
                    );
                }
                Some(sha.to_ascii_lowercase())
            }
        };
        if self.verification.len() > proto::TASK_VERIFICATIONS_MAX {
            bail!(
                "task_handback evidence: {} verification entries, over the limit of {}",
                self.verification.len(),
                proto::TASK_VERIFICATIONS_MAX
            );
        }
        let mut verification = Vec::with_capacity(self.verification.len());
        for entry in self.verification {
            let command = entry.command.trim().to_string();
            if command.is_empty() {
                bail!("task_handback evidence: a verification entry has no command; {PROOF_SHAPE}");
            }
            check_len(
                "verification command",
                &command,
                proto::TASK_PROOF_TEXT_MAX_BYTES,
            )?;
            verification.push(proto::TaskVerification {
                command: crate::sanitize::redact_secrets(&command).0,
                output: trim_output(&entry.output),
                passed: entry.passed,
            });
        }
        if self.permanent.len() > proto::TASK_VERIFICATIONS_MAX {
            bail!(
                "task_handback evidence: {} permanent entries, over the limit of {}",
                self.permanent.len(),
                proto::TASK_VERIFICATIONS_MAX
            );
        }
        let mut permanent = Vec::new();
        for item in self.permanent {
            let item = item.trim().to_string();
            if item.is_empty() {
                continue;
            }
            check_len("permanent entry", &item, proto::TASK_PROOF_TEXT_MAX_BYTES)?;
            permanent.push(crate::sanitize::redact_secrets(&item).0);
        }
        let capture_path = match self.capture_path.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => {
                let path = Path::new(raw);
                let path = match (path.is_absolute(), worktree) {
                    (true, _) | (false, None) => path.to_path_buf(),
                    (false, Some(root)) => root.join(path),
                };
                let resolved = path.canonicalize().ok().filter(|p| p.is_file());
                let Some(resolved) = resolved else {
                    bail!(
                        "task_handback evidence: capture_path {} is not a file (expected a \
                         screenshot or recording the agent saved)",
                        path.display()
                    );
                };
                if let Some(root) = worktree.and_then(|w| w.canonicalize().ok()) {
                    if !resolved.starts_with(&root) {
                        bail!(
                            "task_handback evidence: capture_path {} is outside the task's \
                             worktree {} (expected a file the agent saved there)",
                            resolved.display(),
                            root.display()
                        );
                    }
                }
                Some(resolved.display().to_string())
            }
        };
        Ok(TaskProof {
            pr_number,
            pr_url,
            pushed_sha,
            evidence: proto::TaskRunEvidence {
                verification,
                capture_path,
                permanent,
            },
        })
    }
}

impl Daemon {
    /// Stores the proof on the open run held by `session`. The second value
    /// is the note a handback carries when executable acceptance items got
    /// no verification: the reviewer sees the missing proof by name.
    pub(crate) fn task_record_proof(
        &self,
        id: i64,
        session: u32,
        input: Option<TaskProofInput>,
    ) -> Result<ProofOutcome> {
        let run = self
            .db
            .open_task_run_for_task(id)?
            .filter(|run| run.session_id == Some(session));
        let worktree = run
            .as_ref()
            .and_then(|r| r.worktree_path.as_deref())
            .map(Path::new);
        let proof = input.unwrap_or_default().normalized(worktree)?;
        let commands: Vec<String> = self
            .db
            .task_acceptance(id)?
            .iter()
            .filter_map(|item| acceptance_command(&item.text).map(str::to_string))
            .collect();
        let missing = (!commands.is_empty() && proof.evidence.verification.is_empty()).then(|| {
            format!(
                "[no verification] the acceptance list has {} executable item(s) ({}) and the \
                 handback reported no verification",
                commands.len(),
                commands
                    .iter()
                    .map(|c| format!("`{c}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        });
        let Some(run) = run else {
            return Ok((None, missing));
        };
        if proof.is_empty() {
            return Ok((None, missing));
        }
        self.db.task_run_set_proof(
            run.id,
            proof.pr_number,
            proof.pr_url.as_deref(),
            proof.pushed_sha.as_deref(),
            &serde_json::to_string(&proof.evidence)?,
        )?;
        Ok((Some((run.id, proof)), missing))
    }

    /// Registers the PR watch a handback names, off the caller's thread since
    /// it reads the pull request through `gh`. A failure is a task comment.
    pub(crate) fn task_watch_handback_pr(&self, id: i64, session: u32, pr: u32) {
        let Some(daemon) = self.self_arc() else {
            return;
        };
        std::thread::spawn(move || {
            if let Err(e) = daemon.pr_watch_start(session, &pr.to_string()) {
                let _ = daemon.task_comment_as(
                    None,
                    id,
                    &format!("PR watch for #{pr} was not registered: {e:#}"),
                    PR_WATCH_ACTOR,
                    "task_handback",
                );
            }
        });
    }
}

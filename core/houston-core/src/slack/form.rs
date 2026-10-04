//! The fields an agent fills for a Slack-filed task. Houston lays them out in
//! Block Kit; the limits keep each one readable in a thread and inside Slack's
//! own text caps.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// One sentence of context before the question.
pub const QUESTION_CONTEXT_MAX: usize = 500;
pub const QUESTION_TEXT_MAX: usize = 300;
/// Each option is a section beside its own button, so it can be a full phrase.
pub const QUESTION_OPTION_MAX: usize = 200;
pub const QUESTION_OPTIONS_MIN: usize = 2;
pub const QUESTION_OPTIONS_MAX: usize = 4;

/// `hs-task ask` / `task_ask`: `recommended` is the 1-based option the agent
/// would pick.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionForm {
    #[serde(default)]
    pub context: Option<String>,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub recommended: Option<usize>,
}

fn check_len(field: &str, value: &str, max: usize, operation: &str) -> Result<()> {
    let n = value.chars().count();
    if n > max {
        bail!("{operation}: {field} is {n} characters, over the {max}-character limit; shorten it");
    }
    Ok(())
}

const ASK_SHAPE: &str = "expected `hs-task ask --context \"one sentence\" --question \"…\" \
     --option \"…\" --option \"…\" [--option …] --recommended N`";

impl QuestionForm {
    /// Trims every field and refuses a form that does not fit, naming the
    /// field, its size and the limit.
    pub fn normalized(mut self) -> Result<Self> {
        let op = "task_ask";
        self.question = self.question.trim().to_string();
        self.context = self
            .context
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        self.options = self
            .options
            .into_iter()
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect();
        if self.question.is_empty() {
            bail!("{op} needs a question (got an empty one); {ASK_SHAPE}");
        }
        check_len("the question", &self.question, QUESTION_TEXT_MAX, op)?;
        if let Some(c) = &self.context {
            check_len("the context", c, QUESTION_CONTEXT_MAX, op)?;
        }
        let n = self.options.len();
        if !(QUESTION_OPTIONS_MIN..=QUESTION_OPTIONS_MAX).contains(&n) {
            bail!(
                "{op}: {n} options given, expected {QUESTION_OPTIONS_MIN} to \
                 {QUESTION_OPTIONS_MAX}; the requester picks one or answers in their own words; \
                 {ASK_SHAPE}"
            );
        }
        for (i, o) in self.options.iter().enumerate() {
            check_len(&format!("option {}", i + 1), o, QUESTION_OPTION_MAX, op)?;
        }
        match self.recommended {
            Some(r) if (1..=n).contains(&r) => {}
            Some(r) => bail!("{op}: --recommended {r} names no option (expected 1 to {n})"),
            None => bail!(
                "{op}: mark the option you recommend with --recommended N (1 to {n}); {ASK_SHAPE}"
            ),
        }
        Ok(self)
    }
}

/// The subject names the request everywhere outside the thread, so it fits
/// one line of a direct message.
pub const RESULT_SUBJECT_MAX: usize = 60;
pub const RESULT_CHANGES_MAX: usize = 1_500;
pub const RESULT_STEPS_MAX: usize = 3;
pub const RESULT_STEP_MAX: usize = 300;
pub const RESULT_CAVEATS_MAX: usize = 600;
pub const RESULT_NOTE_MAX: usize = 500;
/// Owner-only facts and warnings: a short line each, a handful per run.
pub const RESULT_OWNER_LINES_MAX: usize = 6;
pub const RESULT_OWNER_LINE_MAX: usize = 200;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    #[default]
    Ready,
    /// Triage refused the request: `changes` says why and what would make it
    /// executable; nothing was pushed.
    Refused,
}

/// The agent's own size category. Only `small` carries information Houston
/// cannot compute: the repository's rule for a small change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Size {
    Small,
    Medium,
    Large,
}

/// `hs-task handback` for a Slack-filed task. The requester reads `subject`
/// through `caveats` in the thread and one of the two notes when the task
/// closes; `notes` and `warnings` go to the owner only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultForm {
    #[serde(default)]
    pub outcome: Outcome,
    pub subject: String,
    pub changes: String,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub caveats: Option<String>,
    #[serde(default)]
    pub live_note: Option<String>,
    #[serde(default)]
    pub dropped_note: Option<String>,
    #[serde(default)]
    pub size: Option<Size>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// What must be fixed before merging (red gates, a failed verifier, a
    /// conflict); the owner reads these first.
    #[serde(default)]
    pub blockers: Vec<String>,
}

const HANDBACK_SHAPE: &str = "expected `hs-task handback --subject \"…\" --changes \"…\" \
     --step \"…\" [--step …] [--caveats \"…\"] --live-note \"…\" --dropped-note \"…\" \
     [--size small|medium|large] [--note \"…\"] [--warning \"…\"] [--blocker \"…\"]`, or `--refused --subject \
     \"…\" --changes \"why, and what would make it executable\"`";

fn trimmed(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn trimmed_all(v: Vec<String>) -> Vec<String> {
    v.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

impl ResultForm {
    pub fn normalized(mut self) -> Result<Self> {
        let op = "task_handback";
        self.subject = self.subject.trim().to_string();
        self.changes = self.changes.trim().to_string();
        self.steps = trimmed_all(self.steps);
        self.caveats = trimmed(self.caveats);
        self.live_note = trimmed(self.live_note);
        self.dropped_note = trimmed(self.dropped_note);
        self.notes = trimmed_all(self.notes);
        self.warnings = trimmed_all(self.warnings);
        self.blockers = trimmed_all(self.blockers);
        if self.subject.is_empty() || self.changes.is_empty() {
            bail!("{op} needs --subject and --changes for a Slack-filed task; {HANDBACK_SHAPE}");
        }
        check_len("the subject", &self.subject, RESULT_SUBJECT_MAX, op)?;
        check_len("--changes", &self.changes, RESULT_CHANGES_MAX, op)?;
        if self.steps.len() > RESULT_STEPS_MAX {
            bail!(
                "{op}: {} steps given, over the limit of {RESULT_STEPS_MAX}; keep the ones a \
                 person needs to see the change",
                self.steps.len()
            );
        }
        for (i, step) in self.steps.iter().enumerate() {
            check_len(&format!("step {}", i + 1), step, RESULT_STEP_MAX, op)?;
        }
        if let Some(c) = &self.caveats {
            check_len("--caveats", c, RESULT_CAVEATS_MAX, op)?;
        }
        for (name, note) in [
            ("--live-note", &self.live_note),
            ("--dropped-note", &self.dropped_note),
        ] {
            if let Some(n) = note {
                check_len(name, n, RESULT_NOTE_MAX, op)?;
            }
        }
        if self.outcome == Outcome::Ready {
            if self.steps.is_empty() {
                bail!("{op}: give at least one --step saying how to see the change once it is live; {HANDBACK_SHAPE}");
            }
            if self.live_note.is_none() || self.dropped_note.is_none() {
                bail!("{op}: give --live-note (posted when the task is Done) and --dropped-note (posted when it is Canceled); {HANDBACK_SHAPE}");
            }
        }
        for (name, lines) in [
            ("--note", &self.notes),
            ("--warning", &self.warnings),
            ("--blocker", &self.blockers),
        ] {
            if lines.len() > RESULT_OWNER_LINES_MAX {
                bail!(
                    "{op}: {} {name} lines given, over the limit of {RESULT_OWNER_LINES_MAX}",
                    lines.len()
                );
            }
            for line in lines.iter() {
                check_len(name, line, RESULT_OWNER_LINE_MAX, op)?;
            }
        }
        Ok(self)
    }

    /// The task comment: the same fields, in Houston's own (English) labels.
    pub fn summary(&self) -> String {
        let mut out = format!("{}\n\n{}", self.subject, self.changes);
        if !self.steps.is_empty() {
            out.push_str("\n\nHow to check:");
            for (i, step) in self.steps.iter().enumerate() {
                out.push_str(&format!("\n{}. {step}", i + 1));
            }
        }
        for (label, value) in [
            ("Caveats", &self.caveats),
            ("Live note", &self.live_note),
            ("Dropped note", &self.dropped_note),
        ] {
            if let Some(v) = value {
                out.push_str(&format!("\n\n{label}: {v}"));
            }
        }
        for line in self
            .blockers
            .iter()
            .chain(&self.notes)
            .chain(&self.warnings)
        {
            out.push_str(&format!("\n- {line}"));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> QuestionForm {
        QuestionForm {
            context: Some("  A new block under the pipeline.  ".into()),
            question: "Which tiers?".into(),
            options: vec!["Up to 300k".into(), " ".into(), "Up to 250k".into()],
            recommended: Some(1),
        }
    }

    #[test]
    fn a_question_is_trimmed_and_needs_two_to_four_options_and_a_recommendation() {
        let ok = form().normalized().unwrap();
        assert_eq!(
            ok.context.as_deref(),
            Some("A new block under the pipeline.")
        );
        assert_eq!(ok.options, ["Up to 300k", "Up to 250k"]);

        let one = QuestionForm {
            options: vec!["only".into()],
            ..form()
        };
        let err = one.normalized().unwrap_err().to_string();
        assert!(err.contains("1 options given, expected 2 to 4"), "{err}");

        let err = QuestionForm {
            recommended: None,
            ..form()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(err.contains("--recommended N"), "{err}");

        let err = QuestionForm {
            recommended: Some(3),
            ..form()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("--recommended 3 names no option (expected 1 to 2)"),
            "{err}"
        );

        let err = QuestionForm {
            question: "q".repeat(QUESTION_TEXT_MAX + 1),
            ..form()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("the question is 301 characters, over the 300-character limit"),
            "{err}"
        );
    }

    fn result() -> ResultForm {
        ResultForm {
            subject: " Conversion by tier ".into(),
            changes: "A new block.".into(),
            steps: vec!["Open the dashboard.".into(), "".into()],
            live_note: Some("It is live.".into()),
            dropped_note: Some("It will not go ahead.".into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_result_needs_a_subject_steps_and_both_notes_unless_it_is_a_refusal() {
        let ok = result().normalized().unwrap();
        assert_eq!(ok.subject, "Conversion by tier");
        assert_eq!(ok.steps, ["Open the dashboard."]);
        assert!(ok
            .summary()
            .contains("How to check:\n1. Open the dashboard."));

        let err = ResultForm {
            live_note: None,
            ..result()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(err.contains("--live-note"), "{err}");

        let err = ResultForm {
            subject: "s".repeat(RESULT_SUBJECT_MAX + 1),
            ..result()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("the subject is 61 characters, over the 60-character limit"),
            "{err}"
        );

        let err = ResultForm {
            steps: vec!["a".into(), "b".into(), "c".into(), "d".into()],
            ..result()
        }
        .normalized()
        .unwrap_err()
        .to_string();
        assert!(err.contains("4 steps given, over the limit of 3"), "{err}");

        let refused = ResultForm {
            outcome: Outcome::Refused,
            subject: "Send a message to every client".into(),
            changes: "It sends messages; a person has to do it.".into(),
            ..Default::default()
        };
        assert!(refused.normalized().is_ok());
    }
}

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
}

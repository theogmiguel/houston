//! Claude's `AskUserQuestion` in a thread: its questions are checked before Houston holds
//! them, and the user's answers are checked before Claude reads them.
use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;
use serde_json::{Map, Value};

use super::threads::{ApprovalGuard, ASK_IN_REPLY};
use super::{Daemon, PermissionPrompt};
use crate::thread_session::{ApprovalAnswer, ThreadHandle};

pub(crate) const ASK_USER_QUESTION: &str = "AskUserQuestion";
/// The deny message Claude reads when the user skips its question.
pub(crate) const QUESTION_SKIPPED: &str = "The user skipped the question.";

/// The questions of a well-formed `AskUserQuestion` input, and whether a header or an
/// option description was cut. Questions and labels are never cut: answers name them.
pub(crate) fn parse_questions(input: &Value) -> Result<(Vec<proto::ThreadQuestion>, bool)> {
    let items = input
        .get("questions")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| anyhow!("\"questions\" must be a non-empty array"))?;
    if items.len() > proto::THREAD_QUESTIONS_MAX {
        bail!(
            "{} questions, over the limit of {} (THREAD_QUESTIONS_MAX)",
            items.len(),
            proto::THREAD_QUESTIONS_MAX
        );
    }
    let mut truncated = false;
    let mut seen = HashSet::new();
    let mut questions = Vec::with_capacity(items.len());
    for (at, item) in items.iter().enumerate() {
        let question = exact_text(item.get("question"), &format!("questions[{at}].question"))?;
        if !seen.insert(question.clone()) {
            bail!("question {question:?} is asked twice; answers name questions by their text");
        }
        let header = cut_text(item.get("header"), &mut truncated);
        let multi_select = item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let raw_options = item
            .get("options")
            .and_then(Value::as_array)
            .filter(|options| !options.is_empty())
            .ok_or_else(|| anyhow!("questions[{at}].options must be a non-empty array"))?;
        if raw_options.len() > proto::THREAD_QUESTION_OPTIONS_MAX {
            bail!(
                "question {question:?} has {} options, over the limit of {} \
                 (THREAD_QUESTION_OPTIONS_MAX)",
                raw_options.len(),
                proto::THREAD_QUESTION_OPTIONS_MAX
            );
        }
        let mut labels = HashSet::new();
        let mut options = Vec::with_capacity(raw_options.len());
        for (index, option) in raw_options.iter().enumerate() {
            let label = exact_text(
                option.get("label"),
                &format!("questions[{at}].options[{index}].label"),
            )?;
            if !labels.insert(label.clone()) {
                bail!("question {question:?} offers the option {label:?} twice");
            }
            let description = cut_text(option.get("description"), &mut truncated);
            options.push(proto::ThreadQuestionOption { label, description });
        }
        questions.push(proto::ThreadQuestion {
            question,
            header,
            options,
            multi_select,
        });
    }
    Ok((questions, truncated))
}

fn exact_text(value: Option<&Value>, field: &str) -> Result<String> {
    let text = value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| anyhow!("{field} must be a non-empty string"))?;
    if text.len() > proto::THREAD_QUESTION_TEXT_MAX_BYTES {
        bail!(
            "{field} is {} bytes, over the limit of {} (THREAD_QUESTION_TEXT_MAX_BYTES)",
            text.len(),
            proto::THREAD_QUESTION_TEXT_MAX_BYTES
        );
    }
    Ok(text.to_string())
}

fn cut_text(value: Option<&Value>, truncated: &mut bool) -> String {
    let text = value.and_then(Value::as_str).unwrap_or_default();
    if text.len() <= proto::THREAD_QUESTION_TEXT_MAX_BYTES {
        return text.to_string();
    }
    *truncated = true;
    let mut end = proto::THREAD_QUESTION_TEXT_MAX_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Answers checked against their questions: in question order, for `question_resolved`,
/// and as Claude's `answers` map (question text to the labels joined with ", ", then
/// the user's own text).
#[derive(Debug, PartialEq)]
pub(crate) struct CheckedAnswers {
    pub answers: Vec<proto::QuestionAnswer>,
    pub map: Map<String, Value>,
}

pub(crate) fn check_answers(
    questions: &[proto::ThreadQuestion],
    answers: &[proto::QuestionAnswer],
) -> Result<CheckedAnswers> {
    let asked = || {
        questions
            .iter()
            .map(|q| q.question.as_str())
            .collect::<Vec<_>>()
    };
    for answer in answers {
        if !questions.iter().any(|q| q.question == answer.question) {
            bail!(
                "the answer for {:?} names no question of this request (questions: {:?})",
                answer.question,
                asked()
            );
        }
    }
    let mut checked = CheckedAnswers {
        answers: Vec::with_capacity(questions.len()),
        map: Map::new(),
    };
    for question in questions {
        let mut given = answers.iter().filter(|a| a.question == question.question);
        let answer = given.next().ok_or_else(|| {
            anyhow!(
                "question {:?} has no answer; answer every question (questions: {:?}) or skip",
                question.question,
                asked()
            )
        })?;
        if given.next().is_some() {
            bail!("question {:?} is answered twice", question.question);
        }
        let labels: Vec<&str> = question.options.iter().map(|o| o.label.as_str()).collect();
        let mut selected: Vec<String> = Vec::with_capacity(answer.selected.len());
        for label in &answer.selected {
            if !labels.contains(&label.as_str()) {
                bail!(
                    "{label:?} is not an option of question {:?} (options: {labels:?})",
                    question.question
                );
            }
            if selected.contains(label) {
                bail!(
                    "{label:?} is chosen twice for question {:?}",
                    question.question
                );
            }
            selected.push(label.clone());
        }
        let other = answer
            .other
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        if let Some(text) = other {
            if text.len() > proto::THREAD_QUESTION_OTHER_MAX_BYTES {
                bail!(
                    "the typed answer to question {:?} is {} bytes, over the limit of {} \
                     (THREAD_QUESTION_OTHER_MAX_BYTES)",
                    question.question,
                    text.len(),
                    proto::THREAD_QUESTION_OTHER_MAX_BYTES
                );
            }
        }
        let choices = selected.len() + usize::from(other.is_some());
        if choices == 0 {
            bail!(
                "question {:?} has an empty answer; choose an option or type one",
                question.question
            );
        }
        if !question.multi_select && choices > 1 {
            bail!(
                "question {:?} takes one answer; got {choices} (selected {selected:?}, \
                 typed {})",
                question.question,
                other.is_some()
            );
        }
        let mut parts: Vec<&str> = selected.iter().map(String::as_str).collect();
        parts.extend(other);
        checked
            .map
            .insert(question.question.clone(), Value::String(parts.join(", ")));
        checked.answers.push(proto::QuestionAnswer {
            question: question.question.clone(),
            selected,
            other: other.map(str::to_string),
        });
    }
    Ok(checked)
}

impl Daemon {
    /// Holds a well-formed question until the user answers or skips it. While the runtime
    /// cannot hold one, Claude is told to ask it in its reply instead.
    pub(super) fn hold_question(
        &self,
        handle: &Arc<ThreadHandle>,
        tool_use_id: &str,
        questions: Vec<proto::ThreadQuestion>,
        truncated: bool,
        input: Value,
    ) -> Result<(PermissionPrompt, Value)> {
        match runtime_hold_question(handle, tool_use_id, questions, truncated, &input) {
            Ok((request_id, receiver)) => Ok((
                PermissionPrompt::Held(
                    receiver,
                    ApprovalGuard {
                        handle: Arc::clone(handle),
                        request_id,
                    },
                ),
                input,
            )),
            Err(error) => Ok((
                PermissionPrompt::Answered(ApprovalAnswer::Deny(format!(
                    "{ASK_IN_REPLY}: {error}."
                ))),
                input,
            )),
        }
    }

    /// Answers or skips a question Houston holds for a thread; refused unless that request
    /// is a held question, and every answer must fit its question.
    pub fn thread_answer(
        &self,
        id: u32,
        request_id: &str,
        answers: Option<Vec<proto::QuestionAnswer>>,
    ) -> Result<()> {
        let handle = self.thread_handle(id, "thread_answer")?;
        runtime_answer_question(&handle, request_id, |questions, input| {
            let Some(answers) = &answers else {
                return Ok(QuestionResolution {
                    outcome: proto::QuestionOutcome::Skipped,
                    answers: Vec::new(),
                    reply: Err(QUESTION_SKIPPED.into()),
                });
            };
            let checked = check_answers(questions, answers)
                .map_err(|e| anyhow!("thread_answer refused for session {id}: {e}"))?;
            Ok(QuestionResolution {
                outcome: proto::QuestionOutcome::Answered,
                answers: checked.answers,
                reply: Ok(crate::mcp_thread_permission::answered_input(
                    input,
                    checked.map,
                )),
            })
        })
    }
}

/// How a held question ends: recorded as `question_resolved` with `answers`, and told to
/// Claude as an allow with this `updatedInput` (`Ok`) or a deny with this message (`Err`).
#[expect(
    dead_code,
    reason = "read by the thread runtime once it holds questions"
)]
pub(crate) struct QuestionResolution {
    pub outcome: proto::QuestionOutcome,
    pub answers: Vec<proto::QuestionAnswer>,
    pub reply: std::result::Result<Value, String>,
}

// STUB: the thread runtime gains held questions after its split; until then both calls
// below refuse through `no_question_runtime`.

/// Records `question_request` and holds the call like an approval (same pending cap and
/// NeedsInput status), returning its request id and the receiver its answer arrives on.
fn runtime_hold_question(
    handle: &Arc<ThreadHandle>,
    _tool_use_id: &str,
    _questions: Vec<proto::ThreadQuestion>,
    _truncated: bool,
    _input: &Value,
) -> Result<(String, tokio::sync::oneshot::Receiver<ApprovalAnswer>)> {
    Err(no_question_runtime(handle.session(), "AskUserQuestion", ""))
}

/// Resolves the held question `request_id` with what `resolve` makes of its questions and
/// Claude's input; the question stays held when `resolve` refuses, so it is answered once.
fn runtime_answer_question(
    handle: &Arc<ThreadHandle>,
    request_id: &str,
    _resolve: impl FnOnce(&[proto::ThreadQuestion], &Value) -> Result<QuestionResolution>,
) -> Result<()> {
    Err(no_question_runtime(
        handle.session(),
        "thread_answer",
        &format!("no held question {request_id:?}; "),
    ))
}

fn no_question_runtime(session: u32, verb: &str, detail: &str) -> anyhow::Error {
    anyhow!(
        "{verb} refused for session {session}: {detail}this daemon's thread runtime does not          hold questions yet"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn colour_input() -> Value {
        json!({"questions":[
            {"question":"Which colour do you prefer?","header":"Colour","multiSelect":false,
             "options":[{"label":"Red","description":"Choose red"},
                        {"label":"Blue","description":"Choose blue"}]},
            {"question":"Which fruits?","header":"Fruit","multiSelect":true,
             "options":[{"label":"Red berries","description":""},
                        {"label":"Green grapes","description":""}]}
        ]})
    }

    fn answer(question: &str, selected: &[&str], other: Option<&str>) -> proto::QuestionAnswer {
        proto::QuestionAnswer {
            question: question.into(),
            selected: selected.iter().map(|s| s.to_string()).collect(),
            other: other.map(str::to_string),
        }
    }

    #[test]
    fn a_captured_question_input_parses_into_cards() {
        let (questions, truncated) = parse_questions(&colour_input()).unwrap();
        assert!(!truncated);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].header, "Colour");
        assert!(!questions[0].multi_select);
        assert!(questions[1].multi_select);
        assert_eq!(questions[0].options[1].label, "Blue");
        assert_eq!(questions[0].options[1].description, "Choose blue");
    }

    #[test]
    fn malformed_question_inputs_are_refused_by_field() {
        for (input, needle) in [
            (json!({}), "\"questions\" must be a non-empty array"),
            (
                json!({"questions":[]}),
                "\"questions\" must be a non-empty array",
            ),
            (
                json!({"questions":[{"question":"Q","options":[]}]}),
                "questions[0].options must be a non-empty array",
            ),
            (
                json!({"questions":[{"question":"Q","options":[{"description":"d"}]}]}),
                "questions[0].options[0].label must be a non-empty string",
            ),
            (
                json!({"questions":[{"question":"Q","options":[{"label":"A"},{"label":"A"}]}]}),
                "offers the option \"A\" twice",
            ),
            (
                json!({"questions":[{"question":"Q","options":[{"label":"A"}]},
                                    {"question":"Q","options":[{"label":"B"}]}]}),
                "is asked twice",
            ),
        ] {
            let error = parse_questions(&input).unwrap_err().to_string();
            assert!(error.contains(needle), "{input}: {error}");
        }
        let many = json!({"questions": vec![json!({"question":"Q","options":[{"label":"A"}]}); proto::THREAD_QUESTIONS_MAX + 1]});
        assert!(parse_questions(&many)
            .unwrap_err()
            .to_string()
            .contains("THREAD_QUESTIONS_MAX"));
        let long = "x".repeat(proto::THREAD_QUESTION_TEXT_MAX_BYTES + 1);
        let error =
            parse_questions(&json!({"questions":[{"question":long,"options":[{"label":"A"}]}]}))
                .unwrap_err()
                .to_string();
        assert!(error.contains("THREAD_QUESTION_TEXT_MAX_BYTES"), "{error}");
    }

    #[test]
    fn long_descriptions_are_cut_and_marked() {
        let long = "é".repeat(proto::THREAD_QUESTION_TEXT_MAX_BYTES);
        let input = json!({"questions":[{"question":"Q","header":long,
            "options":[{"label":"A","description":long}]}]});
        let (questions, truncated) = parse_questions(&input).unwrap();
        assert!(truncated);
        assert!(questions[0].header.len() <= proto::THREAD_QUESTION_TEXT_MAX_BYTES);
        assert!(questions[0].options[0].description.len() <= proto::THREAD_QUESTION_TEXT_MAX_BYTES);
        assert_eq!(questions[0].options[0].label, "A");
    }

    #[test]
    fn answers_become_the_captured_answers_map() {
        let (questions, _) = parse_questions(&colour_input()).unwrap();
        let checked = check_answers(
            &questions,
            &[
                answer(
                    "Which fruits?",
                    &["Red berries", "Green grapes"],
                    Some("  plums "),
                ),
                answer("Which colour do you prefer?", &["Blue"], None),
            ],
        )
        .unwrap();
        assert_eq!(
            Value::Object(checked.map),
            json!({"Which colour do you prefer?":"Blue",
                   "Which fruits?":"Red berries, Green grapes, plums"})
        );
        assert_eq!(checked.answers[0].question, "Which colour do you prefer?");
        assert_eq!(checked.answers[1].other.as_deref(), Some("plums"));
        let typed = check_answers(
            &questions,
            &[
                answer("Which colour do you prefer?", &[], Some("Purple sunset")),
                answer("Which fruits?", &["Red berries"], None),
            ],
        )
        .unwrap();
        assert_eq!(typed.map["Which colour do you prefer?"], "Purple sunset");
    }

    #[test]
    fn answers_that_do_not_fit_their_questions_are_refused() {
        let (questions, _) = parse_questions(&colour_input()).unwrap();
        let colour = "Which colour do you prefer?";
        let fruit = answer("Which fruits?", &["Red berries"], None);
        for (answers, needle) in [
            (vec![fruit.clone()], "has no answer"),
            (
                vec![answer(colour, &["Purple"], None), fruit.clone()],
                "\"Purple\" is not an option",
            ),
            (
                vec![answer(colour, &["Red", "Blue"], None), fruit.clone()],
                "takes one answer; got 2",
            ),
            (
                vec![answer(colour, &["Red"], Some("teal")), fruit.clone()],
                "takes one answer; got 2",
            ),
            (
                vec![answer(colour, &[], Some("   ")), fruit.clone()],
                "has an empty answer",
            ),
            (
                vec![answer(colour, &["Red"], None), fruit.clone(), fruit.clone()],
                "is answered twice",
            ),
            (
                vec![
                    answer(colour, &["Red"], None),
                    answer("Which fruits?", &["Red berries", "Red berries"], None),
                ],
                "chosen twice",
            ),
            (
                vec![
                    answer(colour, &["Red"], None),
                    fruit.clone(),
                    answer("Which car?", &[], Some("x")),
                ],
                "names no question of this request",
            ),
        ] {
            let error = check_answers(&questions, &answers).unwrap_err().to_string();
            assert!(error.contains(needle), "{answers:?}: {error}");
        }
        let long = "x".repeat(proto::THREAD_QUESTION_OTHER_MAX_BYTES + 1);
        let error = check_answers(&questions, &[answer(colour, &[], Some(&long)), fruit])
            .unwrap_err()
            .to_string();
        assert!(error.contains("THREAD_QUESTION_OTHER_MAX_BYTES"), "{error}");
    }
}

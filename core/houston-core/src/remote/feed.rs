//! The conversation a paired device reads, built only from hook payloads: the hook
//! client lifts a masked, truncated summary into the drop file, and the daemon keeps
//! it in a bounded in-memory ring per session (docs/internals/invariants.md).
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use houston_protocol as proto;
use serde::{Deserialize, Serialize};

// A turn's reply is the largest entry; 16 KiB holds a long answer while a
// session's ring stays well under its byte cap.
pub const REPLY_MAX_BYTES: usize = 16 * 1024;
pub const PROMPT_MAX_BYTES: usize = 16 * 1024;
pub const SUMMARY_MAX_CHARS: usize = 300;
pub const STEP_MAX_CHARS: usize = 120;
pub const EXCERPT_MAX_CHARS: usize = 160;
pub const ENTRIES_PER_SESSION: usize = 200;
pub const BYTES_PER_SESSION: usize = 512 * 1024;
// Sixty-four busy panes at the per-session cap; past it the oldest entries of
// the largest ring go first.
pub const BYTES_TOTAL: usize = 32 * 1024 * 1024;
// AskUserQuestion allows at most four questions; options are answered by one
// digit each, so more than nine could not be chosen by key.
const QUESTIONS_MAX: usize = 4;
const OPTIONS_MAX: usize = 9;
// A tap that wrote keys blocks a second tap until the agent moves on or this
// passes, so a lost keystroke never leaves the card disabled for good.
pub const SENT_HOLD_MS: u64 = 10_000;

// A pause between the writes of one decision, so a TUI reads each as its own
// key event rather than one pasted chunk.
const SETTLE_MS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    #[serde(default)]
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// An option carries a preview pane; the CLI then moves focus on a digit
    /// and selects on Enter.
    #[serde(default)]
    pub previews: bool,
}

/// What the hook client lifts from one payload into the drop file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HookFeed {
    Prompt {
        text: String,
    },
    Question {
        #[serde(default)]
        tool_use_id: Option<String>,
        questions: Vec<Question>,
    },
    Answered {
        #[serde(default)]
        tool_use_id: Option<String>,
        answers: Vec<String>,
    },
    Permission {
        tool: String,
        target: String,
        #[serde(default)]
        always: bool,
    },
    Step {
        tool: String,
        target: String,
    },
}

fn cut_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn cut_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(3);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// One line: newlines and tabs become spaces, other controls are dropped.
fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\n' | '\r' | '\t' => {
                if !out.ends_with(' ') {
                    out.push(' ');
                }
            }
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

fn mask_text(s: &str) -> String {
    crate::sanitize::redact_secrets(s).0
}

fn mask_target(s: &str) -> String {
    crate::sanitize::redact_command_secrets(s).0
}

fn str_at<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|v| v.as_str())
}

/// The one value that says what a tool acts on: a command, a path, a URL or a
/// pattern. Anything else in the tool input stays out of the feed.
fn tool_target(input: Option<&serde_json::Value>, max: usize) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let command = match input.get("command").or_else(|| input.get("cmd")) {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(parts)) => Some(
            parts
                .iter()
                .filter_map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    };
    let raw = command.or_else(|| {
        [
            "file_path",
            "notebook_path",
            "path",
            "url",
            "pattern",
            "query",
            "description",
        ]
        .iter()
        .find_map(|k| str_at(input, k).map(str::to_string))
    });
    raw.map(|r| cut_chars(&one_line(&mask_target(&r)), max))
        .unwrap_or_default()
}

fn tool_name(v: &serde_json::Value) -> Option<String> {
    str_at(v, "tool_name")
        .or_else(|| str_at(v, "toolName"))
        .or_else(|| v.get("toolCall").and_then(|t| str_at(t, "name")))
        .map(|s| cut_chars(&one_line(s), 80))
        .filter(|s| !s.is_empty())
}

fn tool_input(v: &serde_json::Value) -> Option<&serde_json::Value> {
    v.get("tool_input")
        .or_else(|| v.get("toolInput"))
        .or_else(|| v.get("toolCall").and_then(|t| t.get("args")))
}

fn questions_from(input: Option<&serde_json::Value>) -> Vec<Question> {
    let Some(list) = input
        .and_then(|i| i.get("questions"))
        .and_then(|q| q.as_array())
    else {
        return Vec::new();
    };
    list.iter()
        .take(QUESTIONS_MAX)
        .filter_map(|q| {
            let question = str_at(q, "question")?;
            let options: Vec<&serde_json::Value> = q
                .get("options")
                .and_then(|o| o.as_array())
                .map(|o| o.iter().take(OPTIONS_MAX).collect())
                .unwrap_or_default();
            Some(Question {
                header: cut_chars(&mask_text(str_at(q, "header").unwrap_or("")), 40),
                question: cut_chars(&mask_text(question), SUMMARY_MAX_CHARS),
                previews: options.iter().any(|o| o.get("preview").is_some()),
                options: options
                    .iter()
                    .map(|o| QuestionOption {
                        label: cut_chars(&mask_text(str_at(o, "label").unwrap_or("")), 120),
                        description: cut_chars(
                            &mask_text(str_at(o, "description").unwrap_or("")),
                            SUMMARY_MAX_CHARS,
                        ),
                    })
                    .collect(),
                multi_select: q
                    .get("multiSelect")
                    .or_else(|| q.get("multi_select"))
                    .and_then(|m| m.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// The feed summary for one hook payload, or `None` when it carries nothing a
/// device shows. `prompt` is the payload's prompt when the event submits one.
pub fn from_hook(
    provider: proto::AgentKind,
    event: &str,
    payload: &str,
    prompt: Option<&str>,
) -> Option<HookFeed> {
    if let Some(text) = prompt.map(str::trim).filter(|p| !p.is_empty()) {
        return Some(HookFeed::Prompt {
            text: cut_bytes(&mask_text(text), PROMPT_MAX_BYTES),
        });
    }
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let name = tool_name(&v);
    let tool_use_id = str_at(&v, "tool_use_id")
        .or_else(|| str_at(&v, "toolUseId"))
        .map(str::to_string);
    let is_question = name.as_deref() == Some("AskUserQuestion");
    match event {
        "PreToolUse" if is_question && provider == proto::AgentKind::Claude => {
            let questions = questions_from(tool_input(&v));
            (!questions.is_empty()).then_some(HookFeed::Question {
                tool_use_id,
                questions,
            })
        }
        "PostToolUse" if is_question => {
            let order: Vec<String> = questions_from(tool_input(&v))
                .into_iter()
                .map(|q| q.question)
                .collect();
            let answers = v
                .get("tool_response")
                .and_then(|r| r.get("answers"))
                .and_then(|a| a.as_object())
                .map(|map| {
                    let mut out: Vec<String> = order
                        .iter()
                        .filter_map(|q| map.get(q).and_then(|a| a.as_str()))
                        .map(str::to_string)
                        .collect();
                    if out.is_empty() {
                        out = map
                            .values()
                            .filter_map(|a| a.as_str())
                            .map(str::to_string)
                            .collect();
                    }
                    out
                })
                .unwrap_or_default()
                .into_iter()
                .take(QUESTIONS_MAX)
                .map(|a| cut_chars(&mask_text(&a), SUMMARY_MAX_CHARS))
                .collect();
            Some(HookFeed::Answered {
                tool_use_id,
                answers,
            })
        }
        "PermissionRequest" => Some(HookFeed::Permission {
            tool: name.unwrap_or_else(|| "tool".to_string()),
            target: tool_target(tool_input(&v), SUMMARY_MAX_CHARS),
            always: v
                .get("permission_suggestions")
                .and_then(|s| s.as_array())
                .is_some_and(|s| !s.is_empty()),
        }),
        "PostToolUse" => Some(HookFeed::Step {
            target: tool_target(tool_input(&v), STEP_MAX_CHARS),
            tool: name?,
        }),
        _ => None,
    }
}

/// A turn's final message for the feed: the orchestration cap's trailing note
/// is dropped, and the text is held to `REPLY_MAX_BYTES`.
pub fn reply_text(message: &str) -> String {
    let body = match message.find("\n…[submit truncated:") {
        Some(at) => format!("{}…", &message[..at]),
        None => message.to_string(),
    };
    cut_bytes(body.trim(), REPLY_MAX_BYTES)
}

/// A device's view of one feed entry.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FeedItem {
    Prompt {
        text: String,
    },
    Reply {
        text: String,
    },
    Question {
        questions: Vec<Question>,
        answers: Option<Vec<String>>,
    },
    /// The answers a question received, from the terminal or a device.
    Answer {
        answers: Vec<String>,
    },
    Permission {
        tool: String,
        target: String,
        always: bool,
        /// `resolved` once the agent moved on; which choice was made is not reported.
        outcome: Option<&'static str>,
    },
    Step {
        tool: String,
        target: String,
    },
    Status {
        status: &'static str,
    },
}

impl FeedItem {
    fn weight(&self) -> usize {
        64 + match self {
            FeedItem::Prompt { text } | FeedItem::Reply { text } => text.len(),
            FeedItem::Question { questions, answers } => {
                questions
                    .iter()
                    .map(|q| {
                        q.question.len()
                            + q.header.len()
                            + q.options
                                .iter()
                                .map(|o| o.label.len() + o.description.len())
                                .sum::<usize>()
                    })
                    .sum::<usize>()
                    + answers
                        .as_ref()
                        .map_or(0, |a| a.iter().map(String::len).sum())
            }
            FeedItem::Answer { answers } => answers.iter().map(String::len).sum(),
            FeedItem::Permission { tool, target, .. } | FeedItem::Step { tool, target } => {
                tool.len() + target.len()
            }
            FeedItem::Status { .. } => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FeedEntry {
    pub seq: u64,
    pub at: u64,
    #[serde(flatten)]
    pub item: FeedItem,
}

/// The decision a pane is blocked on.
#[derive(Debug, Clone)]
pub enum Card {
    Permission {
        always: bool,
    },
    Question {
        tool_use_id: Option<String>,
        questions: Vec<Question>,
    },
    /// Blocked without a structured payload: the device answers in the terminal.
    Input,
}

#[derive(Debug, Clone)]
pub struct Pending {
    /// The feed entry the card was built from; 0 for `Input`, which has none.
    pub seq: u64,
    pub card: Card,
    pub title: String,
    /// What a permission acts on, as the feed entry shows it; empty otherwise.
    pub detail: String,
    pub provider: proto::AgentKind,
    pub since_ms: u64,
    pub sent_at_ms: Option<u64>,
}

/// The summary `/api/sessions` and the feed carry for the active card.
#[derive(Debug, Clone, Serialize)]
pub struct PendingView {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub title: String,
    pub detail: String,
    pub since: u64,
    /// Houston knows the keys this provider's prompt takes for this card.
    pub decidable: bool,
    pub sent: bool,
}

impl Pending {
    pub fn view(&self, now_ms: u64) -> PendingView {
        PendingView {
            seq: self.seq,
            kind: match self.card {
                Card::Permission { .. } => "permission",
                Card::Question { .. } => "question",
                Card::Input => "input",
            },
            title: self.title.clone(),
            detail: self.detail.clone(),
            since: self.since_ms,
            decidable: decision_support(self.provider, &self.card).is_ok(),
            sent: self.is_sent(now_ms),
        }
    }

    fn is_sent(&self, now_ms: u64) -> bool {
        self.sent_at_ms
            .is_some_and(|at| now_ms.saturating_sub(at) < SENT_HOLD_MS)
    }
}

#[derive(Default)]
struct SessionFeed {
    next_seq: u64,
    entries: VecDeque<FeedEntry>,
    bytes: usize,
    pending: Option<Pending>,
    last_reply_excerpt: Option<String>,
    last_step: Option<String>,
}

impl SessionFeed {
    fn evict_oldest(&mut self) -> usize {
        match self.entries.pop_front() {
            Some(e) => {
                let w = e.item.weight();
                self.bytes -= w;
                w
            }
            None => 0,
        }
    }
}

/// What changed, for the event stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Session(u32),
    Feed(u32, u64),
}

pub struct FeedPage {
    pub entries: Vec<FeedEntry>,
    pub first_seq: u64,
    pub last_seq: u64,
    /// `after` is older than the oldest entry still held.
    pub truncated: bool,
    pub pending: Option<PendingView>,
}

pub struct SessionSummary {
    pub pending: Option<PendingView>,
    pub last_reply_excerpt: Option<String>,
    pub last_step: Option<String>,
}

#[derive(Default)]
pub struct Store {
    inner: Mutex<StoreInner>,
}

#[derive(Default)]
struct StoreInner {
    sessions: HashMap<u32, SessionFeed>,
    bytes: usize,
}

impl Store {
    fn with<T>(&self, f: impl FnOnce(&mut StoreInner) -> T) -> T {
        f(&mut self.inner.lock().expect("remote feed lock"))
    }

    pub fn push(&self, session: u32, item: FeedItem, now_ms: u64) -> u64 {
        self.with(|inner| {
            let weight = item.weight();
            let feed = inner.sessions.entry(session).or_default();
            match &item {
                FeedItem::Reply { text } => {
                    feed.last_reply_excerpt = Some(cut_chars(&one_line(text), EXCERPT_MAX_CHARS));
                }
                FeedItem::Step { tool, target } => {
                    feed.last_step = Some(cut_chars(
                        &if target.is_empty() {
                            tool.clone()
                        } else {
                            format!("{tool} {target}")
                        },
                        STEP_MAX_CHARS,
                    ));
                }
                FeedItem::Prompt { .. } => feed.last_step = None,
                _ => {}
            }
            feed.next_seq += 1;
            let seq = feed.next_seq;
            feed.entries.push_back(FeedEntry {
                seq,
                at: now_ms,
                item,
            });
            feed.bytes += weight;
            let mut freed = 0;
            while feed.entries.len() > ENTRIES_PER_SESSION
                || (feed.bytes > BYTES_PER_SESSION && feed.entries.len() > 1)
            {
                freed += feed.evict_oldest();
            }
            inner.bytes = inner.bytes + weight - freed;
            while inner.bytes > BYTES_TOTAL {
                let Some(largest) = inner
                    .sessions
                    .iter_mut()
                    .filter(|(_, f)| f.entries.len() > 1)
                    .max_by_key(|(_, f)| f.bytes)
                    .map(|(_, f)| f)
                else {
                    break;
                };
                let w = largest.evict_oldest();
                inner.bytes -= w;
            }
            seq
        })
    }

    /// Replaces any card; an `Input` card never replaces a structured one.
    pub fn set_pending(&self, session: u32, pending: Pending) -> bool {
        self.with(|inner| {
            let feed = inner.sessions.entry(session).or_default();
            if matches!(pending.card, Card::Input) && feed.pending.is_some() {
                return false;
            }
            feed.pending = Some(pending);
            true
        })
    }

    /// Clears the card; a permission entry is marked resolved. Returns whether
    /// anything changed.
    pub fn resolve_pending(&self, session: u32) -> bool {
        self.with(|inner| {
            let Some(feed) = inner.sessions.get_mut(&session) else {
                return false;
            };
            let Some(pending) = feed.pending.take() else {
                return false;
            };
            if let Some(entry) = feed.entries.iter_mut().find(|e| e.seq == pending.seq) {
                if let FeedItem::Permission { outcome, .. } = &mut entry.item {
                    *outcome = Some("resolved");
                }
            }
            true
        })
    }

    /// Records a question's answers and clears its card when it is the pending one.
    pub fn answer_question(
        &self,
        session: u32,
        tool_use_id: Option<&str>,
        answers: Vec<String>,
    ) -> bool {
        self.with(|inner| {
            let Some(feed) = inner.sessions.get_mut(&session) else {
                return false;
            };
            let matches =
                |id: &Option<String>| tool_use_id.is_none() || id.as_deref() == tool_use_id;
            let target = match &feed.pending {
                Some(Pending {
                    seq,
                    card:
                        Card::Question {
                            tool_use_id: id, ..
                        },
                    ..
                }) if matches(id) => {
                    let seq = *seq;
                    feed.pending = None;
                    Some(seq)
                }
                _ => None,
            };
            let target = target.or_else(|| {
                feed.entries
                    .iter()
                    .rev()
                    .find(|e| matches!(e.item, FeedItem::Question { answers: None, .. }))
                    .map(|e| e.seq)
            });
            if let Some(entry) =
                target.and_then(|seq| feed.entries.iter_mut().find(|e| e.seq == seq))
            {
                if let FeedItem::Question { answers: slot, .. } = &mut entry.item {
                    *slot = Some(answers);
                }
            }
            target.is_some()
        })
    }

    pub fn pending(&self, session: u32) -> Option<Pending> {
        self.with(|inner| inner.sessions.get(&session).and_then(|f| f.pending.clone()))
    }

    pub fn mark_sent(&self, session: u32, seq: u64, now_ms: u64) {
        self.with(|inner| {
            if let Some(p) = inner
                .sessions
                .get_mut(&session)
                .and_then(|f| f.pending.as_mut())
                .filter(|p| p.seq == seq)
            {
                p.sent_at_ms = Some(now_ms);
            }
        })
    }

    pub fn clear_sent(&self, session: u32, seq: u64) {
        self.with(|inner| {
            if let Some(p) = inner
                .sessions
                .get_mut(&session)
                .and_then(|f| f.pending.as_mut())
                .filter(|p| p.seq == seq)
            {
                p.sent_at_ms = None;
            }
        })
    }

    pub fn page(&self, session: u32, after: u64, now_ms: u64) -> FeedPage {
        self.with(|inner| {
            let Some(feed) = inner.sessions.get(&session) else {
                return FeedPage {
                    entries: Vec::new(),
                    first_seq: 0,
                    last_seq: 0,
                    truncated: false,
                    pending: None,
                };
            };
            let first_seq = feed.entries.front().map_or(feed.next_seq + 1, |e| e.seq);
            FeedPage {
                entries: feed
                    .entries
                    .iter()
                    .filter(|e| e.seq > after)
                    .cloned()
                    .collect(),
                first_seq,
                last_seq: feed.next_seq,
                truncated: after + 1 < first_seq && after < feed.next_seq,
                pending: feed.pending.as_ref().map(|p| p.view(now_ms)),
            }
        })
    }

    pub fn summary(&self, session: u32, now_ms: u64) -> SessionSummary {
        self.with(|inner| match inner.sessions.get(&session) {
            Some(f) => SessionSummary {
                pending: f.pending.as_ref().map(|p| p.view(now_ms)),
                last_reply_excerpt: f.last_reply_excerpt.clone(),
                last_step: f.last_step.clone(),
            },
            None => SessionSummary {
                pending: None,
                last_reply_excerpt: None,
                last_step: None,
            },
        })
    }

    pub fn session_count(&self) -> usize {
        self.with(|inner| inner.sessions.len())
    }

    /// Drops rings for sessions `keep` rejects, once more than `at` are held.
    pub fn prune(&self, at: usize, keep: impl Fn(u32) -> bool) {
        self.with(|inner| {
            if inner.sessions.len() <= at {
                return;
            }
            let mut freed = 0;
            inner.sessions.retain(|id, f| {
                let kept = keep(*id);
                if !kept {
                    freed += f.bytes;
                }
                kept
            });
            inner.bytes -= freed;
        })
    }

    #[doc(hidden)]
    pub fn bytes_for_test(&self) -> usize {
        self.with(|inner| inner.bytes)
    }
}

/// A device's choice on a decision card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    Approve,
    Always,
    Deny,
    /// 1-based option of the single question.
    Option(usize),
    /// The question's free-text option, with the text to type into it.
    Other(String),
}

impl Choice {
    pub fn parse(raw: &str, text: Option<&str>) -> Result<Choice, String> {
        let shape = "expected \"approve\", \"always\", \"deny\", an option number such as \"2\", \
                     or \"other\" with `text`";
        match raw.trim() {
            "approve" => Ok(Choice::Approve),
            "always" => Ok(Choice::Always),
            "deny" => Ok(Choice::Deny),
            "other" => match text.map(str::trim).filter(|t| !t.is_empty()) {
                Some(t) => Ok(Choice::Other(t.to_string())),
                None => Err("choice \"other\" needs non-empty `text`".to_string()),
            },
            n => match n.parse::<usize>() {
                Ok(i) if i >= 1 => Ok(Choice::Option(i)),
                _ => Err(format!("choice {raw:?} is not recognised: {shape}")),
            },
        }
    }
}

/// The PTY writes for one decision, `settle_ms` apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPlan {
    pub writes: Vec<Vec<u8>>,
    pub settle_ms: u64,
}

/// Whether Houston can answer `card` for `provider` from a device; the error
/// names why not.
pub fn decision_support(provider: proto::AgentKind, card: &Card) -> Result<(), String> {
    let name = crate::agent_hooks::provider_slug(provider);
    match (provider, card) {
        (_, Card::Input) => Err(format!(
            "pane is waiting without a structured request from {name}: answer it in the terminal"
        )),
        (proto::AgentKind::Claude, Card::Permission { .. }) => Ok(()),
        (proto::AgentKind::Claude, Card::Question { questions, .. }) => {
            match questions.as_slice() {
                [q] if !q.multi_select => Ok(()),
                [q] => Err(format!(
                    "question {:?} allows several answers: choose them in the terminal",
                    q.question
                )),
                qs => Err(format!(
                    "this request asks {} questions at once: answer them in the terminal",
                    qs.len()
                )),
            }
        }
        _ => Err(format!(
            "Houston has no key mapping for {name}'s prompts: answer it in the terminal"
        )),
    }
}

/// The keys `choice` takes on `card`. Claude's dialogs are select lists that act
/// on a digit alone and deny on Esc; "don't ask again" is the second row, offered
/// only with permission suggestions.
pub fn decision_keys(
    provider: proto::AgentKind,
    card: &Card,
    choice: &Choice,
) -> Result<KeyPlan, String> {
    decision_support(provider, card)?;
    let plan = |writes: Vec<Vec<u8>>| KeyPlan {
        writes,
        settle_ms: SETTLE_MS,
    };
    match (card, choice) {
        (Card::Permission { .. }, Choice::Approve) => Ok(plan(vec![b"1".to_vec()])),
        (Card::Permission { always: true }, Choice::Always) => Ok(plan(vec![b"2".to_vec()])),
        (Card::Permission { always: false }, Choice::Always) => Err(
            "this permission request offers no \"don't ask again\" option: choose approve or deny"
                .to_string(),
        ),
        (Card::Permission { .. }, Choice::Deny) => Ok(plan(vec![b"\x1b".to_vec()])),
        (Card::Question { questions, .. }, Choice::Option(n)) => {
            let q = &questions[0];
            if *n > q.options.len() {
                return Err(format!(
                    "option {n} is out of range: the question has {} options",
                    q.options.len()
                ));
            }
            let digit = n.to_string().into_bytes();
            Ok(plan(if q.previews {
                vec![digit, b"\r".to_vec()]
            } else {
                vec![digit]
            }))
        }
        (Card::Question { questions, .. }, Choice::Other(text)) => {
            let q = &questions[0];
            let other = q.options.len() + 1;
            if other > OPTIONS_MAX {
                return Err(format!(
                    "the free-text option is number {other}, beyond the single digit a key can \
                     select: answer it in the terminal"
                ));
            }
            let text = super::validate_input_text(text)?;
            if text.contains('\n') {
                return Err("a free-text answer is one line: remove the line breaks".to_string());
            }
            Ok(plan(vec![
                other.to_string().into_bytes(),
                text.into_bytes(),
                b"\r".to_vec(),
            ]))
        }
        (Card::Permission { .. }, other) => Err(format!(
            "choice {other:?} does not answer a permission request: expected approve, always or deny"
        )),
        (Card::Question { .. }, other) => Err(format!(
            "choice {other:?} does not answer a question: expected an option number or other"
        )),
        (Card::Input, _) => unreachable!("decision_support refuses Input"),
    }
}

/// A short title for a card, as the session list shows it.
pub fn card_title(card: &Card, tool: Option<&str>) -> String {
    match card {
        Card::Permission { .. } => tool.unwrap_or("tool").to_string(),
        Card::Question { questions, .. } => questions
            .first()
            .map(|q| cut_chars(&q.question, 80))
            .unwrap_or_default(),
        Card::Input => "Needs you".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: proto::AgentKind = proto::AgentKind::Claude;

    fn question(n: usize, multi: bool, previews: bool) -> Question {
        Question {
            header: "H".into(),
            question: "Which?".into(),
            options: (1..=n)
                .map(|i| QuestionOption {
                    label: format!("o{i}"),
                    description: String::new(),
                })
                .collect(),
            multi_select: multi,
            previews,
        }
    }

    #[test]
    fn a_bash_permission_keeps_only_the_masked_command() {
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "curl -H 'Authorization: Bearer abc123' https://x", "description": "secret plan"},
            "permission_suggestions": [{"type": "addRules"}]
        })
        .to_string();
        let Some(HookFeed::Permission {
            tool,
            target,
            always,
        }) = from_hook(CLAUDE, "PermissionRequest", &payload, None)
        else {
            panic!("a permission entry");
        };
        assert_eq!(tool, "Bash");
        assert!(always);
        assert!(target.contains("[redacted:auth_header]"), "{target}");
        assert!(!target.contains("abc123") && !target.contains("secret plan"));
    }

    #[test]
    fn steps_are_one_line_and_capped() {
        let long = format!("echo {}\nrm -rf x", "a".repeat(400));
        let payload =
            serde_json::json!({"tool_name": "Bash", "tool_input": {"command": long}}).to_string();
        let Some(HookFeed::Step { target, .. }) = from_hook(CLAUDE, "PostToolUse", &payload, None)
        else {
            panic!("a step");
        };
        assert!(!target.contains('\n'));
        assert_eq!(target.chars().count(), STEP_MAX_CHARS);
    }

    #[test]
    fn a_question_lifts_options_and_its_answer_follows_question_order() {
        let pre = serde_json::json!({
            "tool_name": "AskUserQuestion", "tool_use_id": "t1",
            "tool_input": {"questions": [{"header": "Pick", "question": "Which?", "multiSelect": false,
                "options": [{"label": "A", "description": "first"}, {"label": "B", "description": "second"}]}]}
        })
        .to_string();
        let Some(HookFeed::Question { questions, .. }) =
            from_hook(CLAUDE, "PreToolUse", &pre, None)
        else {
            panic!("a question");
        };
        assert_eq!(questions[0].options.len(), 2);
        assert_eq!(questions[0].options[1].description, "second");
        let post = serde_json::json!({
            "tool_name": "AskUserQuestion", "tool_use_id": "t1",
            "tool_input": {"questions": [{"question": "Which?", "options": []}]},
            "tool_response": {"answers": {"Which?": "B"}}
        })
        .to_string();
        assert_eq!(
            from_hook(CLAUDE, "PostToolUse", &post, None),
            Some(HookFeed::Answered {
                tool_use_id: Some("t1".into()),
                answers: vec!["B".into()]
            })
        );
    }

    #[test]
    fn claude_permissions_map_to_digits_and_escape() {
        let card = Card::Permission { always: true };
        let keys = |c| decision_keys(CLAUDE, &card, &c).unwrap().writes;
        assert_eq!(keys(Choice::Approve), vec![b"1".to_vec()]);
        assert_eq!(keys(Choice::Always), vec![b"2".to_vec()]);
        assert_eq!(keys(Choice::Deny), vec![b"\x1b".to_vec()]);
        let narrow = Card::Permission { always: false };
        assert!(decision_keys(CLAUDE, &narrow, &Choice::Always).is_err());
    }

    #[test]
    fn a_single_choice_question_takes_a_digit_and_previews_add_enter() {
        let card = |q| Card::Question {
            tool_use_id: None,
            questions: vec![q],
        };
        assert_eq!(
            decision_keys(CLAUDE, &card(question(3, false, false)), &Choice::Option(2))
                .unwrap()
                .writes,
            vec![b"2".to_vec()]
        );
        assert_eq!(
            decision_keys(CLAUDE, &card(question(3, false, true)), &Choice::Option(2))
                .unwrap()
                .writes,
            vec![b"2".to_vec(), b"\r".to_vec()]
        );
        assert!(
            decision_keys(CLAUDE, &card(question(3, false, false)), &Choice::Option(4)).is_err()
        );
        assert_eq!(
            decision_keys(
                CLAUDE,
                &card(question(2, false, false)),
                &Choice::Other("blue".into())
            )
            .unwrap()
            .writes,
            vec![b"3".to_vec(), b"blue".to_vec(), b"\r".to_vec()]
        );
        assert!(
            decision_keys(CLAUDE, &card(question(3, true, false)), &Choice::Option(1)).is_err()
        );
    }

    #[test]
    fn providers_without_a_mapping_are_refused_by_name() {
        let err = decision_keys(
            proto::AgentKind::Codex,
            &Card::Permission { always: false },
            &Choice::Approve,
        )
        .unwrap_err();
        assert!(err.contains("codex"), "{err}");
    }

    #[test]
    fn the_ring_is_bounded_by_count_and_bytes() {
        let store = Store::default();
        for i in 0..(ENTRIES_PER_SESSION + 5) {
            store.push(1, FeedItem::Status { status: "finished" }, i as u64);
        }
        let page = store.page(1, 0, 0);
        assert_eq!(page.entries.len(), ENTRIES_PER_SESSION);
        assert!(page.truncated);
        assert_eq!(page.last_seq, (ENTRIES_PER_SESSION + 5) as u64);
        let big = "x".repeat(REPLY_MAX_BYTES);
        for _ in 0..100 {
            store.push(2, FeedItem::Reply { text: big.clone() }, 0);
        }
        assert!(store.page(2, 0, 0).entries.len() < 100);
        assert!(store.bytes_for_test() <= 2 * BYTES_PER_SESSION);
        store.prune(0, |id| id == 1);
        assert!(store.bytes_for_test() < BYTES_PER_SESSION);
    }

    #[test]
    fn an_input_card_never_replaces_a_structured_one() {
        let store = Store::default();
        let pending = |card| Pending {
            seq: 3,
            card,
            title: String::new(),
            detail: String::new(),
            provider: CLAUDE,
            since_ms: 0,
            sent_at_ms: None,
        };
        assert!(store.set_pending(1, pending(Card::Permission { always: false })));
        assert!(!store.set_pending(1, pending(Card::Input)));
        assert_eq!(store.pending(1).unwrap().seq, 3);
        assert!(store.resolve_pending(1));
        assert!(store.pending(1).is_none());
    }
}

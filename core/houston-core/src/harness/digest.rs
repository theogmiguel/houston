//! One line per session of a workspace, extracted without judgment, so the
//! agent of a review run reads digests instead of raw transcripts. The terms
//! any edit must keep are carve-out #6 in `docs/internals/invariants.md`.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use regex::Regex;
use serde_json::{json, Map, Value};

use super::window::{format_ms, Window};
use crate::usage::time::parse_rfc3339_ms;

/// A digest line past this is almost all prompt text; 64 KiB keeps the first
/// and last prompts of even a day-long session.
pub const SESSION_LINE_MAX: usize = 64 * 1024;
/// Roughly half a model context of digest; past it, one reading cannot hold
/// the window and a narrower one is the fix.
pub const DIGEST_TOTAL_MAX: usize = 2 * 1024 * 1024;
/// Same bound as the usage scan: a longer line is tool output or an image.
const LINE_MAX: usize = 8 * 1024 * 1024;
const PROMPT_MAX_CHARS: usize = 2_000;
/// A pasted `/context` report carries its per-source token table past 2 000
/// characters; that table is the evidence for context spent on tool schemas.
const CONTEXT_PASTE_MAX_CHARS: usize = 8_000;
const CONTEXT_PASTE_PREFIX: &str = "## Context Usage";
const LAST_TEXT_MAX_CHARS: usize = 2_000;
const REASON_MAX_CHARS: usize = 200;
const ERROR_SAMPLE_CHARS: usize = 200;
const ERROR_SAMPLES_PER_TOOL: usize = 3;
/// Enough denied calls to show a pattern without carrying a session's log.
const DENIED_PER_SESSION: usize = 10;
const DENIED_INPUT_CHARS: usize = 200;
const AUTOMATIC_REPLY_SAMPLES: usize = 3;
/// How far into a file the cwd and first timestamp are looked for.
const PEEK_LINES: usize = 40;

/// The first line of the Houston review prompt, so a run never digests itself.
pub const REVIEW_MARKER: &str = "[houston harness review]";

/// Wrapper prefixes that are never a person typing; `session-index.py`'s list
/// plus the two wrappers Claude Code added since.
const SKIP_PREFIXES: [&str; 12] = [
    "<command-name>",
    "<local-command",
    "<system-reminder>",
    "Base directory for this skill",
    "<task-notification>",
    "Another Claude session sent",
    "The fork runs as its own",
    "[Request interrupted",
    "<bash-input>",
    "<bash-stdout>",
    "<local-command-caveat>",
    "<command-message>",
];

/// Machine-emitted strings worth counting, from the manual rounds' greps.
const MACHINE_STRINGS: [(&str, &str); 6] = [
    ("sleep_blocked", "Blocked: sleep"),
    ("worktree_guard", "This session is isolated in the worktree"),
    ("low_memory", "running low on memory"),
    (
        "classifier_denied",
        "denied by the Claude Code auto mode classifier",
    ),
    ("interrupted_by_user", "Request interrupted by user"),
    ("usage_limit_reset", "Your claude.ai usage limit has reset"),
];

/// Messages the harness injects as user turns. Counted, never read as prompts:
/// an assistant that answers one with prose instead of acting is friction.
const AUTOMATIC_PREFIXES: [(&str, &str); 3] = [
    ("another_session", "Another Claude session sent"),
    ("task_notification", "<task-notification>"),
    ("fork_notice", "The fork runs as its own"),
];

const CLASSIFIER_PREFIX: &str =
    "Permission for this action was denied by the Claude Code auto mode classifier. Reason: ";

/// The fixed pushback vocabulary of `session-index.py`, kept verbatim so two
/// runs, and a run and a manual round, count the same thing.
fn friction_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)wtf|didn'?t get|i don'?t get|não entendi|nao entendi|why are you|why a subagent|stop that|i don'?t want|too much|not what i asked|you are not|errado|não é isso|request interrupted",
        )
        .expect("the friction vocabulary is a valid regex")
    })
}

fn command_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"<command-name>(/[\w-]+)</command-name>")
            .expect("the command-name pattern is a valid regex")
    })
}

/// `None` when the text is not a person's prompt; slash commands come back as
/// `CMD /<name>`, as `session-index.py` records them.
pub fn human_prompt(text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    let head: String = text.chars().take(100).collect();
    if head.contains("Caveat: The messages below") {
        return None;
    }
    if let Some(m) = command_re().captures(text) {
        return Some(format!("CMD {}", &m[1]));
    }
    let trimmed = text.trim_start();
    if SKIP_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return None;
    }
    Some(text.to_string())
}

fn cap_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Claude's project-directory name for a path: every non-alphanumeric byte
/// becomes `-`.
pub fn claude_slug(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn within(ws: &Path, cwd: &str) -> bool {
    Path::new(cwd).starts_with(ws)
}

#[derive(Debug, Clone)]
struct Prompt {
    at: String,
    text: String,
    uuid: Option<String>,
    queued: bool,
}

/// A session reduced to what the digest writes.
#[derive(Debug, Default)]
struct Session {
    provider: &'static str,
    id: String,
    path: PathBuf,
    title: Option<String>,
    branch: Option<String>,
    cwd: Option<String>,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
    in_window: bool,
    cost_usd: Option<f64>,
    models: BTreeMap<String, u64>,
    prompts: Vec<Prompt>,
    skills: BTreeMap<String, u64>,
    skill_sources: BTreeMap<String, u64>,
    subagents: Vec<Value>,
    tools: BTreeMap<String, u64>,
    tool_errors: BTreeMap<String, u64>,
    tool_error_samples: BTreeMap<String, Vec<String>>,
    denials: BTreeMap<String, u64>,
    classifier_reasons: BTreeMap<String, u64>,
    compactions: u64,
    interrupts: u64,
    fork_marker_ms: Option<i64>,
    forked: bool,
    fork_of: Option<String>,
    first_uuid: Option<String>,
    uuids: Vec<(String, i64)>,
    last_assistant_text: Option<String>,
    machine: BTreeMap<&'static str, u64>,
    tool_names: HashMap<String, String>,
    tool_inputs: HashMap<String, String>,
    denied: Vec<Value>,
    automatic: BTreeMap<&'static str, u64>,
    automatic_answered: BTreeMap<&'static str, u64>,
    automatic_reply_samples: Vec<String>,
    pending_automatic: Option<&'static str>,
}

impl Session {
    fn stamp(&mut self, ts: Option<&str>, window: &Window) -> Option<i64> {
        let ms = parse_rfc3339_ms(ts?)?;
        self.first_ms = Some(self.first_ms.map_or(ms, |f| f.min(ms)));
        self.last_ms = Some(self.last_ms.map_or(ms, |l| l.max(ms)));
        if ms >= window.since_ms && ms < window.until_ms {
            self.in_window = true;
        }
        Some(ms)
    }

    fn count_machine(&mut self, text: &str) {
        for (key, needle) in MACHINE_STRINGS {
            if text.contains(needle) {
                *self.machine.entry(key).or_default() += 1;
            }
        }
    }

    fn tool_error(&mut self, name: &str, text: &str) {
        *self.tool_errors.entry(name.to_string()).or_default() += 1;
        let samples = self.tool_error_samples.entry(name.to_string()).or_default();
        if samples.len() < ERROR_SAMPLES_PER_TOOL {
            samples.push(cap_chars(text.trim(), ERROR_SAMPLE_CHARS));
        }
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn feed_claude(s: &mut Session, o: &Value, window: &Window) {
    if o.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let ts = str_at(o, "timestamp");
    let ms = s.stamp(ts, window);
    let kind = str_at(o, "type").unwrap_or("");
    if s.cwd.is_none() {
        s.cwd = str_at(o, "cwd").map(str::to_string);
    }
    if let Some(b) = str_at(o, "gitBranch") {
        s.branch = Some(b.to_string());
    }
    let uuid = str_at(o, "uuid").map(str::to_string);
    if matches!(kind, "user" | "assistant") {
        if let Some(u) = &uuid {
            if s.first_uuid.is_none() {
                s.first_uuid = Some(u.clone());
            }
            s.uuids.push((u.clone(), ms.unwrap_or(0)));
        }
    }
    match kind {
        "ai-title" => s.title = str_at(o, "aiTitle").map(str::to_string),
        "cost-state" => {
            if let Some(c) = o.get("totalCostUSD").and_then(Value::as_f64) {
                s.cost_usd = Some(c);
            }
        }
        "system" => {
            if str_at(o, "subtype") == Some("compact_boundary") {
                s.compactions += 1;
            }
            if let Some(c) = str_at(o, "content") {
                s.count_machine(c);
            }
        }
        "attachment" => {
            let a = o.get("attachment").unwrap_or(&Value::Null);
            match str_at(a, "type") {
                Some("queued_command")
                    if a.pointer("/origin/kind").and_then(Value::as_str) == Some("human") =>
                {
                    if let Some(p) = str_at(a, "prompt") {
                        s.prompts.push(Prompt {
                            at: ts.unwrap_or("").to_string(),
                            text: p.to_string(),
                            uuid: uuid.clone(),
                            queued: true,
                        });
                    }
                }
                Some("fork_briefing") => {
                    s.fork_marker_ms.get_or_insert(ms.unwrap_or(0));
                }
                _ => {}
            }
        }
        "user" => feed_claude_user(s, o, ts, uuid, ms),
        "assistant" => feed_claude_assistant(s, o),
        _ => {}
    }
}

fn feed_claude_user(
    s: &mut Session,
    o: &Value,
    ts: Option<&str>,
    uuid: Option<String>,
    ms: Option<i64>,
) {
    if o.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        s.compactions += 1;
        return;
    }
    if let Some(kind) = str_at(o, "toolDenialKind") {
        *s.denials.entry(kind.to_string()).or_default() += 1;
    }
    let content = o.pointer("/message/content").unwrap_or(&Value::Null);
    let mut texts: Vec<String> = Vec::new();
    match content {
        Value::String(t) => texts.push(t.clone()),
        Value::Array(blocks) => {
            for b in blocks {
                match str_at(b, "type") {
                    Some("text") => texts.push(str_at(b, "text").unwrap_or("").to_string()),
                    Some("tool_result") => {
                        let body = text_of(b.get("content").unwrap_or(&Value::Null));
                        s.count_machine(&body);
                        let mut reason = None;
                        if let Some(r) = body.strip_prefix(CLASSIFIER_PREFIX) {
                            let r = r.split(" If you have other tasks").next();
                            let r = cap_chars(r.unwrap_or("").trim(), REASON_MAX_CHARS);
                            *s.classifier_reasons.entry(r.clone()).or_default() += 1;
                            reason = Some(r);
                        }
                        let kind = str_at(o, "toolDenialKind");
                        if (kind.is_some() || reason.is_some())
                            && s.denied.len() < DENIED_PER_SESSION
                        {
                            let id = str_at(b, "tool_use_id");
                            s.denied.push(json!({
                                "kind": kind.unwrap_or("automode-blocked"),
                                "tool": id.and_then(|id| s.tool_names.get(id)),
                                "input": id.and_then(|id| s.tool_inputs.get(id)),
                                "reason": reason,
                            }));
                        }
                        if b.get("is_error").and_then(Value::as_bool) == Some(true) {
                            let name = str_at(b, "tool_use_id")
                                .and_then(|id| s.tool_names.get(id).cloned())
                                .unwrap_or_else(|| "unknown".to_string());
                            s.tool_error(&name, &body);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    for t in texts {
        s.count_machine(&t);
        let trimmed = t.trim_start();
        if let Some((kind, _)) = AUTOMATIC_PREFIXES
            .iter()
            .find(|(_, prefix)| trimmed.starts_with(prefix))
        {
            *s.automatic.entry(kind).or_default() += 1;
            s.pending_automatic = Some(kind);
        }
        if trimmed.starts_with("[Request interrupted") {
            s.interrupts += 1;
        }
        if trimmed.starts_with("The fork runs as its own") {
            s.fork_marker_ms.get_or_insert(ms.unwrap_or(0));
        }
        if trimmed.starts_with("This session is being continued") {
            s.compactions += 1;
        }
        for line in t.lines() {
            if let Some(path) = line.strip_prefix("Base directory for this skill:") {
                *s.skill_sources.entry(path.trim().to_string()).or_default() += 1;
            }
        }
        if let Some(p) = human_prompt(&t) {
            s.pending_automatic = None;
            s.prompts.push(Prompt {
                at: ts.unwrap_or("").to_string(),
                text: p,
                uuid: uuid.clone(),
                queued: false,
            });
        }
    }
}

/// What a denied call tried, bounded and with secrets masked, so a review can
/// name the allow or deny rule it would take. Masked before the cap: a cut
/// can remove the delimiter a secret pattern needs, such as a URL's `@`.
fn tool_input_summary(input: &Value) -> String {
    let raw = ["command", "file_path", "url", "pattern"]
        .iter()
        .find_map(|k| str_at(input, k).map(str::to_string))
        .unwrap_or_else(|| input.to_string());
    cap_chars(
        &crate::sanitize::redact_command_secrets(&raw).0,
        DENIED_INPUT_CHARS,
    )
}

fn feed_claude_assistant(s: &mut Session, o: &Value) {
    let Some(m) = o.get("message") else { return };
    if let Some(model) = str_at(m, "model").filter(|m| !m.starts_with('<')) {
        *s.models.entry(model.to_string()).or_default() += 1;
    }
    let Some(blocks) = m.get("content").and_then(Value::as_array) else {
        return;
    };
    for b in blocks {
        match str_at(b, "type") {
            Some("text") => {
                if let Some(t) = str_at(b, "text").filter(|t| !t.trim().is_empty()) {
                    s.last_assistant_text = Some(t.to_string());
                    if let Some(kind) = s.pending_automatic.take() {
                        *s.automatic_answered.entry(kind).or_default() += 1;
                        if s.automatic_reply_samples.len() < AUTOMATIC_REPLY_SAMPLES {
                            s.automatic_reply_samples
                                .push(cap_chars(t.trim(), ERROR_SAMPLE_CHARS));
                        }
                    }
                }
            }
            Some("tool_use") => {
                s.pending_automatic = None;
                let name = str_at(b, "name").unwrap_or("unknown").to_string();
                *s.tools.entry(name.clone()).or_default() += 1;
                let input = b.get("input").unwrap_or(&Value::Null);
                if let Some(id) = str_at(b, "id") {
                    s.tool_names.insert(id.to_string(), name.clone());
                    s.tool_inputs
                        .insert(id.to_string(), tool_input_summary(input));
                }
                if name == "Skill" {
                    if let Some(skill) = str_at(input, "skill") {
                        *s.skills.entry(skill.to_string()).or_default() += 1;
                    }
                }
                if name == "Agent" || name == "Task" {
                    s.subagents.push(json!({
                        "type": str_at(input, "subagent_type"),
                        "model": str_at(input, "model"),
                        "description": str_at(input, "description").map(|d| cap_chars(d, 120)),
                        "background": input.get("run_in_background").and_then(Value::as_bool).unwrap_or(false),
                    }));
                }
            }
            _ => {}
        }
    }
}

fn feed_codex(s: &mut Session, o: &Value, window: &Window, saw_meta: &mut bool) {
    let ts = str_at(o, "timestamp");
    s.stamp(ts, window);
    let payload = o.get("payload").unwrap_or(&Value::Null);
    let ptype = str_at(payload, "type");
    match (str_at(o, "type"), ptype) {
        (Some("session_meta"), _) => {
            if *saw_meta {
                return;
            }
            *saw_meta = true;
            if let Some(id) = str_at(payload, "id") {
                s.id = id.to_string();
            }
            s.cwd = str_at(payload, "cwd").map(str::to_string);
            s.branch = payload
                .pointer("/git/branch")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(map) = payload.as_object() {
                s.forked = crate::usage::transcripts::is_forked_session_meta(map);
            }
        }
        (Some("turn_context"), _) => {
            if let Some(model) = str_at(payload, "model") {
                *s.models.entry(model.to_string()).or_default() += 1;
            }
        }
        (Some("event_msg"), Some("user_message")) => {
            if let Some(p) = str_at(payload, "message").and_then(human_prompt) {
                s.prompts.push(Prompt {
                    at: ts.unwrap_or("").to_string(),
                    text: p,
                    uuid: None,
                    queued: false,
                });
            }
        }
        (Some("event_msg"), Some("thread_name_updated")) => {
            s.title = str_at(payload, "thread_name").map(str::to_string);
        }
        (Some("event_msg"), Some("agent_message")) => {
            s.last_assistant_text = str_at(payload, "message").map(str::to_string);
        }
        (Some("event_msg"), Some("turn_aborted")) => s.interrupts += 1,
        (Some("event_msg"), Some("exec_command_end")) => {
            let code = payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if code != 0 {
                let name = codex_tool_name(s, payload, "exec_command");
                let out = str_at(payload, "stderr").unwrap_or("").to_string();
                s.tool_error(&name, &format!("exit {code} {out}"));
            }
        }
        (Some("event_msg"), Some("patch_apply_end")) => {
            if payload.get("success").and_then(Value::as_bool) == Some(false) {
                let name = codex_tool_name(s, payload, "apply_patch");
                let out = str_at(payload, "stderr").unwrap_or("").to_string();
                s.tool_error(&name, &out);
            }
        }
        (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
            let name = str_at(payload, "name").unwrap_or("unknown").to_string();
            *s.tools.entry(name.clone()).or_default() += 1;
            if let Some(id) = str_at(payload, "call_id") {
                s.tool_names.insert(id.to_string(), name);
            }
        }
        _ => {}
    }
}

fn codex_tool_name(s: &Session, payload: &Value, fallback: &str) -> String {
    str_at(payload, "call_id")
        .and_then(|id| s.tool_names.get(id).cloned())
        .unwrap_or_else(|| fallback.to_string())
}

/// A prompt too long for argv (and any multi-line one on Windows) reaches the
/// CLI as a "Read the file <path> …" stub, so the marker is looked for there too.
fn is_review_run(first_prompt: &str) -> bool {
    let text = first_prompt.trim_start();
    if text.starts_with(REVIEW_MARKER) {
        return true;
    }
    text.strip_prefix("Read the file ")
        .and_then(|rest| rest.split(" and follow every instruction").next())
        .filter(|path| path.contains(".houston"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|brief| brief.trim_start().starts_with(REVIEW_MARKER))
}

#[derive(Debug, Default)]
pub struct Tally {
    pub files_listed: u64,
    pub files_read: u64,
    pub unreadable_files: u64,
    pub oversized_lines: u64,
    pub out_of_window: u64,
    pub self_runs_skipped: u64,
    pub forks: u64,
    pub available_from_ms: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
enum Line {
    Read,
    Oversized,
    End,
}

/// Reads one line into `buf`, holding at most `max + 1` bytes of it: past
/// `max` the rest of the line is consumed and discarded, so one huge line
/// never costs more memory than the cap.
fn read_bounded_line(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<Line> {
    buf.clear();
    let mut seen = 0usize;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(match seen {
                0 => Line::End,
                _ if seen > max => Line::Oversized,
                _ => Line::Read,
            });
        }
        let (take, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        let room = (max + 1).saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..take.min(room)]);
        seen += take;
        reader.consume(take);
        if done {
            return Ok(if seen > max {
                Line::Oversized
            } else {
                Line::Read
            });
        }
    }
}

fn for_each_line(path: &Path, tally: &mut Tally, mut f: impl FnMut(&Value) -> bool) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        tally.unreadable_files += 1;
        return false;
    };
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::with_capacity(8 * 1024);
    loop {
        match read_bounded_line(&mut reader, &mut buf, LINE_MAX) {
            Ok(Line::End) => return true,
            Ok(Line::Read) => {}
            Ok(Line::Oversized) => {
                tally.oversized_lines += 1;
                continue;
            }
            Err(_) => {
                tally.unreadable_files += 1;
                return false;
            }
        }
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else {
            continue;
        };
        if !f(&v) {
            return true;
        }
    }
}

/// The first cwd and timestamp in a file, read from its head only.
fn peek(path: &Path, tally: &mut Tally, codex: bool) -> (Option<String>, Option<i64>) {
    let (mut cwd, mut first) = (None, None);
    let mut n = 0;
    for_each_line(path, tally, |o| {
        n += 1;
        if first.is_none() {
            first = str_at(o, "timestamp").and_then(parse_rfc3339_ms);
        }
        if cwd.is_none() {
            cwd = if codex {
                o.pointer("/payload/cwd").and_then(Value::as_str)
            } else {
                str_at(o, "cwd")
            }
            .map(str::to_string);
        }
        n < PEEK_LINES && (cwd.is_none() || first.is_none())
    });
    (cwd, first)
}

pub struct Request<'a> {
    pub workspace: &'a Path,
    pub claude_roots: Vec<PathBuf>,
    pub codex_roots: Vec<PathBuf>,
    pub window: Window,
    pub session_line_max: usize,
    pub total_max: usize,
}

fn note_available(tally: &mut Tally, first: Option<i64>) {
    if let Some(ms) = first {
        tally.available_from_ms = Some(tally.available_from_ms.map_or(ms, |a| a.min(ms)));
    }
}

fn claude_files(req: &Request, tally: &mut Tally) -> Vec<PathBuf> {
    let slug = claude_slug(req.workspace);
    let mut out = Vec::new();
    for root in &req.claude_roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(&slug))
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for dir in dirs {
            let Ok(files) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<PathBuf> = files
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
                .collect();
            files.sort();
            for f in files {
                tally.files_listed += 1;
                let (cwd, first) = peek(&f, tally, false);
                if !cwd.is_some_and(|c| within(req.workspace, &c)) {
                    continue;
                }
                note_available(tally, first);
                out.push(f);
            }
        }
    }
    out
}

fn codex_files(req: &Request, tally: &mut Tally) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in &req.codex_roots {
        for file in crate::usage::scan::list_transcripts(root, 0).files {
            tally.files_listed += 1;
            let (cwd, first) = peek(&file.path, tally, true);
            if !cwd.is_some_and(|c| within(req.workspace, &c)) {
                continue;
            }
            note_available(tally, first);
            if file.mtime_ms >= req.window.since_ms {
                out.push(file.path);
            } else {
                tally.out_of_window += 1;
            }
        }
    }
    out
}

fn mtime_ms(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Files that share the uuid of their first message are one conversation
/// copied by a fork or a branch. The original is the member with no fork
/// notice of its own; otherwise the one whose own lines start first.
fn resolve_forks(sessions: &mut [Session], tally: &mut Tally) {
    let mut families: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, s) in sessions.iter().enumerate() {
        if let Some(u) = &s.first_uuid {
            families.entry(u.clone()).or_default().push(i);
        }
    }
    for members in families.values().filter(|m| m.len() > 1) {
        let mut shared: HashMap<&str, usize> = HashMap::new();
        for &i in members {
            for (u, _) in &sessions[i].uuids {
                *shared.entry(u.as_str()).or_default() += 1;
            }
        }
        let own_start = |i: usize| {
            sessions[i]
                .uuids
                .iter()
                .find(|(u, _)| shared.get(u.as_str()) == Some(&1))
                .map_or(i64::MAX, |(_, ms)| *ms)
        };
        let mut order: Vec<(bool, i64, usize)> = members
            .iter()
            .map(|&i| (sessions[i].fork_marker_ms.is_some(), own_start(i), i))
            .collect();
        order.sort();
        let original = order[0].2;
        let original_id = sessions[original].id.clone();
        let mut seen: HashSet<String> = HashSet::new();
        for &(_, _, i) in &order {
            let s = &mut sessions[i];
            if i != original {
                s.forked = true;
                s.fork_of = Some(original_id.clone());
                tally.forks += 1;
            }
            s.prompts.retain(|p| match &p.uuid {
                Some(u) => !seen.contains(u),
                None => true,
            });
            seen.extend(s.uuids.iter().map(|(u, _)| u.clone()));
        }
    }
}

fn friction_and_reasks(prompts: &[Prompt]) -> (Vec<Value>, u64) {
    let mut friction = Vec::new();
    let mut reasks = 0;
    let mut prev: Option<String> = None;
    for p in prompts {
        if !p.text.starts_with("CMD /") {
            if let Some(m) = friction_re().find(&p.text) {
                friction.push(json!({ "at": p.at, "match": m.as_str() }));
            }
        }
        let key: String = p.text.chars().take(40).collect();
        if prev.as_deref() == Some(key.as_str()) {
            reasks += 1;
        }
        prev = Some(key);
    }
    (friction, reasks)
}

fn session_value(s: &Session, prompts: &[Prompt], dropped: usize) -> Value {
    let (friction, reasks) = friction_and_reasks(&s.prompts);
    let minutes = match (s.first_ms, s.last_ms) {
        (Some(a), Some(b)) => (b - a + 30_000) / 60_000,
        _ => 0,
    };
    let mut machine: Map<String, Value> = s
        .machine
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let chrome: u64 = s
        .tool_errors
        .iter()
        .filter(|(k, _)| k.starts_with("mcp__claude-in-chrome__"))
        .map(|(_, v)| v)
        .sum();
    if chrome > 0 {
        machine.insert("chrome_mcp_errors".into(), json!(chrome));
    }
    let mut value = json!({
        "v": 1,
        "provider": s.provider,
        "id": s.id,
        "path": s.path.to_string_lossy(),
        "title": s.title,
        "branch": s.branch,
        "cwd": s.cwd,
        "start": s.first_ms.map(format_ms),
        "end": s.last_ms.map(format_ms),
        "minutes": minutes,
        "cost_usd": s.cost_usd,
        "models": s.models,
        "prompt_count": s.prompts.len(),
        "prompts": prompts.iter().map(|p| {
            let max = if p.text.trim_start().starts_with(CONTEXT_PASTE_PREFIX) {
                CONTEXT_PASTE_MAX_CHARS
            } else {
                PROMPT_MAX_CHARS
            };
            let mut v = json!({ "at": p.at, "text": cap_chars(&p.text, max) });
            if p.queued {
                v["queued"] = json!(true);
            }
            v
        }).collect::<Vec<_>>(),
        "prompts_dropped": dropped,
        "skills": s.skills,
        "skill_sources": s.skill_sources,
        "subagents": s.subagents,
        "tools": s.tools,
        "tool_errors": s.tool_errors,
        "tool_error_samples": s.tool_error_samples,
        "denials": s.denials,
        "classifier_reasons": s.classifier_reasons,
        "compactions": s.compactions,
        "interrupts": s.interrupts,
        "forked": s.forked,
        "fork_of": s.fork_of,
        "friction": friction,
        "reasks": reasks,
        "last_assistant_text": s.last_assistant_text.as_deref().map(|t| cap_chars(t, LAST_TEXT_MAX_CHARS)),
        "machine": machine,
        "automatic": s.automatic,
        "automatic_answered_with_text": s.automatic_answered,
        "automatic_reply_samples": s.automatic_reply_samples,
        "denied": s.denied,
    });
    if let Some(task) = s
        .prompts
        .first()
        .and_then(|prompt| task_key_from_prompt(&prompt.text))
    {
        value["task"] = json!(task);
    }
    value
}

fn task_key_from_prompt(prompt: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^Houston task (HOU-[0-9]+)\b").expect("task key pattern is valid")
    })
    .captures(prompt)
    .and_then(|capture| capture.get(1))
    .map(|key| key.as_str().to_string())
}

/// Drops middle prompts until the line fits, keeping the opening ask and the
/// latest ones, then collection entries, then string length; a line that still
/// does not fit is refused rather than written oversized.
fn session_line(
    s_value: impl Fn(&[Prompt], usize) -> Value,
    prompts: &[Prompt],
    max: usize,
) -> Result<String> {
    let mut kept: Vec<Prompt> = prompts.to_vec();
    let mut dropped = 0;
    let mut v = loop {
        let v = s_value(&kept, dropped);
        let len = v.to_string().len();
        if len <= max {
            return Ok(v.to_string());
        }
        if kept.len() <= 2 {
            break v;
        }
        let excess = len - max;
        let mut freed = 0;
        while freed < excess && kept.len() > 2 {
            let mid = kept.len() / 2;
            freed += kept.remove(mid).text.len().min(CONTEXT_PASTE_MAX_CHARS * 4) + 16;
            dropped += 1;
        }
    };
    for keep in SHRINK_KEEP {
        shrink_collections(&mut v, keep);
        let line = v.to_string();
        if line.len() <= max {
            return Ok(line);
        }
    }
    shrink_strings(&mut v);
    let line = v.to_string();
    if line.len() <= max {
        return Ok(line);
    }
    bail!(
        "session {}: the digest line is {} bytes after dropping prompts, collection entries \
         and long strings, over the {max} byte per-session cap",
        v["id"],
        line.len()
    )
}

/// Entries each collection keeps at successive stages of shrinking a line.
const SHRINK_KEEP: [usize; 4] = [32, 8, 2, 0];
/// Collections a session accumulates without a fixed bound.
const SHRINKABLE: [&str; 15] = [
    "models",
    "skills",
    "skill_sources",
    "subagents",
    "tools",
    "tool_errors",
    "tool_error_samples",
    "denials",
    "classifier_reasons",
    "friction",
    "machine",
    "automatic",
    "automatic_answered_with_text",
    "automatic_reply_samples",
    "denied",
];
/// Length of the last stage's strings: enough to recognise a title or path.
const SHRINK_STRING_CHARS: usize = 500;

/// Keeps `keep` entries of each collection (the largest counts of a count map)
/// and records how many each lost under `truncated`, so a reader knows the
/// line is partial.
fn shrink_collections(v: &mut Value, keep: usize) {
    let mut truncated = v
        .get("truncated")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for field in SHRINKABLE {
        let lost = match v.get_mut(field) {
            Some(Value::Array(a)) if a.len() > keep => {
                let lost = a.len() - keep;
                a.truncate(keep);
                lost
            }
            Some(Value::Object(m)) if m.len() > keep => {
                let mut entries: Vec<(String, Value)> = std::mem::take(m).into_iter().collect();
                entries.sort_by_key(|(_, n)| std::cmp::Reverse(n.as_u64().unwrap_or(0)));
                let lost = entries.len() - keep;
                m.extend(entries.into_iter().take(keep));
                lost
            }
            _ => 0,
        };
        if lost > 0 {
            let before = truncated.get(field).and_then(Value::as_u64).unwrap_or(0);
            truncated.insert(field.to_string(), json!(before + lost as u64));
        }
    }
    if !truncated.is_empty() {
        v["truncated"] = Value::Object(truncated);
    }
}

fn shrink_strings(v: &mut Value) {
    for field in [
        "title",
        "branch",
        "cwd",
        "path",
        "fork_of",
        "last_assistant_text",
    ] {
        if let Some(s) = v.get(field).and_then(Value::as_str) {
            v[field] = json!(cap_chars(s, SHRINK_STRING_CHARS));
        }
    }
    if let Some(prompts) = v.get_mut("prompts").and_then(Value::as_array_mut) {
        for p in prompts {
            if let Some(s) = p.get("text").and_then(Value::as_str) {
                p["text"] = json!(cap_chars(s, SHRINK_STRING_CHARS));
            }
        }
    }
}

pub struct Outcome {
    pub lines: Vec<String>,
    pub tally: Tally,
}

pub fn run(req: &Request) -> Result<Outcome> {
    let mut tally = Tally::default();
    let mut sessions: Vec<Session> = Vec::new();
    for path in claude_files(req, &mut tally) {
        if mtime_ms(&path) < req.window.since_ms {
            tally.out_of_window += 1;
            continue;
        }
        let mut s = Session {
            provider: "claude",
            id: path
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.clone(),
            ..Default::default()
        };
        tally.files_read += 1;
        for_each_line(&path, &mut tally, |o| {
            feed_claude(&mut s, o, &req.window);
            true
        });
        sessions.push(s);
    }
    resolve_forks(&mut sessions, &mut tally);
    for path in codex_files(req, &mut tally) {
        let mut s = Session {
            provider: "codex",
            path: path.clone(),
            ..Default::default()
        };
        let mut saw_meta = false;
        tally.files_read += 1;
        for_each_line(&path, &mut tally, |o| {
            feed_codex(&mut s, o, &req.window, &mut saw_meta);
            true
        });
        if s.forked {
            tally.forks += 1;
        }
        sessions.push(s);
    }
    sessions.sort_by_key(|s| s.first_ms);

    let mut lines = Vec::new();
    let mut total = 0usize;
    for s in &sessions {
        if !s.in_window {
            tally.out_of_window += 1;
            continue;
        }
        if s.prompts.first().is_some_and(|p| is_review_run(&p.text)) {
            tally.self_runs_skipped += 1;
            continue;
        }
        let line = session_line(
            |p, d| session_value(s, p, d),
            &s.prompts,
            req.session_line_max,
        )?;
        total += line.len() + 1;
        lines.push(line);
    }
    if total > req.total_max {
        bail!(
            "the digest is {total} bytes for {} sessions, over the {} byte cap; narrow the \
             window with --since/--until",
            lines.len(),
            req.total_max
        );
    }
    Ok(Outcome { lines, tally })
}

/// Runs the digest and writes it only when the whole of it is within caps.
pub fn run_and_write(req: &Request, path: &Path) -> Result<Outcome> {
    let out = run(req)?;
    write_lines(path, &out.lines)?;
    Ok(out)
}

/// Written beside a temporary name and renamed, so a failed write never
/// leaves a partial `digest.jsonl` behind for the agent to read.
fn write_lines(path: &Path, lines: &[String]) -> Result<()> {
    let tmp = path.with_extension("jsonl.tmp");
    let mut body = lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    std::fs::write(&tmp, body).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(text: &str) -> Prompt {
        Prompt {
            at: "2026-09-12T10:00:00Z".into(),
            text: text.into(),
            uuid: None,
            queued: false,
        }
    }

    #[test]
    fn human_prompt_filter_matches_session_index() {
        for wrapper in [
            "<command-message>grilling</command-message>",
            "<local-command-caveat>Caveat: The messages below were generated</local-command-caveat>",
            "<local-command-stdout>ok</local-command-stdout>",
            "Base directory for this skill: /home/u/.claude/skills/grilling\n\n# Grilling",
            "<task-notification>\n<task-id>1</task-id>",
            "Caveat: The messages below were generated by the user while running local commands.",
            "<system-reminder>\nnote\n</system-reminder>",
            "[Request interrupted by user]",
            "   ",
        ] {
            assert_eq!(human_prompt(wrapper), None, "{wrapper:?} is not a person typing");
        }
        assert_eq!(
            human_prompt(
                "<command-name>/model</command-name>\n<command-message>model</command-message>"
            ),
            Some("CMD /model".to_string())
        );
        assert_eq!(
            human_prompt("Traz a branch pro meu checkout"),
            Some("Traz a branch pro meu checkout".to_string())
        );
    }

    #[test]
    fn friction_vocabulary_and_reasks_match_session_index() {
        for hit in [
            "wtf is this",
            "I didn't get it",
            "i dont get the point",
            "não entendi nada",
            "nao entendi",
            "why are you editing that",
            "why a subagent here?",
            "stop that now",
            "I don't want a PR",
            "too much text",
            "not what I asked",
            "you are not listening",
            "isso está errado",
            "não é isso",
            "[request interrupted by user] redo",
        ] {
            let (friction, _) = friction_and_reasks(&[prompt(hit)]);
            assert_eq!(friction.len(), 1, "{hit:?} is in the vocabulary");
        }
        let (friction, _) = friction_and_reasks(&[prompt("all good, ship it")]);
        assert!(friction.is_empty());

        let same = "please make the checkout my current branch now";
        let (_, reasks) = friction_and_reasks(&[prompt(same), prompt(same), prompt("other")]);
        assert_eq!(reasks, 1);
    }

    #[test]
    fn session_line_is_capped_keeping_first_and_last_prompts() {
        let prompts: Vec<Prompt> = (0..300)
            .map(|i| prompt(&format!("p{i:03} {}", "x".repeat(1020))))
            .collect();
        let s = Session {
            provider: "claude",
            id: "s".into(),
            ..Default::default()
        };
        let line =
            session_line(|p, d| session_value(&s, p, d), &prompts, SESSION_LINE_MAX).unwrap();
        assert!(line.len() <= SESSION_LINE_MAX, "{} bytes", line.len());
        let v: Value = serde_json::from_str(&line).unwrap();
        let kept = v["prompts"].as_array().unwrap();
        assert!(kept[0]["text"].as_str().unwrap().starts_with("p000"));
        assert!(kept.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .starts_with("p299"));
        assert!(v["prompts_dropped"].as_u64().unwrap() > 0);
        assert_eq!(
            v["prompts_dropped"].as_u64().unwrap() as usize + kept.len(),
            300
        );
    }

    #[test]
    fn task_sessions_are_labelled_from_the_task_brief() {
        let s = Session {
            provider: "claude",
            id: "s".into(),
            prompts: vec![prompt("Houston task HOU-42 (id 9): update parser")],
            ..Default::default()
        };
        let value = session_value(&s, &s.prompts, 0);
        assert_eq!(value["task"], "HOU-42");
        assert_eq!(task_key_from_prompt("ordinary user prompt"), None);
    }

    #[test]
    fn a_session_over_the_cap_through_its_collections_is_shrunk_below_it() {
        let mut s = Session {
            provider: "claude",
            id: "s".into(),
            ..Default::default()
        };
        for i in 0..4_000u64 {
            s.tools.insert(format!("mcp__server_{i:04}__some_tool"), i);
            s.subagents
                .push(json!({ "type": format!("agent-{i}"), "description": "d".repeat(40) }));
        }
        let prompts = [prompt("first ask"), prompt("last ask")];
        let unshrunk = session_value(&s, &prompts, 0).to_string().len();
        assert!(unshrunk > SESSION_LINE_MAX, "the fixture is over the cap");

        let line =
            session_line(|p, d| session_value(&s, p, d), &prompts, SESSION_LINE_MAX).unwrap();
        assert!(line.len() <= SESSION_LINE_MAX, "{} bytes", line.len());
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["prompts"].as_array().unwrap().len(), 2);
        let tools = v["tools"].as_object().unwrap();
        assert!(
            tools.contains_key("mcp__server_3999__some_tool"),
            "the largest counts are kept"
        );
        assert_eq!(
            v["truncated"]["tools"].as_u64().unwrap() as usize + tools.len(),
            4_000
        );
        assert_eq!(
            v["truncated"]["subagents"].as_u64().unwrap() as usize
                + v["subagents"].as_array().unwrap().len(),
            4_000
        );
    }

    #[test]
    fn a_session_that_cannot_fit_is_refused_naming_cap_and_size() {
        let s = Session {
            provider: "claude",
            id: "s".into(),
            ..Default::default()
        };
        let prompts = [prompt(&"a".repeat(600)), prompt(&"b".repeat(600))];
        let err = session_line(|p, d| session_value(&s, p, d), &prompts, 300)
            .unwrap_err()
            .to_string();
        assert!(err.contains("over the 300 byte per-session cap"), "{err}");
        assert!(err.contains("session \"s\""), "{err}");
        let size: usize = err
            .split("the digest line is ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse().ok())
            .expect("the error names the size");
        assert!(size > 300, "{err}");
    }

    #[test]
    fn review_run_launched_through_a_prompt_file_is_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let prompts = dir.path().join(".houston").join("prompts");
        std::fs::create_dir_all(&prompts).unwrap();
        let brief = prompts.join("prompt-session.md");
        std::fs::write(&brief, format!("{REVIEW_MARKER}\n\nWhat this run sends")).unwrap();
        let stub = format!(
            "Read the file {} and follow every instruction in it exactly. It is your full \
             mission brief for this job; start working immediately.",
            brief.display()
        );
        assert!(is_review_run(&stub));
        std::fs::write(&brief, "an ordinary brief").unwrap();
        assert!(!is_review_run(&stub));
        assert!(is_review_run(&format!("{REVIEW_MARKER}\nrest")));
        assert!(!is_review_run("Make the export button work"));
    }

    #[test]
    fn denied_input_is_bounded_and_masks_secrets() {
        let v = tool_input_summary(&json!({
            "command": "API_TOKEN=abc123 curl -H 'Authorization: Bearer s3cr3tv4lue' https://x"
        }));
        assert!(!v.contains("abc123") && !v.contains("s3cr3tv4lue"), "{v}");
        assert!(v.contains("curl"), "{v}");
        let long = tool_input_summary(&json!({ "command": "x".repeat(500) }));
        assert!(
            long.chars().count() <= DENIED_INPUT_CHARS + 1,
            "{}",
            long.len()
        );
        assert_eq!(
            tool_input_summary(&json!({ "file_path": "/a/b.md" })),
            "/a/b.md"
        );
    }

    #[test]
    fn a_url_password_longer_than_the_cap_is_masked_not_cut() {
        let password = "p".repeat(300);
        let v = tool_input_summary(&json!({
            "command": format!("curl https://alice:{password}@example.invalid/path")
        }));
        assert!(!v.contains("pppp"), "no part of the password survives: {v}");
        assert!(v.contains("[redacted:url_password]"), "{v}");
        assert!(v.chars().count() <= DENIED_INPUT_CHARS + 1, "{v}");
    }

    #[test]
    fn a_pasted_context_report_keeps_its_token_table() {
        let s = Session {
            provider: "claude",
            id: "s".into(),
            ..Default::default()
        };
        let table = format!(
            "## Context Usage\n\n{}| MCP tools (deferred) | 216k |",
            "x".repeat(4_000)
        );
        let ordinary = "y".repeat(4_000);
        let v = session_value(&s, &[prompt(&table), prompt(&ordinary)], 0);
        let texts: Vec<&str> = v["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect();
        assert!(
            texts[0].ends_with("| MCP tools (deferred) | 216k |"),
            "kept whole"
        );
        assert_eq!(
            texts[1].chars().count(),
            PROMPT_MAX_CHARS + 1,
            "capped with an ellipsis"
        );
    }

    fn claude_line(ts: &str, text: &str) -> String {
        json!({
            "type": "user", "uuid": format!("u-{ts}"), "timestamp": ts,
            "cwd": "/ws", "sessionId": "s",
            "message": { "role": "user", "content": text },
        })
        .to_string()
    }

    fn request<'a>(ws: &'a Path, root: &Path, total_max: usize) -> Request<'a> {
        Request {
            workspace: ws,
            claude_roots: vec![root.to_path_buf()],
            codex_roots: vec![],
            window: super::super::window::explicit("2026-09-10", "2026-09-17").unwrap(),
            session_line_max: SESSION_LINE_MAX,
            total_max,
        }
    }

    #[test]
    fn total_cap_refuses_without_partial_output() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(claude_slug(Path::new("/ws")));
        std::fs::create_dir_all(&dir).unwrap();
        for n in 0..3 {
            std::fs::write(
                dir.join(format!("s{n}.jsonl")),
                claude_line("2026-09-12T10:00:00Z", &"a long ask ".repeat(100)),
            )
            .unwrap();
        }
        let out = tempfile::tempdir().unwrap();
        let target = out.path().join("digest.jsonl");
        let err = run_and_write(&request(Path::new("/ws"), root.path(), 1_000), &target)
            .err()
            .expect("three sessions exceed a 1000 byte cap")
            .to_string();
        let expected = run(&request(Path::new("/ws"), root.path(), usize::MAX))
            .unwrap()
            .lines
            .iter()
            .map(|l| l.len() + 1)
            .sum::<usize>();
        assert!(
            err.contains(&format!("the digest is {expected} bytes")),
            "{err}"
        );
        assert!(err.contains("1000 byte cap"), "{err}");
        assert!(err.contains("3 sessions"), "{err}");
        assert!(!target.exists());
        assert!(!out.path().join("digest.jsonl.tmp").exists());
    }

    #[test]
    fn an_oversized_line_is_discarded_within_the_cap_and_reading_resumes() {
        let max = 64;
        let body = format!("short\n{}\nnext\nlast", "z".repeat(10_000));
        let mut reader = BufReader::with_capacity(16, body.as_bytes());
        let mut buf = Vec::new();
        let mut peak = 0;
        let mut lines = Vec::new();
        loop {
            let line = read_bounded_line(&mut reader, &mut buf, max).unwrap();
            peak = peak.max(buf.capacity());
            match line {
                Line::End => break,
                Line::Oversized => lines.push("<oversized>".to_string()),
                Line::Read => lines.push(String::from_utf8(buf.clone()).unwrap()),
            }
        }
        assert_eq!(lines, ["short\n", "<oversized>", "next\n", "last"]);
        assert!(
            peak <= 2 * (max + 1),
            "the buffer grew to {peak} bytes for a {max} byte cap"
        );
    }

    #[test]
    fn oversized_lines_are_skipped_and_counted() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(claude_slug(Path::new("/ws")));
        std::fs::create_dir_all(&dir).unwrap();
        let big = claude_line("2026-09-12T10:00:01Z", &"z".repeat(9 * 1024 * 1024));
        let body = format!(
            "{}\n{}\n{}\n",
            claude_line("2026-09-12T10:00:00Z", "first ask"),
            big,
            claude_line("2026-09-12T10:00:02Z", "second ask")
        );
        std::fs::write(dir.join("s.jsonl"), body).unwrap();
        let out = run(&request(Path::new("/ws"), root.path(), DIGEST_TOTAL_MAX)).unwrap();
        assert_eq!(out.tally.oversized_lines, 1);
        let v: Value = serde_json::from_str(&out.lines[0]).unwrap();
        let texts: Vec<&str> = v["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["first ask", "second ask"]);
    }
}

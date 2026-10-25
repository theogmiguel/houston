//! A redacted diagnostics file for bug reports, written under the state directory.
//! It holds versions, a roster without titles, paths or output, hook health and the
//! recent daemon log; nothing here uploads it.
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use aho_corasick::AhoCorasick;
use anyhow::{Context, Result};
use houston_protocol as proto;
use serde::Serialize;

/// Small enough to attach to an issue; the log tail takes whatever the rest leaves.
pub const FILE_MAX_BYTES: usize = 1024 * 1024;
const KEEP_FILES: usize = 5;
const ROSTER_MAX: usize = 1000;
const APP_VERSION_MAX_CHARS: usize = 64;
const FILE_PREFIX: &str = "houston-diagnostics-";
/// Shorter titles are ordinary words; replacing them would garble every log line.
const TITLE_MIN_CHARS: usize = 3;
/// Log messages whose remainder is a candidate pane title that was never applied, so the
/// roster cannot name it. Everything after the marker is dropped.
const TITLE_MARKERS: &[(&str, &str)] = &[
    ("from its first prompt (", "<title>)"),
    ("from its CLI's window title (", "<title>)"),
    ("invalid session title ", "<title>"),
];

pub struct Inputs<'a> {
    pub generated: time::OffsetDateTime,
    pub app_version: &'a str,
    pub daemon_version: &'a str,
    pub build_commit: &'a str,
    pub channel: &'a str,
    pub uptime: Duration,
    pub sessions: &'a [proto::SessionInfo],
    pub hooks: &'a [proto::AgentHookState],
    /// Raw daemon log lines, oldest first.
    pub log_lines: &'a [String],
    /// Registered workspace folders, numbered in this order.
    pub workspaces: &'a [String],
    pub worktrees: &'a [String],
    /// Every home directory spelling the daemon knows: `HOME`, `USERPROFILE`, canonical.
    pub homes: &'a [PathBuf],
}

struct Rule {
    replacement: String,
    /// Titles and hosts also need a word boundary before the match; paths only after it.
    word: bool,
}

/// Replaces the folders, titles and hosts the daemon knows with placeholders. On
/// Windows, paths match ASCII case-insensitively in every spelling a log line uses.
pub struct Redactor {
    matcher: Option<AhoCorasick>,
    rules: Vec<Rule>,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Display, forward-slash and `{:?}` (doubled backslash) forms, without a verbatim
/// prefix or trailing separator; on Windows also the `/c/...` and `C:\...` twins.
fn spellings(path: &str, windows: bool) -> Vec<String> {
    let base = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    };
    let base = base.trim_end_matches(['/', '\\']).to_string();
    let mut bases = vec![base.clone()];
    let bytes = base.as_bytes();
    if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let rest = base[2..].replace('\\', "/");
        bases.push(format!(
            "/{}{rest}",
            (bytes[0] as char).to_ascii_lowercase()
        ));
    } else if windows
        && bytes.len() > 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
    {
        let rest = base[2..].replace('/', "\\");
        bases.push(format!(
            "{}:{rest}",
            (bytes[1] as char).to_ascii_uppercase()
        ));
    }
    let mut out = Vec::new();
    for b in bases {
        if b.contains('\\') {
            out.push(b.replace('\\', "/"));
            out.push(b.replace('\\', r"\\"));
        }
        out.push(b);
    }
    out.retain(|s| s.chars().count() >= 3);
    out
}

/// `path` with separators, verbatim prefix and (on Windows) case normalised, for
/// deciding whether one folder lies inside another.
fn folded(path: &str, windows: bool) -> String {
    let path = path
        .strip_prefix(r"\\?\")
        .unwrap_or(path)
        .replace('\\', "/");
    let path = path.trim_end_matches('/');
    if windows {
        path.to_ascii_lowercase()
    } else {
        path.to_string()
    }
}

impl Redactor {
    pub fn new(i: &Inputs) -> Self {
        Self::for_platform(i, cfg!(windows))
    }

    pub fn for_platform(i: &Inputs, windows: bool) -> Self {
        let mut needles: Vec<(String, Rule)> = Vec::new();
        let path = |needles: &mut Vec<(String, Rule)>, path: &str, replacement: &str| {
            for spelling in spellings(path, windows) {
                needles.push((
                    spelling,
                    Rule {
                        replacement: replacement.to_string(),
                        word: false,
                    },
                ));
            }
        };
        let mut roots: Vec<String> = Vec::new();
        for (n, ws) in i.workspaces.iter().enumerate() {
            path(&mut needles, ws, &format!("<workspace {}>", n + 1));
            roots.push(folded(ws, windows));
        }
        for (n, wt) in i.worktrees.iter().enumerate() {
            path(&mut needles, wt, &format!("<worktree {}>", n + 1));
            roots.push(folded(wt, windows));
        }
        let mut folders = 0;
        for s in i.sessions {
            let worktree = s.worktree.as_ref();
            for dir in [Some(&s.project_dir), Some(&s.cwd), s.checkout_root.as_ref()]
                .into_iter()
                .chain([
                    worktree.map(|w| &w.path),
                    worktree.map(|w| &w.repo_common_dir),
                ])
                .chain([s.checkout.as_ref().map(|c| &c.root)])
                .flatten()
            {
                let f = folded(dir, windows);
                let inside = roots.iter().any(|r| {
                    f == *r
                        || f.strip_prefix(r.as_str())
                            .is_some_and(|t| t.starts_with('/'))
                });
                if !inside && !f.is_empty() {
                    folders += 1;
                    path(&mut needles, dir, &format!("<folder {folders}>"));
                    roots.push(f);
                }
            }
        }
        for home in i.homes {
            path(&mut needles, &home.display().to_string(), "~");
        }
        let word = |replacement: &str| Rule {
            replacement: replacement.to_string(),
            word: true,
        };
        for s in i.sessions {
            let title = s.title.trim();
            if s.title_source != proto::TitleSource::Codename
                && title.chars().count() >= TITLE_MIN_CHARS
            {
                let debug = format!("{title:?}");
                let escaped = &debug[1..debug.len() - 1];
                if escaped != title {
                    needles.push((escaped.to_string(), word("<title>")));
                }
                needles.push((title.to_string(), word("<title>")));
            }
            if let Some(host) = s.ssh_host.as_deref().filter(|h| !h.is_empty()) {
                needles.push((host.to_string(), word("<host>")));
            }
        }
        let mut seen = HashSet::new();
        needles.retain(|(n, _)| {
            seen.insert(if windows {
                n.to_ascii_lowercase()
            } else {
                n.clone()
            })
        });
        let matcher = (!needles.is_empty())
            .then(|| {
                AhoCorasick::builder()
                    .ascii_case_insensitive(windows)
                    .build(needles.iter().map(|(n, _)| n))
                    .inspect_err(|e| tracing::warn!("diagnostics: building the redactor: {e}"))
                    .ok()
            })
            .flatten();
        Self {
            matcher,
            rules: needles.into_iter().map(|(_, rule)| rule).collect(),
        }
    }

    /// The leftmost, then longest, match that sits on a boundary wins at each position.
    pub fn apply(&self, text: &str) -> String {
        let mut text = text.to_string();
        for (marker, replacement) in TITLE_MARKERS {
            if let Some(at) = text.find(marker) {
                text.truncate(at + marker.len());
                text.push_str(replacement);
            }
        }
        let Some(matcher) = &self.matcher else {
            return text;
        };
        let mut hits: Vec<(usize, usize, usize)> = matcher
            .find_overlapping_iter(&text)
            .filter(|m| {
                let rule = &self.rules[m.pattern().as_usize()];
                let after = text[m.end()..].chars().next();
                let before = text[..m.start()].chars().next_back();
                !after.is_some_and(is_word) && !(rule.word && before.is_some_and(is_word))
            })
            .map(|m| (m.start(), m.end(), m.pattern().as_usize()))
            .collect();
        hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for (start, end, rule) in hits {
            if start < last {
                continue;
            }
            out.push_str(&text[last..start]);
            out.push_str(&self.rules[rule].replacement);
            last = end;
        }
        out.push_str(&text[last..]);
        out
    }
}

/// Control characters go first, so no escape sequence survives; then the known
/// folders, titles and hosts, and every secret shape `sanitize` knows.
pub fn scrub(line: &str, redactor: &Redactor) -> String {
    let text: String = line
        .chars()
        .filter(|c| *c == '\t' || !c.is_control())
        .collect();
    crate::sanitize::redact_diagnostics(&redactor.apply(&text))
}

fn word<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => "?".to_string(),
    }
}

fn stamp(t: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

fn uptime(d: Duration) -> String {
    let minutes = d.as_secs() / 60;
    format!("{}h {}m", minutes / 60, minutes % 60)
}

fn session_line(s: &proto::SessionInfo) -> String {
    let mut line = format!(
        "  #{} agent={} state={} status={}",
        s.id,
        word(&s.agent),
        word(&s.state),
        s.status.as_ref().map_or("-".to_string(), word)
    );
    if let Some(running) = &s.running_agent {
        line.push_str(&format!(" running={}", word(running)));
    }
    if let Some(parent) = s.spawned_by {
        line.push_str(&format!(" child-of=#{parent}"));
    }
    if let Some(reason) = &s.restore_deferred {
        line.push_str(&format!(" deferred={}", word(reason)));
    }
    for (flag, on) in [
        ("hidden", s.hidden),
        ("acp", s.acp.is_some()),
        ("ssh", s.ssh_host.is_some()),
        ("worktree", s.worktree.is_some()),
    ] {
        if on {
            line.push(' ');
            line.push_str(flag);
        }
    }
    line
}

fn hook_line(h: &proto::AgentHookState, redactor: &Redactor) -> String {
    let mut line = format!(
        "  {}: {}, {}",
        word(&h.provider),
        if h.enabled { "enabled" } else { "disabled" },
        if h.installed {
            "installed"
        } else {
            "not installed"
        }
    );
    if !h.present {
        line.push_str(", CLI not found");
    }
    if let Some(version) = &h.version {
        line.push_str(&format!(", version {version}"));
    }
    if let Some(trust) = &h.trust {
        line.push_str(&format!(", trust {}", word(trust)));
    }
    line.push_str(&format!(", config {}", h.path));
    if let Some(error) = &h.error {
        line.push_str(&format!(", error: {error}"));
    }
    scrub(&line, redactor)
}

/// The whole file, at most `FILE_MAX_BYTES`: the oldest log lines are left out first.
pub fn compose(i: &Inputs) -> String {
    let redactor = Redactor::new(i);
    let app_version: String = i.app_version.chars().take(APP_VERSION_MAX_CHARS).collect();
    let mut head = vec![
        "Houston diagnostics".to_string(),
        format!("Generated: {}", stamp(i.generated)),
        format!("App: {}", scrub(&app_version, &redactor)),
        format!("Daemon: {} (build {})", i.daemon_version, i.build_commit),
        format!("Protocol: {}", proto::PROTOCOL_VERSION),
        format!("Channel: {}", i.channel),
        format!(
            "Platform: {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        format!("Uptime: {}", uptime(i.uptime)),
        String::new(),
        "This file stays on this computer until you attach it somewhere. It holds no terminal \
         output. Redaction is best-effort: known secret shapes, the home directory, workspace and \
         worktree folders, pane titles and SSH hosts are replaced, but log lines can still name \
         branches, files, routines and profiles. Read it before you share it."
            .to_string(),
        String::new(),
        format!("Sessions ({})", i.sessions.len()),
    ];
    head.extend(i.sessions.iter().take(ROSTER_MAX).map(session_line));
    if i.sessions.len() > ROSTER_MAX {
        head.push(format!(
            "  ... {} more not listed",
            i.sessions.len() - ROSTER_MAX
        ));
    }
    head.push(String::new());
    head.push(format!("Hooks ({})", i.hooks.len()));
    head.extend(i.hooks.iter().map(|h| hook_line(h, &redactor)));
    head.push(String::new());
    let mut out = head.join("\n");

    let mut budget = FILE_MAX_BYTES.saturating_sub(out.len() + 64);
    let mut tail: Vec<String> = Vec::new();
    for raw in i.log_lines.iter().rev() {
        let line = scrub(raw, &redactor);
        if line.len() + 1 > budget {
            break;
        }
        budget -= line.len() + 1;
        tail.push(line);
    }
    tail.reverse();
    out.push_str(&format!(
        "\nDaemon log (last {} of {} lines)\n",
        tail.len(),
        i.log_lines.len()
    ));
    for line in tail {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// The newest `budget` bytes across the rolling `houston-core*.log` files, oldest
/// line first. A file is read from its end, so a large log costs only the tail.
pub fn read_log_tail(dir: &Path, budget: u64) -> Vec<String> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("houston-core") && n.ends_with(".log"))
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    files.sort();
    let mut remaining = budget;
    let mut chunks: Vec<String> = Vec::new();
    for path in files.iter().rev() {
        if remaining == 0 {
            break;
        }
        let Ok(mut file) = fs::File::open(path) else {
            continue;
        };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let take = len.min(remaining);
        if file.seek(SeekFrom::Start(len - take)).is_err() {
            continue;
        }
        let mut bytes = Vec::with_capacity(take as usize);
        if file.take(take).read_to_end(&mut bytes).is_err() {
            continue;
        }
        remaining -= take;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if take < len {
            text = text
                .split_once('\n')
                .map_or(String::new(), |(_, rest)| rest.to_string());
        }
        chunks.push(text);
    }
    chunks
        .iter()
        .rev()
        .flat_map(|c| c.lines())
        .map(str::to_string)
        .collect()
}

/// Writes `text` as a new file in `dir` and keeps only the newest `KEEP_FILES`.
pub fn write(dir: &Path, generated: time::OffsetDateTime, text: &str) -> Result<PathBuf> {
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let name = format!(
        "{FILE_PREFIX}{}.txt",
        stamp(generated).replace(['-', ':'], "")
    );
    let path = dir.join(name);
    fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    let mut old: Vec<PathBuf> = fs::read_dir(dir)
        .with_context(|| format!("listing {}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(FILE_PREFIX) && n.ends_with(".txt"))
        })
        .collect();
    old.sort();
    let excess = old.len().saturating_sub(KEEP_FILES);
    for stale in old.into_iter().take(excess) {
        if let Err(e) = fs::remove_file(&stale) {
            tracing::warn!("diagnostics: removing {}: {e}", stale.display());
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at() -> time::OffsetDateTime {
        time::OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap()
    }

    fn inputs<'a>(
        log: &'a [String],
        hooks: &'a [proto::AgentHookState],
        homes: &'a [PathBuf],
    ) -> Inputs<'a> {
        Inputs {
            generated: at(),
            app_version: "0.19.9",
            daemon_version: "0.19.9",
            build_commit: "abc1234",
            channel: "dev",
            uptime: Duration::from_secs(3 * 3600 + 120),
            sessions: &[],
            hooks,
            log_lines: log,
            workspaces: &[],
            worktrees: &[],
            homes,
        }
    }

    fn session(id: u32, cwd: &str, title: &str, source: &str) -> proto::SessionInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "agent": "claude", "project_dir": cwd, "cwd": cwd,
            "state": "running", "title": title, "title_source": source,
            "ssh_host": "build-box.internal",
        }))
        .unwrap()
    }

    #[test]
    fn windows_home_spellings_are_redacted_in_every_case_and_separator_form() {
        let homes = [
            PathBuf::from("/c/Users/Someone"),
            PathBuf::from(r"C:\Users\Someone"),
        ];
        let i = inputs(&[], &[], &homes);
        let redactor = Redactor::for_platform(&i, true);
        for line in [
            r"opened c:\users\someone\notes.md",
            r#"opening "C:\\Users\\Someone\\AppData\\x.json": denied"#,
            r"reading \\?\C:\Users\SOMEONE\.claude.json",
            "watching C:/Users/Someone/src",
            "HOME is /c/Users/someone",
        ] {
            let out = redactor.apply(line);
            assert!(
                !out.to_ascii_lowercase().contains("someone"),
                "{line} -> {out}"
            );
            assert!(out.contains('~'), "{line} -> {out}");
        }
        assert_eq!(
            redactor.apply(r"C:\Users\Someone2\x"),
            r"C:\Users\Someone2\x",
            "a sibling folder is not this home"
        );
    }

    #[test]
    fn workspace_worktree_folder_title_and_host_names_become_placeholders() {
        let workspaces = ["/srv/acme".to_string(), "/srv/acme-portal".to_string()];
        let worktrees = ["/srv/acme/.houston/worktrees/payroll-fix".to_string()];
        let sessions = [
            session(
                1,
                "/srv/acme/.houston/worktrees/payroll-fix",
                "Quarterly payroll",
                "user",
            ),
            session(2, "/opt/side-project", "keen-otter", "codename"),
        ];
        let homes = [PathBuf::from("/home/someone")];
        let mut i = inputs(&[], &[], &homes);
        i.sessions = &sessions;
        i.workspaces = &workspaces;
        i.worktrees = &worktrees;
        let r = Redactor::for_platform(&i, false);
        let cases = [
            ("removing workspace /srv/acme", "removing workspace <workspace 1>"),
            ("queue of /srv/acme-portal: idle", "queue of <workspace 2>: idle"),
            (
                "editing /srv/acme/.houston/worktrees/payroll-fix/src/a.rs",
                "editing <worktree 1>/src/a.rs",
            ),
            ("cwd /opt/side-project/bin", "cwd <folder 1>/bin"),
            ("/srv/acme-other stays", "/srv/acme-other stays"),
            ("renamed to \"Quarterly payroll\"", "renamed to \"<title>\""),
            ("keen-otter is a codename", "keen-otter is a codename"),
            ("ssh to build-box.internal failed", "ssh to <host> failed"),
            (
                "naming pane 3 from its CLI's window title (\"Secret plan\"): invalid session title \"Secret plan\"",
                "naming pane 3 from its CLI's window title (<title>)",
            ),
            ("bad: invalid session title \"x y\": expected", "bad: invalid session title <title>"),
        ];
        for (line, want) in cases {
            assert_eq!(r.apply(line), want, "{line}");
        }
    }

    #[test]
    fn seeded_secrets_and_the_home_directory_never_reach_the_file() {
        let homes = [PathBuf::from("/home/someone")];
        let secrets = [
            "ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-123456789012-abcdefghijkl",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
            "hunter2pass",
            "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpL",
            "sk-ant-api03-Qx7Lm2Np9Rt4Vw8Yz1Bc5Df3Gh6Jk0Mn",
        ];
        let log = vec![
            format!("token: {}", secrets[0]),
            format!("aws {}", secrets[1]),
            format!("slack {}", secrets[2]),
            format!("Authorization: Bearer {}", secrets[3]),
            format!("https://user:{}@example.com/repo.git", secrets[4]),
            format!("OPENAI_API_KEY={}", secrets[5]),
            format!("key {}", secrets[6]),
            "opened /home/someone/project/notes.md".to_string(),
            "escape \u{1b}[31mred\u{1b}[0m bell \u{7}".to_string(),
        ];
        let hooks = [proto::AgentHookState {
            provider: proto::AgentKind::Claude,
            path: "/home/someone/.claude/settings.json".into(),
            scope: proto::AgentHookScope::Global,
            enabled: true,
            installed: false,
            error: Some(format!("write failed for PASSWORD={}", secrets[4])),
            present: true,
            version: Some("2.1.0".into()),
            trust: None,
        }];
        let text = compose(&inputs(&log, &hooks, &homes));
        for secret in secrets {
            assert!(!text.contains(secret), "{secret} leaked:\n{text}");
        }
        assert!(!text.contains("/home/someone"), "{text}");
        assert!(text.contains("~/project/notes.md"), "{text}");
        assert!(text.contains("config ~/.claude/settings.json"), "{text}");
        assert!(
            !text.contains('\u{1b}') && !text.contains('\u{7}'),
            "{text}"
        );
        assert!(text.contains("Daemon log (last 9 of 9 lines)"), "{text}");
    }

    #[test]
    fn the_file_stays_under_the_cap_and_keeps_the_newest_log_lines() {
        let log: Vec<String> = (0..40_000)
            .map(|n| format!("line {n:05} {}", "x".repeat(60)))
            .collect();
        let text = compose(&inputs(&log, &[], &[]));
        assert!(text.len() <= FILE_MAX_BYTES, "{} bytes", text.len());
        assert!(text.contains("line 39999"));
        assert!(!text.contains("line 00000"));
    }

    #[test]
    fn the_log_tail_reads_only_the_newest_bytes_across_rolled_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("houston-core.2026-10-23.log"),
            "old one\nold two\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("houston-core.2026-10-24.log"),
            "new one\nnew two\n",
        )
        .unwrap();
        fs::write(dir.path().join("other.log"), "not a daemon log\n").unwrap();
        assert_eq!(
            read_log_tail(dir.path(), 1 << 20),
            vec!["old one", "old two", "new one", "new two"]
        );
        // 20 bytes: all 16 of the newest file and a partial line of the older one, dropped.
        assert_eq!(read_log_tail(dir.path(), 20), vec!["new one", "new two"]);
        assert!(read_log_tail(&dir.path().join("missing"), 100).is_empty());
    }

    #[test]
    fn writing_keeps_only_the_newest_files() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(KEEP_FILES as i64 + 2) {
            write(dir.path(), at() + time::Duration::seconds(n), "x").unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), KEEP_FILES);
        assert!(names[0].ends_with(&format!(
            "{}.txt",
            stamp(at() + time::Duration::seconds(2)).replace(['-', ':'], "")
        )));
    }
}

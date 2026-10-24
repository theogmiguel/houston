//! A redacted diagnostics file for bug reports, written under the state directory.
//! It holds versions, a roster without titles, paths or output, hook health and the
//! recent daemon log; nothing here uploads it.
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use houston_protocol as proto;
use serde::Serialize;

/// Small enough to attach to an issue; the log tail takes whatever the rest leaves.
pub const FILE_MAX_BYTES: usize = 1024 * 1024;
const KEEP_FILES: usize = 5;
const ROSTER_MAX: usize = 1000;
const APP_VERSION_MAX_CHARS: usize = 64;
const FILE_PREFIX: &str = "houston-diagnostics-";

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
    pub home: Option<&'a Path>,
}

/// Control characters go first, so no escape sequence survives; then every secret
/// shape `sanitize` knows, and the home directory becomes `~`.
pub fn scrub(line: &str, home: Option<&Path>) -> String {
    let mut text: String = line
        .chars()
        .filter(|c| *c == '\t' || !c.is_control())
        .collect();
    if let Some(home) = home.map(|h| h.display().to_string()) {
        if home.len() > 1 {
            text = text.replace(&home, "~");
            text = text.replace(&home.replace('\\', "/"), "~");
        }
    }
    crate::sanitize::redact_diagnostics(&text)
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

fn hook_line(h: &proto::AgentHookState, home: Option<&Path>) -> String {
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
    scrub(&line, home)
}

/// The whole file, at most `FILE_MAX_BYTES`: the oldest log lines are left out first.
pub fn compose(i: &Inputs) -> String {
    let app_version: String = i.app_version.chars().take(APP_VERSION_MAX_CHARS).collect();
    let mut head = vec![
        "Houston diagnostics".to_string(),
        format!("Generated: {}", stamp(i.generated)),
        format!("App: {}", scrub(&app_version, i.home)),
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
         output, pane titles or working directories; secrets and the home directory are redacted."
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
    head.extend(i.hooks.iter().map(|h| hook_line(h, i.home)));
    head.push(String::new());
    let mut out = head.join("\n");

    let mut budget = FILE_MAX_BYTES.saturating_sub(out.len() + 64);
    let mut tail: Vec<String> = Vec::new();
    for raw in i.log_lines.iter().rev() {
        let line = scrub(raw, i.home);
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
        home: Option<&'a Path>,
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
            home,
        }
    }

    #[test]
    fn seeded_secrets_and_the_home_directory_never_reach_the_file() {
        let home = Path::new("/home/someone");
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
        let text = compose(&inputs(&log, &hooks, Some(home)));
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
        let text = compose(&inputs(&log, &[], None));
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

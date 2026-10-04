//! `hs-harness`: the extractor a harness review run calls from inside its
//! pane. The daemon never runs it; see carve-out #6 in `invariants.md`.
pub mod digest;
pub mod findings;
pub mod inventory;
pub mod window;

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

/// Set by the daemon in a routine run's pane; its presence is what lets the
/// digest read transcripts at all.
pub const RUN_ENV: &str = "HOUSTON_ROUTINE_RUN";
const READABLE: [&str; 2] = ["claude", "codex"];
const REFUSED: [&str; 5] = ["opencode", "cursor", "grok", "antigravity", "zcode"];

const USAGE: &str = "usage: hs-harness <command> [flags]

commands:
  inventory [--workspace DIR] [--run ID]
      write inventory.json: instruction files, rules, skills, settings, MCP, agents
  digest [--workspace DIR] [--run ID] [--since YYYY-MM-DD --until YYYY-MM-DD]
         [--provider claude,codex]
      write digest.jsonl (one line per session) and digest-meta.json;
      only inside a Harness review routine run
  publish [--summary TEXT]
      hand this run's report.md and findings.json to Houston's Harness view;
      only inside a Harness review routine run

Output goes to <workspace>/.houston/harness/<run>/.";

pub fn run_cli(args: &[String]) -> i32 {
    match cli(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("hs-harness: {e:#}");
            2
        }
    }
}

fn cli(args: &[String]) -> Result<()> {
    let (positional, flags) = crate::orchestrate::parse_flags(args);
    let flag = |k: &str| flags.get(k).map(String::as_str);
    let workspace = || workspace_dir(flag("workspace"));
    match positional.first().map(String::as_str) {
        Some("inventory") => {
            let ws = workspace()?;
            let dir = run_dir(&ws, flag("run"))?;
            let home = crate::home_dir::home_dir();
            let now = window::format_ms(crate::usage::time::now_ms());
            let inv = inventory::build(&ws, home.as_deref(), &now);
            let path = dir.join("inventory.json");
            write_json(&path, &inv)?;
            println!("{}", path.display());
            Ok(())
        }
        Some("digest") => digest_cmd(flag("workspace"), &flags),
        Some("publish") => publish_cmd(flag("summary")),
        _ => bail!("{USAGE}"),
    }
}

fn workspace_dir(flag: Option<&str>) -> Result<PathBuf> {
    let raw = match flag {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir().context("reading the current directory")?,
    };
    let ws = std::fs::canonicalize(&raw)
        .map_err(|e| anyhow!("workspace {} is not a directory: {e}", raw.display()))?;
    if !ws.is_dir() {
        bail!("workspace {} is not a directory", ws.display());
    }
    Ok(ws)
}

fn run_id(flag: Option<&str>) -> Result<String> {
    let id = match (flag, std::env::var(RUN_ENV).ok().filter(|v| !v.is_empty())) {
        (Some(id), _) => id.to_string(),
        (None, Some(run)) => format!("r{run}"),
        (None, None) => {
            let stamp = window::format_ms(crate::usage::time::now_ms());
            format!("manual-{}", stamp.replace([':', '-'], ""))
        }
    };
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("run id {id:?} may only hold letters, digits, '-' and '_'");
    }
    Ok(id)
}

fn harness_root(ws: &Path) -> PathBuf {
    ws.join(crate::paths::PROJECT_DIR).join("harness")
}

fn run_dir(ws: &Path, flag: Option<&str>) -> Result<PathBuf> {
    prepare_run_dir(ws, &run_id(flag)?)
}

/// `<ws>/.houston/harness/<run>`, created with the ignore file beside it.
pub fn prepare_run_dir(ws: &Path, run: &str) -> Result<PathBuf> {
    let root = harness_root(ws);
    let dir = root.join(run);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n")
            .with_context(|| format!("writing {}", gitignore.display()))?;
    }
    Ok(dir)
}

fn write_json(path: &Path, v: &Value) -> Result<()> {
    let body = serde_json::to_string_pretty(v)? + "\n";
    std::fs::write(path, body).with_context(|| format!("writing {}", path.display()))
}

fn providers(flag: Option<&str>) -> Result<Vec<&'static str>> {
    let Some(list) = flag else {
        return Ok(READABLE.to_vec());
    };
    let mut out = Vec::new();
    for name in list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let lower = name.to_ascii_lowercase();
        if REFUSED.contains(&lower.as_str()) {
            bail!(
                "{name} is refused: a harness review reads Claude and Codex transcripts only, \
                 whose format Houston knows; {name}'s sessions are not read"
            );
        }
        match READABLE.iter().find(|r| **r == lower) {
            Some(r) => out.push(*r),
            None => bail!("unknown provider {name:?}; accepted: claude, codex"),
        }
    }
    if out.is_empty() {
        bail!("--provider named no provider; accepted: claude, codex");
    }
    Ok(out)
}

/// The end of the most recent earlier run's window, from its meta file.
fn previous_until(ws: &Path, this_run: &Path) -> Option<i64> {
    let entries = std::fs::read_dir(harness_root(ws)).ok()?;
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != this_run)
        .filter_map(|p| std::fs::read_to_string(p.join("digest-meta.json")).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter_map(|v| v.pointer("/window/until_ms").and_then(Value::as_i64))
        .max()
}

fn claude_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        roots.push(crate::usage::root_under_config_dir(
            houston_protocol::UsageProvider::Claude,
            Path::new(&dir),
        ));
    }
    if let Some(home) = home {
        let default = crate::usage::default_root(houston_protocol::UsageProvider::Claude, home);
        if !roots.contains(&default) {
            roots.push(default);
        }
    }
    roots
}

fn codex_roots(home: Option<&Path>) -> Vec<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return vec![crate::usage::root_under_config_dir(
            houston_protocol::UsageProvider::Codex,
            Path::new(&dir),
        )];
    }
    home.map(|h| crate::usage::default_root(houston_protocol::UsageProvider::Codex, h))
        .into_iter()
        .collect()
}

fn cleanup_period_days(home: Option<&Path>) -> Option<i64> {
    let text = std::fs::read_to_string(home?.join(".claude").join("settings.json")).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("cleanupPeriodDays")
        .and_then(Value::as_i64)
}

fn digest_cmd(
    workspace_flag: Option<&str>,
    flags: &std::collections::HashMap<String, String>,
) -> Result<()> {
    if std::env::var(RUN_ENV).map_or(true, |v| v.is_empty()) {
        bail!(
            "digest reads session transcripts, so it runs only inside a Harness review routine \
             run (carve-out #6 in docs/internals/invariants.md); {RUN_ENV} is not set in this \
             environment"
        );
    }
    let flag = |k: &str| flags.get(k).map(String::as_str);
    let providers = providers(flag("provider"))?;
    let ws = workspace_dir(workspace_flag)?;
    let now = crate::usage::time::now_ms();
    let (window, mode) = match (flag("since"), flag("until")) {
        (Some(since), Some(until)) => (window::explicit(since, until)?, "explicit"),
        (None, None) => (
            window::Window {
                since_ms: 0,
                until_ms: 0,
            },
            "automatic",
        ),
        _ => {
            bail!("--since and --until go together; pass both, or neither for the automatic window")
        }
    };
    let dir = run_dir(&ws, flag("run"))?;
    let previous = previous_until(&ws, &dir);
    let window = if mode == "automatic" {
        window::automatic(now, previous)
    } else {
        window
    };
    let home = crate::home_dir::home_dir();
    let req = digest::Request {
        workspace: &ws,
        claude_roots: if providers.contains(&"claude") {
            claude_roots(home.as_deref())
        } else {
            Vec::new()
        },
        codex_roots: if providers.contains(&"codex") {
            codex_roots(home.as_deref())
        } else {
            Vec::new()
        },
        window,
        session_line_max: digest::SESSION_LINE_MAX,
        total_max: digest::DIGEST_TOTAL_MAX,
    };
    let out = digest::run_and_write(&req, &dir.join("digest.jsonl"))?;
    let t = &out.tally;
    let bytes: usize = out.lines.iter().map(|l| l.len() + 1).sum();
    let meta = json!({
        "v": 1,
        "workspace": ws.to_string_lossy(),
        "run": dir.file_name().map(|n| n.to_string_lossy().into_owned()),
        "generated_at": window::format_ms(now),
        "providers": providers,
        "window": {
            "requested": [window::format_ms(window.since_ms), window::format_ms(window.until_ms)],
            "mode": mode,
            "since": window::format_ms(window.since_ms),
            "until": window::format_ms(window.until_ms),
            "since_ms": window.since_ms,
            "until_ms": window.until_ms,
            "previous_run_until": previous.map(window::format_ms),
            "available_from": t.available_from_ms.map(window::format_ms),
        },
        "cleanup_period_days": cleanup_period_days(home.as_deref()),
        "sessions_written": out.lines.len(),
        "files_listed": t.files_listed,
        "files_read": t.files_read,
        "unreadable_files": t.unreadable_files,
        "out_of_window": t.out_of_window,
        "self_runs_skipped": t.self_runs_skipped,
        "forks": t.forks,
        "oversized_lines": t.oversized_lines,
        "bytes": bytes,
        "caps": { "session_line": digest::SESSION_LINE_MAX, "total": digest::DIGEST_TOTAL_MAX },
    });
    write_json(&dir.join("digest-meta.json"), &meta)?;
    println!(
        "{} sessions, {} bytes, window {} .. {} -> {}",
        out.lines.len(),
        bytes,
        window::format_ms(window.since_ms),
        window::format_ms(window.until_ms),
        dir.display()
    );
    Ok(())
}

/// The CLI door to the daemon's `harness_publish`, for a CLI without MCP.
fn publish_cmd(summary: Option<&str>) -> Result<()> {
    let outside = |var: &str| {
        anyhow!("{var} is not set; hs-harness publish runs only inside a Harness review run's pane")
    };
    let url = std::env::var("HOUSTON_MCP_URL").map_err(|_| outside("HOUSTON_MCP_URL"))?;
    let token = std::env::var("HOUSTON_MCP_TOKEN").map_err(|_| outside("HOUSTON_MCP_TOKEN"))?;
    let base = crate::orchestrate::cli_base_url(Some(&url))?;
    let v = crate::orchestrate::cli_call(
        &base,
        &token,
        "POST",
        "/harness/publish",
        Some(json!({ "summary": summary })),
        crate::orchestrate::CLI_HTTP_TIMEOUT,
    )?;
    println!("{}", v["note"].as_str().unwrap_or_default());
    Ok(())
}

//! What Setup finds in the repository so the user does not type it: the
//! checks CI already runs. Reading is bounded; nothing here runs a command.
use std::collections::HashSet;
use std::path::Path;

use houston_protocol::NightCheck;
use serde_yaml::Value;

use super::settings::CHECKS_MAX;

/// A workflow or manifest larger than this is not read.
const FILE_MAX_BYTES: u64 = 512 * 1024;
const WORKFLOWS_MAX: usize = 20;
/// This many safety scripts of one job become one command, so a repository
/// with dozens of them does not crowd out its other checks.
const SCRIPT_GROUP_MIN: usize = 3;

fn read(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    (meta.is_file() && meta.len() <= FILE_MAX_BYTES)
        .then(|| std::fs::read_to_string(path).ok())
        .flatten()
}

fn words(cmd: &str) -> Vec<&str> {
    cmd.split_whitespace().collect()
}

/// A safety script: `bash scripts/check-x.sh`.
fn is_script(cmd: &str) -> bool {
    matches!(words(cmd).as_slice(), [sh, path] if (*sh == "bash" || *sh == "sh")
        && path.rsplit('/').next().is_some_and(|f| f.starts_with("check-") && f.ends_with(".sh")))
}

/// Commands that check without changing files and finish in minutes. Test
/// suites are left to CI.
pub fn is_check(cmd: &str) -> bool {
    let w = words(cmd);
    let script = |name: &str| {
        matches!(
            name,
            "typecheck" | "lint" | "check" | "format:check" | "fmt:check" | "check:types"
        )
    };
    match w.as_slice() {
        ["cargo", "fmt", rest @ ..] => rest.contains(&"--check"),
        ["cargo", "clippy", ..] | ["cargo", "check", ..] => true,
        [runner, "run", name, ..] if matches!(*runner, "bun" | "npm" | "pnpm" | "yarn") => {
            script(name)
        }
        ["yarn", name, ..] => script(name),
        ["tsc", rest @ ..] | ["npx", "tsc", rest @ ..] => rest.contains(&"--noEmit"),
        ["go", "vet", ..] | ["ruff", "check", ..] => true,
        _ => is_script(cmd),
    }
}

/// What makes two commands the same check: `cargo clippy` with other flags
/// is still clippy, `bun run typecheck` in another directory is still it.
fn key(cmd: &str) -> String {
    let w: Vec<&str> = words(cmd).into_iter().filter(|w| !w.starts_with('-')).collect();
    let n = if w.get(1) == Some(&"run") { 3 } else { 2 };
    w.into_iter().take(n).collect::<Vec<_>>().join(" ")
}

/// The program a command starts, past a leading `cd <dir> &&`.
pub fn program(cmd: &str) -> &str {
    let rest = cmd
        .split_once("&&")
        .filter(|(head, _)| head.trim_start().starts_with("cd "))
        .map_or(cmd, |(_, tail)| tail);
    rest.split_whitespace().next().unwrap_or_default()
}

struct Found {
    out: Vec<NightCheck>,
    seen: HashSet<String>,
}

impl Found {
    fn add(&mut self, command: String, source: String, runnable: &dyn Fn(&str) -> bool) {
        if self.out.len() >= CHECKS_MAX || !runnable(program(&command)) {
            return;
        }
        let bare = command
            .split_once("&& ")
            .filter(|(head, _)| head.starts_with("cd "))
            .map_or(command.as_str(), |(_, tail)| tail);
        if self.seen.insert(key(bare)) {
            self.out.push(NightCheck { command, source });
        }
    }
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// One job's checks, in step order, its safety scripts grouped first; each
/// with the number of scripts it groups.
fn job_checks(job: &Value) -> Vec<(String, usize)> {
    let default_dir = job
        .get("defaults")
        .and_then(|d| d.get("run"))
        .and_then(|r| str_at(r, "working-directory"));
    let mut checks = Vec::new();
    let mut scripts = Vec::new();
    for step in job
        .get("steps")
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
    {
        let Some(run) = str_at(step, "run").map(str::trim) else {
            continue;
        };
        if run.contains('\n') || run.contains("${{") || !is_check(run) {
            continue;
        }
        let dir = str_at(step, "working-directory").or(default_dir);
        let command = match dir {
            Some(d) if d != "." => format!("cd {d} && {run}"),
            _ => run.to_string(),
        };
        if is_script(run) && dir.is_none() {
            scripts.push(command);
        } else {
            checks.push((command, 0));
        }
    }
    if scripts.len() >= SCRIPT_GROUP_MIN {
        checks.insert(0, (scripts.join(" && "), scripts.len()));
    } else {
        checks.splice(0..0, scripts.into_iter().map(|s| (s, 0)));
    }
    checks
}

fn workflow_checks(root: &Path, found: &mut Found, runnable: &dyn Fn(&str) -> bool) {
    let Ok(dir) = std::fs::read_dir(root.join(".github").join("workflows")) else {
        return;
    };
    let mut files: Vec<_> = dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|x| x == "yml" || x == "yaml")
        })
        .collect();
    files.sort();
    for path in files.into_iter().take(WORKFLOWS_MAX) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(doc) = read(&path).and_then(|t| serde_yaml::from_str::<Value>(&t).ok()) else {
            continue;
        };
        let Some(jobs) = doc.get("jobs").and_then(Value::as_mapping) else {
            continue;
        };
        for (job_name, job) in jobs {
            let job_name = job_name.as_str().unwrap_or_default();
            for (command, scripts) in job_checks(job) {
                let source = match scripts {
                    0 => format!("{name} · {job_name}"),
                    n => format!("{name} · {job_name} · {n} scripts"),
                };
                found.add(command, source, runnable);
            }
        }
    }
}

fn package_checks(root: &Path, found: &mut Found, runnable: &dyn Fn(&str) -> bool) {
    let Some(doc) = read(&root.join("package.json"))
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    else {
        return;
    };
    let runner = if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
        "bun run"
    } else if root.join("pnpm-lock.yaml").exists() {
        "pnpm run"
    } else if root.join("yarn.lock").exists() {
        "yarn run"
    } else {
        "npm run"
    };
    let Some(scripts) = doc.get("scripts").and_then(|s| s.as_object()) else {
        return;
    };
    for name in scripts.keys() {
        let command = format!("{runner} {name}");
        if is_check(&command) {
            found.add(command, "package.json".into(), runnable);
        }
    }
}

/// Backticked commands in the contributor instructions.
fn instruction_checks(root: &Path, found: &mut Found, runnable: &dyn Fn(&str) -> bool) {
    for file in ["AGENTS.md", "CLAUDE.md"] {
        let Some(text) = read(&root.join(file)) else {
            continue;
        };
        for span in text.split('`').skip(1).step_by(2) {
            let span = span.trim();
            if !span.contains('\n') && is_check(span) {
                found.add(span.to_string(), file.into(), runnable);
            }
        }
        return;
    }
}

/// How the app starts for App QA: a screenshot harness first, then a
/// package `dev` or `start` script, then a backticked dev script in AGENTS.md.
pub fn start_command(root: &Path) -> Option<NightCheck> {
    for dir in ["ui/harness", "harness", "app/harness", "web/harness"] {
        for file in ["shot.mjs", "screenshot.mjs", "shot.js"] {
            let rel = format!("{dir}/{file}");
            if root.join(&rel).is_file() {
                return Some(NightCheck {
                    command: format!("node {rel} <story> <out.png>"),
                    source: rel,
                });
            }
        }
    }
    let package = read(&root.join("package.json"))
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(scripts) = package.as_ref().and_then(|p| p.get("scripts")?.as_object().cloned()) {
        let runner = if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
            "bun run"
        } else {
            "npm run"
        };
        if let Some(name) = ["dev", "start"].into_iter().find(|n| scripts.contains_key(*n)) {
            return Some(NightCheck {
                command: format!("{runner} {name}"),
                source: "package.json".into(),
            });
        }
    }
    let text = read(&root.join("AGENTS.md"))?;
    text.split('`')
        .skip(1)
        .step_by(2)
        .map(str::trim)
        .find(|span| {
            let first = span.split_whitespace().next().unwrap_or_default();
            first.rsplit('/').next().is_some_and(|f| f.starts_with("dev."))
        })
        .map(|span| NightCheck {
            command: span.to_string(),
            source: "AGENTS.md".into(),
        })
}

/// The repository's checks: CI workflows first, then package scripts, then
/// the contributor instructions; each once, at most `CHECKS_MAX`, and only
/// those whose program `runnable` finds on this machine.
pub fn checks(root: &Path, runnable: &dyn Fn(&str) -> bool) -> Vec<NightCheck> {
    let mut found = Found {
        out: Vec::new(),
        seen: HashSet::new(),
    };
    workflow_checks(root, &mut found, runnable);
    package_checks(root, &mut found, runnable);
    instruction_checks(root, &mut found, runnable);
    found.out
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKFLOW: &str = r#"
name: CI
on: [push]
jobs:
  safety-checks:
    runs-on: ubuntu-latest
    steps:
      - run: echo "JOB_START=$(date +%s)" >> "$GITHUB_ENV"
      - run: bash scripts/check-watchdog.sh
      - run: bash scripts/check-kill-guard.sh
      - run: bash scripts/check-copy.sh
      - run: bun install --frozen-lockfile
        working-directory: ui
  renderer-checks:
    runs-on: ubuntu-latest
    steps:
      - run: bun run typecheck
        working-directory: ui
      - run: bun run test
        working-directory: ui
  core-checks:
    runs-on: ubuntu-latest
    steps:
      - name: cargo fmt
        run: cargo fmt --all --check --manifest-path core/Cargo.toml
      - run: cargo clippy --all-targets --manifest-path core/Cargo.toml -- -D warnings
      - run: |
          cargo nextest run --lib
"#;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let wf = dir.path().join(".github").join("workflows");
        std::fs::create_dir_all(&wf).unwrap();
        std::fs::write(wf.join("ci.yml"), WORKFLOW).unwrap();
        std::fs::write(
            dir.path().join("AGENTS.md"),
            "Run `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and `go vet ./...`.",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"lint":"oxlint","build":"vite build","test":"vitest"}}"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn checks_from_ci_manifest_and_agents_md() {
        let dir = repo();
        let found = checks(dir.path(), &|_| true);
        let pairs: Vec<(&str, &str)> = found
            .iter()
            .map(|c| (c.command.as_str(), c.source.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                (
                    "bash scripts/check-watchdog.sh && bash scripts/check-kill-guard.sh && bash \
                     scripts/check-copy.sh",
                    "ci.yml · safety-checks · 3 scripts"
                ),
                ("cd ui && bun run typecheck", "ci.yml · renderer-checks"),
                (
                    "cargo fmt --all --check --manifest-path core/Cargo.toml",
                    "ci.yml · core-checks"
                ),
                (
                    "cargo clippy --all-targets --manifest-path core/Cargo.toml -- -D warnings",
                    "ci.yml · core-checks"
                ),
                ("npm run lint", "package.json"),
                ("go vet ./...", "AGENTS.md"),
            ]
        );
    }

    #[test]
    fn only_runnable_programs_are_listed() {
        let dir = repo();
        let found = checks(dir.path(), &|program| program == "bun");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].command, "cd ui && bun run typecheck");
    }

    #[test]
    fn start_command_from_a_harness() {
        let dir = repo();
        assert_eq!(start_command(dir.path()), None, "lint and test start nothing");
        std::fs::write(dir.path().join("AGENTS.md"), "Run `scripts/dev.sh --fresh` to try it.").unwrap();
        assert_eq!(
            start_command(dir.path()).map(|c| (c.command, c.source)),
            Some(("scripts/dev.sh --fresh".to_string(), "AGENTS.md".to_string()))
        );
        std::fs::create_dir_all(dir.path().join("ui/harness")).unwrap();
        std::fs::write(dir.path().join("ui/harness/shot.mjs"), "").unwrap();
        assert_eq!(
            start_command(dir.path()).map(|c| (c.command, c.source)),
            Some((
                "node ui/harness/shot.mjs <story> <out.png>".to_string(),
                "ui/harness/shot.mjs".to_string()
            ))
        );
    }

    #[test]
    fn what_is_and_is_not_a_check() {
        for yes in [
            "cargo fmt --all --check",
            "cargo clippy -- -D warnings",
            "bun run typecheck",
            "yarn lint",
            "npx tsc --noEmit",
            "bash scripts/check-copy.sh",
        ] {
            assert!(is_check(yes), "{yes}");
        }
        for no in [
            "cargo fmt",
            "cargo test",
            "bun run test",
            "bun install",
            "bash scripts/dev.sh",
            "echo hi",
        ] {
            assert!(!is_check(no), "{no}");
        }
        assert_eq!(program("cd ui && bun run typecheck"), "bun");
    }
}

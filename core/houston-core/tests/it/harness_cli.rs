#![allow(clippy::disallowed_methods)]
#![cfg(unix)]

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/harness")
}

fn slug(p: &Path) -> String {
    p.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    ws: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        let ws = home.join("code").join("app");
        std::fs::create_dir_all(&ws).unwrap();
        Self {
            _tmp: tmp,
            home,
            ws,
        }
    }

    /// Real-format transcripts, with the placeholder cwd pointed at this workspace.
    fn with_transcripts(self) -> Self {
        let ws = self.ws.to_string_lossy().into_owned();
        let projects = self.home.join(".claude/projects");
        let place = |name: &str, cwd: &Path| {
            let dir = projects.join(slug(cwd));
            std::fs::create_dir_all(&dir).unwrap();
            let body = std::fs::read_to_string(fixtures().join("claude").join(name)).unwrap();
            std::fs::write(dir.join(name), body.replace("__WS__", &ws)).unwrap();
        };
        for id in [MAIN, FORK, OLD, REVIEW] {
            place(&format!("{id}.jsonl"), &self.ws);
        }
        // A finished transcript's mtime is its last record's instant.
        let old = projects.join(slug(&self.ws)).join(format!("{OLD}.jsonl"));
        let august = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_785_571_800);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(august)
            .unwrap();
        place(
            &format!("{SIBLING}.jsonl"),
            Path::new(&format!("{ws}-other")),
        );
        place(
            &format!("{WORKTREE}.jsonl"),
            &self.ws.join(".claude/worktrees/x"),
        );
        let codex = self.home.join(".codex/sessions/2026/09/12");
        std::fs::create_dir_all(&codex).unwrap();
        for entry in std::fs::read_dir(fixtures().join("codex"))
            .unwrap()
            .flatten()
        {
            let body = std::fs::read_to_string(entry.path()).unwrap();
            std::fs::write(codex.join(entry.file_name()), body.replace("__WS__", &ws)).unwrap();
        }
        std::fs::write(
            self.home.join(".claude/settings.json"),
            r#"{"cleanupPeriodDays": 90}"#,
        )
        .unwrap();
        self
    }

    fn run(&self, args: &[&str], routine_run: Option<&str>) -> (i32, String, String) {
        let mut cmd = Command::new(bin());
        cmd.arg("hs-harness").args(args);
        cmd.env_clear();
        cmd.env("HOME", &self.home);
        cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
        if let Some(run) = routine_run {
            cmd.env("HOUSTON_ROUTINE_RUN", run);
        }
        cmd.current_dir(&self.ws);
        let out = cmd.output().expect("running houston-core hs-harness");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }

    fn write(&self, rel: &str, body: &str) {
        let p = self.ws.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn run_dir(&self, run: &str) -> PathBuf {
        self.ws.join(".houston/harness").join(run)
    }

    fn inventory(&self) -> Value {
        let (code, _, err) = self.run(&["inventory", "--run", "t"], None);
        assert_eq!(code, 0, "{err}");
        read_json(&self.run_dir("t").join("inventory.json"))
    }

    fn digest(&self) -> (Vec<Value>, Value) {
        let (code, _, err) = self.run(
            &["digest", "--since", "2026-09-10", "--until", "2026-09-17"],
            Some("7"),
        );
        assert_eq!(code, 0, "{err}");
        let dir = self.run_dir("r7");
        let lines = std::fs::read_to_string(dir.join("digest.jsonl"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        (lines, read_json(&dir.join("digest-meta.json")))
    }
}

fn read_json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn paths(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap().to_string())
        .collect()
}

fn session<'a>(lines: &'a [Value], id: &str) -> &'a Value {
    lines
        .iter()
        .find(|l| l["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("session {id} is in the digest"))
}

const MAIN: &str = "aaaaaaaa-1111-4111-8111-111111111111";
const FORK: &str = "bbbbbbbb-2222-4222-8222-222222222222";
const WORKTREE: &str = "ffffffff-6666-4666-8666-666666666666";
const OLD: &str = "cccccccc-3333-4333-8333-333333333333";
const REVIEW: &str = "dddddddd-4444-4444-8444-444444444444";
const SIBLING: &str = "eeeeeeee-5555-4555-8555-555555555555";
const CODEX: &str = "019d0000-0000-7000-8000-00000000c0de";

#[test]
fn inventory_writes_versioned_file_and_prints_path() {
    let f = Fixture::new();
    let (code, out, err) = f.run(&["inventory", "--workspace", f.ws.to_str().unwrap()], None);
    assert_eq!(code, 0, "{err}");
    let printed = PathBuf::from(out.trim());
    assert!(
        printed.starts_with(f.ws.join(".houston/harness")),
        "{printed:?}"
    );
    assert_eq!(printed.file_name().unwrap(), "inventory.json");
    assert_eq!(read_json(&printed)["v"], 1);
}

#[test]
fn inventory_refuses_missing_workspace() {
    let f = Fixture::new();
    let (code, _, err) = f.run(&["inventory", "--workspace", "/nao/existe"], None);
    assert_eq!(code, 2);
    assert!(err.contains("/nao/existe"), "{err}");
}

#[test]
fn bare_invocation_prints_usage_and_exits_two() {
    let f = Fixture::new();
    let (code, _, err) = f.run(&[], None);
    assert_eq!(code, 2);
    for word in ["inventory", "digest", "publish"] {
        assert!(err.contains(word), "{err}");
    }
}

#[test]
fn inventory_lists_instruction_files_and_skips_excluded_dirs() {
    let f = Fixture::new();
    f.write(
        "CLAUDE.md",
        "# Root\n\n## Build\n```\n# not a heading\n```\n### Deep\n",
    );
    f.write("docs/AGENTS.md", "# Docs agents\n");
    f.write("src/CLAUDE.local.md", "# Local\n");
    f.write("a/b/c/d/CLAUDE.md", "# depth four\n");
    f.write("a/b/c/d/e/CLAUDE.md", "# depth five\n");
    for skipped in [
        ".git",
        "node_modules/pkg",
        "vendor/lib",
        "target/debug",
        ".claude/worktrees/wt",
        ".claude-worktrees/wt",
        ".houston/x",
    ] {
        f.write(&format!("{skipped}/CLAUDE.md"), "# skipped\n");
    }
    let inv = f.inventory();
    let listed = paths(&inv["instructions"]);
    assert_eq!(
        listed,
        [
            "CLAUDE.md",
            "a/b/c/d/CLAUDE.md",
            "docs/AGENTS.md",
            "src/CLAUDE.local.md"
        ]
    );
    let root = &inv["instructions"][0];
    assert_eq!(root["lines"], 7);
    assert_eq!(root["bytes"], 50);
    let headings: Vec<(u64, &str)> = root["headings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["level"].as_u64().unwrap(), h["text"].as_str().unwrap()))
        .collect();
    assert_eq!(headings, [(1, "Root"), (2, "Build"), (3, "Deep")]);
}

#[test]
fn inventory_reads_rule_paths() {
    let f = Fixture::new();
    f.write(
        ".claude/rules/app.md",
        "---\npaths: [\"app/**\"]\n---\n# App rule\n",
    );
    f.write(".claude/rules/plain.md", "# No frontmatter\n");
    let inv = f.inventory();
    let rules = inv["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0]["path"], ".claude/rules/app.md");
    assert_eq!(rules[0]["paths"], serde_json::json!(["app/**"]));
    assert_eq!(rules[1]["paths"], serde_json::json!([]));
}

#[test]
fn inventory_reads_rules_in_subdirectories() {
    let f = Fixture::new();
    f.write(".claude/rules/app.md", "# App rule\n");
    f.write(
        ".claude/rules/backend/security.md",
        "---\npaths: [\"api/**\"]\n---\n# Security\n",
    );
    f.write(".claude/rules/backend/notes.txt", "not a rule\n");
    let inv = f.inventory();
    let paths: Vec<&str> = inv["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        [".claude/rules/app.md", ".claude/rules/backend/security.md"]
    );
    assert_eq!(inv["rules"][1]["paths"], serde_json::json!(["api/**"]));
    assert_eq!(inv["rules_truncated"], false);
}

#[test]
fn inventory_reads_skill_frontmatter() {
    let f = Fixture::new();
    f.write(
        ".claude/skills/grill/SKILL.md",
        "---\nname: grill\nversion: 1.2.0\ndescription: Ask questions\ndisable-model-invocation: true\n---\n# Grill\n",
    );
    f.write(
        ".claude/skills/plain/SKILL.md",
        "---\nname: plain\ndescription: Plain\n---\n# Plain\n",
    );
    f.write(".agents/skills/codexy/SKILL.md", "---\nname: codexy\n---\n");
    let inv = f.inventory();
    let skills = inv["skills"].as_array().unwrap();
    let by = |n: &str| skills.iter().find(|s| s["name"] == n).unwrap().clone();
    assert_eq!(by("grill")["version"], "1.2.0");
    assert_eq!(by("grill")["disable_model_invocation"], true);
    assert_eq!(by("plain")["version"], Value::Null);
    assert_eq!(by("plain")["disable_model_invocation"], false);
    assert_eq!(by("codexy")["path"], ".agents/skills/codexy/SKILL.md");
    assert!(skills.iter().all(|s| s["scope"] == "repo"));
}

#[test]
fn inventory_lists_user_skills_with_user_scope() {
    let f = Fixture::new();
    let user_skill = f.home.join(".claude/skills/grilling/SKILL.md");
    std::fs::create_dir_all(user_skill.parent().unwrap()).unwrap();
    std::fs::write(&user_skill, "---\nname: grilling\n---\n").unwrap();
    let inv = f.inventory();
    let users = inv["user_skills"].as_array().unwrap();
    assert_eq!(users.len(), 1);
    assert_eq!(users[0]["name"], "grilling");
    assert_eq!(users[0]["scope"], "user");
}

#[test]
fn inventory_reads_settings_mcp_and_agents() {
    let f = Fixture::new();
    f.write(
        ".claude/settings.json",
        r#"{"permissions":{"allow":["Bash(ls *)"],"deny":["Bash(rm -rf *)"],"ask":["Bash(git push *)"]}}"#,
    );
    f.write(
        ".claude/settings.local.json",
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"a"},{"type":"command","command":"b"}]}],"SessionStart":[{"matcher":"*","hooks":[{"type":"command","command":"c"}]}]}}"#,
    );
    f.write(".mcp.json", r#"{"mcpServers":{"db":{},"browser":{}}}"#);
    f.write(
        ".claude/agents/frontend.md",
        "---\nname: frontend\nmodel: sonnet\n---\nBuild UI.\n",
    );
    let inv = f.inventory();
    let settings = inv["settings"].as_array().unwrap();
    let shared = settings
        .iter()
        .find(|s| s["path"] == ".claude/settings.json")
        .unwrap();
    assert_eq!(shared["allow"], serde_json::json!(["Bash(ls *)"]));
    assert_eq!(shared["deny"], serde_json::json!(["Bash(rm -rf *)"]));
    assert_eq!(shared["ask"], serde_json::json!(["Bash(git push *)"]));
    let local = settings
        .iter()
        .find(|s| s["path"] == ".claude/settings.local.json")
        .unwrap();
    assert_eq!(local["hooks"]["Stop"], 2);
    assert_eq!(local["hooks"]["SessionStart"], 1);
    let mut servers: Vec<&str> = inv["mcp"][0]["servers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    servers.sort();
    assert_eq!(servers, ["browser", "db"]);
    assert_eq!(inv["agents"][0]["model"], "sonnet");
    assert_eq!(inv["agents"][0]["name"], "frontend");
}

#[test]
fn inventory_records_parse_error_and_exits_zero() {
    let f = Fixture::new();
    f.write(".claude/settings.json", "{ not json");
    let inv = f.inventory();
    let err = inv["settings"][0]["error"].as_str().unwrap();
    assert!(!err.is_empty());
}

#[test]
fn harness_dir_gets_gitignore_once() {
    let f = Fixture::new();
    f.inventory();
    let gitignore = f.ws.join(".houston/harness/.gitignore");
    assert_eq!(std::fs::read_to_string(&gitignore).unwrap(), "*\n");
    std::fs::write(&gitignore, "custom\n").unwrap();
    f.inventory();
    assert_eq!(std::fs::read_to_string(&gitignore).unwrap(), "custom\n");
}

#[test]
fn digest_refuses_outside_a_routine_run() {
    let f = Fixture::new().with_transcripts();
    let (code, _, err) = f.run(
        &["digest", "--since", "2026-09-10", "--until", "2026-09-17"],
        None,
    );
    assert_eq!(code, 2);
    assert!(err.contains("HOUSTON_ROUTINE_RUN"), "{err}");
    assert!(err.contains("carve-out #6"), "{err}");
    assert!(
        !f.ws.join(".houston/harness").exists(),
        "nothing was written"
    );
}

#[test]
fn digest_refuses_each_unsupported_provider_by_name() {
    let f = Fixture::new().with_transcripts();
    for name in ["opencode", "cursor", "grok", "antigravity"] {
        let (code, _, err) = f.run(&["digest", "--provider", name], Some("7"));
        assert_eq!(code, 2, "{name}");
        assert!(err.contains(name), "{err}");
        assert!(err.contains("Claude and Codex"), "{err}");
    }
}

#[test]
fn digest_rejects_unknown_provider_listing_accepted() {
    let f = Fixture::new();
    let (code, _, err) = f.run(&["digest", "--provider", "foo"], Some("7"));
    assert_eq!(code, 2);
    assert!(err.contains("claude") && err.contains("codex"), "{err}");
}

#[test]
fn digest_keeps_only_sessions_whose_cwd_is_in_the_workspace() {
    let f = Fixture::new().with_transcripts();
    let codex = f.home.join(".codex/sessions/2026/09/12");
    let template = std::fs::read_to_string(
        fixtures()
            .join("codex")
            .join("rollout-2026-09-12T14-00-00-019d0000-0000-7000-8000-00000000c0de.jsonl"),
    )
    .unwrap();
    let ws = f.ws.to_string_lossy().into_owned();
    for (id, cwd) in [
        (
            "019d0000-0000-7000-8000-0000000000a1",
            format!("{ws}/.claude/worktrees/y"),
        ),
        (
            "019d0000-0000-7000-8000-0000000000a2",
            format!("{ws}-other"),
        ),
    ] {
        let body = template
            .replace("019d0000-0000-7000-8000-00000000c0de", id)
            .replace("__WS__", &cwd);
        std::fs::write(codex.join(format!("rollout-{id}.jsonl")), body).unwrap();
    }
    let (lines, _) = f.digest();
    let ids: Vec<&str> = lines.iter().map(|l| l["id"].as_str().unwrap()).collect();
    assert!(
        ids.contains(&"019d0000-0000-7000-8000-0000000000a1"),
        "codex in a worktree is in"
    );
    assert!(
        !ids.contains(&"019d0000-0000-7000-8000-0000000000a2"),
        "codex in the sibling is out"
    );
    assert!(ids.contains(&MAIN));
    assert!(
        ids.contains(&WORKTREE),
        "a worktree under the workspace is in"
    );
    assert!(ids.contains(&CODEX));
    assert!(!ids.contains(&SIBLING), "the sibling is out");
    assert!(
        !ids.contains(&"019d0000-0000-7000-8000-0000000000ff"),
        "codex elsewhere is out"
    );
}

#[test]
fn digest_drops_and_counts_out_of_window_sessions() {
    let f = Fixture::new().with_transcripts();
    let (lines, meta) = f.digest();
    assert!(lines.iter().all(|l| l["id"] != OLD));
    assert_eq!(meta["out_of_window"], 1);
}

#[test]
fn digest_claude_session_fields_match_fixture() {
    let f = Fixture::new().with_transcripts();
    let (lines, _) = f.digest();
    let s = session(&lines, MAIN);
    assert_eq!(s["provider"], "claude");
    assert_eq!(s["title"], "Fix the widget export");
    assert_eq!(s["branch"], "feat/export");
    assert_eq!(s["cost_usd"], 1.5);
    assert_eq!(s["start"], "2026-09-12T10:00:00Z");
    assert_eq!(s["end"], "2026-09-12T10:30:00Z");
    assert_eq!(s["minutes"], 30);
    assert_eq!(s["models"]["claude-opus-5-5"], 8);
    assert_eq!(s["skills"]["grilling"], 1);
    assert_eq!(s["skill_sources"]["/home/user/.claude/skills/grilling"], 1);
    assert_eq!(s["subagents"][0]["type"], "Explore");
    assert_eq!(s["subagents"][0]["model"], "sonnet");
    assert_eq!(s["tools"]["Bash"], 2);
    assert_eq!(s["tool_errors"]["Bash"], 2);
    assert_eq!(s["denials"]["automode-blocked"], 1);
    assert_eq!(s["classifier_reasons"]["[Git Destructive]."], 1);
    assert_eq!(s["interrupts"], 1);
    assert_eq!(s["last_assistant_text"], "Done: the export button works.");
    assert_eq!(s["machine"]["sleep_blocked"], 1);
    assert_eq!(s["machine"]["classifier_denied"], 1);
    assert_eq!(s["machine"]["interrupted_by_user"], 1);
    assert_eq!(s["forked"], false);
    let texts: Vec<&str> = s["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        texts,
        [
            "Make the export button work",
            "Make the export button work",
            "CMD /model",
            "no, that is not what I asked"
        ],
        "the line after the non-JSON one is still read"
    );
    assert_eq!(s["reasks"], 1);
    assert_eq!(s["friction"][0]["match"], "not what I asked");
}

#[test]
fn digest_counts_queued_commands_as_human_prompts() {
    let f = Fixture::new().with_transcripts();
    let (lines, _) = f.digest();
    let s = session(&lines, MAIN);
    let queued: Vec<&Value> = s["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["queued"] == true)
        .collect();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["text"], "no, that is not what I asked");
}

#[test]
fn digest_dedupes_fork_families_by_first_uuid() {
    let f = Fixture::new().with_transcripts();
    let (lines, meta) = f.digest();
    let fork = session(&lines, FORK);
    assert_eq!(fork["forked"], true);
    assert_eq!(fork["fork_of"], MAIN);
    let texts: Vec<&str> = fork["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["Only in the fork: write the changelog"]);
    assert_eq!(session(&lines, MAIN)["forked"], false);
    assert_eq!(meta["forks"], 1);
}

#[test]
fn digest_skips_its_own_review_runs() {
    let f = Fixture::new().with_transcripts();
    let (lines, meta) = f.digest();
    assert!(lines.iter().all(|l| l["id"] != REVIEW));
    assert_eq!(meta["self_runs_skipped"], 1);
}

#[test]
fn digest_meta_reports_window_and_counts() {
    let f = Fixture::new().with_transcripts();
    let (lines, meta) = f.digest();
    assert_eq!(meta["v"], 1);
    assert_eq!(
        meta["window"]["requested"],
        serde_json::json!(["2026-09-10T00:00:00Z", "2026-09-18T00:00:00Z"])
    );
    assert_eq!(meta["window"]["mode"], "explicit");
    assert_eq!(meta["window"]["since"], "2026-09-10T00:00:00Z");
    assert_eq!(meta["window"]["until"], "2026-09-18T00:00:00Z");
    assert_eq!(meta["window"]["available_from"], "2026-08-01T08:00:00Z");
    assert_eq!(meta["cleanup_period_days"], 90);
    assert_eq!(meta["sessions_written"], lines.len());
    assert_eq!(lines.len(), 4, "main, fork, worktree, codex");
    assert_eq!(meta["run"], "r7");
}

#[test]
fn digest_codex_session_fields_match_fixture() {
    let f = Fixture::new().with_transcripts();
    let (lines, _) = f.digest();
    let s = session(&lines, CODEX);
    assert_eq!(s["provider"], "codex");
    assert_eq!(s["title"], "Fix the build");
    assert_eq!(s["branch"], "fix/build");
    assert_eq!(s["models"]["gpt-5.4"], 1);
    assert_eq!(s["prompts"][0]["text"], "Fix the build");
    assert_eq!(s["prompt_count"], 1);
    assert_eq!(s["tools"]["exec_command"], 1);
    assert_eq!(s["tools"]["apply_patch"], 1);
    assert_eq!(s["tool_errors"]["exec_command"], 1);
    assert_eq!(s["tool_errors"]["apply_patch"], 1);
    assert_eq!(s["interrupts"], 1);
    assert_eq!(s["last_assistant_text"], "Build fixed.");
}

#[test]
fn publish_outside_a_houston_pane_is_refused_by_name() {
    let f = Fixture::new();
    let (code, out, err) = f.run(&["publish", "--summary", "1 finding"], Some("1"));
    assert_eq!(code, 2, "{out}");
    assert!(
        err.contains("HOUSTON_MCP_URL is not set; hs-harness publish runs only inside"),
        "{err}"
    );
}

#[test]
fn digest_rejects_a_bad_window_through_the_binary() {
    let f = Fixture::new();
    let (code, _, err) = f.run(
        &["digest", "--since", "2026-09-17", "--until", "2026-09-10"],
        Some("7"),
    );
    assert_eq!(code, 2);
    assert!(
        err.contains("2026-09-17") && err.contains("2026-09-10"),
        "{err}"
    );
    let (code, _, err) = f.run(
        &["digest", "--since", "2026-08-01", "--until", "2026-08-31"],
        Some("7"),
    );
    assert_eq!(code, 2);
    assert!(err.contains("31 days") && err.contains("30"), "{err}");
}

#[test]
fn digest_refuses_over_the_total_cap_through_the_binary() {
    let f = Fixture::new();
    let ws = f.ws.to_string_lossy().into_owned();
    let dir = f.home.join(".claude/projects").join(slug(&f.ws));
    std::fs::create_dir_all(&dir).unwrap();
    let ask = "a long ask about the export button ".repeat(55);
    // 40 sessions of 30 prompts near the per-prompt cap: each line stays under
    // 64 KiB, and together they pass 2 MiB.
    for n in 0..40 {
        let lines: Vec<String> = (0..30)
            .map(|i| {
                serde_json::json!({
                    "type": "user", "uuid": format!("u-{n}-{i}"), "sessionId": format!("s{n}"),
                    "timestamp": format!("2026-09-12T10:{i:02}:00.000Z"), "cwd": ws,
                    "message": {"role": "user", "content": format!("{i} {ask}")},
                })
                .to_string()
            })
            .collect();
        std::fs::write(dir.join(format!("s{n:02}.jsonl")), lines.join("\n") + "\n").unwrap();
    }
    let (code, _, err) = f.run(
        &["digest", "--since", "2026-09-10", "--until", "2026-09-17"],
        Some("7"),
    );
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("the digest is "), "{err}");
    assert!(err.contains("2097152 byte cap"), "{err}");
    assert!(err.contains("40 sessions"), "{err}");
    assert!(!f.run_dir("r7").join("digest.jsonl").exists());
}

#[test]
fn digest_counts_automatic_messages_and_how_they_were_answered() {
    let f = Fixture::new().with_transcripts();
    let (lines, _) = f.digest();
    let s = session(&lines, MAIN);
    assert_eq!(s["automatic"]["another_session"], 1);
    assert_eq!(s["automatic"]["task_notification"], 1);
    assert_eq!(s["automatic_answered_with_text"]["another_session"], 1);
    assert_eq!(
        s["automatic_answered_with_text"]["task_notification"],
        Value::Null,
        "answered with a tool call, not prose"
    );
    assert!(s["automatic_reply_samples"][0]
        .as_str()
        .unwrap()
        .starts_with("That was an automatic notification"));
    let texts: Vec<&str> = s["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["text"].as_str().unwrap())
        .collect();
    assert!(texts
        .iter()
        .all(|t| !t.starts_with("Another Claude session")));
}

#[test]
fn digest_keeps_the_command_the_classifier_denied() {
    let f = Fixture::new().with_transcripts();
    let (lines, _) = f.digest();
    let denied = session(&lines, MAIN)["denied"].as_array().unwrap().clone();
    assert_eq!(denied.len(), 1);
    assert_eq!(denied[0]["kind"], "automode-blocked");
    assert_eq!(denied[0]["tool"], "Bash");
    assert_eq!(denied[0]["input"], "git reset --hard");
    assert_eq!(denied[0]["reason"], "[Git Destructive].");
}

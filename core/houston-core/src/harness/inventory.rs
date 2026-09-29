//! The shape of a workspace's agent harness, read from its own files. No
//! transcript is opened here, so this half needs no carve-out.
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Instruction files sit at the root or one project level down; four levels
/// covers a monorepo's `apps/<name>/src` without walking a whole tree.
const MAX_DEPTH: usize = 4;
/// Bounds a walk over a workspace full of generated directories.
const MAX_DIRS: usize = 20_000;
const SKIP_DIRS: [&str; 7] = [
    ".git",
    "node_modules",
    "vendor",
    "target",
    ".houston",
    ".claude-worktrees",
    "worktrees",
];
const INSTRUCTION_FILES: [&str; 3] = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];

fn skip_dir(parent: &Path, name: &str) -> bool {
    if name == "worktrees" {
        return parent.file_name().and_then(|n| n.to_str()) == Some(".claude");
    }
    SKIP_DIRS.contains(&name)
}

fn rel(ws: &Path, p: &Path) -> String {
    p.strip_prefix(ws)
        .unwrap_or(p)
        .to_string_lossy()
        .into_owned()
}

/// YAML between a leading `---` line and the next one, as JSON.
fn frontmatter(text: &str) -> Result<Option<Value>, String> {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Ok(None);
    };
    let end = rest
        .find("\n---")
        .ok_or_else(|| "frontmatter opens with --- and never closes".to_string())?;
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&rest[..end]).map_err(|e| format!("frontmatter: {e}"))?;
    serde_json::to_value(yaml)
        .map(Some)
        .map_err(|e| format!("frontmatter: {e}"))
}

fn headings(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let level = line.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&level) && line.as_bytes().get(level) == Some(&b' ') {
            out.push(json!({ "level": level, "text": line[level + 1..].trim() }));
        }
    }
    out
}

fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn instruction_entry(ws: &Path, path: &Path) -> Value {
    match read(path) {
        Ok(text) => json!({
            "path": rel(ws, path),
            "bytes": text.len(),
            "lines": text.lines().count(),
            "headings": headings(&text),
        }),
        Err(e) => json!({ "path": rel(ws, path), "error": e }),
    }
}

fn string_list(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(s)) => vec![Value::String(s.clone())],
        _ => Vec::new(),
    }
}

fn rule_entry(ws: &Path, path: &Path) -> Value {
    let text = match read(path) {
        Ok(t) => t,
        Err(e) => return json!({ "path": rel(ws, path), "error": e }),
    };
    let mut entry = json!({ "path": rel(ws, path), "bytes": text.len(), "paths": [] });
    match frontmatter(&text) {
        Ok(fm) => {
            entry["paths"] = Value::Array(string_list(fm.as_ref().and_then(|f| f.get("paths"))))
        }
        Err(e) => entry["error"] = Value::String(e),
    }
    entry
}

fn flag(fm: Option<&Value>, key: &str, default: bool) -> bool {
    fm.and_then(|f| f.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn skill_entry(display: &str, path: &Path, scope: &str) -> Value {
    let text = match read(path) {
        Ok(t) => t,
        Err(e) => return json!({ "path": display, "scope": scope, "error": e }),
    };
    let dir_name = path
        .parent()
        .and_then(|d| d.file_name())
        .map(|n| n.to_string_lossy().into_owned());
    let mut entry = json!({ "path": display, "scope": scope, "bytes": text.len() });
    match frontmatter(&text) {
        Ok(fm) => {
            let fm = fm.as_ref();
            let str_field = |k: &str| fm.and_then(|f| f.get(k)).and_then(Value::as_str);
            entry["name"] = json!(str_field("name").map(str::to_string).or(dir_name));
            entry["version"] = json!(str_field("version")
                .or_else(|| fm
                    .and_then(|f| f.get("metadata"))
                    .and_then(|m| m.get("version"))
                    .and_then(Value::as_str))
                .map(str::to_string));
            entry["description_chars"] = json!(str_field("description").map_or(0, str::len));
            entry["disable_model_invocation"] = json!(flag(fm, "disable-model-invocation", false));
            entry["user_invocable"] = json!(flag(fm, "user-invocable", true));
        }
        Err(e) => {
            entry["name"] = json!(dir_name);
            entry["error"] = Value::String(e);
        }
    }
    entry
}

fn skills_under(ws: &Path, skills_dir: &Path, scope: &str, out: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    dirs.sort();
    for dir in dirs {
        let file = dir.join("SKILL.md");
        if file.is_file() {
            let display = if scope == "user" {
                file.to_string_lossy().into_owned()
            } else {
                rel(ws, &file)
            };
            out.push(skill_entry(&display, &file, scope));
        }
    }
}

fn settings_entry(ws: &Path, path: &Path) -> Value {
    let parsed = read(path)
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("not JSON: {e}")));
    let v = match parsed {
        Ok(v) => v,
        Err(e) => return json!({ "path": rel(ws, path), "error": e }),
    };
    let perms = v.get("permissions");
    let mut hooks = Map::new();
    if let Some(Value::Object(events)) = v.get("hooks") {
        for (event, groups) in events {
            let commands: usize = groups
                .as_array()
                .map(|gs| {
                    gs.iter()
                        .map(|g| g.get("hooks").and_then(Value::as_array).map_or(0, Vec::len))
                        .sum()
                })
                .unwrap_or(0);
            hooks.insert(event.clone(), json!(commands));
        }
    }
    json!({
        "path": rel(ws, path),
        "allow": string_list(perms.and_then(|p| p.get("allow"))),
        "deny": string_list(perms.and_then(|p| p.get("deny"))),
        "ask": string_list(perms.and_then(|p| p.get("ask"))),
        "hooks": hooks,
    })
}

fn mcp_entry(ws: &Path, path: &Path) -> Value {
    let parsed = read(path)
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("not JSON: {e}")));
    match parsed {
        Ok(v) => {
            let servers: Vec<&String> = v
                .get("mcpServers")
                .and_then(Value::as_object)
                .map(|m| m.keys().collect())
                .unwrap_or_default();
            json!({ "path": rel(ws, path), "servers": servers })
        }
        Err(e) => json!({ "path": rel(ws, path), "error": e }),
    }
}

fn agent_entry(ws: &Path, path: &Path) -> Value {
    let text = match read(path) {
        Ok(t) => t,
        Err(e) => return json!({ "path": rel(ws, path), "error": e }),
    };
    let mut entry = json!({ "path": rel(ws, path), "bytes": text.len() });
    match frontmatter(&text) {
        Ok(fm) => {
            let get = |k: &str| fm.as_ref().and_then(|f| f.get(k)).cloned();
            entry["name"] = get("name").unwrap_or(Value::Null);
            entry["model"] = get("model").unwrap_or(Value::Null);
        }
        Err(e) => entry["error"] = Value::String(e),
    }
    entry
}

fn sorted_children(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some(ext))
        .collect();
    files.sort();
    files
}

/// Claude loads `.claude/rules/` recursively; these bound that walk the way
/// `MAX_DEPTH` and `MAX_DIRS` bound the workspace walk.
const RULES_MAX_DEPTH: usize = 8;
const RULES_MAX_FILES: usize = 1_000;

/// Every `.md` under `dir`, sorted, and whether a bound cut the walk short.
/// Symlinked directories are followed once each, so a cycle ends the branch.
fn rule_files(dir: &Path) -> (Vec<PathBuf>, bool) {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut truncated = false;
    'walk: while let Some((dir, depth)) = stack.pop() {
        if !std::fs::canonicalize(&dir).is_ok_and(|c| seen.insert(c)) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                if depth < RULES_MAX_DEPTH {
                    stack.push((path, depth + 1));
                } else {
                    truncated = true;
                }
            } else if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
                if files.len() == RULES_MAX_FILES {
                    truncated = true;
                    break 'walk;
                }
                files.push(path);
            }
        }
    }
    files.sort();
    (files, truncated)
}

#[derive(Default)]
struct Found {
    instructions: Vec<Value>,
    claude_dirs: Vec<PathBuf>,
    agents_dirs: Vec<PathBuf>,
    mcp_files: Vec<PathBuf>,
    dirs_visited: usize,
    truncated: bool,
}

fn walk(ws: &Path) -> Found {
    let mut found = Found::default();
    let mut stack = vec![(ws.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        found.dirs_visited += 1;
        if found.dirs_visited > MAX_DIRS {
            found.truncated = true;
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if ft.is_dir() {
                if name == ".claude" {
                    found.claude_dirs.push(path.clone());
                } else if name == ".agents" {
                    found.agents_dirs.push(path.clone());
                }
                if depth < MAX_DEPTH && !skip_dir(&dir, &name) {
                    stack.push((path, depth + 1));
                }
            } else if ft.is_file() {
                if INSTRUCTION_FILES.contains(&name.as_str()) {
                    found.instructions.push(instruction_entry(ws, &path));
                } else if name == ".mcp.json" {
                    found.mcp_files.push(path);
                }
            }
        }
    }
    found
        .instructions
        .sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    found.claude_dirs.sort();
    found.agents_dirs.sort();
    found.mcp_files.sort();
    found
}

/// `home` is where user-level skills live (`~/.claude/skills`), listed so a
/// reader can see a repo skill shadowed by the user's own copy.
pub fn build(ws: &Path, home: Option<&Path>, generated_at: &str) -> Value {
    let found = walk(ws);
    let (mut rules, mut skills, mut settings, mut agents) = (vec![], vec![], vec![], vec![]);
    let mut rules_truncated = false;
    for claude in &found.claude_dirs {
        let (files, capped) = rule_files(&claude.join("rules"));
        rules_truncated |= capped;
        rules.extend(files.iter().map(|p| rule_entry(ws, p)));
        skills_under(ws, &claude.join("skills"), "repo", &mut skills);
        for name in ["settings.json", "settings.local.json"] {
            let p = claude.join(name);
            if p.is_file() {
                settings.push(settings_entry(ws, &p));
            }
        }
        agents.extend(
            sorted_children(&claude.join("agents"), "md")
                .iter()
                .map(|p| agent_entry(ws, p)),
        );
    }
    for dir in &found.agents_dirs {
        skills_under(ws, &dir.join("skills"), "repo", &mut skills);
    }
    let mut user_skills = Vec::new();
    if let Some(home) = home {
        skills_under(
            ws,
            &home.join(".claude").join("skills"),
            "user",
            &mut user_skills,
        );
    }
    json!({
        "v": 1,
        "workspace": ws.to_string_lossy(),
        "generated_at": generated_at,
        "instructions": found.instructions,
        "rules": rules,
        "rules_truncated": rules_truncated,
        "skills": skills,
        "user_skills": user_skills,
        "settings": settings,
        "mcp": found.mcp_files.iter().map(|p| mcp_entry(ws, p)).collect::<Vec<_>>(),
        "agents": agents,
        "dirs_visited": found.dirs_visited,
        "truncated": found.truncated,
    })
}

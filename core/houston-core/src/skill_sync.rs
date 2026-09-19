use houston_protocol as proto;
#[allow(unused_imports)]
use houston_protocol::SkillToolState;
use std::path::{Path, PathBuf};

use crate::agent_hooks::ConfigHome;

pub const SKILL_TOOLS: [proto::AgentKind; 5] = [
    proto::AgentKind::Claude,
    proto::AgentKind::Codex,
    proto::AgentKind::Opencode,
    proto::AgentKind::Cursor,
    proto::AgentKind::Grok,
];

pub fn skills_dir(tool: proto::AgentKind, home: &ConfigHome) -> Option<PathBuf> {
    match tool {
        proto::AgentKind::Claude => Some(home.home.join(".claude").join("skills")),
        proto::AgentKind::Codex => Some(home.home.join(".codex").join("skills")),
        proto::AgentKind::Opencode => Some(home.config_dir().join("opencode").join("skills")),
        proto::AgentKind::Cursor => Some(home.home.join(".cursor").join("skills")),
        proto::AgentKind::Grok => Some(home.home.join(".grok").join("skills")),
        _ => None,
    }
}

/// OpenCode, Cursor and Grok also load `~/.claude/skills`, so a skill only there
/// is genuinely visible to them — calling that cell "missing" would be a lie. The
/// renderer gets `inherits_claude` and shows it as inherited.
pub fn inherits_claude_skills(tool: proto::AgentKind) -> bool {
    matches!(
        tool,
        proto::AgentKind::Opencode | proto::AgentKind::Cursor | proto::AgentKind::Grok
    )
}

pub fn digest(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn read_tool(tool: proto::AgentKind, home: &ConfigHome) -> proto::SkillToolState {
    let Some(dir) = skills_dir(tool, home) else {
        return proto::SkillToolState {
            tool,
            path: String::new(),
            detected: false,
            inherits_claude: false,
            skills: Vec::new(),
            error: Some(format!(
                "{tool:?} has no skills directory Houston knows about"
            )),
        };
    };
    let path = dir.display().to_string();
    let inherits_claude = inherits_claude_skills(tool);
    if !dir.is_dir() {
        return proto::SkillToolState {
            tool,
            path,
            detected: false,
            inherits_claude,
            skills: Vec::new(),
            error: None,
        };
    }
    match collect(&dir) {
        Ok(mut skills) => {
            skills.sort_by(|a, b| a.name.cmp(&b.name));
            proto::SkillToolState {
                tool,
                path,
                detected: true,
                inherits_claude,
                skills,
                error: None,
            }
        }
        Err(e) => proto::SkillToolState {
            tool,
            path,
            detected: true,
            inherits_claude,
            skills: Vec::new(),
            error: Some(format!("{e}")),
        },
    }
}

// A subdirectory without a `SKILL.md` is skipped, not reported: these dirs hold
// assets and references, and listing those as broken skills would fill the
// screen with noise.
fn collect(dir: &Path) -> std::io::Result<Vec<proto::SkillEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let file = entry.path().join("SKILL.md");
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        out.push(proto::SkillEntry {
            name,
            path: file.display().to_string(),
            digest: digest(&bytes),
        });
    }
    Ok(out)
}

pub fn read_tools(home: &ConfigHome) -> Vec<proto::SkillToolState> {
    SKILL_TOOLS.iter().map(|t| read_tool(*t, home)).collect()
}

pub fn canonical_skills(home: &ConfigHome) -> Vec<proto::SkillEntry> {
    read_tool(proto::AgentKind::Claude, home).skills
}

#[derive(Debug, Clone)]
pub struct PushedSkill {
    pub name: String,
    pub path: String,
    pub digest: String,
    pub backup: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Default)]
pub struct PushOutcome {
    pub written: Vec<PushedSkill>,
    pub skipped: Vec<String>,
}

pub fn push_tool(
    tool: proto::AgentKind,
    home: &ConfigHome,
    canonical: &[proto::SkillEntry],
    skill_filter: Option<&str>,
) -> PushOutcome {
    let mut out = PushOutcome::default();
    if tool == proto::AgentKind::Claude {
        return out;
    }
    let Some(dir) = skills_dir(tool, home) else {
        out.skipped
            .push(format!("{tool:?} has no skills directory"));
        return out;
    };
    let current = read_tool(tool, home);
    for entry in canonical {
        if skill_filter.is_some_and(|f| f != entry.name) {
            continue;
        }
        let drifted = match current.skills.iter().find(|s| s.name == entry.name) {
            Some(existing) => existing.digest != entry.digest,
            None => true,
        };
        if !drifted {
            continue;
        }
        let bytes = match std::fs::read(&entry.path) {
            Ok(b) => b,
            Err(e) => {
                out.skipped
                    .push(format!("{}: reading canonical copy: {e}", entry.name));
                continue;
            }
        };
        let target_dir = dir.join(&entry.name);
        let target = target_dir.join("SKILL.md");
        let backup = std::fs::read(&target).ok();
        if let Err(e) = std::fs::create_dir_all(&target_dir) {
            out.skipped.push(format!(
                "{}: creating {}: {e}",
                entry.name,
                target_dir.display()
            ));
            continue;
        }
        if let Err(e) = std::fs::write(&target, &bytes) {
            out.skipped
                .push(format!("{}: writing {}: {e}", entry.name, target.display()));
            continue;
        }
        out.written.push(PushedSkill {
            name: entry.name.clone(),
            path: target.display().to_string(),
            digest: entry.digest.clone(),
            backup,
        });
    }
    out
}

pub fn undo_push(
    tool: proto::AgentKind,
    home: &ConfigHome,
    skill: &str,
    backup: Option<&[u8]>,
) -> std::io::Result<()> {
    let dir = skills_dir(tool, home).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{tool:?} has no skills directory"),
        )
    })?;
    let skill_dir = dir.join(skill);
    let target = skill_dir.join("SKILL.md");
    match backup {
        Some(bytes) => std::fs::write(&target, bytes),
        None => {
            std::fs::remove_file(&target)?;
            let _ = std::fs::remove_dir(&skill_dir);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(dir: &tempfile::TempDir) -> ConfigHome {
        ConfigHome {
            home: dir.path().to_path_buf(),
            xdg_config: Some(dir.path().join("xdg")),
        }
    }

    fn write_skill(dir: &Path, name: &str, body: &str) {
        let d = dir.join(name);
        std::fs::create_dir_all(&d).expect("mkdir");
        std::fs::write(d.join("SKILL.md"), body).expect("write");
    }

    #[test]
    fn a_copy_that_drifted_has_a_different_digest_than_the_original() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        let cursor = skills_dir(proto::AgentKind::Cursor, &h).expect("path");
        write_skill(&claude, "triage", "---\nname: triage\n---\nbody\n");
        write_skill(&cursor, "triage", "---\nname: triage\n---\nbody, edited\n");

        let cols = read_tools(&h);
        let by = |tool| {
            cols.iter()
                .find(|c| c.tool == tool)
                .expect("column")
                .clone()
        };
        let a = by(proto::AgentKind::Claude);
        let b = by(proto::AgentKind::Cursor);
        assert_eq!(a.skills.len(), 1);
        assert_eq!(b.skills.len(), 1);
        assert_ne!(
            a.skills[0].digest, b.skills[0].digest,
            "an edited copy is exactly what this screen exists to show"
        );

        write_skill(&cursor, "triage", "---\nname: triage\n---\nbody\n");
        let cols = read_tools(&h);
        let b = cols
            .iter()
            .find(|c| c.tool == proto::AgentKind::Cursor)
            .expect("column");
        assert_eq!(b.skills[0].digest, a.skills[0].digest);
    }

    #[test]
    fn the_tools_that_read_claudes_directory_say_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        for col in read_tools(&h) {
            let expected = matches!(
                col.tool,
                proto::AgentKind::Opencode | proto::AgentKind::Cursor | proto::AgentKind::Grok
            );
            assert_eq!(col.inherits_claude, expected, "{col:?}");
        }
    }

    #[test]
    fn a_missing_directory_is_a_state_and_a_stray_folder_is_not_a_skill() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        for col in read_tools(&h) {
            assert!(!col.detected, "{col:?}");
            assert!(col.error.is_none(), "{col:?}");
            assert!(!col.path.is_empty(), "a column names its directory anyway");
        }

        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        write_skill(&claude, "real", "body");
        std::fs::create_dir_all(claude.join("assets")).expect("mkdir");
        std::fs::write(claude.join("loose.md"), "not a skill").expect("write");

        let col = read_tool(proto::AgentKind::Claude, &h);
        assert!(col.detected);
        assert_eq!(
            col.skills
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["real"]
        );
    }

    #[test]
    fn push_writes_a_missing_skill_and_undo_removes_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        write_skill(&claude, "triage", "---\nname: triage\n---\nbody\n");

        let canonical = canonical_skills(&h);
        let out = push_tool(proto::AgentKind::Cursor, &h, &canonical, None);
        assert_eq!(out.skipped, Vec::<String>::new(), "{out:?}");
        assert_eq!(out.written.len(), 1);
        let pushed = &out.written[0];
        assert_eq!(pushed.name, "triage");
        assert!(pushed.backup.is_none(), "no pre-existing file to back up");

        let cursor_col = read_tool(proto::AgentKind::Cursor, &h);
        assert_eq!(cursor_col.skills.len(), 1);
        assert_eq!(cursor_col.skills[0].digest, canonical[0].digest);

        undo_push(
            proto::AgentKind::Cursor,
            &h,
            "triage",
            pushed.backup.as_deref(),
        )
        .expect("undo");
        assert!(
            !skills_dir(proto::AgentKind::Cursor, &h)
                .unwrap()
                .join("triage")
                .exists(),
            "undo of a Houston-created file removes it (and its now-empty dir)"
        );
    }

    #[test]
    fn push_overwrites_a_drifted_copy_and_undo_restores_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        let cursor = skills_dir(proto::AgentKind::Cursor, &h).expect("path");
        write_skill(&claude, "triage", "---\nname: triage\n---\ncanonical\n");
        write_skill(&cursor, "triage", "---\nname: triage\n---\ndrifted\n");

        let canonical = canonical_skills(&h);
        let out = push_tool(proto::AgentKind::Cursor, &h, &canonical, None);
        assert_eq!(out.written.len(), 1);
        let pushed = &out.written[0];
        let backup = pushed.backup.clone().expect("drifted file was backed up");
        assert_eq!(
            String::from_utf8_lossy(&backup),
            "---\nname: triage\n---\ndrifted\n"
        );

        let cursor_col = read_tool(proto::AgentKind::Cursor, &h);
        assert_eq!(cursor_col.skills[0].digest, canonical[0].digest);

        undo_push(proto::AgentKind::Cursor, &h, "triage", Some(&backup)).expect("undo");
        let restored = std::fs::read_to_string(cursor.join("triage").join("SKILL.md"))
            .expect("restored file reads back");
        assert_eq!(restored, "---\nname: triage\n---\ndrifted\n");
    }

    #[test]
    fn an_identical_copy_is_left_untouched_by_push() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        let cursor = skills_dir(proto::AgentKind::Cursor, &h).expect("path");
        write_skill(&claude, "triage", "---\nname: triage\n---\nbody\n");
        write_skill(&cursor, "triage", "---\nname: triage\n---\nbody\n");

        let canonical = canonical_skills(&h);
        let out = push_tool(proto::AgentKind::Cursor, &h, &canonical, None);
        assert!(
            out.written.is_empty(),
            "an identical copy is not drift — nothing to push, nothing to undo: {out:?}"
        );
    }

    #[test]
    fn push_never_targets_claude_itself() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let claude = skills_dir(proto::AgentKind::Claude, &h).expect("path");
        write_skill(&claude, "triage", "---\nname: triage\n---\nbody\n");

        let canonical = canonical_skills(&h);
        let out = push_tool(proto::AgentKind::Claude, &h, &canonical, None);
        assert!(out.written.is_empty());
        assert!(out.skipped.is_empty());
    }
}

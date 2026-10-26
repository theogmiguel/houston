//! Where a conversation's files live under a provider's state directory. Files are
//! copied byte for byte: Claude Code resumes a session id from any folder under
//! `projects/`, and Codex resumes a rollout by id wherever its dated folder is.

use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use std::path::{Component, Path, PathBuf};

/// Claude Code's folder name for a working directory: every character other than an
/// ASCII letter or digit becomes `-`.
pub fn claude_project_folder(cwd: &Path) -> String {
    super::paths::plain(cwd)
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub struct Collected {
    /// The transcript relative to `root`.
    pub transcript: String,
    /// The other files relative to `root`: a Claude session's `<id>/` directory.
    pub extra_files: Vec<String>,
    /// The directory the relative paths start from.
    pub root: PathBuf,
}

/// The files of `conversation`, whose transcript is `transcript`.
pub fn collect(
    provider: proto::AgentKind,
    transcript: &Path,
    conversation: &str,
) -> Result<Collected> {
    match provider {
        proto::AgentKind::Claude => {
            let root = transcript
                .parent()
                .with_context(|| format!("transcript {} has no folder", transcript.display()))?
                .to_path_buf();
            let name = transcript
                .file_name()
                .with_context(|| format!("transcript {} has no file name", transcript.display()))?
                .to_string_lossy()
                .into_owned();
            let mut extra_files = Vec::new();
            let sidecar = root.join(conversation);
            if sidecar.is_dir() {
                walk(&sidecar, conversation, &mut extra_files)?;
            }
            extra_files.sort();
            Ok(Collected {
                transcript: name,
                extra_files,
                root,
            })
        }
        proto::AgentKind::Codex => {
            let components: Vec<_> = transcript.components().collect();
            let Some(at) = components
                .iter()
                .rposition(|c| matches!(c, Component::Normal(name) if *name == "sessions"))
            else {
                bail!(
                    "Codex rollout {} is not under a sessions/ folder of its Codex home",
                    transcript.display()
                );
            };
            let root: PathBuf = components[..at].iter().collect();
            let transcript = components[at..]
                .iter()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            Ok(Collected {
                transcript,
                extra_files: Vec::new(),
                root,
            })
        }
        other => {
            bail!("conversations of {other:?} panes are not transferred (only Claude and Codex)")
        }
    }
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("listing {}", dir.display()))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = format!("{prefix}/{name}");
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk(&entry.path(), &relative, out)?;
        } else if kind.is_file() {
            out.push(relative);
        }
    }
    Ok(())
}

/// The directory a conversation's relative paths start from on this computer.
pub fn place_root(provider: proto::AgentKind, provider_dir: &Path, cwd: &Path) -> PathBuf {
    match provider {
        proto::AgentKind::Claude => provider_dir
            .join("projects")
            .join(claude_project_folder(cwd)),
        _ => provider_dir.to_path_buf(),
    }
}

pub fn join(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |p, c| p.join(c))
}

/// Copies `relative` from `from` to `to`, replacing what is there, and returns where.
pub fn copy_file(from: &Path, to: &Path, relative: &str) -> Result<PathBuf> {
    let dest = super::paths::inside(to, relative)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let staged = dest.with_extension("houston-transfer-part");
    std::fs::copy(join(from, relative), &staged)
        .with_context(|| format!("writing {}", staged.display()))?;
    std::fs::rename(&staged, &dest)
        .with_context(|| format!("moving {} into place", dest.display()))?;
    Ok(dest)
}

/// The paths among `relatives` under `to` that exist with other bytes than the carried
/// copy under `from`: writing there would replace another version of the conversation.
pub fn differing(from: &Path, to: &Path, relatives: &[String]) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for relative in relatives {
        let dest = super::paths::inside(to, relative)?;
        match std::fs::read(&dest) {
            Ok(bytes) => {
                if bytes != std::fs::read(join(from, relative))? {
                    out.push(dest);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", dest.display())),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_folder_names_ignore_the_verbatim_prefix() {
        assert_eq!(
            claude_project_folder(Path::new(r"\\?\C:\dev\houston")),
            "C--dev-houston"
        );
    }

    #[test]
    fn claude_folder_names_replace_every_separator() {
        assert_eq!(
            claude_project_folder(Path::new("/home/dev/my.app")),
            "-home-dev-my-app"
        );
        assert_eq!(
            claude_project_folder(Path::new(r"C:\dev\houston")),
            "C--dev-houston"
        );
    }

    #[test]
    fn a_claude_session_carries_its_sidecar_folder() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("abc.jsonl");
        std::fs::write(&transcript, "{}\n").unwrap();
        std::fs::create_dir_all(dir.path().join("abc/subagents")).unwrap();
        std::fs::write(dir.path().join("abc/subagents/s.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.path().join("other.jsonl"), "{}\n").unwrap();
        let collected = collect(proto::AgentKind::Claude, &transcript, "abc").unwrap();
        assert_eq!(collected.transcript, "abc.jsonl");
        assert_eq!(
            collected.extra_files,
            vec!["abc/subagents/s.jsonl".to_string()]
        );
        assert_eq!(collected.root, dir.path());
    }

    #[test]
    fn a_codex_rollout_keeps_its_dated_sessions_path() {
        let home = Path::new("/home/dev/.codex");
        let rollout = home.join("sessions/2026/10/21/rollout-x-id.jsonl");
        let collected = collect(proto::AgentKind::Codex, &rollout, "id").unwrap();
        assert_eq!(
            collected.transcript,
            "sessions/2026/10/21/rollout-x-id.jsonl"
        );
        assert_eq!(collected.root, home);
        assert!(collect(proto::AgentKind::Codex, Path::new("/tmp/r.jsonl"), "id").is_err());
    }
}

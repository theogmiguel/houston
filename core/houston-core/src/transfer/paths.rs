//! Paths a transfer file names and paths import writes to. Every relative path in a
//! manifest is checked before anything is written, and every write refuses to follow a
//! symbolic link out of its root.

use super::manifest::Manifest;
use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// `path` without Windows' verbatim prefix: `\\?\C:\x` is `C:\x` and `\\?\UNC\h\s` is
/// `\\h\s`. Claude's folder encoding, spawned folders, displays and comparisons all use
/// this form.
pub fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// The canonical form of `path` in its plain spelling, or `path` itself when it cannot
/// be resolved.
pub fn canonical(path: &Path) -> PathBuf {
    plain(&path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn component(part: &str) -> std::result::Result<(), String> {
    if part.is_empty() || part == "." || part == ".." {
        return Err(format!("component {part:?}"));
    }
    if part
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(format!(
            "component {part:?} has a character no portable file name has"
        ));
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return Err(format!("component {part:?} ends with a dot or space"));
    }
    let stem = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("component {part:?} is a reserved device name"));
    }
    Ok(())
}

/// A relative, `/`-separated path of ordinary components only.
pub fn relative(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() {
        return Err("an empty path".into());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(format!("{path:?} is absolute"));
    }
    for part in path.split('/') {
        component(part).map_err(|e| format!("{path:?}: {e}"))?;
    }
    Ok(())
}

fn conversation(id: &str) -> std::result::Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(format!("conversation id {id:?}"));
    }
    Ok(())
}

fn numbered(dir: &str, prefix: &str) -> bool {
    dir.strip_prefix(prefix)
        .is_some_and(|n| !n.is_empty() && n.len() <= 6 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Case-insensitive duplicates would overwrite each other on Windows and macOS.
fn unique_folded<'a>(paths: impl Iterator<Item = &'a str>) -> std::result::Result<(), String> {
    let mut seen = HashSet::new();
    for path in paths {
        if !seen.insert(path.to_lowercase()) {
            return Err(format!(
                "{path:?} appears twice when letter case is ignored"
            ));
        }
    }
    Ok(())
}

/// Every path the manifest names, before any of them is used.
pub fn validate_manifest(manifest: &Manifest) -> std::result::Result<(), String> {
    let mut keys = HashSet::new();
    for checkout in &manifest.checkouts {
        match (&checkout.worktree, checkout.key.as_str()) {
            (None, "main") => {}
            (Some(slug), key) if key == format!("worktree:{slug}") => {
                crate::worktrees::validate_slug(slug).map_err(|e| format!("{e:#}"))?;
                component(slug)?;
            }
            (_, key) => return Err(format!("checkout key {key:?}")),
        }
        if !keys.insert(checkout.key.clone()) {
            return Err(format!("checkout {:?} appears twice", checkout.key));
        }
        if !numbered(&checkout.archive_dir, "checkouts/") {
            return Err(format!("checkout folder {:?}", checkout.archive_dir));
        }
        for path in &checkout.untracked {
            relative(path)?;
        }
        unique_folded(checkout.untracked.iter().map(String::as_str))?;
    }
    for pane in &manifest.panes {
        conversation(&pane.conversation)?;
        if !keys.contains(&pane.checkout) {
            return Err(format!(
                "pane {} names checkout {:?}",
                pane.source_session, pane.checkout
            ));
        }
        if !numbered(&pane.archive_dir, "transcripts/") {
            return Err(format!("transcript folder {:?}", pane.archive_dir));
        }
        if !pane.rel_cwd.is_empty() {
            relative(&pane.rel_cwd)?;
        }
        relative(&pane.transcript)?;
        match pane.provider {
            proto::AgentKind::Claude => {
                if pane.transcript != format!("{}.jsonl", pane.conversation) {
                    return Err(format!("Claude transcript {:?}", pane.transcript));
                }
                let prefix = format!("{}/", pane.conversation);
                for extra in &pane.extra_files {
                    relative(extra)?;
                    if !extra.starts_with(&prefix) {
                        return Err(format!("Claude session file {extra:?}"));
                    }
                }
            }
            proto::AgentKind::Codex => {
                if !pane.transcript.starts_with("sessions/") || !pane.transcript.ends_with(".jsonl")
                {
                    return Err(format!("Codex rollout {:?}", pane.transcript));
                }
                if !pane.extra_files.is_empty() {
                    return Err("a Codex conversation with extra files".into());
                }
            }
            other => return Err(format!("{other:?} pane")),
        }
        unique_folded(
            std::iter::once(pane.transcript.as_str())
                .chain(pane.extra_files.iter().map(String::as_str)),
        )?;
    }
    Ok(())
}

/// `root` joined with the `/`-separated `relative`, refusing a symbolic link anywhere
/// between them: a carried file never lands outside `root`.
pub fn inside(root: &Path, relative: &str) -> Result<PathBuf> {
    self::relative(relative).map_err(|e| anyhow::anyhow!(e))?;
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => bail!(
                "{} is a symbolic link, so a carried file would land outside {}",
                plain(&path).display(),
                plain(root).display()
            ),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }
    Ok(relative
        .split('/')
        .fold(root.to_path_buf(), |p, c| p.join(c)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_refuse_escapes_drives_and_device_names() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "C:/x",
            "c:x",
            r"a\b",
            "a//b",
            "./a",
            "con",
            "dir/NUL.txt",
            "lpt1.log",
            "trailing.",
            "space ",
            "a/b\u{0}",
        ] {
            assert!(relative(bad).is_err(), "{bad:?} must be refused");
        }
        for good in ["a.txt", "src/lib.rs", "notes/console.md", "a/b/c.d.e"] {
            assert!(relative(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn plain_paths_drop_both_verbatim_forms() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\dev\x")),
            PathBuf::from(r"C:\dev\x")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\host\share\x")),
            PathBuf::from(r"\\host\share\x")
        );
        assert_eq!(
            plain(Path::new("/home/dev/x")),
            PathBuf::from("/home/dev/x")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_canonical_windows_folder_encodes_without_the_verbatim_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = canonical(dir.path());
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            resolved.display()
        );
        let folder = super::super::transcripts::claude_project_folder(&resolved);
        assert!(folder.as_bytes()[0].is_ascii_alphabetic(), "{folder}");
        assert_eq!(&folder[1..3], "--", "{folder}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_parent_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        let error = inside(root.path(), "link/file.txt").unwrap_err();
        assert!(format!("{error:#}").contains("symbolic link"), "{error:#}");
        assert!(inside(root.path(), "new/file.txt").is_ok());
    }

    #[test]
    fn case_folded_duplicates_are_refused() {
        assert!(unique_folded(["Readme.md", "README.md"].into_iter()).is_err());
        assert!(unique_folded(["a.md", "b.md"].into_iter()).is_ok());
    }
}

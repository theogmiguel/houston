//! Reading, matching and replacing v1-managed config files.

use anyhow::{anyhow, Context, Result};
use std::path::Path;

/// Token-exact, never `contains`: release's sentinel is a prefix of every channel's.
/// `;` separates because the shell guard writes `--houston-managed=dev; fi`.
pub fn has_sentinel(text: &str, sentinel: &str) -> bool {
    tokens(text).any(|t| t == sentinel)
}

/// Any channel's sentinel, for state every channel that installed shares.
pub fn has_any_sentinel(text: &str) -> bool {
    tokens(text).any(|t| {
        t.strip_prefix(super::SENTINEL)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
    })
}

fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '[' | ']' | ';'))
}

/// The file's text, `None` when it does not exist.
pub fn read(path: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow!("cannot read it: {e}")),
    }
}

/// Parses JSON the way v1 required it; the error names the parse failure and position.
pub fn parse_json(text: &str) -> Result<serde_json::Value> {
    serde_json::from_str(text).map_err(|e| anyhow!("not valid JSON: {e}"))
}

/// v1 wrote every JSON config whole, pretty-printed with sorted keys and a final newline;
/// writing back the same way leaves the bytes outside Houston's entries as v1 left them.
pub fn write_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    let mut out = serde_json::to_string_pretty(value)?;
    out.push('\n');
    atomic_write(path, out.as_bytes())
}

/// Through a temporary file and a rename, so a CLI starting mid-write never reads a
/// truncated config. An existing symlink is followed, so the user's target is replaced.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut target = path.to_path_buf();
    for _ in 0..40 {
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let link = std::fs::read_link(&target)?;
                target = if link.is_absolute() {
                    link
                } else {
                    target.parent().unwrap_or(Path::new(".")).join(link)
                };
            }
            _ => break,
        }
    }
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating a temporary file in {}", parent.display()))?;
    if let Ok(meta) = std::fs::metadata(&target) {
        temporary.as_file().set_permissions(meta.permissions())?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&target)
        .map_err(|e| anyhow!("replacing {}: {}", target.display(), e.error))?;
    Ok(())
}

pub fn remove(path: &Path) -> Result<()> {
    std::fs::remove_file(path).map_err(|e| anyhow!("cannot remove it: {e}"))
}

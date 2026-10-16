//! Carries the ignored files a repository lists in `.worktreeinclude` into a new managed
//! worktree, and tells cleanup which ignored files are still such unchanged copies.
//! Git answers which paths match and which are ignored; nothing from the repository runs.

use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const INCLUDE_FILE: &str = ".worktreeinclude";
/// Local settings and secrets are a handful of small files; a listing past these is
/// build output or data, which every new worktree should not copy again.
pub const MAX_FILES: usize = 256;
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;
/// Listing and matching are local reads; a git stuck past this skips the copy, never the
/// worktree.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// A warning names this many paths and counts the rest, so it stays one readable line.
const NAMED_PATHS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub files: usize,
    pub bytes: u64,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        files: MAX_FILES,
        bytes: MAX_BYTES,
    };
}

/// Paths are relative to the checkout root; no file contents are ever held here.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub copied: Vec<String>,
    pub warnings: Vec<String>,
}

/// Copies into `tree` every file under the checkout of `repo` that `.worktreeinclude`
/// matches and git ignores. Tracked files are never candidates, an existing file in
/// `tree` is never overwritten, and a failure becomes a warning: the worktree stands.
pub fn carry_over(repo: &Path, tree: &Path) -> Report {
    carry_over_within(repo, tree, Limits::DEFAULT)
}

pub fn carry_over_within(repo: &Path, tree: &Path, limits: Limits) -> Report {
    let mut report = Report::default();
    let source = match checkout_root(repo) {
        Some(root) => root,
        None => {
            report.warnings.push(format!(
                "{INCLUDE_FILE}: nothing copied into {}: the checkout root of {} is unknown",
                tree.display(),
                repo.display()
            ));
            return report;
        }
    };
    let list = source.join(INCLUDE_FILE);
    match std::fs::symlink_metadata(&list) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return report,
        Err(e) => {
            report.warnings.push(format!(
                "{INCLUDE_FILE}: nothing copied into {}: reading {} failed: {e}",
                tree.display(),
                list.display()
            ));
            return report;
        }
        Ok(meta) if !meta.is_file() => {
            report.warnings.push(format!(
                "{INCLUDE_FILE}: nothing copied into {}: {} is not a regular file \
                 (a symlink or directory is refused); expected a file of gitignore patterns",
                tree.display(),
                list.display()
            ));
            return report;
        }
        Ok(_) => {}
    }
    let listed = match listed_ignored(&source) {
        Ok(listed) => listed,
        Err(e) => {
            report.warnings.push(format!(
                "{INCLUDE_FILE}: nothing copied into {}: {e:#}",
                tree.display()
            ));
            return report;
        }
    };
    copy_listed(&source, tree, listed, limits, &mut report);
    if !report.copied.is_empty() {
        tracing::info!(
            "{INCLUDE_FILE}: copied {} file(s) into {}: {}",
            report.copied.len(),
            tree.display(),
            report.copied.join(", ")
        );
    }
    for warning in &report.warnings {
        tracing::warn!("{warning}");
    }
    report
}

fn copy_listed(
    source: &Path,
    tree: &Path,
    listed: Vec<String>,
    limits: Limits,
    report: &mut Report,
) {
    let mut refused: Vec<(String, &'static str)> = Vec::new();
    let mut existing = Vec::new();
    let mut eligible = Vec::new();
    let source_real = source.canonicalize().ok();
    for rel in listed {
        let src = source.join(&rel);
        let reason = if !is_plain_relative(&rel) {
            Some("the path leaves the checkout")
        } else {
            match std::fs::symlink_metadata(&src) {
                Ok(meta) if meta.file_type().is_symlink() => Some("it is a symlink"),
                Ok(meta) if !meta.is_file() => Some("it is not a regular file"),
                Ok(meta) => {
                    let inside = src
                        .canonicalize()
                        .ok()
                        .zip(source_real.as_ref())
                        .is_some_and(|(real, root)| real.starts_with(root));
                    if !inside {
                        Some("it resolves outside the checkout")
                    } else if std::fs::symlink_metadata(tree.join(&rel)).is_ok() {
                        existing.push(rel.clone());
                        None
                    } else {
                        eligible.push((rel.clone(), meta.len()));
                        None
                    }
                }
                Err(_) => Some("it could not be read"),
            }
        };
        if let Some(reason) = reason {
            refused.push((rel, reason));
        }
    }
    let total_files = eligible.len();
    let total_bytes: u64 = eligible.iter().map(|(_, len)| len).sum();
    let mut bytes = 0u64;
    let mut over: Option<usize> = None;
    for (index, (rel, len)) in eligible.iter().enumerate() {
        if report.copied.len() >= limits.files || bytes + len > limits.bytes {
            over = Some(index);
            break;
        }
        match copy_one(&source.join(rel), tree, rel) {
            Ok(()) => {
                bytes += len;
                report.copied.push(rel.clone());
            }
            Err(e) => {
                report.warnings.push(format!(
                    "{INCLUDE_FILE}: {rel} was not copied into {}: {e:#}",
                    tree.display()
                ));
            }
        }
    }
    if let Some(index) = over {
        let left: Vec<String> = eligible[index..].iter().map(|(r, _)| r.clone()).collect();
        let limit = if report.copied.len() >= limits.files {
            format!(
                "the limit of {} files (asked for {total_files} files)",
                limits.files
            )
        } else {
            format!(
                "the limit of {} bytes (asked for {total_bytes} bytes)",
                limits.bytes
            )
        };
        report.warnings.push(format!(
            "{INCLUDE_FILE}: copying into {} stopped at {limit}; copied {} file(s), \
             not copied: {}",
            tree.display(),
            report.copied.len(),
            name_paths(&left)
        ));
    }
    for reason in [
        "the path leaves the checkout",
        "it is a symlink",
        "it is not a regular file",
        "it resolves outside the checkout",
        "it could not be read",
    ] {
        let paths: Vec<String> = refused
            .iter()
            .filter(|(_, r)| *r == reason)
            .map(|(p, _)| p.clone())
            .collect();
        if !paths.is_empty() {
            report.warnings.push(format!(
                "{INCLUDE_FILE}: not copied into {} because {reason}: {}",
                tree.display(),
                name_paths(&paths)
            ));
        }
    }
    if !existing.is_empty() {
        report.warnings.push(format!(
            "{INCLUDE_FILE}: kept the worktree's own file, not overwritten: {}",
            name_paths(&existing)
        ));
    }
}

/// Creates each missing parent itself so no existing symlink in `tree` is followed out
/// of it, then writes a file that must not exist yet.
fn copy_one(src: &Path, tree: &Path, rel: &str) -> Result<()> {
    let rel_path = Path::new(rel);
    let mut dir = tree.to_path_buf();
    if let Some(parent) = rel_path.parent() {
        for part in parent.components() {
            dir.push(part);
            match std::fs::symlink_metadata(&dir) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    bail!(
                        "{} in the worktree is a symlink; expected a directory",
                        dir.display()
                    )
                }
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => bail!("{} in the worktree is not a directory", dir.display()),
                Err(_) => std::fs::create_dir(&dir)
                    .with_context(|| format!("creating {}", dir.display()))?,
            }
        }
    }
    let dest = tree.join(rel_path);
    let mut input = std::fs::File::open(src).with_context(|| format!("opening {rel}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mode = input.metadata()?.permissions().mode() & 0o777;
        options.mode(mode);
    }
    let mut output = options
        .open(&dest)
        .with_context(|| format!("creating {}", dest.display()))?;
    if let Err(e) = std::io::copy(&mut input, &mut output).and_then(|_| output.flush()) {
        drop(output);
        let _ = std::fs::remove_file(&dest);
        return Err(e).with_context(|| format!("writing {}", dest.display()));
    }
    Ok(())
}

/// What cleanup may discount: compares at most `Limits::DEFAULT` worth of files, and a
/// file past the budget counts as the worktree's own.
#[derive(Debug)]
pub struct CompareBudget {
    files: usize,
    bytes: u64,
}

impl Default for CompareBudget {
    fn default() -> Self {
        CompareBudget {
            files: MAX_FILES,
            bytes: MAX_BYTES,
        }
    }
}

/// Whether `rel` in `tree` is byte for byte the file at the same path in the checkout
/// `source`, so removing it loses nothing. Symlinks and paths that leave either root
/// are never unchanged copies.
pub fn unchanged_copy(source: &Path, tree: &Path, rel: &str, budget: &mut CompareBudget) -> bool {
    if !is_plain_relative(rel) || budget.files == 0 {
        return false;
    }
    let (src, copy) = (source.join(rel), tree.join(rel));
    let (Ok(src_meta), Ok(copy_meta)) = (
        std::fs::symlink_metadata(&src),
        std::fs::symlink_metadata(&copy),
    ) else {
        return false;
    };
    if !src_meta.is_file() || !copy_meta.is_file() || src_meta.len() != copy_meta.len() {
        return false;
    }
    if src_meta.len() > budget.bytes {
        return false;
    }
    let inside = src
        .canonicalize()
        .ok()
        .zip(source.canonicalize().ok())
        .is_some_and(|(real, root)| real.starts_with(root));
    if !inside {
        return false;
    }
    budget.files -= 1;
    budget.bytes -= src_meta.len();
    same_bytes(&src, &copy).unwrap_or(false)
}

fn same_bytes(a: &Path, b: &Path) -> std::io::Result<bool> {
    let (mut a, mut b) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut buf_a, mut buf_b) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = a.read(&mut buf_a)?;
        if n == 0 {
            return Ok(b.read(&mut buf_b[..1])? == 0);
        }
        b.read_exact(&mut buf_b[..n])?;
        if buf_a[..n] != buf_b[..n] {
            return Ok(false);
        }
    }
}

fn is_plain_relative(rel: &str) -> bool {
    !rel.is_empty()
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn name_paths(paths: &[String]) -> String {
    let mut named = paths
        .iter()
        .take(NAMED_PATHS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > NAMED_PATHS {
        named.push_str(&format!(" (+{} more)", paths.len() - NAMED_PATHS));
    }
    named
}

fn checkout_root(repo: &Path) -> Option<PathBuf> {
    crate::git::checkout_facts(repo)
        .toplevel
        .filter(|t| !t.is_empty())
        .map(PathBuf::from)
}

/// Untracked files the include list matches, narrowed to those git ignores. Both
/// answers come from git, so the patterns mean exactly what they mean in `.gitignore`.
fn listed_ignored(source: &Path) -> Result<Vec<String>> {
    let list_arg = format!("--exclude-from={INCLUDE_FILE}");
    let matched = git(
        source,
        &["ls-files", "-z", "--others", "--ignored", &list_arg],
        None,
    )?;
    let matched = matched.stdout;
    if matched.is_empty() {
        return Ok(Vec::new());
    }
    let ignored = git(source, &["check-ignore", "-z", "--stdin"], Some(matched))?;
    if ignored.code == Some(1) {
        return Ok(Vec::new());
    }
    let mut paths: Vec<String> = String::from_utf8_lossy(&ignored.stdout)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

struct GitOut {
    stdout: Vec<u8>,
    code: Option<i32>,
}

/// `check-ignore` exits 1 when nothing is ignored, so that exit is an answer too.
fn git(dir: &Path, args: &[&str], stdin: Option<Vec<u8>>) -> Result<GitOut> {
    let mut cmd = crate::spawn::command("git");
    #[cfg(windows)]
    cmd.args(["-c", "core.longpaths=true"]);
    cmd.args(["-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let out = match stdin {
        None => crate::spawn::output_within(cmd, GIT_TIMEOUT),
        Some(input) => {
            let (reader, mut writer) = std::io::pipe().context("opening a pipe for git")?;
            // The writer runs beside the capture: input larger than the pipe buffer
            // would otherwise block before git starts reading.
            let feeder = std::thread::spawn(move || {
                let _ = writer.write_all(&input);
            });
            let out = crate::spawn::output_within_with_stdin(cmd, GIT_TIMEOUT, reader.into());
            let _ = feeder.join();
            out
        }
    }
    .with_context(|| format!("git {args:?} in {} could not run", dir.display()))?
    .with_context(|| {
        format!(
            "git {args:?} in {} gave no answer within {} s",
            dir.display(),
            GIT_TIMEOUT.as_secs()
        )
    })?;
    let code = out.status.code();
    if !out.status.success() && code != Some(1) {
        bail!(
            "git {args:?} in {} failed (exit {code:?}): {}",
            dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(GitOut {
        stdout: out.stdout,
        code,
    })
}

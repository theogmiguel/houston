//! A checkout's code state for a transfer: branch, HEAD, a bundle of commits no remote
//! ref has, a binary diff of tracked changes and the untracked, non-ignored files.

use super::manifest::TreeState;
use super::refuse;
use anyhow::{bail, Context, Result};
use houston_protocol::TransferRefusalCode as Code;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Bundling or applying a large checkout's state runs well past an interactive git call.
const GIT_TIMEOUT: Duration = Duration::from_secs(600);

struct GitOutput {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn git_raw(dir: &Path, args: &[&str]) -> Result<GitOutput> {
    let mut command = crate::git::command();
    command
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "core.quotePath=false",
            "-c",
            "advice.detachedHead=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::spawn::output_within(command, GIT_TIMEOUT)
        .with_context(|| format!("running git {args:?} in {}", dir.display()))?
        .with_context(|| {
            format!(
                "git {args:?} in {} did not finish within {} s",
                dir.display(),
                GIT_TIMEOUT.as_secs()
            )
        })?;
    Ok(GitOutput {
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = git_raw(dir, args)?;
    if out.code != Some(0) {
        bail!(
            "git {args:?} in {} failed (exit {:?}): {}",
            dir.display(),
            out.code,
            out.stderr
        );
    }
    Ok(out.stdout)
}

fn git_text(dir: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git(dir, args)?).trim().to_string())
}

fn nul_list(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

fn path_of(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |p, c| p.join(c))
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        std::fs::File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).with_context(|| format!("reading {}", path.display()))?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn head(dir: &Path) -> Result<String> {
    git_text(dir, &["rev-parse", "--verify", "HEAD^{commit}"])
}

/// The checked-out branch, or `None` on a detached HEAD.
pub fn branch(dir: &Path) -> Result<Option<String>> {
    let out = git_raw(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    match out.code {
        Some(0) => Ok(Some(
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        )),
        Some(1) => Ok(None),
        code => bail!(
            "git symbolic-ref HEAD in {} failed (exit {code:?}): {}",
            dir.display(),
            out.stderr
        ),
    }
}

/// The top of the checkout that contains `dir`.
pub fn toplevel(dir: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(git_text(
        dir,
        &["rev-parse", "--show-toplevel"],
    )?))
}

pub fn untracked(dir: &Path) -> Result<Vec<String>> {
    Ok(nul_list(&git(
        dir,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?))
}

fn changed_tracked(dir: &Path) -> Result<Vec<String>> {
    Ok(nul_list(&git(
        dir,
        &["diff", "--name-only", "--no-renames", "-z", "HEAD"],
    )?))
}

/// The checkout's `TreeState`: HEAD, and a hash of each changed or untracked path.
pub fn tree_state(dir: &Path) -> Result<TreeState> {
    let head = head(dir)?;
    let mut paths = std::collections::BTreeMap::new();
    for relative in changed_tracked(dir)?.into_iter().chain(untracked(dir)?) {
        let path = path_of(dir, &relative);
        let hash = match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "deleted".to_string(),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
            Ok(meta) if meta.file_type().is_symlink() => format!(
                "link:{}",
                std::fs::read_link(&path)
                    .with_context(|| format!("reading the link {}", path.display()))?
                    .display()
            ),
            Ok(_) => sha256_file(&path)?,
        };
        paths.insert(relative, hash);
    }
    Ok(TreeState { head, paths })
}

/// The untracked regular files `capture` will carry, checked before panes stop.
pub fn untracked_files(dir: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for relative in untracked(dir)? {
        let meta = std::fs::symlink_metadata(path_of(dir, &relative))
            .with_context(|| format!("reading {relative} in {}", dir.display()))?;
        if meta.is_file() && !meta.file_type().is_symlink() {
            files.push(relative);
        }
    }
    Ok(files)
}

/// The non-ignored paths `git status` reports: anything import would have to overwrite.
pub fn dirty_paths(dir: &Path) -> Result<Vec<String>> {
    let raw = git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut out = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        let text = String::from_utf8_lossy(field);
        let (status, path) = text.split_at(3.min(text.len()));
        // A rename or copy is followed by its source path as a separate field.
        if status.starts_with('R') || status.starts_with('C') {
            fields.next();
        }
        out.push(path.to_string());
    }
    Ok(out)
}

pub struct Captured {
    pub branch: Option<String>,
    pub head: String,
    pub bundle: Option<PathBuf>,
    pub diff: Option<PathBuf>,
    /// Untracked regular files, `/`-separated and relative to the checkout.
    pub untracked: Vec<String>,
    pub links: Vec<String>,
    pub state: TreeState,
}

/// Captures `dir`'s state, writing the bundle and diff under `scratch`.
pub fn capture(dir: &Path, scratch: &Path) -> Result<Captured> {
    std::fs::create_dir_all(scratch).with_context(|| format!("creating {}", scratch.display()))?;
    let head = head(dir)?;
    let branch = branch(dir)?;
    let local_commits = git_text(dir, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?;
    let bundle = if local_commits != "0" {
        let path = scratch.join("head.bundle");
        git(
            dir,
            &[
                "bundle",
                "create",
                &path.display().to_string(),
                "HEAD",
                "--not",
                "--remotes",
            ],
        )?;
        Some(path)
    } else {
        None
    };
    let diff_path = scratch.join("tracked.diff");
    git(
        dir,
        &[
            "diff",
            "--binary",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &format!("--output={}", diff_path.display()),
            "HEAD",
        ],
    )?;
    let diff = (std::fs::metadata(&diff_path)?.len() > 0).then_some(diff_path);
    let mut files = Vec::new();
    let mut links = Vec::new();
    for relative in untracked(dir)? {
        let meta = std::fs::symlink_metadata(path_of(dir, &relative))
            .with_context(|| format!("reading {relative} in {}", dir.display()))?;
        if meta.file_type().is_symlink() {
            links.push(relative);
        } else if meta.is_file() {
            files.push(relative);
        }
    }
    let state = tree_state(dir)?;
    Ok(Captured {
        branch,
        head,
        bundle,
        diff,
        untracked: files,
        links,
        state,
    })
}

pub fn has_commit(dir: &Path, sha: &str) -> Result<bool> {
    let out = git_raw(dir, &["cat-file", "-e", &format!("{sha}^{{commit}}")])?;
    Ok(out.code == Some(0))
}

/// The bundle's prerequisite commits this repository lacks.
pub fn missing_prerequisites(dir: &Path, bundle: &Path) -> Result<Vec<String>> {
    let out = git_raw(dir, &["bundle", "verify", &bundle.display().to_string()])?;
    if out.code == Some(0) {
        return Ok(Vec::new());
    }
    let missing: Vec<String> = out
        .stderr
        .lines()
        .filter_map(|line| line.strip_prefix("error: "))
        .filter_map(|rest| rest.split_whitespace().next())
        .filter(|sha| sha.len() >= 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_string)
        .collect();
    if missing.is_empty() {
        bail!(
            "git bundle verify in {} failed (exit {:?}): {}",
            dir.display(),
            out.code,
            out.stderr
        );
    }
    Ok(missing)
}

/// Adds the bundle's objects; the caller points a ref at its head.
pub fn unbundle(dir: &Path, bundle: &Path) -> Result<()> {
    git(dir, &["bundle", "unbundle", &bundle.display().to_string()]).map(drop)
}

pub fn is_ancestor(dir: &Path, ancestor: &str, descendant: &str) -> Result<bool> {
    let out = git_raw(dir, &["merge-base", "--is-ancestor", ancestor, descendant])?;
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        code => bail!(
            "git merge-base --is-ancestor {ancestor} {descendant} in {} failed (exit {code:?}): {}",
            dir.display(),
            out.stderr
        ),
    }
}

pub fn branch_tip(dir: &Path, branch: &str) -> Result<Option<String>> {
    let out = git_raw(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )?;
    Ok((out.code == Some(0)).then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// Whether moving `branch` to `head` is a fast-forward (or no move).
pub fn branch_fast_forwards(dir: &Path, branch: &str, head: &str) -> Result<bool> {
    match branch_tip(dir, branch)? {
        None => Ok(true),
        Some(tip) if tip == head => Ok(true),
        Some(tip) => is_ancestor(dir, &tip, head),
    }
}

/// Moves the checkout at `dir` to `head`: on `branch` (created or fast-forwarded) or
/// detached. The checkout is clean, and the caller checked the fast-forward.
pub fn move_to(dir: &Path, branch: Option<&str>, head: &str) -> Result<()> {
    let Some(name) = branch else {
        return git(dir, &["checkout", "--detach", head]).map(drop);
    };
    let current = self::branch(dir)?;
    match branch_tip(dir, name)? {
        None => git(dir, &["checkout", "-b", name, head]).map(drop),
        Some(tip) => {
            if current.as_deref() == Some(name) {
                if tip != head {
                    git(dir, &["merge", "--ff-only", "--quiet", head])?;
                }
                return Ok(());
            }
            if tip != head {
                git(
                    dir,
                    &["update-ref", &format!("refs/heads/{name}"), head, &tip],
                )?;
            }
            git(dir, &["checkout", name]).map(drop)
        }
    }
}

/// Moves `branch` from `tip` to `head`; the caller checked that this fast-forwards.
pub fn fast_forward_ref(dir: &Path, branch: &str, tip: &str, head: &str) -> Result<()> {
    git(
        dir,
        &["update-ref", &format!("refs/heads/{branch}"), head, tip],
    )
    .map(drop)
}

/// Applies a diff made by `capture` to the working tree only.
pub fn apply_diff(dir: &Path, diff: &Path) -> Result<()> {
    git(
        dir,
        &[
            "apply",
            "--binary",
            "--whitespace=nowarn",
            &diff.display().to_string(),
        ],
    )
    .map(drop)
}

/// The paths of `relatives` that exist in `dir` and that the checkout does not track at
/// HEAD: writing an untracked file there would overwrite something.
pub fn untracked_collisions(
    dir: &Path,
    relatives: &[String],
    ignore: &[String],
) -> Result<Vec<String>> {
    let tracked: std::collections::HashSet<String> = nul_list(&git(dir, &["ls-files", "-z"])?)
        .into_iter()
        .collect();
    Ok(relatives
        .iter()
        .filter(|relative| !ignore.contains(relative) && !tracked.contains(*relative))
        .filter(|relative| std::fs::symlink_metadata(path_of(dir, relative)).is_ok())
        .cloned()
        .collect())
}

/// Copies untracked files from `source` into `dir`, never over an existing file. Each
/// file is added to `written` before it is created, so a failure still lists it.
pub fn write_untracked(
    dir: &Path,
    source: &Path,
    relatives: &[String],
    written: &mut Vec<PathBuf>,
) -> Result<()> {
    for relative in relatives {
        let dest = super::paths::inside(dir, relative)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let mut from = std::fs::File::open(path_of(source, relative))
            .with_context(|| format!("reading the carried copy of {relative}"))?;
        let mut to = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .with_context(|| format!("creating {}", dest.display()))?;
        written.push(dest.clone());
        std::io::copy(&mut from, &mut to).with_context(|| format!("writing {}", dest.display()))?;
    }
    Ok(())
}

/// A return trip's local changes, set aside so an undone import can put them back.
pub struct SavedChanges {
    diff: Option<PathBuf>,
    files: PathBuf,
    untracked: Vec<String>,
}

pub fn save_changes(dir: &Path, into: &Path, untracked: &[String]) -> Result<SavedChanges> {
    std::fs::create_dir_all(into).with_context(|| format!("creating {}", into.display()))?;
    let diff = into.join("tracked.diff");
    git(
        dir,
        &[
            "diff",
            "--binary",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &format!("--output={}", diff.display()),
            "HEAD",
        ],
    )?;
    let files = into.join("untracked");
    let mut kept = Vec::new();
    for relative in untracked {
        let from = path_of(dir, relative);
        if from.is_file() {
            let to = path_of(&files, relative);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&from, &to).with_context(|| format!("saving {}", from.display()))?;
            kept.push(relative.clone());
        }
    }
    Ok(SavedChanges {
        diff: (std::fs::metadata(&diff)?.len() > 0).then_some(diff),
        files,
        untracked: kept,
    })
}

pub fn put_back(dir: &Path, saved: &SavedChanges) -> Result<()> {
    if let Some(diff) = &saved.diff {
        apply_diff(dir, diff)?;
    }
    for relative in &saved.untracked {
        let to = path_of(dir, relative);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(path_of(&saved.files, relative), &to)
            .with_context(|| format!("restoring {}", to.display()))?;
    }
    Ok(())
}

/// Whether `diff` applies to the tree of commit `head`, checked in a scratch index so
/// neither the working tree nor the checkout's index changes. `None` when it applies.
pub fn diff_apply_error(dir: &Path, head: &str, diff: &Path) -> Result<Option<String>> {
    let scratch = tempfile::tempdir().context("creating a scratch index folder")?;
    let index = scratch.path().join("index");
    let run = |args: &[&str]| -> Result<GitOutput> {
        let mut command = crate::git::command();
        command
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_INDEX_FILE", &index)
            .env("GIT_TERMINAL_PROMPT", "0");
        let out = crate::spawn::output_within(command, GIT_TIMEOUT)?
            .with_context(|| format!("git {args:?} did not finish"))?;
        Ok(GitOutput {
            code: out.status.code(),
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    };
    let read = run(&["read-tree", head])?;
    if read.code != Some(0) {
        bail!(
            "git read-tree {head} in {} failed: {}",
            dir.display(),
            read.stderr
        );
    }
    let check = run(&[
        "apply",
        "--check",
        "--cached",
        "--binary",
        &diff.display().to_string(),
    ])?;
    Ok((check.code != Some(0)).then_some(check.stderr))
}

/// Paths commits between `from` and `to` add, `/`-separated.
pub fn added_between(dir: &Path, from: &str, to: &str) -> Result<Vec<String>> {
    Ok(nul_list(&git(
        dir,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "--diff-filter=A",
            "-z",
            from,
            to,
        ],
    )?))
}

/// Paths a diff made by `capture` creates.
pub fn created_by_diff(dir: &Path, diff: &Path) -> Result<Vec<String>> {
    let summary = git_text(dir, &["apply", "--summary", &diff.display().to_string()])?;
    Ok(summary
        .lines()
        .filter_map(|line| line.trim().strip_prefix("create mode "))
        .filter_map(|rest| rest.split_once(' ').map(|(_, path)| path.to_string()))
        .collect())
}

/// Files whose staged content differs from the working copy. A transfer carries the
/// working copy only, so the staged version would be lost.
pub fn partially_staged(dir: &Path) -> Result<Vec<String>> {
    let staged: std::collections::HashSet<String> = nul_list(&git(
        dir,
        &["diff", "--cached", "--name-only", "--no-renames", "-z"],
    )?)
    .into_iter()
    .collect();
    Ok(
        nul_list(&git(dir, &["diff", "--name-only", "--no-renames", "-z"])?)
            .into_iter()
            .filter(|path| staged.contains(path))
            .collect(),
    )
}

/// Where a checkout stood before import changed it: its branch (or detached) and HEAD.
#[derive(Debug, Clone)]
pub struct Position {
    pub branch: Option<String>,
    pub head: String,
}

pub fn position(dir: &Path) -> Result<Position> {
    Ok(Position {
        branch: branch(dir)?,
        head: head(dir)?,
    })
}

/// Puts a checkout back where `position` recorded it, discarding tracked changes import
/// made. Untracked files import wrote are the caller's to remove.
pub fn restore_position(dir: &Path, position: &Position) -> Result<()> {
    git(dir, &["reset", "--quiet", "--hard"])?;
    match &position.branch {
        Some(name) => {
            git(dir, &["checkout", "--quiet", "-f", name])?;
        }
        None => {
            git(
                dir,
                &["checkout", "--quiet", "-f", "--detach", &position.head],
            )?;
        }
    }
    git(dir, &["reset", "--quiet", "--hard", &position.head]).map(drop)
}

/// Points `branch` back at `tip`, or deletes it when import created it.
pub fn restore_branch(dir: &Path, branch: &str, tip: Option<&str>) -> Result<()> {
    let reference = format!("refs/heads/{branch}");
    match tip {
        Some(tip) => git(dir, &["update-ref", &reference, tip]).map(drop),
        None => git(dir, &["update-ref", "-d", &reference]).map(drop),
    }
}

/// Return trip: discards the exported tracked changes and removes exactly the untracked
/// files the export recorded. Other untracked and ignored files stay.
pub fn restore_exported_state(dir: &Path, exported_untracked: &[String]) -> Result<()> {
    git(dir, &["reset", "--quiet", "--hard", "HEAD"])?;
    for relative in exported_untracked {
        let path = path_of(dir, relative);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("removing {}", path.display())),
        }
    }
    Ok(())
}

/// A refusal for a checkout with uncommitted changes.
pub fn dirty_refusal(dir: &str, paths: Vec<String>) -> anyhow::Error {
    refuse(
        Code::DirtyCheckout,
        format!(
            "{dir} has uncommitted changes, and import would mix them with the transferred changes."
        ),
        paths,
        vec![
            format!("Commit, stash or discard the listed changes in {dir}, then import again."),
            "Or choose another folder for the import.".into(),
        ],
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    // Byte-exact fixtures: a host-wide core.autocrlf would rewrite checked-out files.
    fn plain_eol(dir: &Path) {
        run(dir, &["config", "core.autocrlf", "false"]);
    }

    fn repo() -> tempfile::TempDir {
        let dir = crate::fixture_dirs::tempdir_outside_git();
        run(dir.path(), &["init", "-q", "-b", "main"]);
        plain_eol(dir.path());
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-q", "-m", "one"]);
        dir
    }

    #[test]
    fn capture_carries_local_commits_the_diff_and_untracked_files_into_a_clone() {
        let origin = repo();
        let clone = crate::fixture_dirs::tempdir_outside_git();
        run(
            clone.path(),
            &[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                &origin.path().display().to_string(),
                ".",
            ],
        );
        let source = crate::fixture_dirs::tempdir_outside_git();
        run(
            source.path(),
            &[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                &origin.path().display().to_string(),
                ".",
            ],
        );
        run(source.path(), &["checkout", "-q", "-b", "feature"]);
        std::fs::write(source.path().join("b.txt"), "local\n").unwrap();
        run(source.path(), &["add", "."]);
        run(source.path(), &["commit", "-q", "-m", "local"]);
        std::fs::write(source.path().join("a.txt"), "two\n").unwrap();
        std::fs::create_dir_all(source.path().join("new")).unwrap();
        std::fs::write(source.path().join("new/c.txt"), "untracked\n").unwrap();

        let scratch = tempfile::tempdir().unwrap();
        let captured = capture(source.path(), scratch.path()).unwrap();
        assert_eq!(captured.branch.as_deref(), Some("feature"));
        assert_eq!(captured.untracked, vec!["new/c.txt".to_string()]);
        let bundle = captured
            .bundle
            .as_deref()
            .expect("a local commit is bundled");

        assert!(!has_commit(clone.path(), &captured.head).unwrap());
        assert!(missing_prerequisites(clone.path(), bundle)
            .unwrap()
            .is_empty());
        unbundle(clone.path(), bundle).unwrap();
        assert!(branch_fast_forwards(clone.path(), "feature", &captured.head).unwrap());
        move_to(clone.path(), Some("feature"), &captured.head).unwrap();
        apply_diff(clone.path(), captured.diff.as_deref().unwrap()).unwrap();
        write_untracked(
            clone.path(),
            source.path(),
            &captured.untracked,
            &mut Vec::new(),
        )
        .unwrap();

        assert_eq!(tree_state(clone.path()).unwrap(), captured.state);
        assert_eq!(branch(clone.path()).unwrap().as_deref(), Some("feature"));
    }

    #[test]
    fn a_diverged_branch_does_not_fast_forward() {
        let dir = repo();
        let base = head(dir.path()).unwrap();
        run(dir.path(), &["checkout", "-q", "-b", "side"]);
        std::fs::write(dir.path().join("a.txt"), "side\n").unwrap();
        run(dir.path(), &["commit", "-qam", "side"]);
        let side = head(dir.path()).unwrap();
        run(dir.path(), &["checkout", "-q", "main"]);
        std::fs::write(dir.path().join("a.txt"), "main\n").unwrap();
        run(dir.path(), &["commit", "-qam", "main"]);
        assert!(!branch_fast_forwards(dir.path(), "main", &side).unwrap());
        assert!(branch_fast_forwards(dir.path(), "side", &side).unwrap());
        assert!(is_ancestor(dir.path(), &base, &side).unwrap());
    }

    #[test]
    fn dirty_paths_and_collisions_name_untracked_and_ignored_files() {
        let dir = repo();
        std::fs::write(dir.path().join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(dir.path().join("ignored.log"), "x").unwrap();
        std::fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
        let dirty = dirty_paths(dir.path()).unwrap();
        assert!(dirty.contains(&"a.txt".to_string()), "{dirty:?}");
        assert!(dirty.contains(&".gitignore".to_string()), "{dirty:?}");
        assert!(!dirty.contains(&"ignored.log".to_string()), "{dirty:?}");
        let wanted = vec![
            "ignored.log".to_string(),
            "fresh.txt".to_string(),
            "a.txt".to_string(),
        ];
        assert_eq!(
            untracked_collisions(dir.path(), &wanted, &[]).unwrap(),
            vec!["ignored.log".to_string()]
        );
    }

    #[test]
    fn restoring_the_exported_state_keeps_other_untracked_files() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
        std::fs::write(dir.path().join("exported.txt"), "x").unwrap();
        std::fs::write(dir.path().join("mine.txt"), "y").unwrap();
        restore_exported_state(dir.path(), &["exported.txt".to_string()]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(!dir.path().join("exported.txt").exists());
        assert!(dir.path().join("mine.txt").exists());
    }

    #[test]
    fn partially_staged_files_are_named() {
        let dir = repo();
        std::fs::write(dir.path().join("a.txt"), "staged\n").unwrap();
        run(dir.path(), &["add", "a.txt"]);
        assert!(
            partially_staged(dir.path()).unwrap().is_empty(),
            "fully staged is fine"
        );
        std::fs::write(dir.path().join("a.txt"), "staged then edited\n").unwrap();
        assert_eq!(
            partially_staged(dir.path()).unwrap(),
            vec!["a.txt".to_string()]
        );
    }

    #[test]
    fn paths_added_by_commits_and_by_the_diff_are_listed() {
        let dir = repo();
        let base = head(dir.path()).unwrap();
        std::fs::write(dir.path().join("new.txt"), "x\n").unwrap();
        run(dir.path(), &["add", "."]);
        run(dir.path(), &["commit", "-qm", "add new"]);
        let tip = head(dir.path()).unwrap();
        assert_eq!(
            added_between(dir.path(), &base, &tip).unwrap(),
            vec!["new.txt".to_string()]
        );
        std::fs::write(dir.path().join("fresh file.txt"), "y\n").unwrap();
        run(dir.path(), &["add", "-N", "fresh file.txt"]);
        let scratch = tempfile::tempdir().unwrap();
        let captured = capture(dir.path(), scratch.path()).unwrap();
        let diff = captured.diff.expect("an intent-to-add file is in the diff");
        assert_eq!(
            created_by_diff(dir.path(), &diff).unwrap(),
            vec!["fresh file.txt".to_string()]
        );
        assert_eq!(diff_apply_error(dir.path(), &tip, &diff).unwrap(), None);
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        let scratch2 = tempfile::tempdir().unwrap();
        let conflicting = capture(dir.path(), scratch2.path()).unwrap().diff.unwrap();
        run(dir.path(), &["commit", "-qam", "change a"]);
        std::fs::write(dir.path().join("a.txt"), "elsewhere\n").unwrap();
        run(dir.path(), &["commit", "-qam", "change a again"]);
        let moved = head(dir.path()).unwrap();
        assert!(diff_apply_error(dir.path(), &moved, &conflicting)
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_position_is_restored_with_its_branch() {
        let dir = repo();
        let before = position(dir.path()).unwrap();
        run(dir.path(), &["checkout", "-q", "-b", "other"]);
        std::fs::write(dir.path().join("a.txt"), "other\n").unwrap();
        run(dir.path(), &["commit", "-qam", "other"]);
        restore_position(dir.path(), &before).unwrap();
        assert_eq!(branch(dir.path()).unwrap().as_deref(), Some("main"));
        assert_eq!(head(dir.path()).unwrap(), before.head);
        restore_branch(dir.path(), "other", None).unwrap();
        assert_eq!(branch_tip(dir.path(), "other").unwrap(), None);
    }

    /// The default on Windows: checked-out files carry CRLF, and the diff and its
    /// application must agree byte for byte with what the exporting checkout held.
    #[cfg(windows)]
    #[test]
    fn a_crlf_working_tree_round_trips_with_autocrlf() {
        let origin = crate::fixture_dirs::tempdir_outside_git();
        run(origin.path(), &["init", "-q", "-b", "main"]);
        run(origin.path(), &["config", "core.autocrlf", "true"]);
        std::fs::write(origin.path().join("a.txt"), "one\ntwo\n").unwrap();
        run(origin.path(), &["add", "."]);
        run(origin.path(), &["commit", "-qm", "one"]);
        let clone = || {
            let dir = crate::fixture_dirs::tempdir_outside_git();
            run(
                dir.path(),
                &[
                    "clone",
                    "-q",
                    "-c",
                    "core.autocrlf=true",
                    &origin.path().display().to_string(),
                    ".",
                ],
            );
            dir
        };
        let source = clone();
        let target = clone();
        // An edit as a Windows editor saves it in this checkout: CRLF throughout.
        std::fs::write(
            source.path().join("a.txt"),
            "one\r\ntwo edited\r\nthree\r\n",
        )
        .unwrap();
        std::fs::write(source.path().join("b.txt"), "untracked\r\n").unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let captured = capture(source.path(), scratch.path()).unwrap();
        let diff = captured.diff.as_deref().unwrap();
        assert_eq!(
            diff_apply_error(target.path(), &captured.head, diff).unwrap(),
            None
        );
        apply_diff(target.path(), diff).unwrap();
        write_untracked(
            target.path(),
            source.path(),
            &captured.untracked,
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(target.path().join("a.txt")).unwrap(),
            std::fs::read(source.path().join("a.txt")).unwrap()
        );
        assert_eq!(tree_state(target.path()).unwrap(), captured.state);
    }
}

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::ffi::OsStr;
use std::path::Path;

const REF_PREFIX: &str = "refs/houston/checkpoints";
const AUTHOR_NAME: &str = "Houston";
const AUTHOR_EMAIL: &str = "houston@localhost";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub r#ref: String,
    pub owner: String,
    pub label: String,
    pub sha: String,
    pub created_ms: Option<u64>,
}

/// Refuses to overwrite an existing checkpoint: `update-ref` on the same label
/// would silently destroy the older snapshot. The panel says so and offers a
/// free name; `capture_unique` is the convenience path.
pub fn capture_unique(dir: &Path, owner: &str, label: &str) -> Result<Checkpoint> {
    let base = label.trim();
    let base = if base.is_empty() { "manual" } else { base };
    if !exists(dir, &checkpoint_ref(owner, base)) {
        return capture(dir, owner, base);
    }
    for suffix in 2..=100 {
        let candidate = format!("{base}-{suffix}");
        if !exists(dir, &checkpoint_ref(owner, &candidate)) {
            return capture(dir, owner, &candidate);
        }
    }
    bail!(
        "no free checkpoint label left for {base:?}; 100 numbered variants already exist — delete one, or capture under another name"
    )
}

pub fn checkpoint_ref(owner: &str, label: &str) -> String {
    format!("{REF_PREFIX}/{}/{}", ref_segment(owner), ref_segment(label))
}

// Encode rather than slugify: distinct opaque keys must never share a ref.
fn ref_segment(value: &str) -> String {
    format!("x{}", URL_SAFE_NO_PAD.encode(value))
}

/// Snapshots the workspace as a hidden ref. Every untracked file that is not
/// gitignored is inside the snapshot, so a revert removes the files an operation
/// created and restores the ones it changed.
pub fn capture(dir: &Path, owner: &str, label: &str) -> Result<Checkpoint> {
    ensure_git_repo(dir)?;
    let refname = checkpoint_ref(owner, label);
    if exists(dir, &refname) {
        bail!(
            "checkpoint {refname:?} already exists; capture under a different label or delete it first"
        );
    }
    let tmp = tempfile::tempdir().context("creating a temporary index for a checkpoint")?;
    let index = tmp.path().join("index");
    let envs: [(&str, &OsStr); 5] = [
        ("GIT_INDEX_FILE", index.as_os_str()),
        ("GIT_AUTHOR_NAME", OsStr::new(AUTHOR_NAME)),
        ("GIT_AUTHOR_EMAIL", OsStr::new(AUTHOR_EMAIL)),
        ("GIT_COMMITTER_NAME", OsStr::new(AUTHOR_NAME)),
        ("GIT_COMMITTER_EMAIL", OsStr::new(AUTHOR_EMAIL)),
    ];

    if has_head(dir) {
        git_env(dir, &["read-tree", "HEAD"], &envs)?;
    }
    git_env(dir, &["add", "-A", "--", "."], &envs)?;
    let tree = git_env(dir, &["write-tree"], &envs)?.trim().to_string();
    if tree.is_empty() {
        bail!(
            "git write-tree returned no tree for owner {owner:?} label {label:?}; expected a tree oid"
        );
    }
    let message = format!("houston checkpoint {refname}");
    let sha = git_env(dir, &["commit-tree", &tree, "-m", &message], &envs)?
        .trim()
        .to_string();
    if sha.is_empty() {
        bail!("git commit-tree returned no commit for {refname}; expected a commit oid");
    }
    run_git(dir, &["update-ref", &refname, &sha])?;
    Ok(Checkpoint {
        created_ms: ref_created_ms(dir, &refname),
        r#ref: refname,
        owner: owner.to_string(),
        label: label.to_string(),
        sha,
    })
}

fn ref_created_ms(dir: &Path, refname: &str) -> Option<u64> {
    let raw = run_git(
        dir,
        &["for-each-ref", "--format=%(committerdate:unix)", refname],
    )
    .ok()?;
    raw.trim().parse().ok()
}

pub fn revert(dir: &Path, checkpoint: &Checkpoint) -> Result<()> {
    revert_ref(dir, &checkpoint.r#ref)
}

pub fn revert_ref(dir: &Path, refname: &str) -> Result<()> {
    ensure_git_repo(dir)?;
    let sha = resolve_ref(dir, refname)?;
    let snapshot_files = run_git(dir, &["ls-tree", "-r", "-z", "--name-only", &sha])?;
    if !snapshot_files.is_empty() {
        run_git(
            dir,
            &[
                "restore",
                "--source",
                &sha,
                "--worktree",
                "--staged",
                "--",
                ".",
            ],
        )?;
    }
    std::fs::create_dir_all(dir)
        .with_context(|| format!("recreating the checkpoint workspace at {}", dir.display()))?;
    // `restore` only copies paths the snapshot has, so index entries the operation
    // added (a staged new file, a recreated file) would survive; delete their
    // worktree entries so the snapshot is the sole source of what exists.
    let stale = run_git(
        dir,
        &[
            "diff",
            "--cached",
            "-z",
            "--name-only",
            "--no-renames",
            "--diff-filter=A",
            &sha,
            "--",
            ".",
        ],
    )?;
    for path in stale.split('\0').filter(|s| !s.is_empty()) {
        remove_worktree_entry(dir, path)?;
    }
    clean_workspace(dir)?;
    if has_head(dir) {
        run_git(dir, &["reset", "--quiet", "--", "."])?;
    }
    Ok(())
}

fn remove_worktree_entry(dir: &Path, path: &str) -> Result<()> {
    if path.is_empty() || Path::new(path).is_absolute() || path.split('/').any(|s| s == "..") {
        bail!(
            "checkpoint revert: path {path:?} is not a plain repo-relative path; refusing to delete it"
        );
    }
    let full = dir.join(path);
    if full.is_dir() {
        std::fs::remove_dir_all(&full)
            .with_context(|| format!("removing reverted directory {}", full.display()))?;
    } else if full.exists() {
        std::fs::remove_file(&full).with_context(|| format!("removing {}", full.display()))?;
    }
    Ok(())
}

pub fn list(dir: &Path, owner: Option<&str>) -> Result<Vec<Checkpoint>> {
    ensure_git_repo(dir)?;
    let prefix = match owner {
        Some(owner) => format!("{REF_PREFIX}/{}", ref_segment(owner)),
        None => REF_PREFIX.to_string(),
    };
    // A no-owner listing is the bare prefix: `for-each-ref` matches with
    // FNM_PATHNAME, so `refs/houston/checkpoints/*` would not cross the slash
    // into an owner segment and would silently list nothing.
    let pattern = match owner {
        Some(_) => format!("{prefix}/*"),
        None => prefix.clone(),
    };
    let raw = run_git(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(committerdate:unix)",
            &pattern,
        ],
    )?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(refname), Some(sha)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Some(tail) = refname.strip_prefix(&format!("{REF_PREFIX}/")) else {
            continue;
        };
        let (owner_seg, label_seg) = match tail.split_once('/') {
            Some((o, l)) => (o, l),
            None => continue,
        };
        let Some(owner) = decode_segment(owner_seg) else {
            continue;
        };
        let Some(label) = decode_segment(label_seg) else {
            continue;
        };
        out.push(Checkpoint {
            r#ref: refname.to_string(),
            owner,
            label,
            sha: sha.to_string(),
            created_ms: parts.next().and_then(|m| m.trim().parse().ok()),
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.created_ms));
    Ok(out)
}

fn decode_segment(seg: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(seg.strip_prefix('x')?).ok()?;
    String::from_utf8(bytes).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointAgainst {
    /// The live working tree: what restoring this checkpoint would change.
    Working,
    /// The commit HEAD points at, ignoring uncommitted work.
    Head,
}

/// The inspect diff, through the same cap/redact pipeline as the review packet:
/// checkpoint contents can carry secrets the pane must never print.
pub fn diff(dir: &Path, refname: &str, against: CheckpointAgainst) -> Result<(String, bool, bool)> {
    ensure_git_repo(dir)?;
    let sha = resolve_ref(dir, refname)?;
    let raw = match against {
        CheckpointAgainst::Working => run_git(dir, &["diff", &sha])?,
        CheckpointAgainst::Head => run_git(dir, &["diff", &sha, "HEAD"])?,
    };
    Ok(crate::git::sanitized_patch(raw))
}

pub fn exists(dir: &Path, refname: &str) -> bool {
    resolve_ref(dir, refname).is_ok()
}

pub fn delete(dir: &Path, refname: &str) -> Result<()> {
    run_git(dir, &["update-ref", "-d", refname])?;
    Ok(())
}

fn resolve_ref(dir: &Path, refname: &str) -> Result<String> {
    let spec = format!("{refname}^{{commit}}");
    let out = run_git(dir, &["rev-parse", "--verify", "--quiet", &spec]).with_context(|| {
        format!("no checkpoint at ref {refname:?}; expected a ref created by checkpoint capture")
    })?;
    let sha = out.trim().to_string();
    if sha.is_empty() {
        bail!("checkpoint ref {refname:?} resolved to an empty sha; expected a commit");
    }
    Ok(sha)
}

fn clean_workspace(dir: &Path) -> Result<()> {
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(["clean", "-fd", "--", "."])
        .output()
        .with_context(|| format!("spawning git clean -fd in {}", dir.display()))?;
    if out.status.success() {
        return Ok(());
    }
    // git can remove every child, then fail trying to remove './' itself.
    let emptied = std::fs::read_dir(dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(false);
    if out.status.code() == Some(1) && emptied {
        return Ok(());
    }
    bail!(
        "git clean -fd in {} failed (exit {:?}): {}",
        dir.display(),
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).trim()
    );
}

fn has_head(dir: &Path) -> bool {
    run_git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

fn ensure_git_repo(dir: &Path) -> Result<()> {
    if !crate::git::is_git_repo(dir) {
        bail!(
            "{} is not a git repository; a checkpoint needs one",
            dir.display()
        );
    }
    Ok(())
}

fn git_env(dir: &Path, args: &[&str], envs: &[(&str, &OsStr)]) -> Result<String> {
    let mut cmd = crate::spawn::command("git");
    cmd.arg("-C").arg(dir).args(args);
    for &(key, value) in envs {
        cmd.env(key, value);
    }
    let out = cmd
        .output()
        .with_context(|| format!("spawning git {args:?} in {}", dir.display()))?;
    if !out.status.success() {
        bail!(
            "git {:?} in {} failed (exit {:?}): {}",
            args,
            dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .with_context(|| format!("spawning git {args:?} in {}", dir.display()))?;
    if !out.status.success() {
        bail!(
            "git {:?} in {} failed (exit {:?}): {}",
            args,
            dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t.local"]);
        git(dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn capture_unique_never_overwrites_an_existing_label() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let first = capture_unique(tmp.path(), "manual", "shot").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "one\n").unwrap();
        let second = capture_unique(tmp.path(), "manual", "shot").unwrap();

        assert_eq!(first.label, "shot");
        assert_eq!(second.label, "shot-2", "a taken label gets the next number");
        assert_ne!(first.r#ref, second.r#ref);
        assert!(first.sha != second.sha, "the snapshots differ");

        let err = capture(tmp.path(), "manual", "shot")
            .unwrap_err()
            .to_string();
        assert!(err.contains("already exists"), "unexpected: {err}");
    }

    #[test]
    fn list_all_owners_carries_labels_owners_and_dates() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        capture(tmp.path(), "manual", "one").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "x\n").unwrap();
        capture(tmp.path(), "session_7", "two").unwrap();

        let all = list(tmp.path(), None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|c| c.owner == "manual" && c.label == "one"));
        assert!(all
            .iter()
            .any(|c| c.owner == "session_7" && c.label == "two"));
        assert!(
            all.iter()
                .all(|c| c.created_ms.is_some_and(|ms| ms > 1_600_000_000)),
            "every snapshot carries its commit time: {all:?}"
        );

        let only = list(tmp.path(), Some("manual")).unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].label, "one");
    }

    #[test]
    fn diff_inspects_what_restoring_would_change() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("tracked.txt"), "original\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "with tracked"]);
        let shot = capture(tmp.path(), "manual", "shot").unwrap();

        std::fs::write(tmp.path().join("tracked.txt"), "changed\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "moved on"]);

        let (working, _, _) = diff(tmp.path(), &shot.r#ref, CheckpointAgainst::Working).unwrap();
        assert!(working.contains("+changed"), "{working}");
        assert!(working.contains("-original"), "{working}");

        let (head, _, _) = diff(tmp.path(), &shot.r#ref, CheckpointAgainst::Head).unwrap();
        assert!(head.contains("+changed"), "{head}");

        std::fs::write(tmp.path().join("tracked.txt"), "back to original\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "back"]);
        let (head, _, _) = diff(tmp.path(), &shot.r#ref, CheckpointAgainst::Head).unwrap();
        assert!(
            head.contains("back to original"),
            "HEAD diff must compare commits, not the clean worktree: {head}"
        );
    }

    #[test]
    fn diff_redacts_secret_shaped_content_and_drops_sensitive_files() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("config.yml"), "db_password: original\n").unwrap();
        std::fs::write(tmp.path().join(".env"), "TOKEN=original\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "with secrets"]);
        let shot = capture(tmp.path(), "manual", "shot").unwrap();
        std::fs::write(tmp.path().join("config.yml"), "db_password: hunter2\n").unwrap();
        std::fs::write(tmp.path().join(".env"), "TOKEN=abcdef\n").unwrap();

        let (patch, _, redacted) =
            diff(tmp.path(), &shot.r#ref, CheckpointAgainst::Working).unwrap();
        assert!(
            redacted,
            "a secret-shaped value must flip the redacted flag"
        );
        assert!(!patch.contains("hunter2"), "{patch}");
        assert!(!patch.contains("TOKEN=abcdef"), "{patch}");
    }

    #[test]
    fn diff_refuses_an_unknown_ref_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let err = diff(
            tmp.path(),
            "refs/houston/checkpoints/xnope/xnope",
            CheckpointAgainst::Working,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("no checkpoint at ref"), "unexpected: {err}");
    }
}

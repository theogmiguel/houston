//! The git side of a worktree check: read-only questions asked before the operator
//! confirms a removal. Each part answers or names why it could not.

use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use houston_protocol::{WorktreeCheckGap, WorktreeCheckPart, WorktreeCheckResult};

/// The operator waits on the confirm, so a git call past this counts as a gap rather
/// than holding the dialog; three calls bound the check at under a minute.
const GIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Uncommitted files stat'ed for the newest change; a tree with more reports the
/// newest among these, enough to tell "edited a minute ago" from "untouched".
const MAX_DATED: usize = 5_000;

fn git(tree: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::git::command();
    cmd.arg("-C")
        .arg(tree)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let name = args.first().copied().unwrap_or_default();
    match crate::spawn::output_within(cmd, GIT_TIMEOUT) {
        Ok(Some(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(Some(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let line = stderr.lines().next().unwrap_or_default().trim();
            Err(format!(
                "git {name} failed (exit {:?}): {line}",
                out.status.code()
            ))
        }
        Ok(None) => Err(format!(
            "git {name} gave no answer within {} s",
            GIT_TIMEOUT.as_secs()
        )),
        Err(e) => Err(format!("could not run git {name}: {e}")),
    }
}

fn count(tree: &Path, args: &[&str]) -> Result<u32, String> {
    let out = git(tree, args)?;
    out.trim()
        .parse()
        .map_err(|_| format!("git rev-list printed {:?}; expected a count", out.trim()))
}

/// Paths from `git status --porcelain -z`; a rename or copy carries its source as
/// the next field, which is skipped.
fn status_paths(raw: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(entry) = fields.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        if code.contains('R') || code.contains('C') {
            fields.next();
        }
        out.push(path);
    }
    out
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::symlink_metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_millis().min(i64::MAX as u128) as i64)
}

/// Everything but the panes, which only the daemon knows. `base` is the branch the
/// tree was cut from, when Houston recorded one.
pub fn check(repo: &Path, tree: &Path, base: Option<String>) -> WorktreeCheckResult {
    let mut result = WorktreeCheckResult {
        dirty_files: None,
        newest_change_ms: None,
        base: None,
        ahead: None,
        unpushed: None,
        panes: Vec::new(),
        gaps: Vec::new(),
    };
    let mut gap = |part, reason: String| result.gaps.push(WorktreeCheckGap { part, reason });
    if !tree.is_dir() {
        let reason = format!("the worktree directory {} does not exist", tree.display());
        for part in [
            WorktreeCheckPart::Changes,
            WorktreeCheckPart::Commits,
            WorktreeCheckPart::Unpushed,
        ] {
            gap(part, reason.clone());
        }
        return result;
    }
    let status = git(
        tree,
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    );
    let (dirty, newest) = match status {
        Ok(raw) => {
            let paths = status_paths(&raw);
            let newest = paths
                .iter()
                .take(MAX_DATED)
                .filter_map(|p| modified_ms(&tree.join(p)))
                .max();
            (Some(paths.len() as u32), newest)
        }
        Err(reason) => {
            gap(WorktreeCheckPart::Changes, reason);
            (None, None)
        }
    };
    let base = base.or_else(|| crate::git::default_base(repo));
    let ahead = match &base {
        Some(base) => count(tree, &["rev-list", "--count", &format!("{base}..HEAD")])
            .map_err(|reason| gap(WorktreeCheckPart::Commits, reason))
            .ok(),
        None => {
            gap(
                WorktreeCheckPart::Commits,
                "no base branch resolves: none was recorded, and origin/HEAD, main and master \
                 are all missing"
                    .to_string(),
            );
            None
        }
    };
    let unpushed = match git(tree, &["remote"]) {
        Ok(remotes) if remotes.trim().is_empty() => {
            gap(
                WorktreeCheckPart::Unpushed,
                "the repository has no remote".to_string(),
            );
            None
        }
        Ok(_) => count(tree, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
            .map_err(|reason| gap(WorktreeCheckPart::Unpushed, reason))
            .ok(),
        Err(reason) => {
            gap(WorktreeCheckPart::Unpushed, reason);
            None
        }
    };
    result.dirty_files = dirty;
    result.newest_change_ms = newest;
    result.base = base;
    result.ahead = ahead;
    result.unpushed = unpushed;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_paths_skip_a_rename_source() {
        let raw = " M src/a.rs\0R  new.rs\0old.rs\0?? notes/b.txt\0";
        assert_eq!(status_paths(raw), ["src/a.rs", "new.rs", "notes/b.txt"]);
        assert!(status_paths("").is_empty());
    }
}

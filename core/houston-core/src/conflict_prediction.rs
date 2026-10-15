//! What the conflict prediction pass asks git: its version, the branch heads of one
//! repository, and whether merging two commits would conflict. The daemon owns which
//! pairs to ask about and whom to tell.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// `git merge-tree --write-tree` first shipped in this release.
pub const MIN_GIT: (u32, u32) = (2, 38);

/// A merge of two large trees takes seconds; a run past this is abandoned rather than
/// holding the pass, and its pair is retried only when a head moves.
const MERGE_TREE_TIMEOUT: Duration = Duration::from_secs(30);

/// `git --version` and `for-each-ref` answer at once on a healthy repository.
const GIT_QUERY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeVerdict {
    Clean,
    /// Conflicted paths in git's order, each listed once.
    Conflict(Vec<String>),
}

fn git(
    git_dir: Option<&Path>,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    let mut cmd = crate::spawn::command("git");
    if let Some(dir) = git_dir {
        cmd.arg("--git-dir").arg(dir);
    }
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    match crate::spawn::output_within(cmd, timeout) {
        Ok(Some(out)) => Ok(out),
        Ok(None) => Err(format!(
            "git {args:?} gave no answer within {} s",
            timeout.as_secs()
        )),
        Err(e) => Err(format!("spawning git {args:?}: {e}")),
    }
}

/// The installed git's version string, e.g. `2.45.1.windows.1`.
pub fn git_version() -> Result<String, String> {
    let out = git(None, &["--version"], GIT_QUERY_TIMEOUT)?;
    let text = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        return Err(format!(
            "git --version failed (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    text.trim()
        .strip_prefix("git version ")
        .map(|v| v.trim().to_string())
        .ok_or_else(|| {
            format!(
                "git --version printed {:?}; expected \"git version X.Y.Z\"",
                text.trim()
            )
        })
}

/// `(major, minor)` of a version string such as `2.39.2 (Apple Git-143)`.
pub fn parse_version(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Refuses a Git without `merge-tree --write-tree` by naming the version found and the
/// one required.
pub fn require_merge_tree(version: Result<String, String>) -> Result<(), String> {
    let (major, minor) = MIN_GIT;
    match version {
        Ok(v) if parse_version(&v).is_some_and(|found| found >= MIN_GIT) => Ok(()),
        Ok(v) => Err(format!(
            "Git {v} is installed; conflict prediction needs Git {major}.{minor} or newer \
             for `git merge-tree --write-tree`"
        )),
        Err(e) => Err(format!(
            "no usable Git found ({e}); conflict prediction needs Git {major}.{minor} or newer \
             for `git merge-tree --write-tree`"
        )),
    }
}

/// Every local and remote-tracking branch head of the repository at `git_dir`, keyed by
/// full ref name.
pub fn branch_heads(git_dir: &Path) -> Result<HashMap<String, String>, String> {
    let out = git(
        Some(git_dir),
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads",
            "refs/remotes",
        ],
        GIT_QUERY_TIMEOUT,
    )?;
    if !out.status.success() {
        return Err(format!(
            "git for-each-ref in {} failed (exit {:?}): {}",
            git_dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (oid, name) = line.split_once(' ')?;
            Some((name.to_string(), oid.to_string()))
        })
        .collect())
}

/// The head of branch `name` as git resolves a short name: a local branch first, then a
/// remote-tracking one (`origin/main`).
pub fn resolve<'a>(heads: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    heads
        .get(&format!("refs/heads/{name}"))
        .or_else(|| heads.get(&format!("refs/remotes/{name}")))
        .map(String::as_str)
}

/// Merges commits `ours` and `theirs` in memory. Git writes the resulting tree objects
/// to the object store, unreferenced, so a later gc removes them; no ref, index or
/// working tree changes.
pub fn merge_tree(git_dir: &Path, ours: &str, theirs: &str) -> Result<MergeVerdict, String> {
    let out = git(
        Some(git_dir),
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            ours,
            theirs,
        ],
        MERGE_TREE_TIMEOUT,
    )?;
    parse_merge_tree(out.status.code(), &out.stdout).map_err(|e| {
        format!(
            "git merge-tree {ours} {theirs} in {}: {e}: {}",
            git_dir.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })
}

/// Reads `merge-tree --write-tree --name-only --no-messages -z`: tree OID, then conflicted
/// paths, NUL-terminated. Exit 1 also means an unresolvable commit, which prints no
/// tree, so the OID tells a verdict from a failure.
pub fn parse_merge_tree(code: Option<i32>, stdout: &[u8]) -> Result<MergeVerdict, String> {
    let mut fields = stdout.split(|b| *b == 0);
    let tree = fields.next().unwrap_or_default();
    let is_oid = matches!(tree.len(), 40 | 64) && tree.iter().all(u8::is_ascii_hexdigit);
    if !is_oid {
        return Err(format!(
            "exit {code:?} without a tree OID (expected 40 or 64 hex digits, got {:?})",
            String::from_utf8_lossy(&tree[..tree.len().min(80)])
        ));
    }
    match code {
        Some(0) => Ok(MergeVerdict::Clean),
        Some(1) => {
            let mut files: Vec<String> = Vec::new();
            for name in fields.filter(|f| !f.is_empty()) {
                let name = String::from_utf8_lossy(name).into_owned();
                if !files.contains(&name) {
                    files.push(name);
                }
            }
            Ok(MergeVerdict::Conflict(files))
        }
        other => Err(format!(
            "exit {other:?}; expected 0 (clean) or 1 (conflict)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "9b2bfddf03030fe5b19ec005feef891fe71557ef";

    #[test]
    fn a_clean_merge_is_only_the_tree() {
        let out = format!("{OID}\0");
        assert_eq!(
            parse_merge_tree(Some(0), out.as_bytes()),
            Ok(MergeVerdict::Clean)
        );
    }

    #[test]
    fn a_conflict_lists_each_path_once_in_order() {
        let out = format!("{OID}\0src/b.rs\0a b.txt\0src/b.rs\0");
        assert_eq!(
            parse_merge_tree(Some(1), out.as_bytes()),
            Ok(MergeVerdict::Conflict(vec![
                "src/b.rs".into(),
                "a b.txt".into()
            ]))
        );
    }

    #[test]
    fn a_sha256_tree_is_accepted() {
        let out = format!("{}\0f\0", "a".repeat(64));
        assert_eq!(
            parse_merge_tree(Some(1), out.as_bytes()),
            Ok(MergeVerdict::Conflict(vec!["f".into()]))
        );
    }

    #[test]
    fn an_unresolvable_commit_is_a_failure_not_a_conflict() {
        // `git merge-tree --write-tree nope main` exits 1 with nothing on stdout.
        let err = parse_merge_tree(Some(1), b"").unwrap_err();
        assert!(err.contains("without a tree OID"), "{err}");
    }

    #[test]
    fn another_exit_code_is_a_failure() {
        let out = format!("{OID}\0");
        let err = parse_merge_tree(Some(128), out.as_bytes()).unwrap_err();
        assert!(err.contains("Some(128)"), "{err}");
        assert!(parse_merge_tree(None, out.as_bytes()).is_err());
    }

    #[test]
    fn versions_parse_across_platform_suffixes() {
        assert_eq!(parse_version("2.45.1.windows.1"), Some((2, 45)));
        assert_eq!(parse_version("2.39.2 (Apple Git-143)"), Some((2, 39)));
        assert_eq!(parse_version("2.38.0"), Some((2, 38)));
        assert_eq!(parse_version("2.37"), Some((2, 37)));
        assert_eq!(parse_version("unknown"), None);
        assert!(parse_version("2.37.1").unwrap() < MIN_GIT);
        assert!(parse_version("3.0.0").unwrap() >= MIN_GIT);
    }

    #[test]
    fn an_old_git_is_refused_naming_both_versions() {
        assert_eq!(require_merge_tree(Ok("2.38.0".into())), Ok(()));
        let err = require_merge_tree(Ok("2.37.1.windows.1".into())).unwrap_err();
        assert!(err.contains("Git 2.37.1.windows.1 is installed"), "{err}");
        assert!(err.contains("needs Git 2.38 or newer"), "{err}");
        assert!(err.contains("or newer for `git merge-tree"), "{err}");
        let err = require_merge_tree(Err("spawning git: not found".into())).unwrap_err();
        assert!(err.contains("not found") && err.contains("2.38"), "{err}");
    }

    #[test]
    fn a_short_branch_name_resolves_local_before_remote() {
        let heads: HashMap<String, String> = [
            ("refs/heads/main", "l"),
            ("refs/remotes/main", "r"),
            ("refs/remotes/origin/main", "o"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(resolve(&heads, "main"), Some("l"));
        assert_eq!(resolve(&heads, "origin/main"), Some("o"));
        assert_eq!(resolve(&heads, "gone"), None);
    }
}

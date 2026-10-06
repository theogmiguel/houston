//! What a cleanup pass asks git about one managed worktree. The daemon owns the
//! order of the checks and the removal; these answer one question each.

use std::path::Path;
use std::time::Duration;
use std::time::UNIX_EPOCH;

/// A pass runs unattended: a fetch stuck on the network, or a status over a huge tree,
/// must end it rather than hold it. A command past this reads as "unknown", which
/// keeps the tree.
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = crate::spawn::command("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    match crate::spawn::output_within(cmd, GIT_TIMEOUT) {
        Ok(Some(out)) => out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(None) => {
            tracing::warn!(
                "git {args:?} in {} gave no answer within {} s",
                dir.display(),
                GIT_TIMEOUT.as_secs()
            );
            None
        }
        Err(e) => {
            tracing::warn!("spawning git {args:?} in {}: {e}", dir.display());
            None
        }
    }
}

fn git_succeeded(dir: &Path, args: &[&str]) -> Option<bool> {
    let mut cmd = crate::spawn::command("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    match crate::spawn::output_within(cmd, GIT_TIMEOUT) {
        Ok(Some(out)) => Some(out.status.success()),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("spawning git {args:?} in {}: {e}", dir.display());
            None
        }
    }
}

/// The branch checked out in `tree`; `Some(None)` on a detached HEAD.
pub fn current_branch(tree: &Path) -> Option<Option<String>> {
    let out = git(tree, &["branch", "--show-current"])?;
    let name = out.trim();
    Some((!name.is_empty()).then(|| name.to_string()))
}

/// Every modified, staged or untracked file, one per path. The flags are explicit so a
/// repository's `status.showUntrackedFiles` or submodule settings cannot hide one.
pub fn dirty_files(tree: &Path) -> Option<u32> {
    let out = git(
        tree,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    Some(out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
}

/// Loose ignored files (`.env`, local settings) that `git worktree remove` would delete.
/// A wholly ignored directory is listed once with a trailing `/` and is taken as build
/// output (`target/`, `node_modules/`), so it is not counted.
pub fn ignored_files(tree: &Path) -> Option<u32> {
    let out = git(
        tree,
        &[
            "status",
            "--porcelain",
            "--ignored=traditional",
            "--untracked-files=normal",
        ],
    )?;
    Some(
        out.lines()
            .filter_map(|l| l.strip_prefix("!! "))
            .filter(|p| !p.trim_end_matches('"').ends_with('/'))
            .count() as u32,
    )
}

pub fn idle_days(tree: &Path, now_ms: i64) -> Option<u32> {
    if dirty_files(tree)? != 0 || ignored_files(tree)? != 0 {
        return None;
    }
    let unpushed = git(tree, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?;
    if unpushed.trim().parse::<u64>().ok()? != 0 {
        return None;
    }
    let mut paths = Vec::new();
    for item in ["HEAD", "ORIG_HEAD", "COMMIT_EDITMSG", "logs/HEAD"] {
        let raw = git(tree, &["rev-parse", "--git-path", item])?;
        let path = Path::new(raw.trim());
        paths.push(if path.is_absolute() {
            path.to_path_buf()
        } else {
            tree.join(path)
        });
    }
    let latest_ms = paths
        .into_iter()
        .filter_map(|p| {
            let modified = std::fs::metadata(p).ok()?.modified().ok()?;
            let duration = modified.duration_since(UNIX_EPOCH).ok()?;
            Some(duration.as_millis().min(i64::MAX as u128) as i64)
        })
        .max()?;
    let elapsed = now_ms.saturating_sub(latest_ms).max(0);
    let idle_days = (elapsed / 86_400_000).min(u32::MAX as i64) as u32;
    Some(idle_days)
}

pub fn has_object(tree: &Path, oid: &str) -> bool {
    git(tree, &["cat-file", "-e", &format!("{oid}^{{commit}}")]).is_some()
}

/// `host/owner/repo` of a GitHub-style URL, lowercased: `https://`, `ssh://` and
/// scp-like `git@host:owner/repo.git` forms alike. A local path has none.
fn repo_key(url: &str) -> Option<String> {
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None => {
            let (host, path) = url.split_once(':')?;
            if host.contains('/') {
                return None;
            }
            format!("{host}/{path}")
        }
    };
    let rest = rest.rsplit_once('@').map_or(rest.as_str(), |(_, r)| r);
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let host = parts.next()?.split(':').next()?;
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if host.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{host}/{owner}/{repo}").to_lowercase())
}

/// The remote whose configured URL is the PR's repository, the one place its
/// `refs/pull/N/head` lives. Raw config is read, as typed, before any `insteadOf`.
pub fn pr_remote(tree: &Path, pr_url: &str) -> Option<String> {
    let want = repo_key(pr_url)?;
    let urls = git(tree, &["config", "--get-regexp", r"^remote\..*\.url$"])?;
    urls.lines().find_map(|line| {
        let (key, url) = line.split_once(' ')?;
        let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
        (repo_key(url.trim()).as_deref() == Some(want.as_str())).then(|| name.to_string())
    })
}

/// Fetches only `refs/pull/<pr>/head` and only from `remote`; no other ref moves.
pub fn fetch_pr_head(tree: &Path, remote: &str, pr: u32, oid: &str) -> bool {
    let _ = git(
        tree,
        &[
            "fetch",
            "-q",
            "--no-tags",
            "--no-write-fetch-head",
            remote,
            &format!("refs/pull/{pr}/head"),
        ],
    );
    has_object(tree, oid)
}

/// Local commits the PR head does not contain; `None` when git cannot answer.
pub fn commits_outside(tree: &Path, pr_head: &str) -> Option<u32> {
    git(tree, &["rev-list", "--count", &format!("{pr_head}..HEAD")])?
        .trim()
        .parse()
        .ok()
}

/// Commits in `branch` not represented by its PR head or by a patch in `base_branch`.
pub fn cherry_unintegrated(
    tree: &Path,
    base_branch: &str,
    branch: &str,
    pr_head: Option<&str>,
) -> Option<u32> {
    let out = git(tree, &["cherry", "-v", base_branch, branch])?;
    let mut count = 0;
    for line in out.lines() {
        let mut fields = line.split_whitespace();
        let marker = fields.next()?;
        let commit = fields.next()?;
        if marker != "+" {
            continue;
        }
        if let Some(head) = pr_head {
            if git_succeeded(tree, &["merge-base", "--is-ancestor", commit, head])? {
                continue;
            }
        }
        count += 1;
    }
    Some(count)
}

/// Read from the remote-tracking refs as they stand: Houston does not fetch for this,
/// so it reflects the operator's own last `git fetch --prune`.
pub fn upstream_gone(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream:track)",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_some_and(|t| t.trim() == "[gone]")
}

/// The sum of file sizes under `path`, symlinks not followed.
pub fn tree_bytes(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// GitHub's `mergedAt` (`YYYY-MM-DDTHH:MM:SSZ`) as Unix milliseconds.
pub fn parse_github_time(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    // Days-from-civil (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + hh * 3600 + mm * 60 + ss) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_matches_the_pr_repository_in_any_url_form() {
        let pr = "https://github.com/Acme/Widget/pull/7";
        let want = repo_key(pr);
        assert_eq!(want.as_deref(), Some("github.com/acme/widget"));
        for url in [
            "https://github.com/acme/widget",
            "https://github.com/acme/widget.git",
            "https://token@github.com/acme/widget.git",
            "ssh://git@github.com:22/acme/widget.git",
            "git@github.com:acme/widget.git",
        ] {
            assert_eq!(repo_key(url), want, "{url}");
        }
        for url in [
            "https://github.com/someone/widget.git",
            "git@gitlab.com:acme/widget.git",
            "/srv/git/widget.git",
            "../widget",
        ] {
            assert_ne!(repo_key(url), want, "{url}");
        }
    }

    #[test]
    fn github_time_parses_to_unix_millis() {
        assert_eq!(parse_github_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_github_time("2026-09-29T15:15:18Z"),
            Some(1_790_694_918_000)
        );
        assert_eq!(parse_github_time("2026-09-29 15:15:18"), None);
    }
}

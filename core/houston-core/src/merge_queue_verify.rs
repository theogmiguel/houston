//! The merge queue's Git work: fetching the base, rebasing the head in a
//! scratch worktree, running the workspace's verification command there, and
//! the lease push of the verified commit. Nothing here reads GitHub or the
//! database; the daemon decides what runs (`daemon/merge_queue_runner.rs`).

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Fetches and pushes cross the network; ten minutes fits a large first fetch
/// while a stalled one still frees the queue's slot.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(600);
/// Worktree, rebase and rev-parse work is local.
const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
/// What the capture keeps of the command's output. Only the tail is reported,
/// and a test suite can print far more than this.
const OUTPUT_KEEP_BYTES: usize = 64 * 1024;
/// What a failure reports of that tail: the lines nearest the failure, within
/// an inbox row's budget.
const TAIL_MAX_LINES: usize = 40;
const TAIL_MAX_CHARS: usize = 4_000;

/// What one verification found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Passed {
        base_sha: String,
        verified_sha: String,
    },
    Conflict {
        base_sha: String,
        files: Vec<String>,
    },
    Failed {
        base_sha: String,
        code: Option<i32>,
        tail: String,
    },
    TimedOut {
        base_sha: String,
        tail: String,
    },
    /// The remote head is no longer the commit the queue read; a later read re-enters it.
    HeadMoved {
        found: String,
    },
}

pub struct Request<'a> {
    /// The workspace's checkout; the scratch worktree is a worktree of its repository.
    pub repo: &'a Path,
    pub remote: &'a str,
    pub base_ref: &'a str,
    pub head_ref: &'a str,
    pub head_sha: &'a str,
    pub command: &'a str,
    pub limit: Duration,
    /// Outside `.houston/worktrees`, so nothing else mistakes it for an agent's worktree.
    pub scratch: &'a Path,
}

/// Why this daemon cannot verify the workspace at `path`, if it cannot. A WSL
/// workspace is verified by its distro's own daemon, so a Windows path into a
/// distro's file share is refused here rather than run through it.
pub fn environment_refusal(path: &str) -> Option<String> {
    if !cfg!(any(target_os = "linux", windows)) {
        return Some(format!(
            "the merge queue verifies on Linux and Windows; this daemon runs on {}, so it cannot verify {path}",
            std::env::consts::OS
        ));
    }
    let lower = path.replace('/', "\\").to_ascii_lowercase();
    let share = [
        "\\\\wsl.localhost\\",
        "\\\\wsl$\\",
        "\\\\?\\unc\\wsl.localhost\\",
        "\\\\?\\unc\\wsl$\\",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix));
    (cfg!(windows) && share).then(|| {
        format!(
            "{path} is a WSL distro's file share, which the Windows daemon cannot verify in; add it as a WSL workspace so its distro verifies it"
        )
    })
}

fn git(dir: &Path, args: &[&str], timeout: Duration) -> Result<std::process::Output> {
    let mut command = crate::spawn::command("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::spawn::output_within(command, timeout)
        .with_context(|| format!("running git {args:?} in {}", dir.display()))?
        .ok_or_else(|| {
            anyhow!(
                "git {args:?} in {} gave no answer within {} s",
                dir.display(),
                timeout.as_secs()
            )
        })
}

fn git_ok(dir: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let out = git(dir, args, timeout)?;
    if !out.status.success() {
        bail!(
            "git {args:?} in {} failed (exit {:?}): {}",
            dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Brings the remote-tracking refs of `branches` up to date. Only
/// `refs/remotes/<remote>/…` move; no working tree is touched.
pub fn fetch(repo: &Path, remote: &str, branches: &[&str]) -> Result<()> {
    let refspecs: Vec<String> = branches
        .iter()
        .map(|b| format!("+refs/heads/{b}:refs/remotes/{remote}/{b}"))
        .collect();
    let mut args = vec!["fetch", "--no-tags", "--quiet", remote];
    args.extend(refspecs.iter().map(String::as_str));
    git_ok(repo, &args, GIT_NETWORK_TIMEOUT)
        .map(|_| ())
        .with_context(|| format!("fetching {} from {remote}", branches.join(", ")))
}

/// The commit `refs/remotes/<remote>/<branch>` names after the last fetch.
pub fn remote_sha(repo: &Path, remote: &str, branch: &str) -> Result<String> {
    git_ok(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote}/{branch}^{{commit}}"),
        ],
        GIT_LOCAL_TIMEOUT,
    )
    .with_context(|| format!("{remote}/{branch} does not name a commit after the fetch"))
}

/// The scratch worktree, removed however the verification ends.
struct Scratch<'a> {
    repo: &'a Path,
    path: PathBuf,
}

impl<'a> Scratch<'a> {
    fn create(repo: &'a Path, path: &Path, head_sha: &str) -> Result<Self> {
        remove_scratch(repo, path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let scratch = Scratch {
            repo,
            path: path.to_path_buf(),
        };
        git_ok(
            repo,
            &[
                "worktree",
                "add",
                "--detach",
                "--force",
                &path.display().to_string(),
                head_sha,
            ],
            GIT_LOCAL_TIMEOUT,
        )
        .context("creating the scratch worktree")?;
        Ok(scratch)
    }
}

impl Drop for Scratch<'_> {
    fn drop(&mut self) {
        remove_scratch(self.repo, &self.path);
    }
}

/// Removes a scratch worktree and its registration, including one a crash left.
pub fn remove_scratch(repo: &Path, path: &Path) {
    if path.exists() {
        let _ = git(
            repo,
            &["worktree", "remove", "--force", &path.display().to_string()],
            GIT_LOCAL_TIMEOUT,
        );
        if path.exists() {
            if let Err(e) = std::fs::remove_dir_all(path) {
                tracing::warn!(
                    "merge queue: removing scratch worktree {}: {e}",
                    path.display()
                );
            }
        }
    }
    let _ = git(repo, &["worktree", "prune"], GIT_LOCAL_TIMEOUT);
}

/// Fetches, rebases the head onto the base in a scratch worktree and runs the
/// command there. The scratch worktree is always removed.
pub fn verify(request: &Request<'_>) -> Result<Outcome> {
    let Request {
        repo,
        remote,
        base_ref,
        head_ref,
        head_sha,
        ..
    } = *request;
    fetch(repo, remote, &[base_ref, head_ref])?;
    let found = remote_sha(repo, remote, head_ref)?;
    if found != head_sha {
        return Ok(Outcome::HeadMoved { found });
    }
    let base_sha = remote_sha(repo, remote, base_ref)?;
    let scratch = Scratch::create(repo, request.scratch, head_sha)?;
    let rebase = git(
        &scratch.path,
        &[
            "-c",
            "rebase.autoSquash=false",
            "-c",
            "rebase.autoStash=false",
            "rebase",
            &base_sha,
        ],
        GIT_LOCAL_TIMEOUT,
    )?;
    if !rebase.status.success() {
        let files = git_ok(
            &scratch.path,
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            GIT_LOCAL_TIMEOUT,
        )
        .unwrap_or_default();
        let files: Vec<String> = files
            .split('\0')
            .filter(|f| !f.is_empty())
            .map(str::to_string)
            .collect();
        let _ = git(&scratch.path, &["rebase", "--abort"], GIT_LOCAL_TIMEOUT);
        if files.is_empty() {
            bail!(
                "rebasing {head_ref} onto {base_ref} at {base_sha} failed: {}",
                String::from_utf8_lossy(&rebase.stderr).trim()
            );
        }
        return Ok(Outcome::Conflict { base_sha, files });
    }
    let verified_sha = git_ok(&scratch.path, &["rev-parse", "HEAD"], GIT_LOCAL_TIMEOUT)?;
    let run = crate::spawn::tail_within(
        shell(request.command, &scratch.path),
        request.limit,
        OUTPUT_KEEP_BYTES,
    )
    .with_context(|| format!("running the verification command {:?}", request.command))?;
    let tail = report_tail(&run.tail);
    Ok(match run.status {
        None => Outcome::TimedOut { base_sha, tail },
        Some(status) if status.success() => Outcome::Passed {
            base_sha,
            verified_sha,
        },
        Some(status) => Outcome::Failed {
            base_sha,
            code: status.code(),
            tail,
        },
    })
}

/// The platform shell running `command` in `dir`: `sh -c` on Linux, `cmd /c`
/// on Windows, as a person would type it.
fn shell(command: &str, dir: &Path) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        let mut cmd = crate::spawn::command("cmd");
        cmd.args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{command}\""))
            .current_dir(dir);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = crate::spawn::command("sh");
        cmd.arg("-c").arg(command).current_dir(dir);
        cmd
    }
}

/// The last lines of the output, without colour codes or secrets.
fn report_tail(bytes: &[u8]) -> String {
    let text = crate::agents::strip_ansi(&String::from_utf8_lossy(bytes));
    let (text, _) = crate::sanitize::redact_secrets(&text);
    let lines: Vec<&str> = text.lines().collect();
    let mut tail = lines[lines.len().saturating_sub(TAIL_MAX_LINES)..].join("\n");
    if tail.chars().count() > TAIL_MAX_CHARS {
        let skip = tail.chars().count() - TAIL_MAX_CHARS;
        tail = tail.chars().skip(skip).collect();
    }
    tail
}

/// Pushes `new_sha` to `branch` only while the remote branch is still at
/// `old_sha`: `--force-with-lease` pinned to the recorded commit, so a push
/// someone made since is never overwritten. The caller has checked the branch.
pub fn push_with_lease(
    repo: &Path,
    remote: &str,
    branch: &str,
    old_sha: &str,
    new_sha: &str,
) -> Result<()> {
    let lease = format!("--force-with-lease=refs/heads/{branch}:{old_sha}");
    let refspec = format!("{new_sha}:refs/heads/{branch}");
    let out = git(
        repo,
        &["push", "--porcelain", &lease, remote, &refspec],
        GIT_NETWORK_TIMEOUT,
    )?;
    if out.status.success() {
        return Ok(());
    }
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if said.contains("stale info") || said.contains("fetch first") {
        bail!(
            "the push to {branch} was refused: {remote}/{branch} is no longer at the recorded {old_sha}, so the lease did not hold and nothing was overwritten"
        );
    }
    bail!(
        "pushing {new_sha} to {remote}/{branch} failed (exit {:?}): {}",
        out.status.code(),
        said.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reported_tail_is_the_last_lines_without_colour() {
        let mut out = String::new();
        for n in 1..=100 {
            out.push_str(&format!("\x1b[31mline {n}\x1b[0m\n"));
        }
        let tail = report_tail(out.as_bytes());
        assert!(tail.starts_with("line 61"), "{tail}");
        assert!(tail.ends_with("line 100"), "{tail}");
        assert!(!tail.contains('\x1b'));
    }

    #[test]
    fn a_wsl_share_is_refused_by_name_on_windows_only() {
        let share = r"\\wsl.localhost\Ubuntu\home\u\repo";
        let refusal = environment_refusal(share);
        if cfg!(windows) {
            let refusal = refusal.expect("a WSL share is refused on Windows");
            assert!(refusal.contains("add it as a WSL workspace"), "{refusal}");
            assert!(environment_refusal(r"\\wsl$\Debian\srv").is_some());
            assert!(environment_refusal(r"C:\dev\repo").is_none());
        } else {
            assert!(refusal.is_none());
            assert!(environment_refusal("/home/u/repo").is_none());
        }
    }
}

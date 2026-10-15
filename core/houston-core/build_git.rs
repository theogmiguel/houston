//! Git files whose change should re-run the build script. Shared by `build.rs` and
//! `tests/build_rerun_paths.rs` via `#[path]`, because a build script is not a test target.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::process::Command;

fn git_output(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git rev-parse --git-path`, because in a linked worktree `.git` is a file and `HEAD`
/// lives in a per-worktree directory while `refs` and `packed-refs` live in the common one.
fn git_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let printed = git_output(dir, &["rev-parse", "--git-path", name])?;
    Some(dir.join(printed))
}

/// Paths for `cargo:rerun-if-changed`: `HEAD`, `packed-refs` and the ref `HEAD` names, not
/// all of `refs` (fetch and push rewrite remote-tracking refs). Missing paths are skipped,
/// as cargo treats them as always dirty; a packed branch is watched via its parent directory.
pub fn rerun_paths(dir: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = ["HEAD", "packed-refs"]
        .iter()
        .filter_map(|name| git_path(dir, name))
        .collect();
    if let Some(branch) = git_output(dir, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(mut path) = git_path(dir, &branch) {
            while !path.exists() && path.pop() {}
            if path.exists() {
                paths.push(path);
            }
        }
    }
    paths.retain(|p| p.exists());
    paths.dedup();
    paths
}

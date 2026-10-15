//! Git files whose change should re-run the build script. Shared by `build.rs` and
//! `tests/build_rerun_paths.rs` via `#[path]`, because a build script is not a test target.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::process::Command;

/// Files and directories git consults to name the current commit. Each is resolved with
/// `git rev-parse --git-path`, because in a linked worktree `.git` is a file and `HEAD`
/// lives in a per-worktree directory while `refs` lives in the common one.
const WATCHED: [&str; 3] = ["HEAD", "refs", "packed-refs"];

/// Existing paths to pass to `cargo:rerun-if-changed`. A path that does not exist is left
/// out: cargo treats a missing `rerun-if-changed` path as always dirty, which re-runs the
/// build script, rebuilds the crate and relinks every test binary on every invocation.
pub fn rerun_paths(dir: &Path) -> Vec<PathBuf> {
    WATCHED
        .iter()
        .filter_map(|name| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(["rev-parse", "--git-path", name])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let printed = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            let path = dir.join(printed);
            path.exists().then_some(path)
        })
        .collect()
}

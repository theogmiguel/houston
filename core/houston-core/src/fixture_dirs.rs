//! Scratch directories outside every git repository. Under a `TMPDIR` inside a checkout a
//! non-repo fixture belongs to that checkout, and the daemon's git commands write into it.
//! The daemon keeps discovering enclosing repos, so the fixtures move instead.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn inside_git(dir: &Path) -> bool {
    crate::spawn::git()
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--git-dir"])
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Where scratch directories go: `std::env::temp_dir()` unless a git repository encloses it.
fn base() -> &'static PathBuf {
    static BASE: OnceLock<PathBuf> = OnceLock::new();
    BASE.get_or_init(|| {
        let temp = std::env::temp_dir();
        if !inside_git(&temp) {
            return temp;
        }
        repository_free_fallback(&temp)
    })
}

#[cfg(unix)]
fn repository_free_fallback(temp: &Path) -> PathBuf {
    let fallback = PathBuf::from("/tmp");
    assert!(
        !inside_git(&fallback),
        "the temp directory {} and the fallback {} are both inside git repositories; \
         expected a scratch root outside any checkout",
        temp.display(),
        fallback.display()
    );
    fallback
}

#[cfg(not(unix))]
fn repository_free_fallback(temp: &Path) -> PathBuf {
    panic!(
        "the temp directory {} is inside a git repository and this platform has no \
         repository-free fallback; point TMP at a directory outside any checkout",
        temp.display()
    )
}

/// The directory every [`tempdir_outside_git`] is created in.
pub fn root() -> &'static Path {
    base()
}

/// A fresh temporary directory outside every git repository.
pub fn tempdir_outside_git() -> tempfile::TempDir {
    tempfile::Builder::new()
        .tempdir_in(base())
        .unwrap_or_else(|e| panic!("creating a scratch directory in {}: {e}", base().display()))
}

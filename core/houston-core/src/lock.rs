use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

pub const LOCK_FILE_NAME: &str = "daemon.lock";

/// Dropping this releases the lock immediately, even while the process keeps running.
#[derive(Debug)]
pub struct StateLock {
    _file: File,
}

impl StateLock {
    /// # Safety
    /// `fd` must be a descriptor this process owns and uses nowhere else
    /// after this call.
    #[cfg(unix)]
    pub unsafe fn from_raw_fd(fd: std::os::fd::OwnedFd) -> Self {
        StateLock { _file: fd.into() }
    }

    #[cfg(unix)]
    pub fn as_raw_fd(&self) -> std::os::fd::RawFd {
        use std::os::fd::AsRawFd;
        self._file.as_raw_fd()
    }
}

#[derive(Debug)]
pub enum LockError {
    Contended {
        state_dir: PathBuf,
        lock_path: PathBuf,
    },
    Io {
        lock_path: PathBuf,
        source: io::Error,
    },
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Contended {
                state_dir,
                lock_path,
            } => write!(
                f,
                "another process already holds the daemon lock for {} ({}): only one process \
                 may own this channel's daemon at a time",
                state_dir.display(),
                lock_path.display()
            ),
            LockError::Io { lock_path, source } => write!(
                f,
                "failed to acquire the daemon lock at {}: {source}",
                lock_path.display()
            ),
        }
    }
}

impl std::error::Error for LockError {}

// Advisory: only excludes other acquire_exclusive callers, not enforced elsewhere.
// A dedicated lockfile, not daemon.json itself -- daemon.json is replaced via rename,
// and a lock held on its old inode would not follow it.
pub fn acquire_exclusive(state_dir: &Path) -> Result<StateLock, LockError> {
    let lock_path = state_dir.join(LOCK_FILE_NAME);
    std::fs::create_dir_all(state_dir).map_err(|source| LockError::Io {
        lock_path: lock_path.clone(),
        source,
    })?;
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|source| LockError::Io {
            lock_path: lock_path.clone(),
            source,
        })?;
    match file.try_lock() {
        Ok(()) => Ok(StateLock { _file: file }),
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Contended {
            state_dir: state_dir.to_path_buf(),
            lock_path,
        }),
        Err(std::fs::TryLockError::Error(source)) => Err(LockError::Io { lock_path, source }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_acquisition_succeeds_and_creates_the_state_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("channel-a");
        let _lock = acquire_exclusive(&state_dir).expect("first acquisition must succeed");
        assert!(state_dir.join(LOCK_FILE_NAME).exists());
    }

    #[test]
    fn a_second_acquisition_in_the_same_process_is_contended() {
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("channel-b");
        let _first = acquire_exclusive(&state_dir).expect("first acquisition must succeed");
        let err = acquire_exclusive(&state_dir).expect_err("second acquisition must be refused");
        match &err {
            LockError::Contended {
                state_dir: sd,
                lock_path,
            } => {
                assert_eq!(sd, &state_dir);
                assert_eq!(lock_path, &state_dir.join(LOCK_FILE_NAME));
            }
            other => panic!("expected Contended, got {other:?}"),
        }
        assert!(err.to_string().contains(&state_dir.display().to_string()));
    }

    #[test]
    fn dropping_the_lock_releases_it_for_the_next_acquirer() {
        let tmp = tempfile::tempdir().unwrap();
        let state_dir = tmp.path().join("channel-c");
        let lock = acquire_exclusive(&state_dir).expect("first acquisition must succeed");
        drop(lock);
        acquire_exclusive(&state_dir).expect("acquisition after drop must succeed");
    }
}

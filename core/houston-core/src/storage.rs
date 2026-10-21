use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Every connected client polls host_info every 30 s; one walk a minute bounds the
// directory I/O regardless of how many clients are connected.
pub const STORAGE_TOTALS_MAX_AGE: Duration = Duration::from_secs(60);

/// The host_info fields that need a directory walk or the database connection.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StorageTotals {
    pub db_free_bytes: u64,
    pub scrollback_bytes: u64,
    pub logs_bytes: u64,
}

pub struct StorageTotalsCache {
    max_age: Duration,
    /// When the totals were measured (`None` once invalidated) and the totals.
    last: Mutex<(Option<Instant>, Option<StorageTotals>)>,
}

impl StorageTotalsCache {
    pub fn new(max_age: Duration) -> Self {
        Self {
            max_age,
            last: Mutex::new((None, None)),
        }
    }

    /// The cached totals while younger than `max_age`; otherwise `measure` runs with the
    /// previous totals (for values it cannot read right now) and its result is cached.
    pub fn get(
        &self,
        now: Instant,
        measure: impl FnOnce(Option<StorageTotals>) -> StorageTotals,
    ) -> StorageTotals {
        let (measured_at, previous) = *self.last.lock().expect("storage totals lock");
        if let (Some(at), Some(totals)) = (measured_at, previous) {
            if now.saturating_duration_since(at) < self.max_age {
                return totals;
            }
        }
        let totals = measure(previous);
        *self.last.lock().expect("storage totals lock") = (Some(now), Some(totals));
        totals
    }

    /// The next `get` measures again, still seeing the previous totals.
    pub fn invalidate(&self) {
        self.last.lock().expect("storage totals lock").0 = None;
    }
}

/// Total size of the regular files under `dir`, not following symlinks. A missing
/// directory is 0 bytes.
pub fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total += dir_bytes(&entry.path());
        } else if kind.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

pub fn wal_path(db_path: &Path) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The database file plus its write-ahead log: what VACUUM rewrites.
pub fn db_footprint(db_path: &Path) -> u64 {
    file_bytes(db_path) + file_bytes(&wal_path(db_path))
}

/// Bytes available to this process on the volume holding `dir`.
#[cfg(unix)]
pub fn free_disk_bytes(dir: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stat` is written in full on success.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs returned 0, so it initialised `stat`.
    let stat = unsafe { stat.assume_init() };
    // The field widths differ between Unix targets.
    #[allow(clippy::unnecessary_cast)]
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(windows)]
pub fn free_disk_bytes(dir: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    // SAFETY: `wide` is NUL-terminated; the two totals the call may skip are null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

/// Why `storage_reclaim` must not run now, or `None` when it may. VACUUM stalls every live
/// pane's status writes, and its temporary copy plus the rebuilt pages in the WAL need up
/// to twice the database's size before the old pages are released.
pub fn reclaim_refusal(
    live_sessions: usize,
    free_disk: &io::Result<u64>,
    db_bytes: u64,
    state_dir: &Path,
) -> Option<String> {
    if live_sessions > 0 {
        return Some(format!(
            "refused: {live_sessions} live session(s); reclaiming space needs 0 live sessions. \
             Close or sleep every pane, then try again"
        ));
    }
    match free_disk {
        Err(e) => Some(format!(
            "refused: could not read the free disk space at {}: {e}",
            state_dir.display()
        )),
        Ok(free) if *free < db_bytes.saturating_mul(2) => Some(format!(
            "refused: {free} bytes free at {}; reclaiming space needs twice the database and \
             write-ahead log size, {} bytes, for the temporary copy and the rebuilt database",
            state_dir.display(),
            db_bytes.saturating_mul(2)
        )),
        Ok(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_bytes_sums_nested_files_and_a_missing_dir_is_zero() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.bin"), [0u8; 10]).unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        std::fs::write(tmp.path().join("sub").join("b.log"), [0u8; 32]).unwrap();
        assert_eq!(dir_bytes(tmp.path()), 42);
        assert_eq!(dir_bytes(&tmp.path().join("absent")), 0);
    }

    #[test]
    fn free_disk_bytes_reads_the_volume_of_an_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(free_disk_bytes(tmp.path()).unwrap() > 0);
        assert!(free_disk_bytes(&tmp.path().join("absent")).is_err());
    }

    #[test]
    fn reclaim_refusal_names_live_sessions_before_disk_space() {
        let dir = Path::new("/state");
        let msg = reclaim_refusal(2, &Ok(0), 100, dir).unwrap();
        assert!(msg.contains("2 live session"), "{msg}");
        assert!(msg.contains("0 live sessions"), "{msg}");
    }

    #[test]
    fn reclaim_refusal_requires_twice_the_database_size_free() {
        let dir = Path::new("/state");
        let msg = reclaim_refusal(0, &Ok(199), 100, dir).unwrap();
        assert!(msg.contains("199 bytes free"), "{msg}");
        assert!(
            msg.contains("twice the database and write-ahead log size, 200 bytes"),
            "{msg}"
        );
        let unreadable = Err(io::Error::other("no such volume"));
        let msg = reclaim_refusal(0, &unreadable, 100, dir).unwrap();
        assert!(msg.contains("no such volume"), "{msg}");
        assert_eq!(reclaim_refusal(0, &Ok(200), 100, dir), None);
    }

    #[test]
    fn storage_totals_are_measured_once_per_interval_and_again_after_invalidate() {
        let cache = StorageTotalsCache::new(Duration::from_secs(60));
        let start = Instant::now();
        let totals = |logs_bytes| StorageTotals {
            logs_bytes,
            ..StorageTotals::default()
        };
        assert_eq!(
            cache.get(start, |prev| totals(prev.map_or(1, |_| 99))),
            totals(1)
        );
        let within = start + Duration::from_secs(59);
        assert_eq!(cache.get(within, |_| unreachable!()), totals(1));
        let after = start + Duration::from_secs(60);
        assert_eq!(
            cache.get(after, |prev| totals(prev.unwrap().logs_bytes + 1)),
            totals(2)
        );
        cache.invalidate();
        assert_eq!(
            cache.get(after, |prev| totals(prev.unwrap().logs_bytes + 1)),
            totals(3)
        );
    }
}

//! Windows scanners briefly open fresh files without sharing, so state-file writes retry
//! sharing and lock violations, and renames also retry the `ERROR_ACCESS_DENIED` a reader
//! holding the destination without delete sharing causes. Unix runs each operation once.
use std::io;
use std::path::Path;
use std::time::Duration;

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
// Five attempts with 20, 40, 80 and 160 ms between them: 300 ms of waiting at most, which
// covers a scanner's open of a small file and keeps a stuck holder from stalling callers.
const ATTEMPTS: u32 = 5;
const FIRST_DELAY: Duration = Duration::from_millis(20);

/// The Windows error codes one kind of operation treats as transient contention.
struct Contention {
    codes: &'static [i32],
    described: &'static str,
}

const OPEN: Contention = Contention {
    codes: &[ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION],
    described: "a sharing or lock violation",
};

/// A real permission failure on a rename costs the full retry budget before it surfaces.
const REPLACE: Contention = Contention {
    codes: &[
        ERROR_SHARING_VIOLATION,
        ERROR_LOCK_VIOLATION,
        ERROR_ACCESS_DENIED,
    ],
    described: "a sharing violation, lock violation or access denial",
};

impl Contention {
    fn matches(&self, error: &io::Error) -> bool {
        error
            .raw_os_error()
            .is_some_and(|code| self.codes.contains(&code))
    }
}

pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    retry(to, &REPLACE, || std::fs::rename(from, to))
}

pub fn write(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    retry(path, &OPEN, || std::fs::write(path, contents.as_ref()))
}

/// `NamedTempFile::persist` with the same retry; the temporary file is removed on failure.
pub fn persist(file: tempfile::NamedTempFile, dest: &Path) -> io::Result<std::fs::File> {
    let mut pending = Some(file);
    retry(dest, &REPLACE, || {
        let file = pending.take().expect("a failed persist returns its file");
        file.persist(dest).map_err(|e| {
            pending = Some(e.file);
            e.error
        })
    })
}

fn retry<T>(
    path: &Path,
    contention: &Contention,
    op: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    retry_with(path, contention, cfg!(windows), std::thread::sleep, op)
}

fn retry_with<T>(
    path: &Path,
    contention: &Contention,
    enabled: bool,
    mut sleep: impl FnMut(Duration),
    mut op: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut delay = FIRST_DELAY;
    let mut attempt = 1;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) if enabled && attempt < ATTEMPTS && contention.matches(&error) => {
                sleep(delay);
                delay *= 2;
                attempt += 1;
            }
            Err(error) if attempt == 1 => return Err(error),
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "{}: {error} on attempt {attempt} of {ATTEMPTS}; earlier attempts hit {}",
                        path.display(),
                        contention.described
                    ),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn sharing() -> io::Error {
        io::Error::from_raw_os_error(ERROR_SHARING_VIOLATION)
    }

    fn denied() -> io::Error {
        io::Error::from_raw_os_error(ERROR_ACCESS_DENIED)
    }

    fn run(
        outcomes: &[fn() -> io::Error],
        succeed_after: bool,
    ) -> (io::Result<u32>, u32, Vec<Duration>) {
        run_as(&OPEN, outcomes, succeed_after)
    }

    fn run_as(
        contention: &Contention,
        outcomes: &[fn() -> io::Error],
        succeed_after: bool,
    ) -> (io::Result<u32>, u32, Vec<Duration>) {
        let calls = Cell::new(0u32);
        let mut slept = Vec::new();
        let result = retry_with(
            Path::new("state/run-state.json"),
            contention,
            true,
            |d| slept.push(d),
            || {
                let n = calls.get();
                calls.set(n + 1);
                match outcomes.get(n as usize) {
                    Some(error) => Err(error()),
                    None if succeed_after => Ok(n + 1),
                    None => Err(sharing()),
                }
            },
        );
        (result, calls.get(), slept)
    }

    #[test]
    fn a_sharing_violation_is_retried_until_the_holder_lets_go() {
        let (result, calls, slept) = run(&[sharing, || io::Error::from_raw_os_error(33)], true);
        assert_eq!(result.unwrap(), 3);
        assert_eq!(calls, 3);
        assert_eq!(
            slept,
            [Duration::from_millis(20), Duration::from_millis(40)]
        );
    }

    #[test]
    fn a_replace_retries_access_denied_from_a_held_destination() {
        let (result, calls, slept) = run_as(&REPLACE, &[denied, sharing], true);
        assert_eq!(result.unwrap(), 3);
        assert_eq!(calls, 3);
        assert_eq!(slept.len(), 2);
    }

    #[test]
    fn a_replace_that_stays_denied_names_path_attempt_and_error() {
        let outcomes = [denied as fn() -> io::Error; ATTEMPTS as usize];
        let (result, calls, slept) = run_as(&REPLACE, &outcomes, false);
        let text = result.unwrap_err().to_string();
        assert_eq!(calls, ATTEMPTS);
        assert!(slept.iter().sum::<Duration>() < Duration::from_secs(1));
        assert!(text.contains("run-state.json"), "{text}");
        assert!(text.contains("attempt 5 of 5"), "{text}");
        assert!(text.contains(&denied().to_string()), "{text}");
        assert!(text.contains("access denial"), "{text}");
    }

    #[test]
    fn access_denied_and_other_errors_are_not_retried_by_a_write() {
        for error in [denied as fn() -> io::Error, || {
            io::Error::from(io::ErrorKind::NotFound)
        }] {
            let (result, calls, slept) = run(&[error], true);
            let kind = error().kind();
            let err = result.unwrap_err();
            assert_eq!(calls, 1);
            assert!(slept.is_empty());
            assert_eq!(err.kind(), kind);
            assert_eq!(err.to_string(), error().to_string(), "returned unchanged");
        }
    }

    #[test]
    fn a_persistent_holder_gives_up_after_the_cap_naming_path_and_attempts() {
        let (result, calls, slept) = run(&[], false);
        let err = result.unwrap_err();
        assert_eq!(calls, ATTEMPTS);
        assert!(slept.iter().sum::<Duration>() < Duration::from_secs(1));
        let text = err.to_string();
        assert!(text.contains("run-state.json"), "{text}");
        assert!(text.contains("attempt 5 of 5"), "{text}");
        assert!(text.contains(&sharing().to_string()), "{text}");
        assert_eq!(err.kind(), sharing().kind());
    }

    #[test]
    fn a_different_error_after_a_sharing_violation_is_reported_with_the_attempt() {
        let (result, calls, _) = run(&[sharing, denied], true);
        let text = result.unwrap_err().to_string();
        assert_eq!(calls, 2);
        assert!(text.contains("attempt 2 of 5"), "{text}");
    }

    #[test]
    fn nothing_is_retried_when_disabled_as_on_unix() {
        let calls = Cell::new(0u32);
        let result: io::Result<()> = retry_with(
            Path::new("run-state.json"),
            &REPLACE,
            false,
            |_| panic!("no sleep when retries are disabled"),
            || {
                calls.set(calls.get() + 1);
                Err(sharing())
            },
        );
        assert_eq!(result.unwrap_err().to_string(), sharing().to_string());
        assert_eq!(calls.get(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn a_write_waits_out_a_real_exclusive_open() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.json");
        std::fs::write(&path, "old").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let first = std::fs::write(&path, "x").unwrap_err();
        assert_eq!(
            first.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION),
            "{first}"
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        write(&path, "new").unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }

    #[cfg(windows)]
    #[test]
    fn a_rename_waits_out_a_real_exclusive_open_of_the_source() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("run-state.json.tmp");
        let dest = dir.path().join("run-state.json");
        std::fs::write(&tmp, "new").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ, as a scanner opens it: no delete sharing
            .open(&tmp)
            .unwrap();
        let first = std::fs::rename(&tmp, &dest).unwrap_err();
        assert_eq!(
            first.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION),
            "{first}"
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        rename(&tmp, &dest).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    }

    #[cfg(windows)]
    #[test]
    fn a_rename_waits_out_a_reader_holding_the_destination_without_delete_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("run-state.json.tmp");
        let dest = dir.path().join("run-state.json");
        std::fs::write(&dest, "old").unwrap();
        std::fs::write(&tmp, "new").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ: a scanner reading the previous version
            .open(&dest)
            .unwrap();
        let first = std::fs::rename(&tmp, &dest).unwrap_err();
        assert_eq!(first.raw_os_error(), Some(ERROR_ACCESS_DENIED), "{first}");
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        rename(&tmp, &dest).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    }

    #[cfg(windows)]
    #[test]
    fn a_persist_waits_out_a_reader_holding_the_destination_without_delete_sharing() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("config.toml");
        std::fs::write(&dest, "old").unwrap();
        let mut temporary = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        temporary.write_all(b"new").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&dest)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        persist(temporary, &dest).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
    }
}

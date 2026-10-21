//! Windows scanners and indexers briefly open fresh files without sharing, so state-file
//! renames and creates retry sharing and lock violations only; `ERROR_ACCESS_DENIED` is a
//! real permission failure. On Unix every operation runs exactly once.
use std::io;
use std::path::Path;
use std::time::Duration;

const ERROR_SHARING_VIOLATION: i32 = 32;
const ERROR_LOCK_VIOLATION: i32 = 33;
// Five attempts with 20, 40, 80 and 160 ms between them: 300 ms of waiting at most, which
// covers a scanner's open of a small file and keeps a stuck holder from stalling callers.
const ATTEMPTS: u32 = 5;
const FIRST_DELAY: Duration = Duration::from_millis(20);

pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    retry(to, || std::fs::rename(from, to))
}

pub fn write(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    retry(path, || std::fs::write(path, contents.as_ref()))
}

/// `NamedTempFile::persist` with the same retry; the temporary file is removed on failure.
pub fn persist(file: tempfile::NamedTempFile, dest: &Path) -> io::Result<std::fs::File> {
    let mut pending = Some(file);
    retry(dest, || {
        let file = pending.take().expect("a failed persist returns its file");
        file.persist(dest).map_err(|e| {
            pending = Some(e.file);
            e.error
        })
    })
}

fn retry<T>(path: &Path, op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    retry_with(path, is_sharing_violation, std::thread::sleep, op)
}

fn is_sharing_violation(error: &io::Error) -> bool {
    cfg!(windows) && is_sharing_code(error.raw_os_error())
}

fn is_sharing_code(code: Option<i32>) -> bool {
    matches!(code, Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION))
}

fn retry_with<T>(
    path: &Path,
    retryable: impl Fn(&io::Error) -> bool,
    mut sleep: impl FnMut(Duration),
    mut op: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let mut delay = FIRST_DELAY;
    let mut attempt = 1;
    loop {
        match op() {
            Ok(value) => return Ok(value),
            Err(error) if attempt < ATTEMPTS && retryable(&error) => {
                sleep(delay);
                delay *= 2;
                attempt += 1;
            }
            Err(error) if attempt == 1 => return Err(error),
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "{}: {error} on attempt {attempt} of {ATTEMPTS}; earlier attempts hit a \
                         sharing or lock violation",
                        path.display()
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

    fn run(
        outcomes: &[fn() -> io::Error],
        succeed_after: bool,
    ) -> (io::Result<u32>, u32, Vec<Duration>) {
        let calls = Cell::new(0u32);
        let mut slept = Vec::new();
        let result = retry_with(
            Path::new("state/run-state.json"),
            |e| is_sharing_code(e.raw_os_error()),
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
    fn access_denied_and_other_errors_are_not_retried() {
        for error in [
            (|| io::Error::from_raw_os_error(5)) as fn() -> io::Error,
            || io::Error::from(io::ErrorKind::NotFound),
        ] {
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
        let (result, calls, _) = run(&[sharing, || io::Error::from_raw_os_error(5)], true);
        let text = result.unwrap_err().to_string();
        assert_eq!(calls, 2);
        assert!(text.contains("attempt 2 of 5"), "{text}");
    }

    #[test]
    fn sharing_codes_are_retried_only_on_windows() {
        assert_eq!(is_sharing_violation(&sharing()), cfg!(windows));
        assert!(!is_sharing_violation(&io::Error::from_raw_os_error(5)));
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
}

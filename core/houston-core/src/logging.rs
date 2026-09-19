use anyhow::{Context, Result};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

/// Daily log files are capped at this many — an unbounded rolling log is a disk
/// leak, and two weeks is enough to debug a stale report without growing forever.
const MAX_LOG_FILES: usize = 14;

pub struct LogGuard(#[allow(dead_code)] Option<tracing_appender::non_blocking::WorkerGuard>);

fn build_env_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| "houston_core=info".into())
}

fn init_file_writer(
    dir: &Path,
) -> Result<(
    tracing_appender::non_blocking::NonBlocking,
    tracing_appender::non_blocking::WorkerGuard,
)> {
    fs::create_dir_all(dir).with_context(|| format!("creating log directory {}", dir.display()))?;
    #[cfg(unix)]
    if let Err(e) = fs::set_permissions(dir, fs::Permissions::from_mode(0o700)) {
        eprintln!(
            "tracing: could not tighten permissions on log directory {}: {e}",
            dir.display()
        );
    }
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("houston-core")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)
        .with_context(|| format!("opening rolling log appender in {}", dir.display()))?;
    Ok(tracing_appender::non_blocking(appender))
}

/// Call only once the channel is settled — `paths::log_dir()` reads
/// `HOUSTON_CHANNEL` fresh, so installing before a host agrees which channel it
/// owns writes that host's logs into the wrong state dir.
#[must_use = "dropping the LogGuard stops the file sink's worker and loses buffered lines"]
pub fn init() -> LogGuard {
    let mut guard = None;
    let file_layer = match crate::paths::log_dir() {
        Ok(dir) => match init_file_writer(&dir) {
            Ok((writer, worker_guard)) => {
                guard = Some(worker_guard);
                Some(
                    fmt::layer()
                        .with_writer(writer)
                        .with_ansi(false)
                        .with_filter(build_env_filter()),
                )
            }
            Err(e) => {
                eprintln!("tracing: file log disabled, continuing stdout-only: {e:#}");
                None
            }
        },
        Err(e) => {
            eprintln!("tracing: file log disabled, continuing stdout-only: {e:#}");
            None
        }
    };
    tracing_subscriber::registry()
        .with(fmt::layer().with_filter(build_env_filter()))
        .with(file_layer)
        .init();
    LogGuard(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_log_init_fails_soft_when_the_log_dir_cannot_be_created() {
        let tmp = tempfile::tempdir().unwrap();
        let blocked = tmp.path().join("blocked-by-a-file");
        fs::write(&blocked, b"not a directory").unwrap();
        let log_dir = blocked.join("logs");

        let err =
            init_file_writer(&log_dir).expect_err("a file in the way must not be silently ok'd");
        let msg = err.to_string();
        assert!(
            msg.contains(&log_dir.display().to_string()),
            "error must name the offending path, got: {msg}"
        );
    }

    #[test]
    fn a_line_emitted_through_the_file_layer_reaches_a_log_file() {
        crate::test_tracing_capture::ensure_permissive_global_default();

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("logs");
        let (writer, guard) = init_file_writer(&dir).expect("temp log dir must open");

        let subscriber = tracing_subscriber::registry().with(
            fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_filter(EnvFilter::new("houston_core=info")),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("logging-sink-probe");
        });
        drop(guard);

        let mut found = Vec::new();
        for entry in fs::read_dir(&dir).expect("log dir must exist") {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let body = fs::read_to_string(&path).unwrap_or_default();
            found.push(format!("{name}: {body}"));
        }
        assert!(
            found.iter().any(|f| f.contains("logging-sink-probe")),
            "the file sink in {} received no line; files seen: {found:?}",
            dir.display()
        );
    }
}

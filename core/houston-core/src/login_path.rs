//! Login-shell PATH recovery. A daemon started from the desktop entry inherits
//! the systemd user session PATH, which lacks the dirs agent CLIs live in, so a
//! pane dies with ENOENT. Probes `-lic` on purpose: `.zshrc` adds those dirs.
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
const MARKER: &str = "__TR_LOGIN_PATH__";

/// Hard cap on the probe: a hanging rc file must not hold up daemon boot, while
/// a slow rc setup still gets its ~1 s to answer.
#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(unix)]
const CACHE_FILE: &str = "login-path-cache.json";

#[cfg(unix)]
#[derive(serde::Serialize, serde::Deserialize)]
struct CachedLogin {
    shell: String,
    login_path: String,
}

#[cfg(unix)]
fn cache_path() -> Option<PathBuf> {
    crate::paths::config_dir().ok().map(|d| d.join(CACHE_FILE))
}

#[cfg(unix)]
fn read_cached_login(path: &Path, shell: &str) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let cached: CachedLogin = serde_json::from_str(&raw).ok()?;
    (cached.shell == shell && !cached.login_path.is_empty()).then_some(cached.login_path)
}

#[cfg(unix)]
fn write_cached_login(path: &Path, shell: &str, login_path: &str) {
    let Ok(json) = serde_json::to_string(&CachedLogin {
        shell: shell.to_string(),
        login_path: login_path.to_string(),
    }) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        if let Err(e) = std::fs::rename(&tmp, path) {
            tracing::debug!("login-path cache rename to {} failed: {e}", path.display());
        }
    }
}

#[cfg(unix)]
fn merge(login: &str, inherited: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for entry in login.split(':').chain(inherited.split(':')) {
        if entry.is_empty() || out.contains(&entry) {
            continue;
        }
        out.push(entry);
    }
    out.join(":")
}

#[cfg(unix)]
fn probe(shell: &str, timeout: Duration) -> Option<String> {
    let script = format!("printf '{MARKER}%s\\n' \"$PATH\"");
    let mut child = crate::spawn::command(shell)
        .args(["-lic", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let reader = child.stdout.take().map(|mut r| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = r.read_to_string(&mut s);
            s
        })
    })?;

    let start = Instant::now();
    let status = loop {
        match child.try_wait().ok()? {
            Some(status) => break status,
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                tracing::warn!(
                    "login-shell PATH probe ({shell}) timed out — keeping inherited PATH"
                );
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    let stdout = reader.join().ok()?;
    if !status.success() {
        tracing::warn!(
            "login-shell PATH probe ({shell}) exited with {:?} — keeping inherited PATH",
            status.code()
        );
        return None;
    }
    parse_probe_output(&stdout)
}

#[cfg(unix)]
fn parse_probe_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .filter_map(|l| l.trim().strip_prefix(MARKER))
        .rfind(|v| !v.is_empty())
        .map(str::to_string)
}

/// Call once during startup, **before** any spawn and before the server is up:
/// it mutates the process environment, which is only sound while no other thread
/// can be reading it.
#[cfg(unix)]
pub fn adopt() {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
    let started = Instant::now();
    let cache = cache_path();

    if let Some(login) = cache
        .as_deref()
        .and_then(|path| read_cached_login(path, &shell))
    {
        apply(&shell, &login, &inherited, started, "cached");
        let shell_bg = shell.clone();
        std::thread::spawn(move || {
            if let (Some(fresh), Some(path)) = (probe(&shell_bg, PROBE_TIMEOUT), cache) {
                write_cached_login(&path, &shell_bg, &fresh);
            }
        });
        return;
    }

    let Some(login) = probe(&shell, PROBE_TIMEOUT) else {
        return;
    };
    if let Some(path) = cache {
        write_cached_login(&path, &shell, &login);
    }
    apply(&shell, &login, &inherited, started, "probed");
}

#[cfg(not(unix))]
pub fn adopt() {
    tracing::info!("login-shell PATH recovery skipped: not a Unix platform");
}

#[cfg(unix)]
fn apply(shell: &str, login: &str, inherited: &str, started: Instant, source: &str) {
    let merged = merge(login, inherited);
    if merged == inherited {
        tracing::info!(
            "login-shell PATH probe ({shell}, {}ms, {source}): PATH already complete",
            started.elapsed().as_millis()
        );
        return;
    }
    std::env::set_var("PATH", &merged);
    tracing::info!(
        "login-shell PATH probe ({shell}, {}ms, {source}): PATH extended from {inherited:?} to \
         {merged:?}",
        started.elapsed().as_millis()
    );
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips_for_the_same_shell_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        write_cached_login(&path, "/usr/bin/zsh", "/a:/b");
        assert_eq!(
            read_cached_login(&path, "/usr/bin/zsh").as_deref(),
            Some("/a:/b")
        );
        assert_eq!(
            read_cached_login(&path, "/usr/bin/fish"),
            None,
            "a cache written by another shell must not be adopted"
        );
    }

    #[test]
    fn malformed_or_empty_cache_reads_as_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILE);
        assert_eq!(read_cached_login(&path, "zsh"), None, "missing file");
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(read_cached_login(&path, "zsh"), None, "malformed json");
        write_cached_login(&path, "zsh", "");
        assert_eq!(
            read_cached_login(&path, "zsh"),
            None,
            "an empty cached PATH must fall back to the blocking probe"
        );
    }

    #[cfg(unix)]
    fn fake_shell(dir: &std::path::Path, name: &str, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }

    #[test]
    fn merge_puts_login_first_and_keeps_inherited_only_dirs() {
        let merged = merge("/home/u/.local/bin:/usr/bin", "/usr/bin:/sbin:/snap/bin");
        assert_eq!(merged, "/home/u/.local/bin:/usr/bin:/sbin:/snap/bin");
    }

    #[test]
    fn merge_drops_duplicates_and_empty_segments() {
        assert_eq!(merge("/a::/a:/b", "/b:/c:"), "/a:/b:/c");
    }

    #[test]
    fn parse_takes_the_marker_line_through_rc_noise() {
        let out = "p10k instant prompt\n__TR_LOGIN_PATH__/opt/bin:/usr/bin\ntrailing junk\n";
        assert_eq!(
            parse_probe_output(out).as_deref(),
            Some("/opt/bin:/usr/bin")
        );
    }

    #[test]
    fn parse_last_marker_wins() {
        let out = "__TR_LOGIN_PATH__/stale\n__TR_LOGIN_PATH__/fresh\n";
        assert_eq!(parse_probe_output(out).as_deref(), Some("/fresh"));
    }

    #[test]
    fn parse_without_a_marker_or_with_an_empty_value_is_none() {
        assert!(parse_probe_output("hello\nworld\n").is_none());
        assert!(parse_probe_output("__TR_LOGIN_PATH__\n").is_none());
    }

    #[test]
    fn probe_through_a_real_shell_returns_its_path() {
        let path = probe("/bin/sh", PROBE_TIMEOUT).expect("sh reports a PATH");
        assert!(path.contains("/bin"), "looks like a PATH: {path:?}");
    }

    #[test]
    #[cfg(unix)]
    fn probe_nonzero_exit_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(
            dir.path(),
            "broken.sh",
            "printf '__TR_LOGIN_PATH__/opt/bin\\n'\nexit 1",
        );
        assert!(probe(&shell, PROBE_TIMEOUT).is_none());
    }

    #[test]
    #[cfg(unix)]
    fn probe_timeout_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(dir.path(), "hang.sh", "sleep 30");
        assert!(probe(&shell, Duration::from_millis(200)).is_none());
    }

    #[test]
    fn probe_missing_shell_is_none() {
        assert!(probe("/nonexistent/shell", PROBE_TIMEOUT).is_none());
    }
}

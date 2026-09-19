use std::collections::HashMap;
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use houston_protocol as proto;

// Measured warm on this machine: claude 0.01s, codex 0.10s, grok 0.08s, agy
// 0.33s, opencode 0.68s, cursor-agent 0.85s. 4s covers a cold disk spin-up
// while still bounding the six-provider sweep to a few seconds worst case.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CliPresence {
    pub present: bool,
    pub version: Option<String>,
}

pub fn binary_name(kind: proto::AgentKind) -> Option<&'static str> {
    match kind {
        proto::AgentKind::Claude => Some("claude"),
        proto::AgentKind::Codex => Some("codex"),
        proto::AgentKind::Antigravity => Some("agy"),
        proto::AgentKind::Opencode => Some("opencode"),
        proto::AgentKind::Cursor => Some("cursor-agent"),
        proto::AgentKind::Grok => Some("grok"),
        proto::AgentKind::Shell
        | proto::AgentKind::Ssh
        | proto::AgentKind::Custom
        | proto::AgentKind::Droid
        | proto::AgentKind::Copilot
        | proto::AgentKind::Aider => None,
    }
}

pub fn parse_version(output: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\b(\d+\.\d+\.\d+)\b").expect("literal regex"))
        .captures(output)
        .map(|c| c[1].to_string())
}

pub fn probe(binary: &str) -> CliPresence {
    // exe_path::resolve passes a path containing a separator straight back
    // without touching disk (the caller owns existence there), so a resolved
    // path is not yet a path that exists.
    let resolved = crate::exe_path::resolve(binary).filter(|p| p.is_file());
    let Some(path) = resolved else {
        return CliPresence {
            present: false,
            version: None,
        };
    };
    CliPresence {
        present: true,
        version: read_version(&path),
    }
}

fn read_version(path: &std::path::Path) -> Option<String> {
    let mut child = crate::spawn::command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;

    // Drained on their own threads: a CLI that fills a pipe buffer while we
    // sit in try_wait would deadlock against us otherwise.
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);

    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() >= VERSION_PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                tracing::warn!(
                    "{} --version timed out after {:?} — reporting the CLI as present with an \
                     unknown version",
                    path.display(),
                    VERSION_PROBE_TIMEOUT
                );
                return None;
            }
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
            Err(e) => {
                tracing::debug!("waiting on {} --version: {e}", path.display());
                return None;
            }
        }
    }

    // Exit status deliberately not consulted: a CLI that prints its version
    // then exits non-zero over something unrelated is still installed at a
    // version worth showing.
    let text = format!(
        "{}\n{}",
        out.and_then(|h| h.join().ok()).unwrap_or_default(),
        err.and_then(|h| h.join().ok()).unwrap_or_default()
    );
    parse_version(&text)
}

fn drain<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = r.read_to_string(&mut s);
        s
    })
}

#[derive(Debug, Default)]
pub struct ProbeCache {
    path: std::ffi::OsString,
    entries: HashMap<&'static str, CliPresence>,
}

impl ProbeCache {
    pub fn get(&mut self, binary: &'static str) -> CliPresence {
        self.discard_if_path_changed();
        if let Some(hit) = self.entries.get(binary) {
            return hit.clone();
        }
        let fresh = probe(binary);
        self.entries.insert(binary, fresh.clone());
        fresh
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn discard_if_path_changed(&mut self) {
        let now = std::env::var_os("PATH").unwrap_or_default();
        if now != self.path {
            self.path = now;
            self.entries.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn fake_cli(dir: &std::path::Path, name: &str, line: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\nprintf '%s\\n' '{line}'\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.display().to_string()
    }

    #[test]
    fn every_hooked_provider_has_a_binary_name() {
        for provider in crate::agent_hooks::PROVIDERS
            .iter()
            .chain(std::iter::once(&proto::AgentKind::Claude))
        {
            assert!(
                binary_name(*provider).is_some(),
                "{provider:?} installs hooks but names no binary to probe"
            );
        }
    }

    #[test]
    fn identity_only_and_argv_kinds_name_no_binary() {
        for kind in [
            proto::AgentKind::Shell,
            proto::AgentKind::Ssh,
            proto::AgentKind::Custom,
            proto::AgentKind::Droid,
            proto::AgentKind::Copilot,
            proto::AgentKind::Aider,
        ] {
            assert_eq!(binary_name(kind), None, "{kind:?}");
        }
    }

    #[test]
    fn version_is_read_out_of_each_shipped_cli_s_real_answer() {
        for (output, want) in [
            ("2.1.263 (Claude Code)", "2.1.263"),
            ("codex-cli 0.153.4", "0.153.4"),
            ("1.1.26", "1.1.26"),
            ("1.18.27", "1.18.27"),
            ("2026.08.11-e8db854", "2026.08.11"),
            ("grok 1.0.13 (5e9a58528b76) [stable]", "1.0.13"),
        ] {
            assert_eq!(parse_version(output).as_deref(), Some(want), "{output:?}");
        }
    }

    #[test]
    fn output_with_nothing_version_shaped_parses_to_none() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("command not found"), None);
        assert_eq!(parse_version("v2"), None, "two numbers is not a version");
        assert_eq!(parse_version("2.1"), None);
    }

    #[test]
    fn a_cli_that_is_nowhere_is_absent_with_no_version() {
        let got = probe("houston-cli-probe-no-such-binary");
        assert!(!got.present, "no PATH entry holds this name");
        assert_eq!(got.version, None, "absent means no version, never a guess");
    }

    #[test]
    fn a_path_that_does_not_exist_is_absent_too() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("never-written");
        let got = probe(&missing.display().to_string());
        assert!(
            !got.present,
            "an explicit path resolves without existing — presence must still check"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_real_binary_is_present_at_the_version_it_prints() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "houston-fake-cli", "fake-cli 4.5.6 (build abc)");

        let got = probe(&cli);
        assert!(got.present);
        assert_eq!(got.version.as_deref(), Some("4.5.6"));
    }

    #[test]
    #[cfg(unix)]
    fn a_binary_that_prints_no_version_is_still_present() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "houston-mute-cli", "no idea");

        let got = probe(&cli);
        assert!(got.present, "the binary is there even if its answer is not");
        assert_eq!(got.version, None);
    }

    #[test]
    #[cfg(unix)]
    fn a_version_printed_on_stderr_counts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("houston-stderr-cli");
        std::fs::write(&p, "#!/bin/sh\nprintf 'tool 7.7.7\\n' >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();

        let got = probe(&p.display().to_string());
        assert!(got.present);
        assert_eq!(
            got.version.as_deref(),
            Some("7.7.7"),
            "a non-zero exit does not unmake a version the CLI already printed"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_hanging_binary_times_out_as_present_with_an_unknown_version() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("houston-hang-cli");
        std::fs::write(&p, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = Instant::now();
        let got = probe(&p.display().to_string());
        assert!(got.present);
        assert_eq!(got.version, None);
        assert!(
            started.elapsed() < VERSION_PROBE_TIMEOUT + Duration::from_secs(2),
            "the probe must not outlive its own cap"
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_cache_answers_from_one_probe_and_re_probes_after_clear() {
        let dir = tempfile::tempdir().unwrap();
        let name: &'static str = Box::leak(
            dir.path()
                .join("houston-cached-cli")
                .display()
                .to_string()
                .into_boxed_str(),
        );
        let mut cache = ProbeCache::default();

        assert!(!cache.get(name).present, "nothing written yet");
        fake_cli(dir.path(), "houston-cached-cli", "1.2.3");
        assert!(
            !cache.get(name).present,
            "the cached answer stands until something asks for a rescan"
        );

        cache.clear();
        let fresh = cache.get(name);
        assert!(fresh.present);
        assert_eq!(fresh.version.as_deref(), Some("1.2.3"));
    }
}

//! The process environment, captured once at boot. Daemon code reads variables
//! through this instead of `std::env`, so a test can inject an environment
//! without mutating the process, and children see exactly the injected one.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct HostEnv(Arc<HashMap<OsString, OsString>>);

impl HostEnv {
    /// Snapshot of the current process environment. Call after every startup
    /// mutation (`login_path::adopt`, `env_hygiene::scrub`, the channel variable).
    #[allow(clippy::disallowed_methods)]
    pub fn capture() -> Self {
        Self(Arc::new(std::env::vars_os().collect()))
    }

    /// The process environment with every agent CLI config home under `home`, for unit tests
    /// that build a daemon: the account's own configuration stays out of reach.
    #[cfg(test)]
    pub fn capture_with_home(home: &std::path::Path) -> Self {
        Self::capture()
            .with("HOME", Some(home))
            .with("USERPROFILE", Some(home))
            .with("XDG_CONFIG_HOME", Some(home.join(".config")))
            .without("CLAUDE_CONFIG_DIR")
            .without("CODEX_HOME")
    }

    pub fn from_pairs<K: Into<OsString>, V: Into<OsString>>(
        pairs: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        Self(Arc::new(
            pairs
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        ))
    }

    /// A copy with `name` set (or removed when `value` is `None`).
    #[must_use]
    pub fn with(&self, name: &str, value: Option<impl Into<OsString>>) -> Self {
        let mut map = (*self.0).clone();
        if let Some(existing) = self.key_of(name) {
            map.remove(existing);
        }
        if let Some(v) = value {
            map.insert(name.into(), v.into());
        }
        Self(Arc::new(map))
    }

    #[must_use]
    pub fn without(&self, name: &str) -> Self {
        self.with(name, None::<&str>)
    }

    pub fn var_os(&self, name: &str) -> Option<&OsStr> {
        self.key_of(name)
            .and_then(|key| self.0.get(key))
            .map(OsString::as_os_str)
    }

    /// The stored spelling of `name`. Windows variable names are case-insensitive
    /// (the process environment holds `Path`, callers ask for `PATH`), so the
    /// lookup there ignores ASCII case, as `std::env::var` does.
    fn key_of(&self, name: &str) -> Option<&OsString> {
        if cfg!(windows) {
            self.0.keys().find(|key| key.eq_ignore_ascii_case(name))
        } else {
            self.0.get_key_value(OsStr::new(name)).map(|(key, _)| key)
        }
    }

    /// Like `std::env::var(..).ok()`: `None` when unset or not valid Unicode.
    pub fn var(&self, name: &str) -> Option<String> {
        self.var_os(name)
            .and_then(|v| v.to_str())
            .map(str::to_string)
    }

    pub fn names(&self) -> impl Iterator<Item = &OsStr> {
        self.0.keys().map(OsString::as_os_str)
    }

    /// `HOME`, then `USERPROFILE`, then the platform lookup. On Windows
    /// `dirs::home_dir()` reads the registry and ignores the environment, so
    /// the environment comes first or hermetic tests could not redirect state.
    #[allow(clippy::disallowed_methods)]
    pub fn home_dir(&self) -> Option<PathBuf> {
        ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|name| self.var_os(name))
            .find(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
    }

    /// Children see this environment instead of the process's own. Only the
    /// differences from the process environment are applied, so a snapshot equal
    /// to it spawns as before. Call before per-command `env`/`env_remove`.
    pub fn apply_to(&self, cmd: &mut std::process::Command) {
        let (set, remove) = self.diff_from_process();
        for (k, v) in set {
            cmd.env(k, v);
        }
        for k in remove {
            cmd.env_remove(k);
        }
    }

    pub fn apply_to_tokio(&self, cmd: &mut tokio::process::Command) {
        let (set, remove) = self.diff_from_process();
        for (k, v) in set {
            cmd.env(k, v);
        }
        for k in remove {
            cmd.env_remove(k);
        }
    }

    /// The same overlay for a PTY child. `portable_pty` seeds its own base
    /// environment, and on Unix replaces `SHELL` with the passwd shell, so
    /// `SHELL` is left to it.
    pub fn apply_to_pty(&self, cmd: &mut portable_pty::CommandBuilder) {
        let (set, remove) = self.diff_from_process();
        for (k, v) in set {
            if !cfg!(unix) || k != "SHELL" {
                cmd.env(k, v);
            }
        }
        for k in remove {
            if !cfg!(unix) || k != "SHELL" {
                cmd.env_remove(k);
            }
        }
    }

    #[allow(clippy::disallowed_methods)]
    fn diff_from_process(&self) -> (Vec<(&OsString, &OsString)>, Vec<OsString>) {
        let key = |k: &OsStr| -> OsString {
            if cfg!(windows) {
                k.to_ascii_uppercase()
            } else {
                k.to_os_string()
            }
        };
        let process: HashMap<OsString, OsString> =
            std::env::vars_os().map(|(k, v)| (key(&k), v)).collect();
        let ours: std::collections::HashSet<OsString> = self.0.keys().map(|k| key(k)).collect();
        let set = self
            .0
            .iter()
            .filter(|(k, v)| process.get(&key(k)) != Some(*v))
            .collect();
        let mut remove: Vec<OsString> = std::env::vars_os()
            .map(|(k, _)| k)
            .filter(|k| !ours.contains(&key(k)))
            .collect();
        remove.sort();
        (set, remove)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_lookups_ignore_the_case_of_variable_names() {
        let env = HostEnv::from_pairs([("Path", r"C:\Windows\System32")]);
        assert_eq!(env.var("PATH").as_deref(), Some(r"C:\Windows\System32"));
        let env = env.with("PATH", Some(r"C:\tools"));
        assert_eq!(
            env.names().count(),
            1,
            "PATH replaces Path instead of adding a second entry"
        );
        assert_eq!(env.var("Path").as_deref(), Some(r"C:\tools"));
        assert_eq!(env.without("path").names().count(), 0);
    }

    #[test]
    fn lookups_read_the_snapshot_not_the_process() {
        let env = HostEnv::from_pairs([("A", "1"), ("EMPTY", "")]);
        assert_eq!(env.var("A").as_deref(), Some("1"));
        assert_eq!(env.var("HOUSTON_HOST_ENV_UNSET_IN_SNAPSHOT"), None);
        assert_eq!(env.var_os("EMPTY"), Some(OsStr::new("")));
    }

    #[test]
    fn home_prefers_home_then_userprofile_and_skips_empty_values() {
        let env = HostEnv::from_pairs([("HOME", ""), ("USERPROFILE", "/u")]);
        assert_eq!(env.home_dir(), Some(PathBuf::from("/u")));
        let env = HostEnv::from_pairs([("HOME", "/h"), ("USERPROFILE", "/u")]);
        assert_eq!(env.home_dir(), Some(PathBuf::from("/h")));
    }

    #[test]
    fn with_sets_and_removes_without_touching_the_original() {
        let env = HostEnv::from_pairs([("A", "1")]);
        assert_eq!(env.with("A", None::<&str>).var("A"), None);
        assert_eq!(env.with("B", Some("2")).var("B").as_deref(), Some("2"));
        assert_eq!(env.var("A").as_deref(), Some("1"));
        assert_eq!(env.var("B"), None);
    }

    #[test]
    fn a_snapshot_of_the_process_changes_nothing_for_children() {
        let mut cmd = crate::spawn::command("true");
        HostEnv::capture().apply_to(&mut cmd);
        assert_eq!(cmd.get_envs().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn apply_to_replaces_the_inherited_environment() {
        let env = HostEnv::from_pairs([("ONLY_VAR", "x")]);
        let mut cmd = crate::spawn::command("/usr/bin/env");
        env.apply_to(&mut cmd);
        let out = cmd.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ONLY_VAR=x");
    }
}

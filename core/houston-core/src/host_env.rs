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
        match value {
            Some(v) => map.insert(name.into(), v.into()),
            None => map.remove(OsStr::new(name)),
        };
        Self(Arc::new(map))
    }

    pub fn var_os(&self, name: &str) -> Option<&OsStr> {
        self.0.get(OsStr::new(name)).map(OsString::as_os_str)
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

    /// Children see this environment instead of the process's own. Call before
    /// any per-command `env`/`env_remove`, which then layer on top.
    pub fn apply_to(&self, cmd: &mut std::process::Command) {
        cmd.env_clear().envs(self.0.iter());
    }

    pub fn apply_to_tokio(&self, cmd: &mut tokio::process::Command) {
        cmd.env_clear().envs(self.0.iter());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

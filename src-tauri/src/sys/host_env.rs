//! The process environment, captured once at boot. Daemon code reads variables
//! through this instead of `std::env`, so a test can inject an environment
//! without mutating the process, and children see exactly the injected one.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
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

    #[cfg(test)]
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
    #[cfg(test)]
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

    #[cfg(all(test, windows))]
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
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn var(&self, name: &str) -> Option<String> {
        self.var_os(name)
            .and_then(|v| v.to_str())
            .map(str::to_string)
    }

    #[cfg(all(test, windows))]
    pub fn names(&self) -> impl Iterator<Item = &OsStr> {
        self.0.keys().map(OsString::as_os_str)
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
    fn with_sets_and_removes_without_touching_the_original() {
        let env = HostEnv::from_pairs([("A", "1")]);
        assert_eq!(env.with("A", None::<&str>).var("A"), None);
        assert_eq!(env.with("B", Some("2")).var("B").as_deref(), Some("2"));
        assert_eq!(env.var("A").as_deref(), Some("1"));
        assert_eq!(env.var("B"), None);
    }
}

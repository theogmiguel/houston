#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

pub const CHANNEL_ENV: &str = "HOUSTON_CHANNEL";
pub const BASE_DIR: &str = ".houston";
// Bounded so a channel name can never become a path bomb or an unreadable dir name.
const MAX_CHANNEL_LEN: usize = 32;

pub fn channel() -> Result<Option<String>> {
    let Ok(raw) = std::env::var(CHANNEL_ENV) else {
        return Ok(None);
    };
    validate_channel(&raw)
}

pub fn channel_shape_rule() -> String {
    format!(
        "expected 1-{MAX_CHANNEL_LEN} characters of [a-z0-9-], not starting or ending with '-'; \
         leave it unset (or use \"release\") for the default {BASE_DIR} directory"
    )
}

// Fails closed and names the offending value: this string becomes a directory under
// $HOME, so anything that could escape it (`..`, `/`) must stop the daemon at startup.
// Unset, "release" and "" all mean the default (release) channel.
pub fn validate_channel(raw: &str) -> Result<Option<String>> {
    let name = raw.trim();
    if name.is_empty() || name == "release" {
        return Ok(None);
    }
    let shape_ok = name.len() <= MAX_CHANNEL_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if !shape_ok {
        bail!(
            "{CHANNEL_ENV}={raw:?} is not a valid channel name: {}",
            channel_shape_rule()
        );
    }
    Ok(Some(name.to_string()))
}

pub fn config_dir() -> Result<PathBuf> {
    let home = crate::sys::home_dir::home_dir().context("cannot resolve home directory")?;
    Ok(dir_for(&home, channel()?.as_deref()))
}

pub fn dir_for(home: &Path, channel: Option<&str>) -> PathBuf {
    match channel {
        None => home.join(BASE_DIR),
        Some(c) => home.join(format!("{BASE_DIR}-{c}")),
    }
}

pub fn log_dir() -> Result<PathBuf> {
    let home = crate::sys::home_dir::home_dir().context("cannot resolve home directory")?;
    Ok(log_dir_for(&home, channel()?.as_deref()))
}

pub fn log_dir_for(home: &Path, channel: Option<&str>) -> PathBuf {
    dir_for(home, channel).join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_empty_and_release_all_mean_the_default_channel() {
        assert_eq!(validate_channel("").unwrap(), None);
        assert_eq!(validate_channel("   ").unwrap(), None);
        assert_eq!(validate_channel("release").unwrap(), None);
    }

    #[test]
    fn a_named_channel_is_accepted_and_trimmed() {
        assert_eq!(validate_channel("dev").unwrap().as_deref(), Some("dev"));
        assert_eq!(validate_channel("pr-42").unwrap().as_deref(), Some("pr-42"));
        assert_eq!(validate_channel(" dev ").unwrap().as_deref(), Some("dev"));
        assert_eq!(validate_channel("dev\n").unwrap().as_deref(), Some("dev"));
    }

    #[test]
    fn a_channel_that_could_escape_the_home_dir_is_refused() {
        for bad in [
            "..",
            "../etc",
            "a/b",
            "/abs",
            "dev/../..",
            "Dev",
            "dev_1",
            "-dev",
            "dev-",
            "dev name",
            "dev\tx",
        ] {
            let err = validate_channel(bad)
                .expect_err(&format!("{bad:?} must be refused"))
                .to_string();
            assert!(err.contains(CHANNEL_ENV), "error names the variable: {err}");
        }
        let long = "a".repeat(MAX_CHANNEL_LEN + 1);
        assert!(validate_channel(&long).is_err(), "over-long name refused");
    }

    #[test]
    fn dir_for_puts_a_channel_beside_the_release_dir() {
        let home = Path::new("/home/x");
        assert_eq!(dir_for(home, None), home.join(".houston"));
        assert_eq!(
            dir_for(home, Some("dev")),
            home.join(".houston-dev"),
            "sibling dir, so the release dir's retention/checkpoint loops never see it"
        );
    }

    #[test]
    fn log_dir_for_is_channel_aware_and_lives_under_the_state_dir() {
        let home = Path::new("/home/x");
        assert_eq!(log_dir_for(home, None), home.join(".houston").join("logs"));
        assert_eq!(
            log_dir_for(home, Some("dev")),
            home.join(".houston-dev").join("logs"),
            "dev channel logs must sit under the dev state dir, not the release one"
        );
        assert_ne!(log_dir_for(home, None), log_dir_for(home, Some("dev")));
    }
}

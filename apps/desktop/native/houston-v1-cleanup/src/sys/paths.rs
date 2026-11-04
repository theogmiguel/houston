//! The channel directory names the v1 state whose entries the cleanup removes.

use std::path::{Path, PathBuf};

const BASE_DIR: &str = ".houston";
const CHANNEL_ENV: &str = "HOUSTON_CHANNEL";
const MAX_CHANNEL_LEN: usize = 32;

/// `None` means the release channel (`~/.houston`).
pub fn dir_for(home: &Path, channel: Option<&str>) -> PathBuf {
    match channel {
        None => home.join(BASE_DIR),
        Some(name) => home.join(format!("{BASE_DIR}-{name}")),
    }
}

/// Unset, empty and "release" all mean the default channel.
pub fn validate_channel(raw: &str) -> Result<Option<String>, String> {
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
        return Err(format!(
            "{CHANNEL_ENV}={raw:?} is not a valid channel name: expected 1-{MAX_CHANNEL_LEN} \
             characters of [a-z0-9-], not starting or ending with '-'; leave it unset (or use \
             \"release\") for the default {BASE_DIR} directory"
        ));
    }
    Ok(Some(name.to_string()))
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
        assert_eq!(validate_channel(" dev ").unwrap().as_deref(), Some("dev"));
        assert!(validate_channel("dev/../release").is_err());
        assert!(validate_channel("-dev").is_err());
    }

    #[test]
    fn dir_for_puts_a_channel_beside_the_release_dir() {
        let home = Path::new("/home/x");
        assert_eq!(dir_for(home, None), home.join(".houston"));
        assert_eq!(dir_for(home, Some("dev")), home.join(".houston-dev"));
    }
}

//! The Slack app-level token (`xapp-`, Socket Mode) and bot token (`xoxb-`, Web
//! API), in the system keychain only. One service per state directory, so a dev
//! or test daemon's disconnect leaves the installed build's tokens in place.

use anyhow::{anyhow, bail, Result};
use std::path::Path;

use crate::ssh_credentials::Secret;

pub const TOKEN_LEN_MAX: usize = houston_protocol::SLACK_TOKEN_LEN_MAX as usize;

const APP_USER: &str = "app-token";
const BOT_USER: &str = "bot-token";

pub struct Tokens {
    pub app: Secret,
    pub bot: Secret,
}

/// `houston-slack` for the installed state directory, `houston-slack-<channel>`
/// for a channel's, and `houston-slack-dir-<digest>` for any other (a test's or
/// a custom one): only the installed daemon reaches the installed tokens.
pub fn service(state_dir: &Path, channel: Option<&str>) -> String {
    service_in(crate::home_dir::home_dir().as_deref(), state_dir, channel)
}

fn service_in(home: Option<&Path>, state_dir: &Path, channel: Option<&str>) -> String {
    match channel {
        Some(c) => format!("houston-slack-{c}"),
        None if home.is_some_and(|h| crate::paths::dir_for(h, None) == state_dir) => {
            "houston-slack".to_string()
        }
        None => format!(
            "houston-slack-dir-{}",
            crate::paths::short_digest(&state_dir.display().to_string())
        ),
    }
}

fn entry(service: &str, user: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, user).map_err(|e| {
        anyhow!("opening the system keychain entry {user:?} of service {service:?} failed: {e}")
    })
}

/// Refuses an empty, oversized or wrongly prefixed token by naming the limit or
/// the expected prefix and the operation; the value itself is never echoed.
pub fn validate(app: &str, bot: &str) -> Result<()> {
    for (name, value, prefix) in [
        ("app-level token", app, "xapp-"),
        ("bot token", bot, "xoxb-"),
    ] {
        if value.is_empty() {
            bail!("refusing to store an empty Slack {name}; disconnect instead if that is what you meant");
        }
        if value.len() > TOKEN_LEN_MAX {
            bail!(
                "the Slack {name} is {} bytes, over the {TOKEN_LEN_MAX}-byte limit; refusing to store it",
                value.len()
            );
        }
        if !value.starts_with(prefix) {
            bail!("the Slack {name} must start with {prefix:?}; refusing to store it");
        }
    }
    Ok(())
}

pub fn store(service: &str, app: &str, bot: &str) -> Result<()> {
    let (app, bot) = (app.trim(), bot.trim());
    validate(app, bot)?;
    for (user, value) in [(APP_USER, app), (BOT_USER, bot)] {
        entry(service, user)?
            .set_password(value)
            .map_err(|e| anyhow!("storing the Slack {user} in the system keychain failed: {e}"))?;
    }
    match load(service)? {
        Some(t) if t.app.expose() == app && t.bot.expose() == bot => Ok(()),
        Some(_) => bail!("the system keychain read the Slack tokens back as different values; they were not stored"),
        None => bail!("the system keychain read the Slack tokens back as absent; they were not stored"),
    }
}

fn load_one(service: &str, user: &str) -> Result<Option<Secret>> {
    match entry(service, user)?.get_password() {
        Ok(p) => Ok(Some(Secret::new(p))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => bail!("reading the Slack {user} from the system keychain failed: {e}"),
    }
}

/// `Ok(None)` is no tokens; an unreadable keychain or only one of the two
/// tokens is an error, never absence.
pub fn load(service: &str) -> Result<Option<Tokens>> {
    match (load_one(service, APP_USER)?, load_one(service, BOT_USER)?) {
        (Some(app), Some(bot)) => Ok(Some(Tokens { app, bot })),
        (None, None) => Ok(None),
        (Some(_), None) => bail!("the system keychain holds the Slack app-level token but not the bot token (service {service:?}, user {BOT_USER:?}); connect again with both"),
        (None, Some(_)) => bail!("the system keychain holds the Slack bot token but not the app-level token (service {service:?}, user {APP_USER:?}); connect again with both"),
    }
}

pub fn delete(service: &str) -> Result<()> {
    for user in [APP_USER, BOT_USER] {
        match entry(service, user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => bail!("deleting the Slack {user} from the system keychain failed: {e}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static SERIAL: Mutex<()> = Mutex::new(());

    fn use_mock_keychain() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
            keyring_core::set_default_store(
                keyring_core::mock::Store::new().expect("building the mock credential store"),
            );
        });
    }

    #[test]
    fn only_the_installed_state_dir_uses_the_installed_service() {
        let home = Path::new("/home/u");
        let installed = Path::new("/home/u/.houston");
        assert_eq!(service_in(Some(home), installed, None), "houston-slack");
        assert_eq!(
            service_in(Some(home), Path::new("/home/u/.houston-dev"), Some("dev")),
            "houston-slack-dev"
        );
        let other = service_in(Some(home), Path::new("/tmp/.tmpAbc"), None);
        assert!(other.starts_with("houston-slack-dir-"), "{other}");
        assert_ne!(service_in(None, installed, None), "houston-slack");
    }

    #[test]
    fn tokens_round_trip_and_disconnect_removes_both() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let service = "houston-slack-unit-round-trip";
        delete(service).unwrap();
        assert!(load(service).unwrap().is_none());

        store(service, " xapp-1-A ", "xoxb-1-b").unwrap();
        let got = load(service).unwrap().expect("stored");
        assert_eq!(got.app.expose(), "xapp-1-A", "tokens are stored trimmed");
        assert_eq!(got.bot.expose(), "xoxb-1-b");

        delete(service).unwrap();
        assert!(load(service).unwrap().is_none());
        delete(service).expect("deleting nothing is not an error");
    }

    #[test]
    fn one_token_alone_is_an_error_not_absence() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let service = "houston-slack-unit-half";
        delete(service).unwrap();
        entry(service, BOT_USER)
            .unwrap()
            .set_password("xoxb-1")
            .unwrap();
        let err = load(service).err().expect("half a pair").to_string();
        assert!(err.contains("not the app-level token"), "{err}");
        delete(service).unwrap();
    }

    #[test]
    fn wrong_prefix_empty_and_oversized_tokens_are_refused_without_the_value() {
        assert!(validate("", "xoxb-1")
            .unwrap_err()
            .to_string()
            .contains("empty"));
        let err = validate("xoxb-swapped", "xoxb-1").unwrap_err().to_string();
        assert!(err.contains("\"xapp-\""), "{err}");
        assert!(!err.contains("swapped"), "{err}");
        let long = format!("xapp-{}", "s".repeat(TOKEN_LEN_MAX));
        let err = validate(&long, "xoxb-1").unwrap_err().to_string();
        assert!(
            err.contains(&format!("{TOKEN_LEN_MAX}-byte limit")),
            "{err}"
        );
        assert!(!err.contains(&long), "{err}");
    }
}

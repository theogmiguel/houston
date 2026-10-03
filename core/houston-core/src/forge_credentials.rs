//! The Bitbucket Cloud API token, kept in the system keychain only. One entry
//! per state directory, so disconnecting a development or test daemon leaves
//! the installed build's token in place.

use anyhow::{anyhow, bail, Result};
use std::path::Path;
use zeroize::Zeroizing;

use crate::pull_requests::bitbucket::Credentials;

pub const BITBUCKET_EMAIL_LEN_MAX: usize = houston_protocol::BITBUCKET_EMAIL_LEN_MAX as usize;
pub const BITBUCKET_TOKEN_LEN_MAX: usize = houston_protocol::BITBUCKET_TOKEN_LEN_MAX as usize;

const USER: &str = "bitbucket-cloud";

/// `houston-forge` for the installed state directory, `houston-forge-<channel>`
/// for a channel's, and `houston-forge-dir-<digest>` for any other (a test's or
/// a custom one): only the installed daemon reaches the installed token.
pub fn service(state_dir: &Path, channel: Option<&str>) -> String {
    service_in(crate::home_dir::home_dir().as_deref(), state_dir, channel)
}

fn service_in(home: Option<&Path>, state_dir: &Path, channel: Option<&str>) -> String {
    match channel {
        Some(c) => format!("houston-forge-{c}"),
        None if home.is_some_and(|h| crate::paths::dir_for(h, None) == state_dir) => {
            "houston-forge".to_string()
        }
        None => format!(
            "houston-forge-dir-{}",
            crate::paths::short_digest(&state_dir.display().to_string())
        ),
    }
}

fn entry(service: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, USER).map_err(|e| {
        anyhow!("opening the system keychain entry {USER:?} of service {service:?} failed: {e}")
    })
}

/// Refuses an empty or oversized value by naming the limit, the length and the
/// operation; the value itself is never echoed.
pub fn validate(email: &str, token: &str) -> Result<()> {
    let email = email.trim();
    if email.is_empty() {
        bail!("refusing to store a Bitbucket API token without the Atlassian account e-mail it belongs to");
    }
    if token.is_empty() {
        bail!("refusing to store an empty Bitbucket API token; disconnect instead if that is what you meant");
    }
    if email.len() > BITBUCKET_EMAIL_LEN_MAX {
        bail!(
            "the Atlassian e-mail is {} bytes, over the {BITBUCKET_EMAIL_LEN_MAX}-byte limit; refusing to store the Bitbucket API token",
            email.len()
        );
    }
    if token.len() > BITBUCKET_TOKEN_LEN_MAX {
        bail!(
            "the Bitbucket API token is {} bytes, over the {BITBUCKET_TOKEN_LEN_MAX}-byte limit; refusing to store it",
            token.len()
        );
    }
    Ok(())
}

pub fn store(service: &str, email: &str, token: &str) -> Result<()> {
    validate(email, token)?;
    let email = email.trim();
    let payload = Zeroizing::new(serde_json::json!({ "email": email, "token": token }).to_string());
    entry(service)?.set_password(&payload).map_err(|e| {
        anyhow!("storing the Bitbucket API token in the system keychain failed: {e}")
    })?;
    match load(service)? {
        Some(c) if c.email == email && *c.token == token => Ok(()),
        Some(_) => bail!("the system keychain read the Bitbucket API token back as a different value; it was not stored"),
        None => bail!("the system keychain read the Bitbucket API token back as absent; it was not stored"),
    }
}

/// `Ok(None)` is no token; an unreadable keychain is an error, never absence.
pub fn load(service: &str) -> Result<Option<Credentials>> {
    let raw = match entry(service)?.get_password() {
        Ok(p) => Zeroizing::new(p),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => bail!("reading the Bitbucket API token from the system keychain failed: {e}"),
    };
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        anyhow!("the keychain entry for the Bitbucket API token is not the expected {{email, token}} JSON; disconnect and add the token again")
    })?;
    let field = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
    match (field("email"), field("token")) {
        (Some(email), Some(token)) => Ok(Some(Credentials {
            email,
            token: Zeroizing::new(token),
        })),
        _ => bail!("the keychain entry for the Bitbucket API token lacks an email or token field; disconnect and add the token again"),
    }
}

pub fn delete(service: &str) -> Result<()> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => bail!("deleting the Bitbucket API token from the system keychain failed: {e}"),
    }
}

/// Why the keychain cannot be used at all, as opposed to holding no token.
pub fn keyring_error(service: &str) -> Option<String> {
    let probe = keyring::Entry::new(service, "__tr_probe__")
        .map_err(|e| e.to_string())
        .and_then(|e| match e.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        });
    probe.err()
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
        assert_eq!(service_in(Some(home), installed, None), "houston-forge");
        assert_eq!(
            service_in(Some(home), Path::new("/home/u/.houston-dev"), Some("dev")),
            "houston-forge-dev"
        );
        for other in [
            "/tmp/.tmpAbc",
            "/home/u/custom-state",
            "/home/u/.houston-release",
        ] {
            let got = service_in(Some(home), Path::new(other), None);
            assert!(got.starts_with("houston-forge-dir-"), "{other}: {got}");
        }
        assert_ne!(
            service_in(Some(home), Path::new("/tmp/a"), None),
            service_in(Some(home), Path::new("/tmp/b"), None)
        );
        assert_ne!(service_in(None, installed, None), "houston-forge");
    }

    #[test]
    fn a_token_round_trips_and_disconnect_removes_it() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let service = "houston-forge-unit-round-trip";
        delete(service).unwrap();
        assert!(load(service).unwrap().is_none());

        store(service, " me@example.com ", "tok-1").unwrap();
        let got = load(service).unwrap().expect("stored");
        assert_eq!(got.email, "me@example.com", "the e-mail is stored trimmed");
        assert_eq!(*got.token, "tok-1");

        store(service, "me@example.com", "tok-2").unwrap();
        assert_eq!(*load(service).unwrap().unwrap().token, "tok-2");

        delete(service).unwrap();
        assert!(load(service).unwrap().is_none());
        delete(service).expect("deleting nothing is not an error");
    }

    #[test]
    fn empty_and_oversized_values_are_refused_by_limit_without_the_value() {
        assert!(validate("", "t")
            .unwrap_err()
            .to_string()
            .contains("e-mail"));
        assert!(validate("a@b", "")
            .unwrap_err()
            .to_string()
            .contains("empty"));

        let long_email = format!("{}@example.com", "e".repeat(BITBUCKET_EMAIL_LEN_MAX));
        let err = validate(&long_email, "t").unwrap_err().to_string();
        assert!(err.contains("254-byte limit"), "{err}");
        assert!(err.contains(&long_email.len().to_string()), "{err}");
        assert!(!err.contains(&long_email), "{err}");

        let long_token = "s".repeat(BITBUCKET_TOKEN_LEN_MAX + 1);
        let err = validate("a@b", &long_token).unwrap_err().to_string();
        assert!(err.contains("1024-byte limit"), "{err}");
        assert!(err.contains("1025 bytes"), "{err}");
        assert!(!err.contains(&long_token), "{err}");
        assert!(validate("a@b", &"s".repeat(BITBUCKET_TOKEN_LEN_MAX)).is_ok());
    }

    #[test]
    fn a_malformed_entry_is_an_error_not_an_absent_token() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let service = "houston-forge-unit-malformed";
        entry(service).unwrap().set_password("not json").unwrap();
        let err = load(service)
            .err()
            .expect("unreadable is an error")
            .to_string();
        assert!(err.contains("{email, token}"), "{err}");
        assert!(
            !err.contains("not json"),
            "the stored value is never echoed: {err}"
        );
        delete(service).unwrap();
    }

    #[test]
    fn a_keychain_that_fails_is_unreadable_not_empty() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use_mock_keychain();
        let service = "houston-forge-unit-failing";
        let e = entry(service).unwrap();
        e.set_password("{}").unwrap();
        let mock: &keyring_core::mock::Cred = e
            .inner
            .as_any()
            .downcast_ref()
            .expect("the mock store builds mock credentials");
        mock.set_error(keyring::Error::PlatformFailure("locked".into()));
        let err = load(service).err().expect("a failing keychain is an error");
        assert!(err.to_string().contains("locked"), "{err}");
    }
}

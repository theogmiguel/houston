//! SSH password/passphrase storage. The system keychain is the only store: a
//! profile row holds a reference (a profile name), never a credential, so copying
//! or backing up the database never carries a secret with it.

use anyhow::{Context, Result};
use zeroize::Zeroizing;

const SERVICE: &str = "houston-ssh";

/// A secret in memory, wrapped so it cannot be logged by accident: no `Debug`,
/// `Display` or `Serialize`, so a `{:?}` will not compile rather than print it,
/// and the buffer zeroizes on drop rather than lingering in freed memory.
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(Zeroizing::new(s))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn entry(profile: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, profile).with_context(|| {
        format!(
            "opening the system keychain for ssh profile {profile:?} \
             (service {SERVICE:?}) failed"
        )
    })
}

pub fn store(profile: &str, secret: &Secret) -> Result<()> {
    anyhow::ensure!(
        !profile.trim().is_empty(),
        "an ssh credential needs a profile name to be stored under (got an empty name)"
    );
    anyhow::ensure!(
        !secret.is_empty(),
        "refusing to store an empty ssh credential for profile {profile:?} — \
         clear the stored password instead if that is what you meant"
    );
    entry(profile)?
        .set_password(secret.expose())
        .with_context(|| format!("storing the ssh credential for profile {profile:?}"))
}

pub fn load(profile: &str) -> Result<Option<Secret>> {
    match entry(profile)?.get_password() {
        Ok(p) => Ok(Some(Secret::new(p))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::Error::new(e))
            .with_context(|| format!("reading the ssh credential for profile {profile:?}")),
    }
}

pub fn delete(profile: &str) -> Result<()> {
    match entry(profile)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::Error::new(e))
            .with_context(|| format!("deleting the ssh credential for profile {profile:?}")),
    }
}

pub fn has_credential(profile: &str) -> bool {
    matches!(load(profile), Ok(Some(_)))
}

/// Why a credential lookup came back empty. The badge cannot tell "no password
/// saved" from "the keyring is asleep", and those mean very different things to a
/// user; probed once per profile-list build since the answer is the session bus's.
pub fn keyring_error() -> Option<String> {
    match entry("__tr_probe__").and_then(|e| match e.get_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::Error::new(e)),
    }) {
        Ok(()) => None,
        Err(e) => Some(format!("{e:#}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_cannot_be_formatted_into_a_log() {
        let s = Secret::new("hunter2".into());
        assert_eq!(s.expose(), "hunter2");
        assert!(!s.is_empty());
    }

    #[test]
    fn refuses_to_store_an_empty_credential() {
        let err = store("tr-test-empty", &Secret::new(String::new())).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("tr-test-empty"), "{msg}");
        assert!(msg.contains("empty"), "{msg}");
    }

    #[test]
    fn refuses_an_unnamed_profile() {
        let err = store("  ", &Secret::new("x".into())).unwrap_err();
        assert!(err.to_string().contains("profile name"), "{err}");
    }
}

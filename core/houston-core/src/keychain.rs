//! Keychain services scoped per state directory, so a development or test daemon
//! never reads or replaces the installed daemon's secrets.

use std::path::Path;

use crate::remote::hash_secret;

/// `<prefix>-<digest of the state directory>`: one service per state directory.
pub fn scoped_service(prefix: &str, state_dir: &Path) -> String {
    let digest = hash_secret(&state_dir.to_string_lossy());
    format!("{prefix}-{}", &digest[..16])
}

/// A secret the installed release channel stored under a fixed service before
/// services were scoped. Only the installed state directory (`~/.houston`) may
/// read it, so a dev or test daemon never picks up the release channel's key.
pub struct Legacy {
    pub service: &'static str,
}

impl Legacy {
    fn applies_to(&self, state_dir: &Path) -> bool {
        self.applies_in(
            crate::host_env::HostEnv::capture().home_dir().as_deref(),
            state_dir,
        )
    }

    fn applies_in(&self, home: Option<&Path>, state_dir: &Path) -> bool {
        home.is_some_and(|h| crate::paths::dir_for(h, None) == state_dir)
    }

    /// Reads `user` from `scoped`; when it is absent and `state_dir` is the
    /// installed one, copies the legacy entry into `scoped` first. The legacy
    /// entry stays in place, so rolling back to an older build still finds it.
    pub fn load(
        &self,
        scoped: &keyring::Entry,
        state_dir: &Path,
        user: &str,
    ) -> keyring::Result<Option<String>> {
        self.load_if(scoped, self.applies_to(state_dir), user)
    }

    fn load_if(
        &self,
        scoped: &keyring::Entry,
        migrate: bool,
        user: &str,
    ) -> keyring::Result<Option<String>> {
        match scoped.get_password() {
            Ok(p) => return Ok(Some(p)),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e),
        }
        if !migrate {
            return Ok(None);
        }
        match keyring::Entry::new(self.service, user)?.get_password() {
            Ok(p) => {
                scoped.set_password(&p)?;
                Ok(Some(p))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Removes `user` from `scoped` and, for the installed state directory, the
    /// legacy entry too: an explicit clear must not be undone by the next load
    /// copying the legacy entry back.
    pub fn delete(
        &self,
        scoped: &keyring::Entry,
        state_dir: &Path,
        user: &str,
    ) -> keyring::Result<()> {
        self.delete_if(scoped, self.applies_to(state_dir), user)
    }

    fn delete_if(&self, scoped: &keyring::Entry, legacy: bool, user: &str) -> keyring::Result<()> {
        let ignore_absent = |r: keyring::Result<()>| match r {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        };
        ignore_absent(scoped.delete_credential())?;
        if legacy {
            ignore_absent(keyring::Entry::new(self.service, user)?.delete_credential())?;
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn use_mock_keychain() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = keyring::Entry::new("__tr_mock_priming__", "__tr_mock_priming__");
        keyring_core::set_default_store(
            keyring_core::mock::Store::new().expect("building the mock credential store"),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: Legacy = Legacy {
        service: "__tr_legacy_test__",
    };

    #[test]
    fn two_state_directories_resolve_to_different_services() {
        let a = scoped_service("houston-voice", Path::new("/home/u/.houston"));
        let b = scoped_service("houston-voice", Path::new("/home/u/.houston-dev"));
        assert_ne!(a, b);
        assert_ne!(
            a, "houston-voice",
            "the fixed legacy service is never reused"
        );
        assert_eq!(
            a,
            scoped_service("houston-voice", Path::new("/home/u/.houston"))
        );
    }

    #[test]
    fn only_the_installed_state_directory_reads_the_legacy_service() {
        let home = Path::new("/home/u");
        assert!(LEGACY.applies_in(Some(home), &home.join(".houston")));
        assert!(!LEGACY.applies_in(Some(home), &home.join(".houston-dev")));
        assert!(!LEGACY.applies_in(Some(home), Path::new("/tmp/throwaway/.houston")));
        assert!(!LEGACY.applies_in(None, &home.join(".houston")));
    }

    #[test]
    fn the_installed_directory_copies_the_legacy_entry_and_keeps_it() {
        use_mock_keychain();
        let user = "migrate-installed";
        let legacy = keyring::Entry::new(LEGACY.service, user).unwrap();
        legacy.set_password("secret-1").unwrap();
        let scoped = keyring::Entry::new("__tr_scoped_installed__", user).unwrap();

        assert_eq!(
            LEGACY.load_if(&scoped, true, user).unwrap().as_deref(),
            Some("secret-1")
        );
        assert_eq!(
            scoped.get_password().unwrap(),
            "secret-1",
            "copied into the scoped service"
        );
        assert_eq!(
            legacy.get_password().unwrap(),
            "secret-1",
            "the legacy entry stays"
        );

        LEGACY.delete_if(&scoped, true, user).unwrap();
        assert!(matches!(
            legacy.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(
            LEGACY.load_if(&scoped, true, user).unwrap(),
            None,
            "a clear stays cleared"
        );
    }

    #[test]
    fn another_state_directory_never_sees_the_legacy_entry() {
        use_mock_keychain();
        let user = "migrate-other";
        keyring::Entry::new(LEGACY.service, user)
            .unwrap()
            .set_password("release-secret")
            .unwrap();
        let scoped = keyring::Entry::new("__tr_scoped_other__", user).unwrap();

        assert_eq!(LEGACY.load_if(&scoped, false, user).unwrap(), None);
        assert!(matches!(
            scoped.get_password(),
            Err(keyring::Error::NoEntry)
        ));
        LEGACY.delete_if(&scoped, false, user).unwrap();
        assert_eq!(
            keyring::Entry::new(LEGACY.service, user)
                .unwrap()
                .get_password()
                .unwrap(),
            "release-secret",
            "a non-installed daemon's clear leaves the release entry alone"
        );
    }
}

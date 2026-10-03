//! The Bitbucket Cloud reader's setting and token, and the context the
//! pull-request reads take from them.

use anyhow::{bail, Result};
use houston_protocol as proto;

use super::Daemon;
use crate::forge::ForgeContext;
use crate::forge_credentials;

const BITBUCKET_ENABLED_KEY: &str = "forge.bitbucket.enabled";

impl Daemon {
    pub fn forge_context(&self) -> ForgeContext {
        ForgeContext {
            bitbucket_enabled: self.bitbucket_enabled(),
            bitbucket_api_base: self
                .bitbucket_api_base
                .lock()
                .expect("bitbucket api base lock")
                .clone(),
            keychain_service: self.forge_keychain_service(),
        }
    }

    fn forge_keychain_service(&self) -> String {
        forge_credentials::service(&self.state_dir, self.channel())
    }

    fn bitbucket_enabled(&self) -> bool {
        matches!(self.db.get_setting(BITBUCKET_ENABLED_KEY), Ok(Some(v)) if v == "true")
    }

    pub fn bitbucket_enabled_set(&self, enabled: bool) -> Result<()> {
        self.db.set_setting(
            BITBUCKET_ENABLED_KEY,
            if enabled { "true" } else { "false" },
        )
    }

    pub fn bitbucket_token_set(&self, email: &str, token: &str) -> Result<()> {
        let service = self.forge_keychain_service();
        tracing::info!("storing the Bitbucket API token under keychain service {service:?}");
        forge_credentials::store(&service, email, token)
    }

    pub fn bitbucket_token_clear(&self) -> Result<()> {
        forge_credentials::delete(&self.forge_keychain_service())
    }

    /// The current setting and which account a token is stored for; the token
    /// itself never leaves the keychain through here.
    pub fn forge_settings_reply(&self) -> proto::ServerMsg {
        let service = self.forge_keychain_service();
        let keyring_error = forge_credentials::keyring_error(&service);
        let account = forge_credentials::load(&service)
            .ok()
            .flatten()
            .map(|c| c.email);
        proto::ServerMsg::ForgeSettings {
            bitbucket_enabled: self.bitbucket_enabled(),
            bitbucket_account: account,
            keyring_error,
        }
    }

    /// Points the Bitbucket reader at a local fixture server; anything but a
    /// loopback `http://` base is refused, so a test cannot reach the network.
    #[doc(hidden)]
    pub fn set_bitbucket_api_base_for_test(&self, base: &str) -> Result<()> {
        let Some(rest) = base.strip_prefix("http://") else {
            bail!("test API base {base:?} is not http://; expected a loopback fixture server");
        };
        let host = rest.split(['/', ':']).next().unwrap_or_default();
        if !matches!(host, "127.0.0.1" | "localhost") {
            bail!("test API base {base:?} is not loopback; expected 127.0.0.1 or localhost");
        }
        *self
            .bitbucket_api_base
            .lock()
            .expect("bitbucket api base lock") = base.to_string();
        Ok(())
    }
}

//! The saved-environment catalog, including bearer tokens, in the OS keychain.

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::v2_server::V2Host;

const SERVICE_PREFIX: &str = "houston-v2-catalog";
const PROFILE: &str = "connection-catalog";
// Keychain backends vary; a catalog with hundreds of environments still fits well below this.
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;

pub trait CatalogStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
}

pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(base_dir: &Path) -> Self {
        Self {
            service: crate::sys::keychain::scoped_service(SERVICE_PREFIX, base_dir),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, PROFILE).map_err(|e| {
            format!(
                "opening the system keychain for the saved environment catalog \
                 (service {:?}) failed: {e}",
                self.service
            )
        })
    }
}

impl CatalogStore for KeychainStore {
    fn read(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!(
                "reading the saved environment catalog from the system keychain \
                 (service {:?}) failed: {e}",
                self.service
            )),
        }
    }

    fn write(&self, value: &str) -> Result<(), String> {
        self.entry()?.set_password(value).map_err(|e| {
            format!(
                "saving the environment catalog to the system keychain (service {:?}) failed: {e}",
                self.service
            )
        })
    }
}

pub fn read_catalog(store: &impl CatalogStore) -> Result<Option<String>, String> {
    store.read()
}

pub fn write_catalog(store: &impl CatalogStore, value: &str) -> Result<(), String> {
    if value.len() > MAX_CATALOG_BYTES {
        return Err(format!(
            "refusing to save the environment catalog: {} bytes exceeds the {MAX_CATALOG_BYTES} \
             byte keychain limit",
            value.len()
        ));
    }
    store.write(value)
}

#[tauri::command]
pub fn v2_get_connection_catalog(host: State<'_, Arc<V2Host>>) -> Result<Option<String>, String> {
    read_catalog(&KeychainStore::new(host.base_dir()))
}

#[tauri::command]
pub fn v2_set_connection_catalog(
    host: State<'_, Arc<V2Host>>,
    catalog: String,
) -> Result<bool, String> {
    write_catalog(&KeychainStore::new(host.base_dir()), &catalog)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore {
        value: Mutex<Option<String>>,
    }

    impl CatalogStore for MemoryStore {
        fn read(&self) -> Result<Option<String>, String> {
            Ok(self.value.lock().expect("memory store").clone())
        }

        fn write(&self, value: &str) -> Result<(), String> {
            *self.value.lock().expect("memory store") = Some(value.to_string());
            Ok(())
        }
    }

    #[test]
    fn a_saved_catalog_round_trips_through_the_store() {
        let store = MemoryStore::default();
        assert_eq!(read_catalog(&store).unwrap(), None);
        write_catalog(&store, "{\"targets\":[]}").unwrap();
        assert_eq!(
            read_catalog(&store).unwrap().as_deref(),
            Some("{\"targets\":[]}")
        );
    }

    #[test]
    fn an_oversized_catalog_is_refused_with_the_limit_and_actual_size() {
        let store = MemoryStore::default();
        let oversized = "x".repeat(MAX_CATALOG_BYTES + 1);
        let error = write_catalog(&store, &oversized).expect_err("oversized catalog refused");
        assert!(error.contains(&MAX_CATALOG_BYTES.to_string()), "{error}");
        assert!(
            error.contains(&(MAX_CATALOG_BYTES + 1).to_string()),
            "{error}"
        );
        assert_eq!(read_catalog(&store).unwrap(), None);
    }
}

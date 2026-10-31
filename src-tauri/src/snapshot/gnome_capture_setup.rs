//! GNOME Shell extension state and enable/disable. Mirrors upstream
//! `GnomeCaptureSetup.ts`. Houston does not bundle the extension yet, so
//! installation reports that instead of writing into the user's session.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedValue;

pub const GNOME_CAPTURE_UUID: &str = "t3-snap-shot@t3tools";
const SHELL: &str = "org.gnome.Shell";
const SHELL_PATH: &str = "/org/gnome/Shell";
const EXTENSIONS: &str = "org.gnome.Shell.Extensions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureExtensionState {
    pub status: String,
    pub message: String,
}

fn state(status: &str, message: &str) -> CaptureExtensionState {
    CaptureExtensionState {
        status: status.to_string(),
        message: message.to_string(),
    }
}

pub struct GnomeCaptureSetup {
    bundle: PathBuf,
    data_home: PathBuf,
}

impl GnomeCaptureSetup {
    pub fn new(bundle: PathBuf, data_home: PathBuf) -> Self {
        Self { bundle, data_home }
    }

    pub fn state(&self) -> CaptureExtensionState {
        if !self.bundle.join("metadata.json").is_file() {
            return state(
                "unsupported",
                "This Houston build does not bundle the GNOME capture extension.",
            );
        }
        match self.query() {
            Ok(result) => result,
            Err(error) => state("error", &error),
        }
    }

    fn query(&self) -> Result<CaptureExtensionState, String> {
        let connection = Connection::session()
            .map_err(|error| format!("Could not connect to GNOME: {error}"))?;
        let properties = Proxy::new(
            &connection,
            SHELL,
            SHELL_PATH,
            "org.freedesktop.DBus.Properties",
        )
        .map_err(|error| format!("GNOME properties: {error}"))?;
        let all: HashMap<String, OwnedValue> = properties
            .call("GetAll", &(EXTENSIONS,))
            .map_err(|error| format!("GNOME did not respond: {error}"))?;
        let shell_version = all
            .get("ShellVersion")
            .cloned()
            .and_then(|value| String::try_from(value).ok())
            .ok_or_else(|| "GNOME returned no shell version.".to_string())?;
        let extensions_enabled = all
            .get("UserExtensionsEnabled")
            .cloned()
            .and_then(|value| bool::try_from(value).ok())
            .unwrap_or(false);
        let major = shell_version.split('.').next().unwrap_or("0");
        let metadata = std::fs::read_to_string(self.bundle.join("metadata.json"))
            .map_err(|error| format!("reading the bundled extension metadata: {error}"))?;
        let metadata: serde_json::Value = serde_json::from_str(&metadata)
            .map_err(|error| format!("parsing the bundled extension metadata: {error}"))?;
        let supported = metadata
            .get("shell-version")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|versions| {
                versions
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .any(|version| version == major)
            });
        if !supported {
            return Ok(state(
                "unsupported",
                &format!(
                    "The bundled extension does not support GNOME {major}. Use the screenshot picker instead."
                ),
            ));
        }
        let installed = std::fs::read_to_string(
            self.data_home
                .join("gnome-shell/extensions")
                .join(GNOME_CAPTURE_UUID)
                .join("metadata.json"),
        )
        .ok();
        let info = self.extension_info(&connection);
        if info.is_none() && installed.is_none() {
            return Ok(state(
                "not-installed",
                "Install the bundled extension to capture the active window without a picker.",
            ));
        }
        if !extensions_enabled {
            return Ok(state(
                "extensions-disabled",
                "GNOME has disabled user extensions. Turn on Extensions in the GNOME Extensions app, then check again.",
            ));
        }
        match info.and_then(|info| info.state) {
            Some(1) => Ok(state(
                "enabled",
                "The Houston extension is running. Active-window snapshots are available.",
            )),
            Some(3 | 4) => Ok(state(
                "error",
                "GNOME could not load the extension. Check GNOME Extensions for details, or sign out and back in.",
            )),
            Some(_) => Ok(state(
                "disabled",
                "Enable the Houston extension to allow active-window snapshots.",
            )),
            None => Ok(state(
                "restart-required",
                "Installed. Save your work, sign out of GNOME and sign back in, then return here to enable the extension.",
            )),
        }
    }

    fn extension_info(&self, connection: &Connection) -> Option<ExtensionInfo> {
        let proxy = Proxy::new(connection, SHELL, SHELL_PATH, EXTENSIONS).ok()?;
        let info: HashMap<String, OwnedValue> = proxy
            .call("GetExtensionInfo", &(GNOME_CAPTURE_UUID,))
            .ok()?;
        Some(ExtensionInfo {
            state: info
                .get("state")
                .cloned()
                .and_then(|value| u32::try_from(value).ok()),
        })
    }

    pub fn perform(&self, action: &str) -> Result<(), String> {
        match action {
            "install-extension" => {
                if !self.bundle.join("metadata.json").is_file() {
                    return Err(
                        "This Houston build does not bundle the GNOME capture extension."
                            .to_string(),
                    );
                }
                Err("Installing the bundled GNOME extension is not available yet.".to_string())
            }
            "enable-extension" | "disable-extension" => {
                let connection = Connection::session()
                    .map_err(|error| format!("Could not connect to GNOME: {error}"))?;
                let proxy = Proxy::new(&connection, SHELL, SHELL_PATH, EXTENSIONS)
                    .map_err(|error| format!("GNOME extensions: {error}"))?;
                let member = if action == "enable-extension" {
                    "EnableExtension"
                } else {
                    "DisableExtension"
                };
                let enabled: bool = proxy
                    .call(member, &(GNOME_CAPTURE_UUID,))
                    .map_err(|error| format!("GNOME did not change the extension: {error}"))?;
                if action == "enable-extension" && !enabled {
                    return Err(
                        "GNOME has not loaded the extension. Sign out and back in, then try again."
                            .to_string(),
                    );
                }
                Ok(())
            }
            other => Err(format!(
                "unknown GNOME capture setup action {other:?}; expected install-extension, enable-extension or disable-extension"
            )),
        }
    }
}

struct ExtensionInfo {
    state: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_bundle_reports_unsupported_without_touching_the_session() {
        let setup = GnomeCaptureSetup::new(
            PathBuf::from("/nonexistent/houston/gnome-extension"),
            PathBuf::from("/nonexistent/data"),
        );
        let state = setup.state();
        assert_eq!(state.status, "unsupported");
        assert!(state.message.contains("does not bundle"));
    }
}

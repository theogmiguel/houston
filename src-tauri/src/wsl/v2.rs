//! The v2 bridge's WSL state; distro enumeration reuses the `wsl.exe` helpers.
//! The server still starts on the host, so enabling the WSL backend is refused
//! by name while the distro and WSL-only selections persist.

use serde_json::{json, Value};

use crate::v2_server::{DesktopSettings, V2Host};

use super::command::{self, WSL_EXE};
use super::distros::{is_utility, parse_list};
use super::NOT_WINDOWS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2Distro {
    pub name: String,
    pub version: u8,
    pub default: bool,
}

impl V2Distro {
    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "isDefault": self.default,
            "version": self.version,
        })
    }
}

/// `wsl.exe -l -v`, minus container-engine utility distros and anything that
/// is neither WSL 1 nor WSL 2.
pub fn parse_distros(raw: &str) -> Vec<V2Distro> {
    parse_list(raw)
        .into_iter()
        .filter(|distro| !is_utility(&distro.name))
        .filter(|distro| distro.version == 1 || distro.version == 2)
        .map(|distro| V2Distro {
            name: distro.name,
            version: distro.version,
            default: distro.default,
        })
        .collect()
}

async fn list_distros_async() -> Result<Vec<V2Distro>, String> {
    tokio::task::spawn_blocking(list_distros)
        .await
        .map_err(|e| format!("the WSL distro list task stopped unexpectedly: {e}"))?
}

fn list_distros() -> Result<Vec<V2Distro>, String> {
    if !cfg!(windows) {
        return Err(NOT_WINDOWS.to_string());
    }
    let output = crate::sys::spawn::command(WSL_EXE)
        .args(command::list())
        .env("WSL_UTF8", "1")
        .output()
        .map_err(|e| {
            format!(
                "{} could not be started: {e}",
                command::describe(&command::list())
            )
        })?;
    if !output.status.success() {
        let out = command::RunOutput {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        };
        return Err(command::failure(&command::list(), &out, true));
    }
    Ok(parse_distros(&String::from_utf8_lossy(&output.stdout)))
}

fn resolve_distro<'a>(settings: &DesktopSettings, distros: &'a [V2Distro]) -> Option<&'a V2Distro> {
    let wanted = settings.wsl_distro.as_deref();
    distros.iter().find(|distro| match wanted {
        Some(name) => distro.name.eq_ignore_ascii_case(name),
        None => distro.default,
    })
}

pub fn describe_state(settings: &DesktopSettings, distros: Result<Vec<V2Distro>, String>) -> Value {
    let available = distros.is_ok();
    let found = distros.unwrap_or_default();
    let resolved = resolve_distro(settings, &found);
    let preflight_error = if !settings.wsl_enabled || settings.wsl_only {
        None
    } else {
        match resolved {
            None => Some(format!(
                "the selected WSL distro {:?} is not installed; wsl.exe -l -v lists: {}",
                settings.wsl_distro.as_deref().unwrap_or("<default>"),
                found
                    .iter()
                    .map(|distro| distro.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            Some(distro) if distro.version == 1 => Some(format!(
                "{} runs under WSL 1; Houston needs WSL 2",
                distro.name
            )),
            Some(_) => None,
        }
    };
    json!({
        "enabled": settings.wsl_enabled,
        "distro": settings.wsl_distro,
        "available": available,
        "wslOnly": settings.wsl_only,
        "distros": found.iter().map(V2Distro::to_json).collect::<Vec<_>>(),
        "preflightError": preflight_error,
    })
}

async fn current_state(host: &V2Host) -> Value {
    describe_state(&host.settings(), list_distros_async().await)
}

fn unsupported_state() -> Value {
    json!({
        "enabled": false,
        "distro": Value::Null,
        "available": false,
        "wslOnly": false,
        "distros": [],
        "preflightError": Value::Null,
    })
}

#[tauri::command]
pub async fn v2_wsl_state(host: tauri::State<'_, std::sync::Arc<V2Host>>) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(unsupported_state());
    }
    let host = std::sync::Arc::clone(&host);
    Ok(current_state(&host).await)
}

#[tauri::command]
pub async fn v2_wsl_set_enabled(
    enabled: bool,
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(unsupported_state());
    }
    let host = std::sync::Arc::clone(&host);
    let mut settings = host.settings();
    if enabled {
        let distros = list_distros_async().await?;
        let distro = resolve_distro(&settings, &distros).ok_or_else(|| {
            format!(
                "cannot enable the WSL backend: the selected distro {:?} is not installed; \
                 wsl.exe -l -v lists: {}",
                settings.wsl_distro.as_deref().unwrap_or("<default>"),
                distros
                    .iter()
                    .map(|distro| distro.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
        if distro.version == 1 {
            return Err(format!(
                "cannot enable {} as the WSL backend: it runs under WSL 1 and Houston needs WSL 2",
                distro.name
            ));
        }
        return Err(
            "the WSL backend is not available yet: Houston must start its server inside the \
             distro, which the server-side WSL slice owns. The distro and WSL-only selections \
             were saved."
                .to_string(),
        );
    }
    settings.wsl_enabled = false;
    host.update_settings(settings)?;
    Ok(current_state(&host).await)
}

#[tauri::command]
pub async fn v2_wsl_set_distro(
    distro: Option<String>,
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(unsupported_state());
    }
    let host = std::sync::Arc::clone(&host);
    if let Some(name) = distro.as_deref() {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("WSL distro must name a distro, got an empty string".to_string());
        }
        let distros = list_distros_async().await?;
        if !distros
            .iter()
            .any(|distro| distro.name.eq_ignore_ascii_case(trimmed))
        {
            return Err(format!(
                "no WSL distro named {trimmed:?}; wsl.exe -l -v lists: {}",
                distros
                    .iter()
                    .map(|distro| distro.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    let mut settings = host.settings();
    settings.wsl_distro = distro;
    host.update_settings(settings)?;
    Ok(current_state(&host).await)
}

#[tauri::command]
pub async fn v2_wsl_set_only(
    enabled: bool,
    host: tauri::State<'_, std::sync::Arc<V2Host>>,
) -> Result<Value, String> {
    if !cfg!(windows) {
        return Ok(unsupported_state());
    }
    let host = std::sync::Arc::clone(&host);
    let mut settings = host.settings();
    settings.wsl_only = enabled;
    host.update_settings(settings)?;
    Ok(current_state(&host).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "  NAME            STATE           VERSION\n* Ubuntu-24.04    Running         2\n  Debian          Stopped         2\n  Alpine          Stopped         1\n  docker-desktop  Stopped         2\n";

    #[test]
    fn parses_and_filters_wsl_distros() {
        let distros = parse_distros(LIST);
        assert_eq!(
            distros,
            vec![
                V2Distro {
                    name: "Ubuntu-24.04".into(),
                    version: 2,
                    default: true
                },
                V2Distro {
                    name: "Debian".into(),
                    version: 2,
                    default: false
                },
                V2Distro {
                    name: "Alpine".into(),
                    version: 1,
                    default: false
                }
            ]
        );
    }

    #[test]
    fn state_reports_distros_and_resolves_the_default() {
        let settings = DesktopSettings {
            wsl_enabled: true,
            ..DesktopSettings::default()
        };
        let state = describe_state(&settings, Ok(parse_distros(LIST)));
        assert_eq!(state["enabled"], true);
        assert_eq!(state["available"], true);
        assert_eq!(state["distros"][0]["isDefault"], true);
        assert_eq!(state["preflightError"], Value::Null);
    }

    #[test]
    fn a_wsl1_selection_is_a_preflight_error() {
        let settings = DesktopSettings {
            wsl_enabled: true,
            wsl_distro: Some("Alpine".into()),
            ..DesktopSettings::default()
        };
        let state = describe_state(&settings, Ok(parse_distros(LIST)));
        assert!(state["preflightError"].as_str().unwrap().contains("WSL 2"));
    }

    #[test]
    fn wsl_only_never_reports_a_preflight_error() {
        let settings = DesktopSettings {
            wsl_enabled: true,
            wsl_only: true,
            wsl_distro: Some("missing".into()),
            ..DesktopSettings::default()
        };
        let state = describe_state(&settings, Ok(parse_distros(LIST)));
        assert_eq!(state["preflightError"], Value::Null);
    }

    #[test]
    fn a_failed_list_is_unavailable_not_a_fabricated_distro_list() {
        let state = describe_state(&DesktopSettings::default(), Err(NOT_WINDOWS.into()));
        assert_eq!(state["available"], false);
        assert_eq!(state["distros"], serde_json::json!([]));
    }
}

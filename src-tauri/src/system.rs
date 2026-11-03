fn system_settings_pane(pane: &str) -> Result<&'static str, String> {
    match pane {
        "screen-recording" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        "accessibility" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        "full-disk-access" => Ok(
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
        ),
        other => Err(format!(
            "system settings pane must be \"screen-recording\", \"accessibility\" or \
             \"full-disk-access\", got {other:?}"
        )),
    }
}

#[tauri::command]
pub fn v2_open_system_settings(pane: String) -> Result<bool, String> {
    let url = system_settings_pane(&pane)?;
    #[cfg(target_os = "macos")]
    {
        let status = crate::sys::spawn::command("open").arg(url).status();
        Ok(status.map(|status| status.success()).unwrap_or(false))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Ok(false)
    }
}

#[cfg(any(target_os = "macos", test))]
fn safari_cookie_candidates(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let container = home.join("Library/Containers/com.apple.Safari/Data/Library");
    let mut paths = vec![container.join("Cookies/Cookies.binarycookies")];
    let stores = container.join("WebKit/WebsiteDataStore");
    if let Ok(entries) = std::fs::read_dir(&stores) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("Cookies/Cookies.binarycookies");
            if candidate.exists() {
                paths.push(candidate);
            }
        }
    }
    paths
}

/// Upstream proves Full Disk Access by opening Safari's cookie database; TCC
/// refuses the open until the app holds the grant.
#[cfg(any(target_os = "macos", test))]
fn safari_access_granted(home: &std::path::Path) -> bool {
    safari_cookie_candidates(home)
        .iter()
        .any(|path| std::fs::File::open(path).is_ok())
}

/// On macOS this mirrors upstream's Safari cookie probe; elsewhere upstream has
/// no permission to query and reports false.
#[tauri::command]
pub fn v2_check_system_permission(pane: String) -> Result<bool, String> {
    system_settings_pane(&pane)?;
    #[cfg(target_os = "macos")]
    {
        let Some(home) = crate::sys::home_dir::home_dir() else {
            return Ok(false);
        };
        Ok(safari_access_granted(&home))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sys::paths;

    #[test]
    fn the_underlying_resolver_is_actually_channel_aware() {
        let home = dirs::home_dir().expect("test host must have a resolvable home dir");
        let release = paths::log_dir_for(&home, None);
        let dev = paths::log_dir_for(&home, Some("dev"));
        assert_ne!(
            release, dev,
            "release and dev channels must resolve to different log dirs"
        );
        assert!(release.ends_with("logs") && dev.ends_with("logs"));
    }

    #[test]
    fn system_settings_panes_accept_the_three_privacy_panes_only() {
        for pane in ["screen-recording", "accessibility", "full-disk-access"] {
            assert!(
                system_settings_pane(pane).is_ok(),
                "{pane} must be accepted"
            );
        }
        let error = system_settings_pane("microphone").expect_err("unknown pane must be refused");
        assert!(error.contains("microphone"), "{error}");
    }

    #[test]
    fn safari_cookie_candidates_start_with_the_default_container_database() {
        let home = std::path::Path::new("/home/fixture");
        let candidates = safari_cookie_candidates(home);
        assert_eq!(
            candidates.first().expect("at least the default path"),
            &home.join(
                "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"
            )
        );
    }

    #[cfg(any(target_os = "macos", test))]
    #[test]
    fn safari_access_is_denied_when_no_cookie_database_is_readable() {
        let home = std::env::temp_dir().join(format!(
            "houston-safari-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("the test clock is after the epoch")
                .as_nanos()
        ));
        assert!(!safari_access_granted(&home));
    }

    fn generated_inventory() -> serde_json::Value {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/third-party-licenses.json"
        ))
        .expect(
            "the generated inventory must exist at src-tauri/resources/third-party-licenses.json",
        );
        serde_json::from_str(&raw).expect("the generated inventory must be valid JSON")
    }

    #[test]
    fn the_generated_inventory_is_valid_json_with_the_shape_the_renderer_expects() {
        let doc = generated_inventory();

        let obj = doc
            .as_object()
            .expect("the inventory's top level must be a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["packages", "texts"],
            "the inventory's top level must have exactly `texts` and `packages`, got {keys:?}"
        );

        let texts = obj["texts"]
            .as_object()
            .expect("`texts` must be a JSON object of id -> licence text");
        let packages = obj["packages"]
            .as_array()
            .expect("`packages` must be a JSON array");
        assert!(
            !packages.is_empty(),
            "`packages` must not be empty: the inventory names every shipped package"
        );

        for pkg in packages {
            let pkg_obj = pkg
                .as_object()
                .unwrap_or_else(|| panic!("every package must be a JSON object, got {pkg}"));
            let name = pkg_obj
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("<unnamed>");
            for field in [
                "origin",
                "name",
                "version",
                "license",
                "repository",
                "textIds",
            ] {
                assert!(
                    pkg_obj.contains_key(field),
                    "package {name:?} is missing the `{field}` field"
                );
            }
            let text_ids = pkg_obj["textIds"]
                .as_array()
                .unwrap_or_else(|| panic!("package {name:?}'s `textIds` must be an array"));
            for id in text_ids {
                let id = id
                    .as_str()
                    .unwrap_or_else(|| panic!("package {name:?} has a non-string text id {id}"));
                assert!(
                    texts.contains_key(id),
                    "package {name:?} references text id {id:?} which is not a key of `texts`"
                );
            }
        }
    }

    #[test]
    fn every_shipped_package_is_named_with_a_licence() {
        let doc = generated_inventory();

        let packages = doc["packages"]
            .as_array()
            .expect("`packages` must be a JSON array");

        let missing: Vec<String> = packages
            .iter()
            .filter(|pkg| {
                pkg.get("license")
                    .and_then(|v| v.as_str())
                    .is_none_or(str::is_empty)
            })
            .map(|pkg| {
                pkg.get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unnamed package>")
                    .to_string()
            })
            .collect();

        assert!(
            missing.is_empty(),
            "every shipped package must name a non-empty licence; these do not: {missing:?}"
        );
    }
}

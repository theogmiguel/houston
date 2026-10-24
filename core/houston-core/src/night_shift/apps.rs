//! Apps installed on this computer that a competitor entry can name: the
//! uninstall registry on Windows, desktop entries on Linux. Elsewhere the
//! list is empty and says why.
use houston_protocol::NightInstalledApp;

/// More apps than this is a machine's whole catalogue; the picker lists the first.
const APPS_MAX: usize = 400;

/// The detected apps, by name, and a note when this platform cannot list them.
pub fn installed() -> (Vec<NightInstalledApp>, Option<String>) {
    let (mut apps, note) = platform::installed();
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name) && a.version == b.version);
    apps.truncate(APPS_MAX);
    (apps, note)
}

/// One uninstall-registry entry; `DisplayIcon` may carry `,<index>` and quotes.
pub fn app_from_uninstall(
    name: Option<String>,
    version: Option<String>,
    location: Option<String>,
    icon: Option<String>,
) -> Option<NightInstalledApp> {
    let name = name?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let clean = |s: String| {
        let s = s.trim().trim_matches('"').to_string();
        match s.rsplit_once(',') {
            Some((path, index)) if index.trim().parse::<i32>().is_ok() => {
                path.trim().trim_matches('"').to_string()
            }
            _ => s,
        }
    };
    let path = icon
        .map(clean)
        .filter(|p| p.to_ascii_lowercase().ends_with(".exe"))
        .or_else(|| location.map(clean))
        .filter(|p| !p.is_empty())?;
    Some(NightInstalledApp {
        name,
        version: version.unwrap_or_default().trim().to_string(),
        path,
    })
}

/// One `.desktop` file: its `[Desktop Entry]` name and program, unless hidden.
pub fn app_from_desktop(text: &str) -> Option<NightInstalledApp> {
    let mut in_entry = false;
    let (mut name, mut exec, mut version) = (None, None, String::new());
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Exec" => exec = value.split_whitespace().next().map(str::to_string),
            "X-AppImage-Version" => version = value.trim().to_string(),
            "Type" if value.trim() != "Application" => return None,
            "NoDisplay" | "Hidden" if value.trim() == "true" => return None,
            _ => {}
        }
    }
    Some(NightInstalledApp {
        name: name.filter(|n| !n.is_empty())?,
        version,
        path: exec.filter(|e| !e.is_empty())?,
    })
}

#[cfg(windows)]
mod platform {
    use houston_protocol::NightInstalledApp;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD, REG_EXPAND_SZ, REG_SZ,
    };

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const UNINSTALL_32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    /// Subkeys read per root; a registry with more is not a desktop.
    const SUBKEYS_MAX: u32 = 4_000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn open(root: HKEY, path: &str) -> Option<HKEY> {
        let p = wide(path);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `p` is NUL-terminated and `key` an out-parameter the caller closes.
        let rc = unsafe { RegOpenKeyExW(root, p.as_ptr(), 0, KEY_READ, &mut key) };
        (rc == ERROR_SUCCESS).then_some(key)
    }

    fn value(key: HKEY, name: &str) -> Option<(u32, Vec<u8>)> {
        let n = wide(name);
        let (mut kind, mut size) = (0u32, 0u32);
        // SAFETY: a size query with no buffer.
        let rc = unsafe {
            RegQueryValueExW(
                key,
                n.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if rc != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        // SAFETY: `buf` holds `size` bytes, the size the query above reported.
        let rc = unsafe {
            RegQueryValueExW(
                key,
                n.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buf.as_mut_ptr(),
                &mut size,
            )
        };
        buf.truncate(size as usize);
        (rc == ERROR_SUCCESS).then_some((kind, buf))
    }

    fn string(key: HKEY, name: &str) -> Option<String> {
        let (kind, buf) = value(key, name)?;
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            return None;
        }
        let units: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|u| *u != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn dword(key: HKEY, name: &str) -> Option<u32> {
        let (kind, buf) = value(key, name)?;
        (kind == REG_DWORD && buf.len() == 4).then(|| u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]))
    }

    pub fn installed() -> (Vec<NightInstalledApp>, Option<String>) {
        let mut out = Vec::new();
        for (root, path) in [
            (HKEY_CURRENT_USER, UNINSTALL),
            (HKEY_LOCAL_MACHINE, UNINSTALL),
            (HKEY_LOCAL_MACHINE, UNINSTALL_32),
        ] {
            let Some(base) = open(root, path) else {
                continue;
            };
            for index in 0..SUBKEYS_MAX {
                let mut name = [0u16; 256];
                let mut len = name.len() as u32;
                // SAFETY: `name` holds `len` units; the other out-parameters are optional.
                let rc = unsafe {
                    RegEnumKeyExW(
                        base,
                        index,
                        name.as_mut_ptr(),
                        &mut len,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if rc != ERROR_SUCCESS {
                    break;
                }
                let sub = String::from_utf16_lossy(&name[..len as usize]);
                let Some(key) = open(base, &sub) else {
                    continue;
                };
                if dword(key, "SystemComponent") != Some(1) {
                    out.extend(super::app_from_uninstall(
                        string(key, "DisplayName"),
                        string(key, "DisplayVersion"),
                        string(key, "InstallLocation"),
                        string(key, "DisplayIcon"),
                    ));
                }
                // SAFETY: `key` was opened above and is closed once.
                unsafe { RegCloseKey(key) };
            }
            // SAFETY: `base` was opened above and is closed once.
            unsafe { RegCloseKey(base) };
        }
        (out, None)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use houston_protocol::NightInstalledApp;

    /// Desktop entry files read per directory.
    const FILES_MAX: usize = 2_000;

    pub fn installed() -> (Vec<NightInstalledApp>, Option<String>) {
        let mut dirs = vec![
            std::path::PathBuf::from("/usr/share/applications"),
            std::path::PathBuf::from("/usr/local/share/applications"),
            std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        ];
        if let Some(home) = crate::home_dir::home_dir() {
            dirs.push(home.join(".local/share/applications"));
        }
        let mut out = Vec::new();
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten().take(FILES_MAX) {
                let path = entry.path();
                if path.extension().is_none_or(|x| x != "desktop") {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.extend(super::app_from_desktop(&text));
                }
            }
        }
        (out, None)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    pub fn installed() -> (Vec<houston_protocol::NightInstalledApp>, Option<String>) {
        (
            Vec::new(),
            Some(format!(
                "Houston cannot list installed apps on {}; add a GitHub repository instead",
                std::env::consts::OS
            )),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_values_are_apps() {
        let s = |v: &str| Some(v.to_string());
        let app = app_from_uninstall(
            s("Orca"),
            s("1.4.238"),
            None,
            s(r#""C:\Users\you\AppData\Local\Programs\orca\Orca.exe",0"#),
        )
        .unwrap();
        assert_eq!(
            (app.name.as_str(), app.version.as_str(), app.path.as_str()),
            ("Orca", "1.4.238", r"C:\Users\you\AppData\Local\Programs\orca\Orca.exe")
        );
        let by_folder = app_from_uninstall(s("Warp"), None, s(r"C:\Program Files\Warp"), s("icon.ico"))
            .unwrap();
        assert_eq!((by_folder.path.as_str(), by_folder.version.as_str()), (r"C:\Program Files\Warp", ""));
        assert!(app_from_uninstall(s("No path"), None, None, None).is_none());
        assert!(app_from_uninstall(s(" "), None, s(r"C:\x"), None).is_none());
    }

    #[test]
    fn desktop_entries_are_apps() {
        let app = app_from_desktop(
            "[Desktop Entry]\nType=Application\nName=Cursor\nExec=/opt/cursor/cursor %F\n\
             X-AppImage-Version=1.7.2\n[Desktop Action new]\nName=New window\n",
        )
        .unwrap();
        assert_eq!(
            (app.name.as_str(), app.version.as_str(), app.path.as_str()),
            ("Cursor", "1.7.2", "/opt/cursor/cursor")
        );
        assert!(app_from_desktop("[Desktop Entry]\nName=Hidden\nExec=x\nNoDisplay=true\n").is_none());
        assert!(app_from_desktop("[Desktop Entry]\nType=Link\nName=Web\nExec=x\n").is_none());
    }
}

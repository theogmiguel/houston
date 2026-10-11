//! `<state_dir>/wsl.json`: which distros are enabled and the slot each one tags its
//! session ids with. A disabled distro keeps its slot, so its ids never collide later.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "wsl.json";
pub const VERSION: u32 = 1;
pub const MAX_SLOT: u8 = 127;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WslConfig {
    pub version: u32,
    pub distros: Vec<DistroEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DistroEntry {
    pub name: String,
    pub slot: u8,
    pub enabled: bool,
}

impl Default for WslConfig {
    fn default() -> Self {
        Self {
            version: VERSION,
            distros: Vec::new(),
        }
    }
}

pub fn path(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE_NAME)
}

pub fn load(state_dir: &Path) -> Result<WslConfig, String> {
    let file = path(state_dir);
    let body = match std::fs::read_to_string(&file) {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(WslConfig::default()),
        Err(e) => return Err(format!("reading {}: {e}", file.display())),
    };
    let expected =
        r#"expected {"version":1,"distros":[{"name":"<distro>","slot":1,"enabled":true}]}"#;
    let config: WslConfig = serde_json::from_str(&body)
        .map_err(|e| format!("{} is not valid ({e}); {expected}", file.display()))?;
    if config.version != VERSION {
        return Err(format!(
            "{} has version {}; this app reads version {VERSION}",
            file.display(),
            config.version
        ));
    }
    let mut slots: Vec<u8> = config.distros.iter().map(|d| d.slot).collect();
    slots.sort_unstable();
    slots.dedup();
    if slots.len() != config.distros.len() || slots.iter().any(|s| !(1..=MAX_SLOT).contains(s)) {
        return Err(format!(
            "{} assigns slots {:?}; expected a distinct slot in 1-{MAX_SLOT} per distro",
            file.display(),
            config.distros.iter().map(|d| d.slot).collect::<Vec<_>>()
        ));
    }
    Ok(config)
}

pub fn save(state_dir: &Path, config: &WslConfig) -> Result<(), String> {
    let file = path(state_dir);
    let tmp = state_dir.join(format!("{FILE_NAME}.tmp"));
    let body = serde_json::to_string(config).expect("WslConfig serializes");
    std::fs::write(&tmp, body)
        .and_then(|()| std::fs::rename(&tmp, &file))
        .map_err(|e| format!("writing {}: {e}", file.display()))
}

impl WslConfig {
    pub fn entry(&self, name: &str) -> Option<&DistroEntry> {
        self.distros.iter().find(|d| d.name == name)
    }

    pub fn is_enabled(&self, name: &str) -> bool {
        self.entry(name).is_some_and(|d| d.enabled)
    }

    /// Keeps a slot the distro held before; otherwise takes the lowest free one.
    pub fn enable(&mut self, name: &str) -> Result<u8, String> {
        if let Some(entry) = self.distros.iter_mut().find(|d| d.name == name) {
            entry.enabled = true;
            return Ok(entry.slot);
        }
        let slot = (1..=MAX_SLOT)
            .find(|slot| self.distros.iter().all(|d| d.slot != *slot))
            .ok_or_else(|| {
                format!(
                    "cannot enable {name}: all {MAX_SLOT} WSL slots are held by distros in {FILE_NAME}"
                )
            })?;
        self.distros.push(DistroEntry {
            name: name.to_string(),
            slot,
            enabled: true,
        });
        Ok(slot)
    }

    pub fn disable(&mut self, name: &str) -> Result<u8, String> {
        match self.distros.iter_mut().find(|d| d.name == name) {
            Some(entry) if entry.enabled => {
                entry.enabled = false;
                Ok(entry.slot)
            }
            _ => Err(not_enabled(name)),
        }
    }
}

pub fn not_enabled(name: &str) -> String {
    format!("{name} is not enabled in Settings → WSL; there is nothing to disable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_stable_and_unique() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = load(dir.path()).unwrap();
        assert_eq!(config.enable("A").unwrap(), 1);
        assert_eq!(config.enable("B").unwrap(), 2);
        assert_eq!(config.disable("A").unwrap(), 1);
        assert_eq!(config.enable("C").unwrap(), 3);
        save(dir.path(), &config).unwrap();

        let mut reloaded = load(dir.path()).unwrap();
        assert_eq!(reloaded, config);
        assert_eq!(reloaded.version, 1);
        assert_eq!(
            reloaded.entry("A"),
            Some(&DistroEntry {
                name: "A".into(),
                slot: 1,
                enabled: false
            })
        );
        assert_eq!(reloaded.enable("A").unwrap(), 1);
        assert_eq!(reloaded.enable("A").unwrap(), 1);
        let slots: Vec<(&str, u8)> = reloaded
            .distros
            .iter()
            .map(|d| (d.name.as_str(), d.slot))
            .collect();
        assert_eq!(slots, [("A", 1), ("B", 2), ("C", 3)]);

        let raw = std::fs::read_to_string(path(dir.path())).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(
            value["distros"][0],
            serde_json::json!({"name": "A", "slot": 1, "enabled": false})
        );

        let err = reloaded.disable("Nope").unwrap_err();
        assert!(err.contains("Nope"), "{err}");
    }

    #[test]
    fn slots_run_out_at_127() {
        let mut config = WslConfig::default();
        for n in 1..=MAX_SLOT {
            assert_eq!(config.enable(&format!("d{n}")).unwrap(), n);
        }
        let err = config.enable("one-more").unwrap_err();
        assert!(err.contains("one-more") && err.contains("127"), "{err}");
    }

    #[test]
    fn a_corrupt_or_foreign_file_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{ not json").unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(
            err.contains("wsl.json") && err.contains("expected"),
            "{err}"
        );
        std::fs::write(
            path(dir.path()),
            r#"{"version":1,"distros":[{"name":"A","slot":1,"enabled":true},{"name":"B","slot":1,"enabled":true}]}"#,
        )
        .unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(err.contains("distinct slot"), "{err}");
    }
}

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

pub const CHANNEL_ENV: &str = "HOUSTON_CHANNEL";
pub const BASE_DIR: &str = ".houston";
// Bounded so a channel name can never become a path bomb or an unreadable dir name.
const MAX_CHANNEL_LEN: usize = 32;

pub fn channel() -> Result<Option<String>> {
    let Ok(raw) = std::env::var(CHANNEL_ENV) else {
        return Ok(None);
    };
    validate_channel(&raw)
}

pub fn channel_shape_rule() -> String {
    format!(
        "expected 1-{MAX_CHANNEL_LEN} characters of [a-z0-9-], not starting or ending with '-'; \
         leave it unset (or use \"release\") for the default {BASE_DIR} directory"
    )
}

// Fails closed and names the offending value: this string becomes a directory under
// $HOME, so anything that could escape it (`..`, `/`) must stop the daemon at startup.
// Unset, "release" and "" all mean the default (release) channel.
pub fn validate_channel(raw: &str) -> Result<Option<String>> {
    let name = raw.trim();
    if name.is_empty() || name == "release" {
        return Ok(None);
    }
    let shape_ok = name.len() <= MAX_CHANNEL_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if !shape_ok {
        bail!(
            "{CHANNEL_ENV}={raw:?} is not a valid channel name: {}",
            channel_shape_rule()
        );
    }
    Ok(Some(name.to_string()))
}

#[derive(Debug)]
pub enum ChannelOwnershipRefusal {
    NotExplicit {
        release_dir: PathBuf,
        dev_dir: PathBuf,
    },
    Invalid {
        raw: String,
    },
}

impl ChannelOwnershipRefusal {
    pub fn message(&self) -> String {
        match self {
            ChannelOwnershipRefusal::NotExplicit {
                release_dir,
                dev_dir,
            } => format!(
                "houston-core: refusing to own a daemon: {CHANNEL_ENV} is not set. Without it \
                 this process would silently own {} (the release channel -- the installed \
                 app's live state) or, with it set, {} (the dev channel). Set \
                 {CHANNEL_ENV}=release or {CHANNEL_ENV}=dev explicitly before launching -- \
                 scripts/start.sh and scripts/dev.sh both do this already; a stray direct \
                 invocation of this binary is what this refusal is for.",
                release_dir.display(),
                dev_dir.display()
            ),
            ChannelOwnershipRefusal::Invalid { raw } => format!(
                "houston-core: refusing to own a daemon: {CHANNEL_ENV}={raw:?} is not a valid \
                 channel name: {}",
                channel_shape_rule()
            ),
        }
    }
}

// `None` (the var absent) is the only case this refuses; `Some("")` / `Some("release")`
// are explicit, if degenerate, choices for the release channel and fall through.
pub fn resolve_owning_channel(
    env_value: Option<&str>,
    home: &Path,
) -> Result<Option<String>, ChannelOwnershipRefusal> {
    let Some(raw) = env_value else {
        return Err(ChannelOwnershipRefusal::NotExplicit {
            release_dir: dir_for(home, None),
            dev_dir: dir_for(home, Some("dev")),
        });
    };
    validate_channel(raw).map_err(|_| ChannelOwnershipRefusal::Invalid {
        raw: raw.to_string(),
    })
}

pub fn config_dir() -> Result<PathBuf> {
    let home = crate::home_dir::home_dir().context("cannot resolve home directory")?;
    Ok(dir_for(&home, channel()?.as_deref()))
}

pub fn dir_for(home: &Path, channel: Option<&str>) -> PathBuf {
    match channel {
        None => home.join(BASE_DIR),
        Some(c) => home.join(format!("{BASE_DIR}-{c}")),
    }
}

pub fn log_dir() -> Result<PathBuf> {
    let home = crate::home_dir::home_dir().context("cannot resolve home directory")?;
    Ok(log_dir_for(&home, channel()?.as_deref()))
}

pub fn log_dir_for(home: &Path, channel: Option<&str>) -> PathBuf {
    dir_for(home, channel).join("logs")
}

// FNV-1a, not `DefaultHasher`: that hasher's seed is randomized per process, which
// would make this digest change across runs.
pub fn short_digest(s: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for b in s.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{:016x}", hash)[..8].to_string()
}

pub fn channel_of_state_dir(state_dir: &Path) -> Option<String> {
    let name = state_dir.file_name()?.to_str()?;
    let suffix = name.strip_prefix(BASE_DIR)?.strip_prefix('-')?;
    validate_channel(suffix).ok().flatten()
}

// Same string as `BASE_DIR` but a different thing: `BASE_DIR` is the channel's state
// dir under `$HOME`; this one lives inside a workspace and carries no channel suffix.
pub const PROJECT_DIR: &str = ".houston";

pub const LEGACY_PROJECT_DIR: &str = ".tr";

// Refuses rather than merges when both exist: silently picking a winner is how one
// set of handoff documents disappears. Whole-directory rename so nothing under it is lost.
pub fn migrate_legacy_project_dir(root: &Path) -> Result<bool> {
    let legacy = root.join(LEGACY_PROJECT_DIR);
    if !legacy.is_dir() {
        return Ok(false);
    }
    let current = root.join(PROJECT_DIR);
    if current.exists() {
        bail!(
            "{} and {} both exist; leaving the legacy directory alone rather than merging it \
             — move what you want out of {} by hand and delete it",
            legacy.display(),
            current.display(),
            legacy.display()
        );
    }
    std::fs::rename(&legacy, &current)
        .with_context(|| format!("renaming {} to {}", legacy.display(), current.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_moves_the_legacy_dir_with_everything_under_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let legacy = root.join(LEGACY_PROJECT_DIR).join("handoffs");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("1.md"), b"kept").unwrap();

        assert!(migrate_legacy_project_dir(root).unwrap());
        assert!(!root.join(LEGACY_PROJECT_DIR).exists());
        assert_eq!(
            std::fs::read(root.join(PROJECT_DIR).join("handoffs").join("1.md")).unwrap(),
            b"kept"
        );
    }

    #[test]
    fn migrate_is_a_no_op_when_there_is_no_legacy_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!migrate_legacy_project_dir(tmp.path()).unwrap());
        std::fs::create_dir_all(tmp.path().join(PROJECT_DIR)).unwrap();
        assert!(!migrate_legacy_project_dir(tmp.path()).unwrap());
    }

    #[test]
    fn migrate_refuses_when_both_directories_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(LEGACY_PROJECT_DIR)).unwrap();
        std::fs::create_dir_all(root.join(PROJECT_DIR)).unwrap();

        let err = migrate_legacy_project_dir(root).expect_err("both present must refuse");
        let msg = format!("{err:#}");
        assert!(msg.contains(LEGACY_PROJECT_DIR), "{msg}");
        assert!(msg.contains(PROJECT_DIR), "{msg}");
        assert!(root.join(LEGACY_PROJECT_DIR).is_dir());
    }

    #[test]
    fn unset_empty_and_release_all_mean_the_default_channel() {
        assert_eq!(validate_channel("").unwrap(), None);
        assert_eq!(validate_channel("   ").unwrap(), None);
        assert_eq!(validate_channel("release").unwrap(), None);
    }

    #[test]
    fn resolve_owning_channel_refuses_when_the_env_var_is_absent() {
        let home = Path::new("/home/testuser");
        let err = resolve_owning_channel(None, home).expect_err("no env var must refuse");
        let ChannelOwnershipRefusal::NotExplicit {
            release_dir,
            dev_dir,
        } = &err
        else {
            panic!("expected NotExplicit, got {err:?}");
        };
        assert_eq!(release_dir, &home.join(".houston"));
        assert_eq!(dev_dir, &home.join(".houston-dev"));
        let msg = err.message();
        assert!(msg.contains(CHANNEL_ENV), "must name the variable: {msg}");
        assert!(
            msg.contains(".houston") && msg.contains(".houston-dev"),
            "must name both channel dirs: {msg}"
        );
    }

    #[test]
    fn resolve_owning_channel_accepts_any_explicit_value_validate_channel_accepts() {
        let home = Path::new("/home/testuser");
        assert_eq!(resolve_owning_channel(Some("release"), home).unwrap(), None);
        assert_eq!(resolve_owning_channel(Some(""), home).unwrap(), None);
        assert_eq!(
            resolve_owning_channel(Some("dev"), home)
                .unwrap()
                .as_deref(),
            Some("dev")
        );
    }

    #[test]
    fn resolve_owning_channel_refuses_an_explicit_invalid_value() {
        let home = Path::new("/home/testuser");
        let err = resolve_owning_channel(Some("../etc"), home)
            .expect_err("a shape-violating explicit value must refuse");
        assert!(matches!(err, ChannelOwnershipRefusal::Invalid { .. }));
        let msg = err.message();
        assert!(
            msg.contains("../etc"),
            "must name the offending value: {msg}"
        );
    }

    #[test]
    fn short_digest_is_deterministic_and_disambiguates() {
        assert_eq!(
            short_digest("/home/a/backend"),
            short_digest("/home/a/backend")
        );
        assert_ne!(
            short_digest("/home/a/backend"),
            short_digest("/home/b/backend")
        );
        assert_eq!(short_digest("x").len(), 8);
    }

    #[test]
    fn a_named_channel_is_accepted_and_trimmed() {
        assert_eq!(validate_channel("dev").unwrap().as_deref(), Some("dev"));
        assert_eq!(validate_channel("pr-42").unwrap().as_deref(), Some("pr-42"));
        assert_eq!(validate_channel(" dev ").unwrap().as_deref(), Some("dev"));
        assert_eq!(validate_channel("dev\n").unwrap().as_deref(), Some("dev"));
    }

    #[test]
    fn a_channel_that_could_escape_the_home_dir_is_refused() {
        for bad in [
            "..",
            "../etc",
            "a/b",
            "/abs",
            "dev/../..",
            "Dev",
            "dev_1",
            "-dev",
            "dev-",
            "dev name",
            "dev\tx",
        ] {
            let err = validate_channel(bad)
                .expect_err(&format!("{bad:?} must be refused"))
                .to_string();
            assert!(err.contains(CHANNEL_ENV), "error names the variable: {err}");
        }
        let long = "a".repeat(MAX_CHANNEL_LEN + 1);
        assert!(validate_channel(&long).is_err(), "over-long name refused");
    }

    #[test]
    fn dir_for_puts_a_channel_beside_the_release_dir() {
        let home = Path::new("/home/x");
        assert_eq!(dir_for(home, None), home.join(".houston"));
        assert_eq!(
            dir_for(home, Some("dev")),
            home.join(".houston-dev"),
            "sibling dir, so the release dir's retention/checkpoint loops never see it"
        );
    }

    #[test]
    fn log_dir_for_is_channel_aware_and_lives_under_the_state_dir() {
        let home = Path::new("/home/x");
        assert_eq!(log_dir_for(home, None), home.join(".houston").join("logs"));
        assert_eq!(
            log_dir_for(home, Some("dev")),
            home.join(".houston-dev").join("logs"),
            "dev channel logs must sit under the dev state dir, not the release one"
        );
        assert_ne!(log_dir_for(home, None), log_dir_for(home, Some("dev")));
    }

    #[test]
    fn channel_round_trips_through_the_state_dir() {
        let home = Path::new("/home/x");
        assert_eq!(channel_of_state_dir(&dir_for(home, None)), None);
        assert_eq!(
            channel_of_state_dir(&dir_for(home, Some("dev"))).as_deref(),
            Some("dev")
        );
    }

    #[test]
    fn a_temp_dir_is_not_a_channel() {
        assert_eq!(channel_of_state_dir(Path::new("/tmp/xyz123")), None);
        assert_eq!(channel_of_state_dir(Path::new("/tmp/.houston")), None);
        assert_eq!(
            channel_of_state_dir(Path::new("/tmp/.houston-")),
            None,
            "a bare trailing dash is not a channel name"
        );
    }
}

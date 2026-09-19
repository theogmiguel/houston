//! The home directory, resolved environment-first. On Windows `dirs::home_dir()`
//! reads the registry and IGNORES the environment, so hermetic tests could not
//! redirect the state dir and a daemon could silently boot against the real one.

use std::path::PathBuf;

pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
    {
        return Some(home);
    }
    if let Some(home) = std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
    {
        return Some(home);
    }
    dirs::home_dir()
}

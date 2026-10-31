//! WSL helpers shared by the v2 bridge: `wsl.exe` invocation and path mapping.
//! Windows only; elsewhere the v2 WSL commands answer that WSL is unavailable.

pub mod command;
pub mod distros;
pub mod unc;
pub mod v2;

pub const NOT_WINDOWS: &str = "WSL environments are only available on Windows";

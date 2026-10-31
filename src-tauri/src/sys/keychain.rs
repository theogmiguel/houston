//! Keychain services scoped per state directory, so a development or test daemon
//! never reads or replaces the installed daemon's secrets.

use std::path::Path;

use sha2::{Digest, Sha256};

/// `<prefix>-<digest of the state directory>`: one service per state directory.
pub fn scoped_service(prefix: &str, state_dir: &Path) -> String {
    let digest = hash_secret(&state_dir.to_string_lossy());
    format!("{prefix}-{}", &digest[..16])
}

fn hash_secret(raw: &str) -> String {
    hex(&Sha256::digest(raw.trim().as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_state_directories_resolve_to_different_services() {
        let a = scoped_service("houston-voice", Path::new("/home/u/.houston"));
        let b = scoped_service("houston-voice", Path::new("/home/u/.houston-dev"));
        assert_ne!(a, b);
        assert_ne!(
            a, "houston-voice",
            "the fixed legacy service is never reused"
        );
        assert_eq!(
            a,
            scoped_service("houston-voice", Path::new("/home/u/.houston"))
        );
    }
}

//! Redaction for suspected-defect issue drafts: environment values, tokens,
//! long high-entropy runs, URL passwords and absolute workspace or home paths.

use std::sync::OnceLock;

fn env_values() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?mi)\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)"#,
        )
        .expect("defect redaction env pattern")
    })
}

fn bearer() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
            .expect("defect redaction bearer pattern")
    })
}

fn token_prefixes() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"\b(?:ghp_|gho_|ghs_|github_pat_|sk-)[A-Za-z0-9_-]{8,}")
            .expect("defect redaction token pattern")
    })
}

fn long_runs() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"[A-Za-z0-9+/]{32,}={0,2}").expect("defect redaction entropy pattern")
    })
}

fn url_userinfo() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@")
            .expect("defect redaction URL pattern")
    })
}

/// Both separator spellings of an absolute path, so a Windows path in a Unix
/// report (or the reverse) still disappears.
fn spellings(path: &str) -> Vec<String> {
    let mut out = vec![path.to_string()];
    let forward = path.replace('\\', "/");
    if forward != path {
        out.push(forward);
    }
    let back = path.replace('/', "\\");
    if back != path {
        out.push(back);
    }
    out
}

/// Redact `text` for a draft in `workspace` on `home`. The workspace is replaced
/// first, so a path inside it becomes `<workspace>`, and the remaining home
/// prefix `~`.
pub fn redact(text: &str, workspace: Option<&str>, home: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(workspace) = workspace.filter(|w| !w.is_empty()) {
        for spelling in spellings(workspace) {
            out = out.replace(&spelling, "<workspace>");
        }
    }
    if let Some(home) = home.filter(|h| !h.is_empty()) {
        for spelling in spellings(home) {
            out = out.replace(&spelling, "~");
        }
    }
    out = env_values().replace_all(&out, "$1=<redacted>").into_owned();
    out = bearer().replace_all(&out, "Bearer <redacted>").into_owned();
    out = token_prefixes()
        .replace_all(&out, "<redacted>")
        .into_owned();
    out = long_runs().replace_all(&out, "<redacted>").into_owned();
    url_userinfo()
        .replace_all(&out, "$1<redacted>@")
        .into_owned()
}

/// Redact with the daemon's home directory, for a draft the daemon builds.
pub fn redact_here(env: &crate::host_env::HostEnv, text: &str, workspace: &str) -> String {
    let home = env.home_dir();
    let home = home
        .as_deref()
        .map(|path| path.to_string_lossy().into_owned());
    redact(text, Some(workspace), home.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_paths_and_credentials_are_removed() {
        let workspace = "C:\\Users\\me\\proj";
        let home = "C:\\Users\\me";
        let raw = concat!(
            "GITHUB_TOKEN=abc123\n",
            "MY_SECRET=hello\n",
            "Authorization: Bearer eyJhbGciOi.payload.sig\n",
            "key ghp_abcdefghijklmnop\n",
            "key sk-abcdefghijklmnop\n",
            "hash 0123456789abcdef0123456789abcdef\n",
            "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5+/==\n",
            "url https://user:pass@example.com/x\n",
            "file C:\\Users\\me\\proj\\src\\a.rs\n",
            "other C:\\Users\\me\\notes.txt\n",
            "unix /home/me/notes.txt"
        );
        let redacted = redact(raw, Some(workspace), Some(home));
        for secret in [
            "abc123",
            "hello",
            "eyJhbGciOi",
            "ghp_abcdefghijklmnop",
            "sk-abcdefghijklmnop",
            "0123456789abcdef0123456789abcdef",
            "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5",
            "user:pass",
        ] {
            assert!(!redacted.contains(secret), "{secret}: {redacted}");
        }
        assert!(redacted.contains("GITHUB_TOKEN=<redacted>"), "{redacted}");
        assert!(redacted.contains("MY_SECRET=<redacted>"), "{redacted}");
        assert!(redacted.contains("Bearer <redacted>"), "{redacted}");
        assert!(redacted.contains("<workspace>\\src\\a.rs"), "{redacted}");
        assert!(redacted.contains("~\\notes.txt"), "{redacted}");
        assert!(
            redacted.contains("https://<redacted>@example.com/x"),
            "{redacted}"
        );
    }

    #[test]
    fn ordinary_identifiers_and_sentences_stay_readable() {
        let raw = "Worker 12 asked once; request 12345678 took 3 attempts. The body is 64 chars.";
        assert_eq!(redact(raw, None, None), raw);
    }

    #[test]
    fn a_home_path_outside_the_workspace_becomes_a_tilde() {
        let redacted = redact(
            "see /home/me/.config/houston and /srv/repo",
            Some("/srv/repo"),
            Some("/home/me"),
        );
        assert_eq!(redacted, "see ~/.config/houston and <workspace>");
    }
}

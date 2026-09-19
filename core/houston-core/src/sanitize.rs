use std::sync::OnceLock;

use regex::Regex;

pub const PATTERN_NAMES: &[&str] = &[
    "private_key",
    "aws_key",
    "github_token",
    "jwt",
    "uuid",
    "high_entropy",
];

fn private_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
        )
        .unwrap()
    })
}

fn aws_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap())
}

fn github_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b").unwrap())
}

fn jwt_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b").unwrap()
    })
}

fn uuid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
            .unwrap()
    })
}

fn apply_pattern(text: &mut String, re: &Regex, replacement: &str) -> bool {
    if re.is_match(text) {
        *text = re.replace_all(text, replacement).into_owned();
        true
    } else {
        false
    }
}

fn redact_with_patterns(input: &str, patterns: &[(&Regex, &str)]) -> (String, bool) {
    let mut redacted = false;
    let mut text = input.to_string();
    for (re, name) in patterns {
        redacted |= apply_pattern(&mut text, re, &format!("[redacted:{name}]"));
    }
    let (text2, hit) = redact_high_entropy(&text);
    (text2, redacted || hit)
}

/// Redaction runs before any surface persists agent-derived text (review packet,
/// command ledger, handoff). This content never reaches the daemon log, so a
/// missed secret is invisible: get it right here, not later.
pub fn redact_secrets(input: &str) -> (String, bool) {
    redact_with_patterns(
        input,
        &[
            (private_key_re(), "private_key"),
            (aws_key_re(), "aws_key"),
            (github_token_re(), "github_token"),
            (jwt_re(), "jwt"),
            (uuid_re(), "uuid"),
        ],
    )
}

fn env_secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b((?:[a-z0-9]+_)*(?:secret|token|key|password)(?:_[a-z0-9]+)*)=("[^"]*"|'[^']*'|\S+)"#,
        )
        .unwrap()
    })
}

fn auth_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)(Authorization:\s*\S+\s+)([^\s\["'][^\s"']*)"#).unwrap())
}

fn url_userinfo_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]+:)([^@\s]+)@").unwrap())
}

/// No entropy pass here on purpose: `is_b64` counts `/`, so an ordinary path or
/// a `docker -v host:/container` mount clears the entropy floor and would be
/// mangled. The structured patterns catch the named secret shapes instead.
pub fn redact_command_secrets(input: &str) -> (String, bool) {
    let mut redacted = false;
    let mut text = input.to_string();
    for (re, name) in [
        (private_key_re(), "private_key"),
        (aws_key_re(), "aws_key"),
        (github_token_re(), "github_token"),
        (jwt_re(), "jwt"),
    ] {
        redacted |= apply_pattern(&mut text, re, &format!("[redacted:{name}]"));
    }
    redacted |= apply_pattern(&mut text, auth_header_re(), "$1[redacted:auth_header]");
    redacted |= apply_pattern(&mut text, env_secret_re(), "$1=[redacted:env_secret]");
    redacted |= apply_pattern(&mut text, url_userinfo_re(), "$1[redacted:url_password]@");
    (text, redacted)
}

fn generic_secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(api[_-]?key|secret|token|password)(\s*[:=]\s*)(\S+)").unwrap()
    })
}

fn authorization_assignment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(authorization)(\s*=\s*)(\S+)").unwrap())
}

fn apply_pattern_skip_marker(text: &mut String, re: &Regex, name: &str) -> bool {
    let mut redacted = false;
    let replaced = re
        .replace_all(text.as_str(), |caps: &regex::Captures| {
            let value = &caps[3];
            if value.starts_with("[redacted:") {
                caps[0].to_string()
            } else {
                redacted = true;
                format!("{}{}[redacted:{name}]", &caps[1], &caps[2])
            }
        })
        .into_owned();
    *text = replaced;
    redacted
}

pub fn redact_review_secrets(input: &str) -> (String, bool) {
    let (mut text, mut redacted) = redact_command_secrets(input);
    redacted |= apply_pattern_skip_marker(&mut text, generic_secret_re(), "env_secret");
    redacted |= apply_pattern_skip_marker(&mut text, authorization_assignment_re(), "auth_header");
    (text, redacted)
}

const ENTROPY_MIN_LEN: usize = 32;
const ENTROPY_MIN_BITS: f64 = 3.5;

fn redact_high_entropy(input: &str) -> (String, bool) {
    let mut out = String::with_capacity(input.len());
    let mut redacted = false;
    let mut run_start: Option<usize> = None;
    for (i, c) in input.char_indices() {
        if is_b64(c) {
            run_start.get_or_insert(i);
        } else {
            if let Some(s) = run_start.take() {
                redacted |= flush_run(&input[s..i], &mut out);
            }
            out.push(c);
        }
    }
    if let Some(s) = run_start {
        redacted |= flush_run(&input[s..], &mut out);
    }
    (out, redacted)
}

fn flush_run(run: &str, out: &mut String) -> bool {
    if is_high_entropy(run) {
        out.push_str("[redacted:high_entropy]");
        true
    } else {
        out.push_str(run);
        false
    }
}

// `/` is deliberately NOT a run character: counting it fused whole filesystem
// paths into one run, so capture redacted paths as `[redacted:high_entropy]`.
fn is_b64(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '=' | '_' | '-')
}

fn is_high_entropy(s: &str) -> bool {
    if s.len() < ENTROPY_MIN_LEN {
        return false;
    }
    let has_lower = s.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = s.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = s.chars().any(|c| c.is_ascii_digit());
    let has_special = s.chars().any(|c| matches!(c, '+' | '='));
    let classes = [has_lower, has_upper, has_digit]
        .iter()
        .filter(|b| **b)
        .count();
    if !(classes >= 3 || (has_special && classes >= 2)) {
        return false;
    }
    shannon_bits(s) >= ENTROPY_MIN_BITS
}

fn shannon_bits(s: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0u32) += 1;
    }
    let len = s.chars().count() as f64;
    -counts
        .values()
        .map(|&n| {
            let p = n as f64 / len;
            p * p.log2()
        })
        .sum::<f64>()
}

pub fn matches_ignored(text: &str, globs: &[String]) -> bool {
    if globs.is_empty() {
        return false;
    }
    let res: Vec<Regex> = globs.iter().filter_map(|g| glob_to_regex(g)).collect();
    text.split_whitespace().any(|tok| {
        let tok = tok.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')'));
        res.iter().any(|re| re.is_match(tok))
    })
}

fn glob_to_regex(glob: &str) -> Option<Regex> {
    let glob = glob.trim();
    if glob.is_empty() {
        return None;
    }
    let mut re = String::from("^");
    let bytes = glob.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    re.push_str(".*");
                    i += 2;
                    if i < bytes.len() && bytes[i] == b'/' {
                        re.push_str("/?");
                        i += 1;
                    }
                    continue;
                }
                re.push_str("[^/]*");
            }
            b'?' => re.push_str("[^/]"),
            c => {
                if b".+()|[]{}^$\\".contains(&c) {
                    re.push('\\');
                }
                re.push(c as char);
            }
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_aws_access_key() {
        let (out, hit) = redact_secrets("key is AKIAIOSFODNN7EXAMPLE done");
        assert!(hit);
        assert_eq!(out, "key is [redacted:aws_key] done");
    }

    #[test]
    fn redacts_github_token() {
        let secret = format!("ghp_{}", "a1B2c3D4e5".repeat(4));
        let (out, hit) = redact_secrets(&format!("token={secret}"));
        assert!(hit);
        assert!(out.contains("[redacted:github_token]"));
        assert!(!out.contains("ghp_a1B2"));
    }

    #[test]
    fn redacts_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let (out, hit) = redact_secrets(&format!("Authorization: Bearer {jwt}"));
        assert!(hit);
        assert!(out.contains("[redacted:jwt]"));
    }

    #[test]
    fn redacts_private_key_block() {
        let key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\nabc123==\n-----END RSA PRIVATE KEY-----";
        let (out, hit) = redact_secrets(&format!("here it is:\n{key}\nthanks"));
        assert!(hit);
        assert!(out.contains("[redacted:private_key]"));
        assert!(!out.contains("MIIEpAIBAAK"));
    }

    #[test]
    fn redacts_high_entropy_token_in_context() {
        let secret = "Xa9Kd7Qp2Zr4Lm8Bn6Vc3Ws1Tf5Yg0Hj+Kl/Op=QrSt";
        let (out, hit) = redact_secrets(&format!("SECRET=\"{secret}\""));
        assert!(hit, "high-entropy secret should be caught: {out}");
        assert!(out.contains("[redacted:high_entropy]"));
        assert!(out.starts_with("SECRET=\""));
        assert!(out.ends_with('"'));
    }

    #[test]
    fn leaves_ordinary_prose_untouched() {
        let text = "The daemon reindexes memory_pages after every write to the store.";
        let (out, hit) = redact_secrets(text);
        assert!(!hit);
        assert_eq!(out, text);
    }

    #[test]
    fn does_not_redact_a_long_word_or_hex_sha() {
        let sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
        let (out, hit) = redact_secrets(&format!("commit {sha}"));
        assert!(!hit, "hex sha is not a secret: {out}");
        assert!(out.contains(sha));
    }

    #[test]
    fn redacts_uuid_in_quoted_json_and_bearer_shapes() {
        let uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
        let (out, hit) = redact_secrets(&format!(r#"body: {{"token":"{uuid}"}}"#));
        assert!(hit, "bare uuid in quoted JSON should be caught: {out}");
        assert!(out.contains("[redacted:uuid]"));
        assert!(!out.contains(uuid));

        let (out, hit) = redact_secrets(&format!("Authorization: Bearer {uuid}"));
        assert!(hit, "uuid after Bearer should be caught: {out}");
        assert!(out.contains("[redacted:uuid]"));
        assert!(!out.contains(uuid));
    }

    #[test]
    fn does_not_redact_iso_dates_or_kebab_slugs() {
        let text = "on 2026-07-25 rename memory-store-plan to memory-store-plan-v2";
        let (out, hit) = redact_secrets(text);
        assert!(!hit, "ISO date / kebab slugs are not secrets: {out}");
        assert_eq!(out, text);
    }

    #[test]
    fn ignore_glob_matches_nested_path() {
        let globs = vec!["**/secrets/**".to_string()];
        assert!(matches_ignored(
            "please edit config/secrets/db.yaml now",
            &globs
        ));
        assert!(!matches_ignored(
            "please edit config/app/db.yaml now",
            &globs
        ));
    }

    #[test]
    fn ignore_glob_segment_wildcard_stays_in_segment() {
        let globs = vec!["*.env".to_string()];
        assert!(matches_ignored("wrote .env and prod.env", &globs));
        assert!(!matches_ignored("wrote config/prod.env", &globs));
    }

    #[test]
    fn ignore_globs_empty_is_never_a_match() {
        assert!(!matches_ignored("anything at all", &[]));
    }

    #[test]
    fn command_redaction_catches_aws_key_and_bearer_token() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let cmd = format!(
            "curl -H \"Authorization: Bearer {jwt}\" -u AKIAIOSFODNN7EXAMPLE:secret https://api.example.com"
        );
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(hit);
        assert!(out.contains("[redacted:jwt]"));
        assert!(out.contains("[redacted:aws_key]"));
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!out.contains(jwt));
    }

    #[test]
    fn command_redaction_leaves_ordinary_paths_and_urls_untouched() {
        for cmd in [
            "cd /home/dev/projects/houston",
            "code /home/dev/projects/houston/core/houston-core/src/db.rs",
            "curl https://api.github.com/repos/theogmiguel/houston",
            "docker run -v /home/dev/projects/houston:/app someimage",
        ] {
            let (out, hit) = redact_command_secrets(cmd);
            assert!(!hit, "ordinary command text must not be redacted: {out}");
            assert_eq!(out, cmd);
        }
    }

    #[test]
    fn command_redaction_catches_env_secret_and_preserves_the_label() {
        let cmd =
            "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string();
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(hit, "env-style secret assignment should be caught: {out}");
        assert!(
            out.contains("AWS_SECRET_ACCESS_KEY=[redacted:env_secret]"),
            "key label must survive, only the value is redacted: {out}"
        );
        assert!(!out.contains("wJalrXUtnFEMI"));
    }

    #[test]
    fn command_redaction_catches_bearer_token_regardless_of_shape() {
        let cmd = r#"curl -H "Authorization: Bearer not-a-jwt-shaped-token-1234""#.to_string();
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(hit, "non-JWT bearer token should still be caught: {out}");
        assert!(!out.contains("not-a-jwt-shaped-token-1234"));
        assert_eq!(
            out, r#"curl -H "Authorization: Bearer [redacted:auth_header]""#,
            "the closing quote must survive redaction"
        );
    }

    #[test]
    fn command_redaction_keeps_a_single_quoted_auth_header_balanced() {
        let cmd = r#"curl -H 'Authorization: Basic dXNlcjpwYXNzd29yZA==' https://api.example.com"#
            .to_string();
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(hit, "basic-auth credentials should be caught: {out}");
        assert_eq!(
            out,
            r#"curl -H 'Authorization: Basic [redacted:auth_header]' https://api.example.com"#
        );
    }

    #[test]
    fn command_redaction_catches_a_bare_unquoted_auth_header() {
        let (out, hit) = redact_command_secrets("Authorization: Bearer abc123def456");
        assert!(hit);
        assert_eq!(out, "Authorization: Bearer [redacted:auth_header]");
    }

    #[test]
    fn command_redaction_catches_url_userinfo_password() {
        let cmd = r#"psql "postgres://admin:sup3rs3cret@db.internal:5432/prod""#.to_string();
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(hit, "URL userinfo password should be caught: {out}");
        assert!(out.contains("postgres://admin:[redacted:url_password]@db.internal:5432/prod"));
        assert!(!out.contains("sup3rs3cret"));
    }

    #[test]
    fn command_redaction_leaves_an_ordinary_uuid_argument_alone() {
        let uuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
        let cmd = format!("kubectl get pod {uuid} -n default");
        let (out, hit) = redact_command_secrets(&cmd);
        assert!(
            !hit,
            "a bare uuid argument is not a secret in command text: {out}"
        );
        assert_eq!(out, cmd);
    }

    #[test]
    fn review_redaction_catches_colon_form_password() {
        let (out, hit) = redact_review_secrets("db_password: hunter2");
        assert!(
            hit,
            "colon-form password assignment should be caught: {out}"
        );
        assert!(!out.contains("hunter2"), "{out}");
        assert_eq!(out, "db_password: [redacted:env_secret]");
    }

    #[test]
    fn review_redaction_catches_colon_form_api_key() {
        let (out, hit) = redact_review_secrets("api-key: abc");
        assert!(hit, "colon-form api-key assignment should be caught: {out}");
        assert_eq!(out, "api-key: [redacted:env_secret]");
    }

    #[test]
    fn review_redaction_catches_space_padded_equals_token() {
        let (out, hit) = redact_review_secrets("token = xyz");
        assert!(
            hit,
            "space-padded '=' token assignment should be caught: {out}"
        );
        assert_eq!(out, "token = [redacted:env_secret]");
    }

    #[test]
    fn review_redaction_catches_authorization_equals_form() {
        let (out, hit) = redact_review_secrets("Authorization = Bearer-xyz");
        assert!(hit, "'Authorization =' form should be caught: {out}");
        assert!(!out.contains("Bearer-xyz"), "{out}");
        assert_eq!(out, "Authorization = [redacted:auth_header]");
    }

    #[test]
    fn review_redaction_does_not_rewrap_an_existing_marker() {
        let (out, hit) = redact_review_secrets("token: AKIAIOSFODNN7EXAMPLE");
        assert!(hit);
        assert_eq!(out, "token: [redacted:aws_key]");
    }

    #[test]
    fn review_redaction_still_catches_structured_secrets_from_command_secrets() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let (out, hit) = redact_review_secrets(&format!("curl -H \"Authorization: Bearer {jwt}\""));
        assert!(hit);
        assert!(out.contains("[redacted:jwt]"), "{out}");
    }

    #[test]
    fn entropy_pass_leaves_real_paths_intact() {
        for path in [
            "/home/dev/.claude-personal/projects/-home-dev-projects-houston",
            "/home/dev/projects/houston/core/houston-core/src/sanitize",
            "spawned claude in /home/dev/projects/houston",
            "/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0",
        ] {
            let (out, hit) = redact_high_entropy(path);
            assert!(!hit, "path was redacted: {path} -> {out}");
            assert_eq!(out, path);
        }
    }

    #[test]
    fn entropy_pass_still_catches_a_real_secret() {
        let secret = "aGVsbG9Xb3JsZFRoaXNJc0FWZXJ5TG9uZ1NlY3JldEtleQ+PQ==";
        let (out, hit) = redact_high_entropy(&format!("token {secret} end"));
        assert!(hit, "secret survived: {out}");
        assert!(out.contains("[redacted:high_entropy]"), "{out}");
        assert!(
            out.starts_with("token "),
            "surrounding text is preserved: {out}"
        );
        assert!(out.ends_with(" end"), "{out}");
    }

    #[test]
    fn a_secret_split_by_a_slash_is_knowingly_missed() {
        let halves = "aGVsbG9Xb3JsZFRoaXNJc0E5";
        let split = format!("{halves}/{halves}");
        assert!(
            split.len() >= ENTROPY_MIN_LEN,
            "the joined run clears the floor"
        );
        assert!(
            halves.len() < ENTROPY_MIN_LEN,
            "each half is below it, which is the whole mechanism"
        );
        let (_, hit) = redact_high_entropy(&split);
        assert!(
            !hit,
            "documented gap: a `/` splits this below the length floor"
        );
    }
}

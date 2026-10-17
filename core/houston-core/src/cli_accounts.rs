//! The identity each agent CLI is signed in to, read from its own local files.
//! Only identifiers leave a file; a token is decoded in memory and never stored or sent.

use crate::agent_hooks::ConfigHome;
use crate::host_env::HostEnv;
use base64::Engine;
use houston_protocol::{AgentAccountIdentity, AgentKind, AgentSignIn};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

/// `~/.claude.json` also holds per-project history and grows with use; 8 MiB covers heavy
/// accounts while keeping a runaway file from stalling a Settings refresh.
const CLAUDE_FILE_LIMIT: u64 = 8 * 1024 * 1024;
/// Auth stores hold a few provider entries or one token set, well under 64 KiB in practice.
const AUTH_FILE_LIMIT: u64 = 256 * 1024;

/// A Houston account profile: an alternate config directory for one CLI.
pub struct ProfileDir {
    pub id: u32,
    pub agent: AgentKind,
    pub config_dir: PathBuf,
}

/// Why a file produced no identity.
enum ReadFailure {
    Missing(PathBuf),
    Failed(String),
}

fn read_bounded(path: &Path, limit: u64) -> Result<String, ReadFailure> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReadFailure::Missing(path.to_path_buf()))
        }
        Err(e) => return Err(ReadFailure::Failed(format!("{}: {e}", path.display()))),
    };
    let mut text = String::new();
    // One byte past the limit distinguishes "exactly at the limit" from "over it".
    if let Err(e) = file.take(limit + 1).read_to_string(&mut text) {
        return Err(ReadFailure::Failed(format!("{}: {e}", path.display())));
    }
    if text.len() as u64 > limit {
        return Err(ReadFailure::Failed(format!(
            "{} is larger than Houston's read limit of {limit} bytes",
            path.display()
        )));
    }
    Ok(text)
}

fn parse_json(path: &Path, text: &str) -> Result<Value, ReadFailure> {
    serde_json::from_str(text).map_err(|e| {
        ReadFailure::Failed(format!(
            "{} is not valid JSON (expected an object): {e}",
            path.display()
        ))
    })
}

fn row(agent: AgentKind, profile_id: Option<u32>, verified: bool) -> AgentAccountIdentity {
    AgentAccountIdentity {
        agent,
        profile_id,
        sign_in: AgentSignIn::SignedOut,
        identity: None,
        detail: None,
        providers: Vec::new(),
        reason: None,
        verified,
    }
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Claude Code: `oauthAccount.emailAddress` (and `organizationName`) in the global config
/// file, `~/.claude.json` or `<CLAUDE_CONFIG_DIR>/.claude.json`.
pub fn claude_identity(file: &Path, profile_id: Option<u32>) -> AgentAccountIdentity {
    let mut out = row(AgentKind::Claude, profile_id, true);
    let root = match read_bounded(file, CLAUDE_FILE_LIMIT).and_then(|t| parse_json(file, &t)) {
        Ok(root) => root,
        Err(ReadFailure::Missing(path)) => {
            out.reason = Some(format!("{} does not exist", path.display()));
            return out;
        }
        Err(ReadFailure::Failed(reason)) => {
            out.reason = Some(reason);
            return out;
        }
    };
    let account = root.get("oauthAccount");
    match non_empty(account.and_then(|a| a.get("emailAddress"))) {
        Some(email) => {
            out.sign_in = AgentSignIn::SignedIn;
            out.identity = Some(email);
            out.detail = non_empty(account.and_then(|a| a.get("organizationName")));
        }
        None => {
            out.reason = Some(format!(
                "{} has no oauthAccount.emailAddress; Claude Code may be using an API key",
                file.display()
            ));
        }
    }
    out
}

/// Codex: `auth.json` in `CODEX_HOME`. A ChatGPT sign-in carries its email in the
/// `id_token` JWT payload (decoded without checking the signature: Houston only displays
/// it); an API-key sign-in has no identifier to show.
pub fn codex_identity(codex_home: &Path, profile_id: Option<u32>) -> AgentAccountIdentity {
    let file = codex_home.join("auth.json");
    let mut out = row(AgentKind::Codex, profile_id, true);
    let root = match read_bounded(&file, AUTH_FILE_LIMIT).and_then(|t| parse_json(&file, &t)) {
        Ok(root) => root,
        Err(ReadFailure::Missing(path)) => {
            out.reason = Some(format!("{} does not exist", path.display()));
            return out;
        }
        Err(ReadFailure::Failed(reason)) => {
            out.reason = Some(reason);
            return out;
        }
    };
    let has_key = non_empty(root.get("OPENAI_API_KEY")).is_some();
    let mode = root.get("auth_mode").and_then(Value::as_str);
    let id_token = non_empty(root.get("tokens").and_then(|t| t.get("id_token")));
    if mode.is_some_and(|m| m.eq_ignore_ascii_case("apikey")) || (id_token.is_none() && has_key) {
        out.sign_in = AgentSignIn::SignedIn;
        out.identity = Some("API key".to_string());
        return out;
    }
    let Some(token) = id_token else {
        out.reason = Some(format!(
            "{} has neither tokens.id_token nor an API key",
            file.display()
        ));
        return out;
    };
    match jwt_payload(&token) {
        Some(claims) => {
            let email = non_empty(claims.get("email")).or_else(|| {
                non_empty(
                    claims
                        .get("https://api.openai.com/profile")
                        .and_then(|p| p.get("email")),
                )
            });
            out.sign_in = AgentSignIn::SignedIn;
            out.detail = non_empty(
                claims
                    .get("https://api.openai.com/auth")
                    .and_then(|a| a.get("chatgpt_plan_type")),
            );
            if email.is_none() {
                out.reason = Some("tokens.id_token carries no email claim".to_string());
            }
            out.identity = email;
        }
        None => {
            out.reason = Some(format!(
                "{}: tokens.id_token is not a decodable JWT (expected three dot-separated base64url parts)",
                file.display()
            ));
        }
    }
    out
}

fn jwt_payload(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let (_, payload, _) = (parts.next()?, parts.next()?, parts.next()?);
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok().filter(Value::is_object)
}

/// OpenCode: the top-level keys of `auth.json` in its data directory name the providers
/// it holds credentials for. OpenCode 2 imports that file into its database and stops
/// writing it, so a missing file proves nothing.
pub fn opencode_identity(file: &Path) -> AgentAccountIdentity {
    let mut out = row(AgentKind::Opencode, None, true);
    let root = match read_bounded(file, AUTH_FILE_LIMIT).and_then(|t| parse_json(file, &t)) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            out.reason = Some(format!(
                "{} is not a JSON object of provider entries",
                file.display()
            ));
            return out;
        }
        Err(ReadFailure::Missing(path)) => {
            out.sign_in = AgentSignIn::Unknown;
            out.reason = Some(format!(
                "{} does not exist; OpenCode 2 keeps credentials in its database, which Houston does not read",
                path.display()
            ));
            return out;
        }
        Err(ReadFailure::Failed(reason)) => {
            out.reason = Some(reason);
            return out;
        }
    };
    let mut providers: Vec<String> = root.keys().cloned().collect();
    providers.sort();
    if providers.is_empty() {
        out.reason = Some(format!("{} lists no providers", file.display()));
    } else {
        out.sign_in = AgentSignIn::SignedIn;
        out.providers = providers;
    }
    out
}

/// Antigravity: no non-secret identifier is verified, so only the presence of its OAuth
/// token file is reported. On Linux and macOS the CLI may hold the token in the OS keyring
/// instead, so an absent file is `unknown`, not `signed_out`.
pub fn antigravity_identity(home: &Path) -> AgentAccountIdentity {
    let file = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("antigravity-oauth-token");
    let mut out = row(AgentKind::Antigravity, None, false);
    match std::fs::metadata(&file) {
        Ok(meta) if meta.is_file() && meta.len() > 0 => {
            out.sign_in = AgentSignIn::SignedIn;
        }
        Ok(_) => {
            out.reason = Some(format!("{} is empty or not a file", file.display()));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            out.sign_in = AgentSignIn::Unknown;
            out.reason = Some(format!(
                "{} does not exist; the token may be in the OS keyring",
                file.display()
            ));
        }
        Err(e) => {
            out.sign_in = AgentSignIn::Unknown;
            out.reason = Some(format!("{}: {e}", file.display()));
        }
    }
    out
}

fn zcode_identity() -> AgentAccountIdentity {
    let mut out = row(AgentKind::Zcode, None, false);
    out.sign_in = AgentSignIn::Unknown;
    out.reason = Some("ZCode does not document where it keeps its sign-in".to_string());
    out
}

fn env_dir(env: &HostEnv, name: &str) -> Option<PathBuf> {
    env.var_os(name)
        .filter(|v| !v.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn claude_file(dir: &Path) -> PathBuf {
    dir.join(".claude.json")
}

fn opencode_auth_path(env: &HostEnv, home: &ConfigHome) -> PathBuf {
    env_dir(env, "XDG_DATA_HOME")
        .unwrap_or_else(|| home.home.join(".local").join("share"))
        .join("opencode")
        .join("auth.json")
}

/// Blocking: reads a handful of small files. Call off the async runtime.
pub fn read_all(
    env: &HostEnv,
    home: &ConfigHome,
    profiles: &[ProfileDir],
) -> Vec<AgentAccountIdentity> {
    let mut rows = Vec::with_capacity(5 + profiles.len());
    let claude_default = match env_dir(env, "CLAUDE_CONFIG_DIR") {
        Some(dir) => claude_file(&dir),
        None => home.home.join(".claude.json"),
    };
    rows.push(claude_identity(&claude_default, None));
    let codex_default = env_dir(env, "CODEX_HOME").unwrap_or_else(|| home.home.join(".codex"));
    rows.push(codex_identity(&codex_default, None));
    rows.push(opencode_identity(&opencode_auth_path(env, home)));
    rows.push(antigravity_identity(&home.home));
    rows.push(zcode_identity());
    for profile in profiles {
        match profile.agent {
            AgentKind::Claude => rows.push(claude_identity(
                &claude_file(&profile.config_dir),
                Some(profile.id),
            )),
            AgentKind::Codex => rows.push(codex_identity(&profile.config_dir, Some(profile.id))),
            _ => {}
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn jwt(payload: &str) -> String {
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!(
            "{}.{}.sig",
            enc.encode(r#"{"alg":"none"}"#),
            enc.encode(payload)
        )
    }

    #[test]
    fn claude_reads_email_and_organization() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            ".claude.json",
            r#"{"oauthAccount":{"emailAddress":"dev@example.com","organizationName":"Acme"},"projects":{}}"#,
        );
        let id = claude_identity(&file, None);
        assert_eq!(id.sign_in, AgentSignIn::SignedIn);
        assert_eq!(id.identity.as_deref(), Some("dev@example.com"));
        assert_eq!(id.detail.as_deref(), Some("Acme"));
    }

    #[test]
    fn claude_without_oauth_account_is_signed_out_with_reason() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(dir.path(), ".claude.json", r#"{"mcpServers":{}}"#);
        let id = claude_identity(&file, Some(3));
        assert_eq!(id.sign_in, AgentSignIn::SignedOut);
        assert_eq!(id.profile_id, Some(3));
        assert!(id.reason.unwrap().contains("oauthAccount.emailAddress"));
    }

    #[test]
    fn claude_missing_and_malformed_files_never_panic() {
        let dir = tempfile::tempdir().unwrap();
        let missing = claude_identity(&dir.path().join(".claude.json"), None);
        assert_eq!(missing.sign_in, AgentSignIn::SignedOut);
        assert!(missing.reason.unwrap().contains("does not exist"));
        let file = write(dir.path(), ".claude.json", "{not json");
        let bad = claude_identity(&file, None);
        assert_eq!(bad.sign_in, AgentSignIn::SignedOut);
        assert!(bad.reason.unwrap().contains("not valid JSON"));
    }

    #[test]
    fn oversized_file_names_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(AUTH_FILE_LIMIT as usize));
        let file = write(dir.path(), "auth.json", &big);
        let id = opencode_identity(&file);
        assert!(id.reason.unwrap().contains(&AUTH_FILE_LIMIT.to_string()));
        assert_eq!(id.sign_in, AgentSignIn::SignedOut);
    }

    #[test]
    fn codex_reads_email_and_plan_from_the_id_token() {
        let dir = tempfile::tempdir().unwrap();
        let token = jwt(
            r#"{"email":"dev@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#,
        );
        write(
            dir.path(),
            "auth.json",
            &format!(
                r#"{{"auth_mode":"chatgpt","tokens":{{"id_token":"{token}","access_token":"a","refresh_token":"r"}}}}"#
            ),
        );
        let id = codex_identity(dir.path(), None);
        assert_eq!(id.sign_in, AgentSignIn::SignedIn);
        assert_eq!(id.identity.as_deref(), Some("dev@example.com"));
        assert_eq!(id.detail.as_deref(), Some("plus"));
        let wire = serde_json::to_string(&id).unwrap();
        assert!(!wire.contains(&token), "the token must not ride the wire");
    }

    #[test]
    fn codex_falls_back_to_the_profile_email_claim() {
        let dir = tempfile::tempdir().unwrap();
        let token = jwt(r#"{"https://api.openai.com/profile":{"email":"p@example.com"}}"#);
        write(
            dir.path(),
            "auth.json",
            &format!(r#"{{"tokens":{{"id_token":"{token}"}}}}"#),
        );
        assert_eq!(
            codex_identity(dir.path(), None).identity.as_deref(),
            Some("p@example.com")
        );
    }

    #[test]
    fn codex_api_key_reports_no_identifier() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "auth.json",
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-synthetic"}"#,
        );
        let id = codex_identity(dir.path(), None);
        assert_eq!(id.sign_in, AgentSignIn::SignedIn);
        assert_eq!(id.identity.as_deref(), Some("API key"));
        assert!(!serde_json::to_string(&id).unwrap().contains("sk-synthetic"));
    }

    #[test]
    fn codex_missing_and_malformed_inputs_are_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let missing = codex_identity(dir.path(), None);
        assert_eq!(missing.sign_in, AgentSignIn::SignedOut);
        assert!(missing.reason.unwrap().contains("does not exist"));
        write(
            dir.path(),
            "auth.json",
            r#"{"tokens":{"id_token":"not-a-jwt"}}"#,
        );
        let bad = codex_identity(dir.path(), None);
        assert_eq!(bad.sign_in, AgentSignIn::SignedOut);
        assert!(bad.reason.unwrap().contains("not a decodable JWT"));
        write(dir.path(), "auth.json", "[1,2");
        assert!(codex_identity(dir.path(), None)
            .reason
            .unwrap()
            .contains("not valid JSON"));
    }

    #[test]
    fn opencode_lists_provider_names_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = write(
            dir.path(),
            "auth.json",
            r#"{"openai":{"type":"oauth","access":"a","refresh":"r"},"anthropic":{"type":"api","key":"sk-synthetic"}}"#,
        );
        let id = opencode_identity(&file);
        assert_eq!(id.sign_in, AgentSignIn::SignedIn);
        assert_eq!(id.providers, vec!["anthropic", "openai"]);
        assert!(!serde_json::to_string(&id).unwrap().contains("sk-synthetic"));
    }

    #[test]
    fn opencode_missing_is_unknown_and_malformed_is_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let missing = opencode_identity(&dir.path().join("auth.json"));
        assert_eq!(missing.sign_in, AgentSignIn::Unknown);
        let file = write(dir.path(), "auth.json", "[]");
        assert_eq!(opencode_identity(&file).sign_in, AgentSignIn::SignedOut);
        let file = write(dir.path(), "auth.json", "{}");
        assert_eq!(opencode_identity(&file).sign_in, AgentSignIn::SignedOut);
        let file = write(dir.path(), "auth.json", "nope");
        assert!(opencode_identity(&file)
            .reason
            .unwrap()
            .contains("not valid JSON"));
    }

    #[test]
    fn antigravity_reports_presence_only_and_is_unverified() {
        let home = tempfile::tempdir().unwrap();
        let absent = antigravity_identity(home.path());
        assert_eq!(absent.sign_in, AgentSignIn::Unknown);
        assert!(!absent.verified);
        let dir = home.path().join(".gemini").join("antigravity-cli");
        std::fs::create_dir_all(&dir).unwrap();
        write(&dir, "antigravity-oauth-token", "synthetic-secret");
        let present = antigravity_identity(home.path());
        assert_eq!(present.sign_in, AgentSignIn::SignedIn);
        assert!(present.identity.is_none());
        assert!(!serde_json::to_string(&present)
            .unwrap()
            .contains("synthetic-secret"));
    }

    #[test]
    fn read_all_covers_default_and_profile_directories() {
        let home = tempfile::tempdir().unwrap();
        write(
            home.path(),
            ".claude.json",
            r#"{"oauthAccount":{"emailAddress":"default@example.com"}}"#,
        );
        let work = home.path().join("claude-work");
        std::fs::create_dir_all(&work).unwrap();
        write(
            &work,
            ".claude.json",
            r#"{"oauthAccount":{"emailAddress":"work@example.com"}}"#,
        );
        let env = HostEnv::from_pairs([("HOME", home.path().as_os_str().to_owned())]);
        let config_home = ConfigHome::from_env(&env).unwrap();
        let rows = read_all(
            &env,
            &config_home,
            &[ProfileDir {
                id: 7,
                agent: AgentKind::Claude,
                config_dir: work,
            }],
        );
        let claude: Vec<_> = rows
            .iter()
            .filter(|r| r.agent == AgentKind::Claude)
            .collect();
        assert_eq!(claude.len(), 2);
        assert_eq!(claude[0].identity.as_deref(), Some("default@example.com"));
        assert_eq!(claude[1].profile_id, Some(7));
        assert_eq!(claude[1].identity.as_deref(), Some("work@example.com"));
        assert!(rows
            .iter()
            .any(|r| r.agent == AgentKind::Zcode && r.sign_in == AgentSignIn::Unknown));
    }

    #[test]
    fn opencode_honours_xdg_data_home() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data.path().join("opencode")).unwrap();
        write(
            &data.path().join("opencode"),
            "auth.json",
            r#"{"openai":{}}"#,
        );
        let env = HostEnv::from_pairs([
            ("HOME", std::ffi::OsString::from("/nonexistent-home")),
            ("XDG_DATA_HOME", data.path().as_os_str().to_owned()),
        ]);
        let home = ConfigHome::from_env(&env).unwrap();
        let rows = read_all(&env, &home, &[]);
        let opencode = rows
            .iter()
            .find(|r| r.agent == AgentKind::Opencode)
            .unwrap();
        assert_eq!(opencode.providers, vec!["openai"]);
    }
}

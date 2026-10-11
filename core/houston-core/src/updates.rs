use anyhow::anyhow;
use houston_protocol as proto;
use std::cmp::Ordering;
use std::time::Duration;

use crate::daemon::Daemon;

// The settings row that carries the on/off choice; absent means on.
const UPDATES_CHECK_KEY: &str = "updates_check";
// Check frequently enough to surface new releases and models within the working day.
pub(crate) const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
// The Tauri updater manifest the desktop app also reads. Unlike the REST API it has no
// 60-requests-per-hour anonymous quota shared by everyone behind one public IP. One
// constant, so a repository rename moves one line.
const UPDATE_MANIFEST_URL: &str =
    "https://github.com/theogmiguel/houston/releases/latest/download/latest.json";
// Release page for a version; the manifest carries notes but not a page URL.
const RELEASE_PAGE_PREFIX: &str = "https://github.com/theogmiguel/houston/releases/tag/v";
/// Replaces the manifest URL. Tests set it so no daemon reaches the real endpoint.
pub const UPDATE_MANIFEST_URL_ENV: &str = "HOUSTON_UPDATE_MANIFEST_URL";
// GitHub refuses a request with no User-Agent. This one names the product and
// nothing else: no version, no OS, no identifier.
const USER_AGENT: &str = "houston";
// A check that outlives this is a hung request, not a slow release.
const REQUEST_TIMEOUT_SECS: u64 = 10;

#[derive(Default)]
pub(crate) struct ReleaseCache {
    etag: Option<String>,
    release: Option<Option<proto::UpdateRelease>>,
}

/// Compares two `MAJOR.MINOR.PATCH` strings, tolerating a leading `v` and ignoring
/// any prerelease or build suffix. Anything unparseable compares `Equal`, so an
/// unknown remote version is never read as newer.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    match (parse_semver(a), parse_semver(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => Ordering::Equal,
    }
}

fn trim_version(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('v').unwrap_or(s)
}

/// Whether two strings name the same release exactly, build metadata included.
/// `compare_versions` reads unparseable input as `Equal`, which is wrong for
/// "is this the release the operator was shown".
pub fn same_release(a: &str, b: &str) -> bool {
    let a = trim_version(a);
    let b = trim_version(b);
    !a.is_empty() && a == b && parse_semver(a).is_some()
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let core = s.split(['-', '+']).next().unwrap_or(s);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Stable offers only a strictly newer release; an equal or older version is
/// not an update.
pub fn is_newer(remote: &str, running: &str) -> bool {
    compare_versions(remote, running) == Ordering::Greater
}

fn first_chars(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Resolves an endpoint: the environment override when set and non-empty, else `default`.
pub(crate) fn endpoint(var: &str, default: &str) -> String {
    match std::env::var(var) {
        Ok(url) if !url.trim().is_empty() => url.trim().to_string(),
        _ => default.to_string(),
    }
}

/// Reads the `latest.json` updater manifest. A prerelease version is refused
/// unconditionally: an rc must never reach a stable install, and a candidate is installed
/// by hand. An error names the missing field and the body's first 200 characters.
fn parse_latest_release(body: &str) -> anyhow::Result<Option<proto::UpdateRelease>> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| {
        anyhow!(
            "latest.json body is not JSON ({e}); body starts: {}",
            first_chars(body)
        )
    })?;
    let raw = v
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "latest.json payload has no string `version` (expected `version`, optional `notes`); body starts: {}",
                first_chars(body)
            )
        })?;
    let version = trim_version(raw);
    if parse_semver(version).is_none() {
        return Err(anyhow!(
            "latest.json `version` is {raw:?}; expected MAJOR.MINOR.PATCH with an optional leading v"
        ));
    }
    if version.contains('-') {
        return Ok(None);
    }
    // `notes` is absent or null on a release with no description, which is a normal
    // state and reads as no notes rather than a failed check.
    let notes = v
        .get("notes")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Ok(Some(proto::UpdateRelease {
        version: version.to_string(),
        notes: notes.to_string(),
        notes_url: format!("{RELEASE_PAGE_PREFIX}{version}"),
    }))
}

/// Names the limit when GitHub throttles the check, instead of reqwest's bare status text.
fn status_error(url: &str, response: &reqwest::Response) -> anyhow::Error {
    let status = response.status();
    if status != reqwest::StatusCode::FORBIDDEN && status != reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return anyhow!("update check got HTTP {status} from {url}");
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let mut details = Vec::new();
    let limit = header("x-ratelimit-limit");
    let remaining = header("x-ratelimit-remaining");
    if let Some(limit) = &limit {
        details.push(format!("limit {limit} requests"));
    }
    if let (Some(Ok(limit)), Some(Ok(remaining))) = (
        limit.as_deref().map(str::parse::<u64>),
        remaining.as_deref().map(str::parse::<u64>),
    ) {
        details.push(format!("used {}", limit.saturating_sub(remaining)));
    }
    if let Some(remaining) = &remaining {
        details.push(format!("remaining {remaining}"));
    }
    if let Some(reset) = header("x-ratelimit-reset") {
        details.push(format!("resets at unix time {reset}"));
    }
    if let Some(retry) = header("retry-after") {
        details.push(format!("retry after {retry}s"));
    }
    let details = if details.is_empty() {
        "the server reported no rate-limit headers".to_string()
    } else {
        details.join(", ")
    };
    anyhow!("update check rate limited (HTTP {status}) by {url}: {details}")
}

impl Daemon {
    pub fn update_policy(&self) -> proto::UpdatePolicy {
        let check = match self.db().get_setting(UPDATES_CHECK_KEY) {
            Ok(Some(v)) => v != "0",
            _ => true,
        };
        // The stored `updates_channel` row is deliberately left in place,
        // inert: a migration to delete one dead row costs more than it returns,
        // and nothing reads it any more.
        proto::UpdatePolicy { check }
    }

    pub fn update_state(&self) -> proto::UpdateState {
        self.update_state.lock().expect("update_state lock").clone()
    }

    pub fn update_snapshot(&self) -> proto::ServerMsg {
        proto::ServerMsg::Update {
            policy: self.update_policy(),
            state: self.update_state(),
        }
    }

    pub fn update_policy_set(&self, policy: proto::UpdatePolicy) -> anyhow::Result<()> {
        self.db()
            .set_setting(UPDATES_CHECK_KEY, if policy.check { "1" } else { "0" })?;
        {
            let mut state = self.update_state.lock().expect("update_state lock");
            *state = if policy.check {
                proto::UpdateState::Unknown
            } else {
                proto::UpdateState::Disabled
            };
        }
        if policy.check {
            self.update_wake.notify_one();
        }
        Ok(())
    }

    pub async fn check_for_update(&self) {
        let _check = self.update_check_lock.lock().await;
        let policy = self.update_policy();
        if !policy.check {
            *self.update_state.lock().expect("update_state lock") = proto::UpdateState::Disabled;
            self.broadcast_control(&self.update_snapshot());
            return;
        }
        *self.update_state.lock().expect("update_state lock") = proto::UpdateState::Checking;
        self.broadcast_control(&self.update_snapshot());

        let state = match self
            .fetch_latest(&endpoint(UPDATE_MANIFEST_URL_ENV, UPDATE_MANIFEST_URL))
            .await
        {
            Ok(Some(release)) => {
                let checked_at_ms = crate::daemon::now_ms();
                if is_newer(&release.version, env!("CARGO_PKG_VERSION")) {
                    proto::UpdateState::Available {
                        release,
                        checked_at_ms,
                    }
                } else {
                    proto::UpdateState::UpToDate { checked_at_ms }
                }
            }
            Ok(None) => proto::UpdateState::UpToDate {
                checked_at_ms: crate::daemon::now_ms(),
            },
            Err(e) => proto::UpdateState::Failed {
                error: e.to_string(),
                checked_at_ms: crate::daemon::now_ms(),
            },
        };
        {
            let mut current = self.update_state.lock().expect("update_state lock");
            if !self.update_policy().check {
                *current = proto::UpdateState::Disabled;
            } else {
                *current = state;
            }
        }
        self.broadcast_control(&self.update_snapshot());
    }

    async fn fetch_latest(&self, url: &str) -> anyhow::Result<Option<proto::UpdateRelease>> {
        // Hold the cache lock across the request so a manual check cannot race
        // the scheduled check and replace a newer validator with an older one.
        let mut cache = self.release_cache.lock().await;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .user_agent(USER_AGENT)
            .build()?;
        let mut request = client.get(url);
        if let Some(etag) = &cache.etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag.as_str());
        }
        let response = request.send().await?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            if cache.etag.is_none() {
                return Err(anyhow!(
                    "latest.json returned 304 without a cached validator"
                ));
            }
            let release = cache
                .release
                .clone()
                .ok_or_else(|| anyhow!("latest.json returned 304 without a cached release"))?;
            if let Some(etag) = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
            {
                cache.etag = Some(etag.to_owned());
            }
            return Ok(release);
        }
        if !response.status().is_success() {
            return Err(status_error(url, &response));
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.text().await?;
        let release = parse_latest_release(&body)?;
        cache.etag = etag;
        cache.release = Some(release.clone());
        Ok(release)
    }

    pub async fn update_check_loop(&self) {
        loop {
            self.check_for_update().await;
            self.refresh_model_catalog(true).await;
            tokio::select! {
                _ = self.update_wake.notified() => {}
                _ = tokio::time::sleep(UPDATE_CHECK_INTERVAL) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn scripted_release_server(
        responses: Vec<String>,
    ) -> (String, Arc<StdMutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/latest", listener.local_addr().unwrap());
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let read = stream.read(&mut request).await.unwrap();
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request[..read]).into_owned());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, requests)
    }

    #[tokio::test]
    async fn release_etag_reuses_the_last_good_payload_across_304_and_failure() {
        let payload = r#"{"version":"99.0.0","notes":"n"}"#;
        let ok = format!(
            "HTTP/1.1 200 OK\r\nETag: \"release-1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        let responses = vec![
            ok,
            "HTTP/1.1 304 Not Modified\r\nETag: \"release-2\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            "HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        ];
        let (url, requests) = scripted_release_server(responses).await;
        let dir = tempfile::tempdir().unwrap();
        let daemon = crate::daemon::Daemon::new(crate::daemon::DaemonConfig {
            token: "test-token-0000-0000-000000000000".to_string(),
            db_path: dir.path().join("test.db"),
        })
        .unwrap();

        let first = daemon.fetch_latest(&url).await.unwrap().unwrap();
        assert_eq!(first.version, "99.0.0");
        assert_eq!(
            daemon.fetch_latest(&url).await.unwrap(),
            Some(first.clone())
        );
        assert!(daemon.fetch_latest(&url).await.is_err());
        assert_eq!(daemon.fetch_latest(&url).await.unwrap(), Some(first));

        let requests = requests.lock().unwrap();
        assert!(!requests[0].contains("if-none-match"));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("if-none-match: \"release-1\""));
        for request in &requests[2..] {
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("if-none-match: \"release-2\""),
                "rotated conditional validator missing from request: {request}"
            );
        }
    }

    #[test]
    fn equal_versions_compare_equal() {
        assert_eq!(compare_versions("1.2.3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare_versions("v1.2.3", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn greater_patch_minor_major_compare_greater() {
        assert_eq!(compare_versions("1.2.4", "1.2.3"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.3", "1.2.4"), Ordering::Less);
        assert_eq!(compare_versions("1.3.0", "1.2.99"), Ordering::Greater);
        assert_eq!(compare_versions("2.0.0", "1.99.99"), Ordering::Greater);
    }

    #[test]
    fn numeric_not_lexicographic() {
        assert_eq!(compare_versions("0.10.0", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.9.0", "0.10.0"), Ordering::Less);
    }

    #[test]
    fn prerelease_suffix_is_ignored() {
        assert_eq!(compare_versions("1.2.3-rc.1", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn unparseable_compares_equal() {
        assert_eq!(compare_versions("latest", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn same_release_demands_the_full_identity() {
        assert!(same_release("1.2.3", "v1.2.3"));
        assert!(same_release("0.11.0-rc.1", "0.11.0-rc.1"));
        assert!(
            !same_release("0.11.0-rc.1", "0.11.0-rc.2"),
            "a moved candidate is a different release"
        );
        assert!(
            !same_release("0.11.0-rc.1", "0.11.0"),
            "the base version is not the candidate's identity"
        );
        assert!(
            !same_release("latest", "latest"),
            "an unidentifiable name never matches anything, even itself"
        );
        assert!(!same_release("", ""));
        assert!(!same_release("1.2.3", "1.2.4"));
    }

    #[test]
    fn a_prerelease_version_is_refused_unconditionally() {
        let pre = r#"{"version":"1.3.0-rc.1","notes":"n","pub_date":"2026-01-01T00:00:00Z","platforms":{}}"#;
        assert!(
            parse_latest_release(pre).unwrap().is_none(),
            "a release candidate must never be offered to a stable install"
        );
    }

    #[test]
    fn only_a_strictly_newer_release_is_an_update() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
    }

    #[test]
    fn realistic_manifest_picks_version_notes_and_builds_the_release_page() {
        let body = r###"{
          "version": "v1.2.3",
          "notes": "## What changed\n\n- a fix\n- a feature",
          "pub_date": "2026-01-01T00:00:00Z",
          "platforms": {"linux-x86_64": {"signature": "s", "url": "https://example.com/Houston.AppImage"}}
        }"###;
        let release = parse_latest_release(body).unwrap().expect("a release");
        assert_eq!(release.version, "1.2.3", "the leading v is stripped");
        assert_eq!(
            release.notes, "## What changed\n\n- a fix\n- a feature",
            "the notes ride through verbatim"
        );
        assert_eq!(
            release.notes_url,
            "https://github.com/theogmiguel/houston/releases/tag/v1.2.3"
        );
    }

    #[test]
    fn a_manifest_with_no_notes_carries_empty_notes() {
        let release = parse_latest_release(r#"{"version":"1.2.3","notes":null}"#)
            .unwrap()
            .expect("a release");
        assert_eq!(release.notes, "");
        let release = parse_latest_release(r#"{"version":"1.2.3"}"#)
            .unwrap()
            .expect("a release");
        assert_eq!(release.notes, "");
    }

    #[test]
    fn missing_version_error_names_the_field() {
        let err = parse_latest_release(r#"{"notes":"n"}"#).unwrap_err();
        assert!(err.to_string().contains("`version`"), "{err}");
    }

    #[test]
    fn unparseable_version_error_names_the_value_and_shape() {
        let err = parse_latest_release(r#"{"version":"latest"}"#).unwrap_err();
        let text = err.to_string();
        assert!(
            text.contains("\"latest\"") && text.contains("MAJOR.MINOR.PATCH"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_rate_limited_check_names_the_limit_the_usage_the_reset_and_the_url() {
        let responses = vec![
            "HTTP/1.1 403 Forbidden\r\nx-ratelimit-limit: 60\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: 1760000000\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            "HTTP/1.1 429 Too Many Requests\r\nretry-after: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        ];
        let (url, _requests) = scripted_release_server(responses).await;
        let dir = tempfile::tempdir().unwrap();
        let daemon = crate::daemon::Daemon::new(crate::daemon::DaemonConfig {
            token: "test-token-0000-0000-000000000000".to_string(),
            db_path: dir.path().join("test.db"),
        })
        .unwrap();

        let text = daemon.fetch_latest(&url).await.unwrap_err().to_string();
        for want in [
            "rate limited",
            "403",
            "limit 60",
            "used 60",
            "remaining 0",
            "1760000000",
            &url,
        ] {
            assert!(text.contains(want), "{want:?} missing from: {text}");
        }
        let text = daemon.fetch_latest(&url).await.unwrap_err().to_string();
        for want in ["rate limited", "429", "retry after 120s", &url] {
            assert!(text.contains(want), "{want:?} missing from: {text}");
        }
        let text = daemon.fetch_latest(&url).await.unwrap_err().to_string();
        assert!(text.contains("500") && text.contains(&url), "{text}");
        assert!(!text.contains("rate limited"), "{text}");
    }

    // Switching the check off must not leave a standing "0.11.0 is available" over a
    // setting that says Houston is not looking. Here rather than in the wire test because
    // seeding the state needs the crate-private field.
    #[test]
    fn switching_the_setting_off_clears_a_standing_offer() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = crate::daemon::Daemon::new(crate::daemon::DaemonConfig {
            token: "test-token-0000-0000-000000000000".to_string(),
            db_path: dir.path().join("test.db"),
        })
        .unwrap();

        *daemon.update_state.lock().unwrap() = proto::UpdateState::Available {
            release: proto::UpdateRelease {
                version: "99.0.0".to_string(),
                notes: "notes".to_string(),
                notes_url: "https://example.com/r".to_string(),
            },
            checked_at_ms: 1,
        };

        daemon
            .update_policy_set(proto::UpdatePolicy { check: false })
            .unwrap();

        assert_eq!(daemon.update_state(), proto::UpdateState::Disabled);
    }
}

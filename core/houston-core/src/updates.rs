use anyhow::anyhow;
use houston_protocol as proto;
use std::cmp::Ordering;
use std::time::Duration;

use crate::daemon::Daemon;

// The settings row that carries the on/off choice; absent means on.
const UPDATES_CHECK_KEY: &str = "updates_check";
// The settings row that carries the channel name; absent or unknown means Stable.
const UPDATES_CHANNEL_KEY: &str = "updates_channel";
// One request a day sits far below any rate limit, and a release is never
// more urgent than that.
const CHECK_INTERVAL_HOURS: u64 = 24;
// The repository the four manifests name. One constant, so a rename moves one line.
const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/theogmiguel/houston/releases/latest";
// The nightly prerelease is a rolling tag, so it is fetched by name: `releases/latest`
// is documented to skip prereleases and would never return it.
const RELEASES_NIGHTLY_URL: &str =
    "https://api.github.com/repos/theogmiguel/houston/releases/tags/nightly";
// The nightly release title, as the publish workflow files it. The moving tag
// carries no version, so this title is the only release identity on the payload.
const NIGHTLY_TITLE_PREFIX: &str = "Houston nightly ";

fn releases_url(channel: proto::UpdateChannel) -> &'static str {
    match channel {
        proto::UpdateChannel::Stable => RELEASES_LATEST_URL,
        proto::UpdateChannel::Nightly => RELEASES_NIGHTLY_URL,
    }
}
// GitHub refuses a request with no User-Agent. This one names the product and
// nothing else: no version, no OS, no identifier.
const USER_AGENT: &str = "houston";
// A check that outlives this is a hung request, not a slow release.
const REQUEST_TIMEOUT_SECS: u64 = 10;

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

/// The version the nightly release title (`Houston nightly <version>`, as the
/// publish workflow files it) carries; the moving `nightly` tag holds none. A
/// title outside that shape gives no identity to check an install against.
fn version_from_release_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(NIGHTLY_TITLE_PREFIX)?;
    let token = trim_version(rest);
    parse_semver(token).map(|_| token)
}

/// Whether the remote nightly names the commit this binary was built from, so
/// the same nightly is not offered forever after it is installed: the running
/// binary reports only its base `CARGO_PKG_VERSION`.
pub fn nightly_names_this_build(remote: &str, build_commit: &str) -> bool {
    if build_commit.is_empty() || build_commit == "unknown" {
        return false;
    }
    let Some((_, metadata)) = remote.split_once('+') else {
        return false;
    };
    let Some(rest) = metadata.strip_prefix("nightly.") else {
        return false;
    };
    rest.rsplit('.').next() == Some(build_commit)
}

/// The daemon's whole availability decision for one fetched release.
fn update_is_available(
    remote: &str,
    running: &str,
    channel: proto::UpdateChannel,
    build_commit: &str,
) -> bool {
    if channel == proto::UpdateChannel::Nightly && nightly_names_this_build(remote, build_commit) {
        return false;
    }
    is_newer(remote, running, channel)
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

/// Stable offers only a strictly newer release; a rolling nightly tag carries
/// whatever version `main` is at, usually the running one, so Nightly must also
/// offer an equal version.
pub fn is_newer(remote: &str, running: &str, channel: proto::UpdateChannel) -> bool {
    match compare_versions(remote, running) {
        Ordering::Greater => true,
        Ordering::Equal => channel == proto::UpdateChannel::Nightly,
        Ordering::Less => false,
    }
}

fn first_chars(s: &str) -> String {
    s.chars().take(200).collect()
}

/// Reads a release body, rejecting a draft on both channels and a prerelease on
/// Stable only. An error names the missing field and the body's first 200 characters.
fn parse_latest_release(
    body: &str,
    channel: proto::UpdateChannel,
) -> anyhow::Result<Option<proto::UpdateRelease>> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| {
        anyhow!(
            "releases/latest body is not JSON ({e}); body starts: {}",
            first_chars(body)
        )
    })?;
    let draft = v.get("draft").and_then(serde_json::Value::as_bool) == Some(true);
    let prerelease = v.get("prerelease").and_then(serde_json::Value::as_bool) == Some(true);
    if draft || (prerelease && channel == proto::UpdateChannel::Stable) {
        return Ok(None);
    }
    let tag = v
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "releases/latest payload has no string `tag_name`; body starts: {}",
                first_chars(body)
            )
        })?;
    let notes_url = v
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "releases/latest payload has no string `html_url`; body starts: {}",
                first_chars(body)
            )
        })?;
    // `body` is null on a release with no description, which is a normal state
    // and reads as no notes rather than a failed check.
    let notes = v
        .get("body")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let version = match channel {
        proto::UpdateChannel::Stable => tag.strip_prefix('v').unwrap_or(tag).to_string(),
        // The rolling `nightly` tag carries no version; the release title does.
        // A payload whose title does not is an error, never a release the panel
        // cannot identify and an install cannot pin.
        proto::UpdateChannel::Nightly => {
            let name = v
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    anyhow!(
                        "nightly release payload has no string `name` carrying its version; \
                         body starts: {}",
                        first_chars(body)
                    )
                })?;
            version_from_release_name(name)
                .ok_or_else(|| {
                    anyhow!(
                        "nightly release title {name:?} does not match the publish workflow's \
                         {NIGHTLY_TITLE_PREFIX:?}<version> shape; body starts: {}",
                        first_chars(body)
                    )
                })?
                .to_string()
        }
    };
    Ok(Some(proto::UpdateRelease {
        version,
        notes: notes.to_string(),
        notes_url: notes_url.to_string(),
    }))
}

impl Daemon {
    pub fn update_policy(&self) -> proto::UpdatePolicy {
        let check = match self.db().get_setting(UPDATES_CHECK_KEY) {
            Ok(Some(v)) => v != "0",
            _ => true,
        };
        // Only the exact stored string opts into nightly; an absent row or an
        // unrecognised value is Stable, the conservative side, never untested builds.
        let channel = match self.db().get_setting(UPDATES_CHANNEL_KEY) {
            Ok(Some(v)) if v == "nightly" => proto::UpdateChannel::Nightly,
            _ => proto::UpdateChannel::Stable,
        };
        proto::UpdatePolicy { check, channel }
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
        let stored = self.update_policy();
        self.db()
            .set_setting(UPDATES_CHECK_KEY, if policy.check { "1" } else { "0" })?;
        self.db().set_setting(
            UPDATES_CHANNEL_KEY,
            match policy.channel {
                proto::UpdateChannel::Stable => "stable",
                proto::UpdateChannel::Nightly => "nightly",
            },
        )?;
        let channel_changed = stored.channel != policy.channel;
        {
            let mut state = self.update_state.lock().expect("update_state lock");
            *state = if policy.check {
                proto::UpdateState::Unknown
            } else {
                proto::UpdateState::Disabled
            };
        }
        if policy.check || channel_changed {
            self.update_wake.notify_one();
        }
        Ok(())
    }

    pub async fn check_for_update(&self) {
        let policy = self.update_policy();
        if !policy.check {
            *self.update_state.lock().expect("update_state lock") = proto::UpdateState::Disabled;
            self.broadcast_control(&self.update_snapshot());
            return;
        }
        *self.update_state.lock().expect("update_state lock") = proto::UpdateState::Checking;
        self.broadcast_control(&self.update_snapshot());

        let state = match self.fetch_latest(policy.channel).await {
            Ok(Some(release)) => {
                let checked_at_ms = crate::daemon::now_ms();
                if update_is_available(
                    &release.version,
                    env!("CARGO_PKG_VERSION"),
                    policy.channel,
                    crate::daemon::build_commit(),
                ) {
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
        *self.update_state.lock().expect("update_state lock") = state;
        self.broadcast_control(&self.update_snapshot());
    }

    async fn fetch_latest(
        &self,
        channel: proto::UpdateChannel,
    ) -> anyhow::Result<Option<proto::UpdateRelease>> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .user_agent(USER_AGENT)
            .build()?;
        let response = client
            .get(releases_url(channel))
            .send()
            .await?
            .error_for_status()?;
        let body = response.text().await?;
        parse_latest_release(&body, channel)
    }

    pub async fn update_check_loop(&self) {
        self.check_for_update().await;
        let interval = Duration::from_secs(CHECK_INTERVAL_HOURS * 60 * 60);
        loop {
            tokio::select! {
                _ = self.update_wake.notified() => {}
                _ = tokio::time::sleep(interval) => {}
            }
            self.check_for_update().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(compare_versions("nightly", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn same_release_demands_the_full_identity() {
        assert!(same_release("1.2.3", "v1.2.3"));
        assert!(same_release(
            "0.10.0+nightly.20260916.abcdef1",
            "0.10.0+nightly.20260916.abcdef1"
        ));
        assert!(
            !same_release(
                "0.10.0+nightly.20260916.abcdef1",
                "0.10.0+nightly.20260917.abcdef1"
            ),
            "a moved nightly feed is a different release; build metadata is the identity"
        );
        assert!(
            !same_release("0.10.0+nightly.20260916.abcdef1", "0.10.0"),
            "the base version is not the nightly's identity"
        );
        assert!(
            !same_release("nightly", "nightly"),
            "an unidentifiable name never matches anything, even itself"
        );
        assert!(!same_release("", ""));
        assert!(!same_release("1.2.3", "1.2.4"));
    }

    #[test]
    fn a_nightly_release_takes_its_identity_from_the_release_title() {
        let body = r#"{"tag_name":"nightly","name":"Houston nightly 0.10.0+nightly.20260916.abcdef1","html_url":"https://example.com/r","prerelease":true,"body":"notes"}"#;
        let release = parse_latest_release(body, proto::UpdateChannel::Nightly)
            .unwrap()
            .expect("a release");
        assert_eq!(release.version, "0.10.0+nightly.20260916.abcdef1");
    }

    #[test]
    fn a_nightly_release_without_an_identifiable_title_is_an_error() {
        let cases = [
            (
                r#"{"tag_name":"nightly","html_url":"https://example.com/r","prerelease":true}"#,
                "name",
            ),
            (
                r#"{"tag_name":"nightly","name":null,"html_url":"https://example.com/r","prerelease":true}"#,
                "name",
            ),
            (
                r#"{"tag_name":"nightly","name":"Houston nightly","html_url":"https://example.com/r","prerelease":true}"#,
                "shape",
            ),
            (
                r#"{"tag_name":"nightly","name":"Houston nightly 1.2","html_url":"https://example.com/r","prerelease":true}"#,
                "shape",
            ),
            (
                r#"{"tag_name":"nightly","name":"Nightly 1.2.3","html_url":"https://example.com/r","prerelease":true}"#,
                "shape",
            ),
            (
                r#"{"tag_name":"nightly","name":"Houston nightly 1.2.3 extra","html_url":"https://example.com/r","prerelease":true}"#,
                "shape",
            ),
        ];
        for (body, expected) in cases {
            let err = parse_latest_release(body, proto::UpdateChannel::Nightly)
                .expect_err(&format!("must refuse: {body}"));
            assert!(err.to_string().contains(expected), "{err}");
        }
    }

    #[test]
    fn a_nightly_naming_this_build_is_not_an_update() {
        let commit = "abcdef1";
        assert!(!update_is_available(
            "0.10.0+nightly.20260916.abcdef1",
            "0.10.0",
            proto::UpdateChannel::Nightly,
            commit
        ));
        assert!(update_is_available(
            "0.10.0+nightly.20260917.1234567",
            "0.10.0",
            proto::UpdateChannel::Nightly,
            commit
        ));
        assert!(update_is_available(
            "0.11.0+nightly.20260917.1234567",
            "0.10.0",
            proto::UpdateChannel::Nightly,
            commit
        ));
        assert!(
            update_is_available("0.11.0", "0.10.0", proto::UpdateChannel::Stable, commit),
            "stable never carries nightly metadata; its rule is untouched"
        );
    }

    #[test]
    fn nightly_names_this_build_reads_only_the_controlled_suffix() {
        assert!(nightly_names_this_build(
            "0.10.0+nightly.20260916.abcdef1",
            "abcdef1"
        ));
        assert!(!nightly_names_this_build(
            "0.10.0+nightly.20260916.abcdef1",
            "1234567"
        ));
        assert!(!nightly_names_this_build("0.10.0", "abcdef1"));
        assert!(!nightly_names_this_build(
            "0.10.0+nightly.20260916.abcdef1",
            "unknown"
        ));
        assert!(!nightly_names_this_build(
            "0.10.0+nightly.20260916.abcdef1",
            ""
        ));
    }

    #[test]
    fn draft_and_prerelease_are_none() {
        let draft =
            r#"{"tag_name":"v1.2.3","html_url":"https://example.com/r","draft":true,"assets":[]}"#;
        assert!(parse_latest_release(draft, proto::UpdateChannel::Stable)
            .unwrap()
            .is_none());
        let pre = r#"{"tag_name":"v1.2.3","html_url":"https://example.com/r","prerelease":true,"assets":[]}"#;
        assert!(parse_latest_release(pre, proto::UpdateChannel::Stable)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prerelease_is_accepted_only_on_nightly() {
        let pre = r#"{"tag_name":"v1.2.3","name":"Houston nightly 1.2.3+nightly.20260916.abcdef1","html_url":"https://example.com/r","prerelease":true,"assets":[]}"#;
        assert!(parse_latest_release(pre, proto::UpdateChannel::Stable)
            .unwrap()
            .is_none());
        assert!(parse_latest_release(pre, proto::UpdateChannel::Nightly)
            .unwrap()
            .is_some());
    }

    #[test]
    fn draft_is_rejected_on_both_channels() {
        let draft =
            r#"{"tag_name":"v1.2.3","html_url":"https://example.com/r","draft":true,"assets":[]}"#;
        assert!(parse_latest_release(draft, proto::UpdateChannel::Stable)
            .unwrap()
            .is_none());
        assert!(parse_latest_release(draft, proto::UpdateChannel::Nightly)
            .unwrap()
            .is_none());
    }

    #[test]
    fn is_newer_stable_requires_strictly_greater() {
        assert!(is_newer("1.2.4", "1.2.3", proto::UpdateChannel::Stable));
        assert!(!is_newer("1.2.3", "1.2.3", proto::UpdateChannel::Stable));
        assert!(!is_newer("1.2.2", "1.2.3", proto::UpdateChannel::Stable));
    }

    #[test]
    fn is_newer_nightly_also_accepts_equal() {
        assert!(is_newer("1.2.4", "1.2.3", proto::UpdateChannel::Nightly));
        assert!(is_newer("1.2.3", "1.2.3", proto::UpdateChannel::Nightly));
        assert!(!is_newer("1.2.2", "1.2.3", proto::UpdateChannel::Nightly));
    }

    #[test]
    fn releases_url_differs_per_channel() {
        let stable = releases_url(proto::UpdateChannel::Stable);
        let nightly = releases_url(proto::UpdateChannel::Nightly);
        assert_ne!(stable, nightly);
        assert!(nightly.ends_with("/tags/nightly"), "{nightly}");
    }

    #[test]
    fn realistic_payload_picks_version_notes_and_release_page() {
        let body = r###"{
          "tag_name": "v1.2.3",
          "html_url": "https://github.com/theogmiguel/houston/releases/tag/v1.2.3",
          "body": "## What changed\n\n- a fix\n- a feature",
          "draft": false,
          "prerelease": false,
          "assets": [
            {"name":"Houston_1.2.3_amd64.AppImage","browser_download_url":"https://example.com/Houston.AppImage"}
          ]
        }"###;
        let release = parse_latest_release(body, proto::UpdateChannel::Stable)
            .unwrap()
            .expect("a release");
        assert_eq!(release.version, "1.2.3", "the leading v is stripped");
        assert_eq!(
            release.notes, "## What changed\n\n- a fix\n- a feature",
            "the release body rides through verbatim"
        );
        assert_eq!(
            release.notes_url,
            "https://github.com/theogmiguel/houston/releases/tag/v1.2.3"
        );
    }

    #[test]
    fn a_release_with_no_body_carries_empty_notes() {
        let body = r#"{"tag_name":"v1.2.3","html_url":"https://example.com/r","body":null}"#;
        let release = parse_latest_release(body, proto::UpdateChannel::Stable)
            .unwrap()
            .expect("a release");
        assert_eq!(release.notes, "");

        let body = r#"{"tag_name":"v1.2.3","html_url":"https://example.com/r"}"#;
        let release = parse_latest_release(body, proto::UpdateChannel::Stable)
            .unwrap()
            .expect("a release");
        assert_eq!(release.notes, "");
    }

    #[test]
    fn missing_tag_name_error_names_the_field() {
        let body = r#"{"html_url":"https://example.com/r","assets":[]}"#;
        let err = parse_latest_release(body, proto::UpdateChannel::Stable).unwrap_err();
        assert!(err.to_string().contains("tag_name"), "{err}");
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
            .update_policy_set(proto::UpdatePolicy {
                check: false,
                channel: proto::UpdateChannel::Stable,
            })
            .unwrap();

        assert_eq!(daemon.update_state(), proto::UpdateState::Disabled);
    }

    #[test]
    fn missing_html_url_error_names_the_field() {
        let body = r#"{"tag_name":"v1.2.3","assets":[]}"#;
        let err = parse_latest_release(body, proto::UpdateChannel::Stable).unwrap_err();
        assert!(err.to_string().contains("html_url"), "{err}");
    }
}

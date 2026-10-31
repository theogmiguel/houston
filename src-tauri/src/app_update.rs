//! The Rust half of signed click-to-update: fetch the fixed manifest, refuse
//! builds a manifest cannot name, hold the operator's version to what it
//! publishes, then let the plugin download, verify and install.

use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use serde_json::{json, Value};

// GitHub's `latest` alias, which by definition never serves a draft or a
// prerelease: the one endpoint an installed copy can be offered from.
const MANIFEST_URL: &str =
    "https://github.com/theogmiguel/houston/releases/latest/download/latest.json";

// Bound stalled requests while allowing a large installer on a slow connection.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

fn bounded_updater(
    builder: tauri_plugin_updater::UpdaterBuilder,
    check_timeout: Duration,
    idle_timeout: Duration,
) -> tauri_plugin_updater::UpdaterBuilder {
    builder
        .timeout(check_timeout)
        .configure_client(move |client| {
            client
                .connect_timeout(idle_timeout.min(Duration::from_secs(10)))
                .read_timeout(idle_timeout)
        })
}

fn bounded_download(
    mut update: tauri_plugin_updater::Update,
    timeout: Duration,
) -> tauri_plugin_updater::Update {
    // The plugin does not copy the check's timeout into the download.
    update.timeout = Some(timeout);
    update
}

/// The `platforms` key this bundle installs from: `{os}-{arch}-{installer}`,
/// e.g. `linux-x86_64-appimage`. Naming the installer exactly is what stops a
/// deb install from being handed the AppImage of the same version.
fn updater_target(bundle: BundleType, os_arch: Option<String>) -> Result<String, String> {
    let base = os_arch.ok_or_else(|| {
        "app_update_install: refusing: this OS/architecture is outside the updater's map \
         (linux/windows on x86_64/aarch64 are the shipped pair)"
            .to_string()
    })?;
    Ok(format!("{base}-{}", installer_name(bundle)))
}

fn installer_name(bundle: BundleType) -> &'static str {
    match bundle {
        BundleType::Deb => "deb",
        BundleType::Rpm => "rpm",
        BundleType::AppImage => "appimage",
        BundleType::Msi => "msi",
        BundleType::Nsis => "nsis",
        BundleType::App => "app",
        BundleType::Dmg => "dmg",
    }
}

/// Stable installs only a strictly newer version; an equal or older manifest is
/// not an update.
fn offers_update(running: &str, manifest: &str) -> bool {
    crate::sys::updates::is_newer(manifest, running)
}

fn updater_error(
    phase: &str,
    endpoint: &str,
    target: &str,
    err: tauri_plugin_updater::Error,
) -> String {
    use tauri_plugin_updater::Error;
    match err {
        Error::TargetsNotFound(_searched) => format!(
            "app_update_install: {endpoint} carries no entry for target {target:?}; this \
             release does not ship an installer for this platform, so there is nothing to \
             install"
        ),
        Error::TargetNotFound(missing) => format!(
            "app_update_install: {endpoint} does not publish {missing:?}, the updater artifact \
             this build needs"
        ),
        Error::Minisign(err) => format!(
            "app_update_install: refusing the downloaded update: its signature does not verify \
             against the configured public key ({err}). Nothing was installed"
        ),
        other => format!(
            "app_update_install: {phase} the update for target {target:?} from {endpoint} \
             failed: {other}"
        ),
    }
}

/// Emitted after every v2 update state transition, for `desktopBridge.onUpdateState`.
pub const V2_UPDATE_EVENT: &str = "v2-update://state";
const V2_UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2ReleaseNote {
    pub version: String,
    pub items: Vec<String>,
    pub total_items: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2UpdateState {
    pub enabled: bool,
    pub status: String,
    pub channel: String,
    pub current_version: String,
    pub host_arch: String,
    pub app_arch: String,
    pub running_under_arm64_translation: bool,
    pub available_version: Option<String>,
    pub downloaded_version: Option<String>,
    pub release_notes: Vec<V2ReleaseNote>,
    pub omitted_release_count: usize,
    pub download_percent: Option<u64>,
    pub checked_at: Option<String>,
    pub message: Option<String>,
    pub error_context: Option<String>,
    pub can_retry: bool,
}

fn runtime_arch() -> String {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => "other",
    }
    .to_string()
}

fn initial_v2_update_state() -> V2UpdateState {
    let enabled = !cfg!(debug_assertions);
    V2UpdateState {
        enabled,
        status: if enabled { "idle" } else { "disabled" }.to_string(),
        channel: "latest".to_string(),
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        host_arch: runtime_arch(),
        app_arch: runtime_arch(),
        running_under_arm64_translation: false,
        available_version: None,
        downloaded_version: None,
        release_notes: Vec::new(),
        omitted_release_count: 0,
        download_percent: None,
        checked_at: None,
        message: (!enabled).then(|| "Updates are disabled in a development build.".to_string()),
        error_context: None,
        can_retry: false,
    }
}

struct V2UpdateInner {
    state: V2UpdateState,
    candidate: Option<tauri_plugin_updater::Update>,
    downloaded: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
}

pub struct V2UpdateHandle(Mutex<V2UpdateInner>);

impl Default for V2UpdateHandle {
    fn default() -> Self {
        Self(Mutex::new(V2UpdateInner {
            state: initial_v2_update_state(),
            candidate: None,
            downloaded: None,
        }))
    }
}

impl V2UpdateHandle {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> V2UpdateState {
        self.0
            .lock()
            .map(|inner| inner.state.clone())
            .unwrap_or_else(|_| initial_v2_update_state())
    }

    fn update<F: FnOnce(&mut V2UpdateInner)>(&self, change: F) -> V2UpdateState {
        self.0
            .lock()
            .map(|mut inner| {
                change(&mut inner);
                inner.state.clone()
            })
            .unwrap_or_else(|_| initial_v2_update_state())
    }
}

fn v2_emit_state(app: &AppHandle, state: &V2UpdateState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = window.emit(V2_UPDATE_EVENT, state) {
        eprintln!("v2 update: could not emit {V2_UPDATE_EVENT}: {error}");
    }
}

fn release_notes(update: &tauri_plugin_updater::Update) -> Vec<V2ReleaseNote> {
    let items: Vec<String> = update
        .body
        .as_deref()
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if items.is_empty() {
        return Vec::new();
    }
    let total_items = items.len();
    vec![V2ReleaseNote {
        version: update.version.clone(),
        items,
        total_items,
    }]
}

fn validate_update_channel(channel: &str) -> Result<(), String> {
    if channel != "latest" && channel != "nightly" {
        return Err(format!(
            "update channel must be \"latest\" or \"nightly\", got {channel:?}"
        ));
    }
    Ok(())
}

fn v2_updater(app: &AppHandle, channel: &str) -> Result<tauri_plugin_updater::Updater, String> {
    validate_update_channel(channel)?;
    let bundle = tauri::utils::platform::bundle_type().ok_or_else(|| {
        "update checks need an installed bundle; this build carries no bundle type".to_string()
    })?;
    let target = updater_target(bundle, tauri_plugin_updater::target())?;
    let endpoint = MANIFEST_URL;
    let endpoint_url = endpoint
        .parse()
        .map_err(|e| format!("the update endpoint {endpoint:?} is not a URL: {e}"))?;
    bounded_updater(app.updater_builder(), CHECK_TIMEOUT, NETWORK_IDLE_TIMEOUT)
        .target(target)
        .endpoints(vec![endpoint_url])
        .map_err(|e| format!("update endpoint {endpoint:?} was refused: {e}"))?
        .version_comparator(|running, manifest| {
            offers_update(&running.to_string(), &manifest.version.to_string())
        })
        .build()
        .map_err(|e| format!("could not build the updater: {e}"))
}

#[tauri::command]
pub fn v2_update_state(state: State<'_, Arc<V2UpdateHandle>>) -> Value {
    serde_json::to_value(state.snapshot()).expect("V2UpdateState serializes")
}

#[tauri::command]
pub fn v2_update_set_channel(
    channel: String,
    _minimum_version: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<V2UpdateHandle>>,
) -> Result<Value, String> {
    validate_update_channel(&channel)?;
    let next = state.update(|inner| {
        if inner.state.channel == channel {
            return;
        }
        inner.state.channel = channel;
        inner.state.available_version = None;
        inner.state.downloaded_version = None;
        inner.state.release_notes.clear();
        inner.state.download_percent = None;
        inner.state.error_context = None;
        inner.state.can_retry = false;
        inner.state.message = None;
        inner.state.status = if inner.state.enabled {
            "idle"
        } else {
            "disabled"
        }
        .to_string();
        inner.candidate = None;
        inner.downloaded = None;
    });
    v2_emit_state(&app, &next);
    Ok(serde_json::to_value(next).expect("V2UpdateState serializes"))
}

/// Runs one check and folds the result into the shared state. `checked` is
/// false when the check could not run or the updater reported an error.
async fn perform_update_check(app: &AppHandle, state: &V2UpdateHandle) -> (bool, V2UpdateState) {
    if !state.snapshot().enabled {
        return (false, state.snapshot());
    }
    let channel = state.snapshot().channel;
    let checking = state.update(|inner| {
        inner.state.status = "checking".to_string();
        inner.state.error_context = None;
        inner.state.can_retry = false;
        inner.state.message = None;
        inner.state.download_percent = None;
    });
    v2_emit_state(app, &checking);

    let updater = match v2_updater(app, &channel) {
        Ok(updater) => updater,
        Err(error) => {
            let failed = state.update(|inner| {
                inner.state.status = "error".to_string();
                inner.state.message = Some(error);
                inner.state.error_context = Some("check".to_string());
                inner.state.can_retry = true;
            });
            v2_emit_state(app, &failed);
            return (false, failed);
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let next = state.update(|inner| {
                inner.state.status = "available".to_string();
                inner.state.available_version = Some(update.version.clone());
                inner.state.downloaded_version = None;
                inner.state.download_percent = None;
                inner.state.release_notes = release_notes(&update);
                inner.state.omitted_release_count = 0;
                inner.state.message = Some(format!("Version {} is available.", update.version));
                inner.state.error_context = None;
                inner.state.can_retry = false;
                inner.candidate = Some(update);
                inner.downloaded = None;
            });
            v2_emit_state(app, &next);
            (true, next)
        }
        Ok(None) => {
            let next = state.update(|inner| {
                inner.state.status = "up-to-date".to_string();
                inner.state.available_version = None;
                inner.state.downloaded_version = None;
                inner.state.release_notes.clear();
                inner.state.omitted_release_count = 0;
                inner.state.download_percent = None;
                inner.state.message = Some("Houston is up to date.".to_string());
                inner.state.error_context = None;
                inner.state.can_retry = false;
                inner.candidate = None;
                inner.downloaded = None;
            });
            v2_emit_state(app, &next);
            (true, next)
        }
        Err(error) => {
            let message = updater_error("checking", MANIFEST_URL, &runtime_arch(), error);
            let failed = state.update(|inner| {
                inner.state.status = "error".to_string();
                inner.state.message = Some(message);
                inner.state.error_context = Some("check".to_string());
                inner.state.can_retry = true;
            });
            v2_emit_state(app, &failed);
            (false, failed)
        }
    }
}

#[tauri::command]
pub async fn v2_update_check(
    app: AppHandle,
    state: State<'_, Arc<V2UpdateHandle>>,
) -> Result<Value, String> {
    let check_state = Arc::clone(state.inner());
    let (checked, snapshot) = perform_update_check(&app, &check_state).await;
    Ok(json!({ "checked": checked, "state": snapshot }))
}

/// Menu-initiated check: updates the same state and reports the outcome to the
/// caller, which shows the native dialog upstream shows from its menu.
pub async fn check_for_updates_from_menu(app: &AppHandle) -> Result<Option<String>, String> {
    let handle = app.state::<Arc<V2UpdateHandle>>();
    let (checked, snapshot) = perform_update_check(app, handle.inner().as_ref()).await;
    if !checked {
        return Err(snapshot
            .message
            .unwrap_or_else(|| "Automatic updates are not available right now.".to_string()));
    }
    Ok(snapshot.available_version)
}

#[tauri::command]
pub async fn v2_update_download(
    app: AppHandle,
    state: State<'_, Arc<V2UpdateHandle>>,
) -> Result<Value, String> {
    let (candidate, version) = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "update state lock poisoned".to_string())?;
        let version = inner.state.available_version.clone().ok_or_else(|| {
            "there is no checked update to download; check again first".to_string()
        })?;
        let candidate = inner.candidate.clone().ok_or_else(|| {
            "there is no checked update to download; check again first".to_string()
        })?;
        (candidate, version)
    };

    let downloading = state.update(|inner| {
        inner.state.status = "downloading".to_string();
        inner.state.download_percent = Some(0);
        inner.state.message = Some(format!("Downloading {version}…"));
        inner.state.error_context = None;
        inner.state.can_retry = false;
    });
    v2_emit_state(&app, &downloading);

    let downloaded = Arc::new(AtomicU64::new(0));
    let last_percent = Arc::new(AtomicU64::new(u64::MAX));
    let progress = Arc::clone(&downloaded);
    let progress_percent = Arc::clone(&last_percent);
    let progress_app = app.clone();
    let progress_state = Arc::clone(&state);
    let update = bounded_download(candidate.clone(), V2_UPDATE_DOWNLOAD_TIMEOUT);
    let bytes = match update
        .download(
            move |chunk_len, content_len| {
                let done = progress.fetch_add(chunk_len as u64, AtomicOrdering::Relaxed)
                    + chunk_len as u64;
                let Some(total) = content_len.filter(|total| *total > 0) else {
                    return;
                };
                let percent = done.saturating_mul(100) / total;
                if progress_percent.swap(percent, AtomicOrdering::Relaxed) == percent {
                    return;
                }
                let next = progress_state.update(|inner| {
                    inner.state.download_percent = Some(percent);
                });
                v2_emit_state(&progress_app, &next);
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = updater_error("downloading", MANIFEST_URL, &runtime_arch(), error);
            let failed = state.update(|inner| {
                inner.state.status = "error".to_string();
                inner.state.download_percent = None;
                inner.state.message = Some(message);
                inner.state.error_context = Some("download".to_string());
                inner.state.can_retry = true;
            });
            v2_emit_state(&app, &failed);
            return Ok(json!({ "accepted": true, "completed": false, "state": failed }));
        }
    };

    let next = state.update(|inner| {
        inner.state.status = "downloaded".to_string();
        inner.state.downloaded_version = Some(version);
        inner.state.download_percent = Some(100);
        inner.state.message = Some("Update downloaded. Install it to restart Houston.".to_string());
        inner.state.error_context = None;
        inner.state.can_retry = false;
        inner.downloaded = Some((candidate, bytes));
    });
    v2_emit_state(&app, &next);
    Ok(json!({ "accepted": true, "completed": true, "state": next }))
}

#[tauri::command]
pub async fn v2_update_install(
    app: AppHandle,
    expected_version: Option<String>,
    state: State<'_, Arc<V2UpdateHandle>>,
) -> Result<Value, String> {
    let (update, bytes, downloaded_version) = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "update state lock poisoned".to_string())?;
        let Some((update, bytes)) = inner.downloaded.take() else {
            return Err("there is no downloaded update to install; download it first".to_string());
        };
        let version = inner
            .state
            .downloaded_version
            .clone()
            .unwrap_or_else(|| update.version.clone());
        (update, bytes, version)
    };
    if let Some(expected) = expected_version.as_deref() {
        if expected != downloaded_version {
            return Err(format!(
                "refusing to install: the panel asked for {expected:?} but {downloaded_version:?} \
                 was downloaded; check for updates again"
            ));
        }
    }

    let installing = state.update(|inner| {
        inner.state.message = Some(format!("Installing {downloaded_version}…"));
        inner.state.error_context = None;
        inner.state.can_retry = false;
    });
    v2_emit_state(&app, &installing);

    if let Err(error) = update.install(bytes) {
        let message = updater_error("installing", MANIFEST_URL, &runtime_arch(), error);
        let failed = state.update(|inner| {
            inner.state.status = "error".to_string();
            inner.state.message = Some(message);
            inner.state.error_context = Some("install".to_string());
            inner.state.can_retry = true;
        });
        v2_emit_state(&app, &failed);
        return Ok(json!({ "accepted": true, "completed": false, "state": failed }));
    }

    let complete = state.update(|inner| {
        inner.state.status = "downloaded".to_string();
        inner.state.downloaded_version = Some(update.version.clone());
        inner.state.message = Some("Update installed. Houston is restarting.".to_string());
    });
    v2_emit_state(&app, &complete);

    #[cfg(target_os = "linux")]
    {
        eprintln!(
            "v2 update: Houston {} installed; relaunching the updated app",
            update.version
        );
        app.restart();
    }

    #[cfg(not(target_os = "linux"))]
    Ok(json!({ "accepted": true, "completed": true, "state": complete }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_v2_update_state_starts_idle_with_the_package_version() {
        let state = initial_v2_update_state();
        assert_eq!(state.current_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(state.channel, "latest");
        assert_eq!(state.host_arch, state.app_arch);
        assert_eq!(
            state.status,
            if cfg!(debug_assertions) {
                "disabled"
            } else {
                "idle"
            }
        );
        assert_eq!(state.enabled, !cfg!(debug_assertions));
        assert_eq!(state.download_percent, None);
    }

    #[test]
    fn v2_update_channel_validation_names_the_bad_value() {
        assert!(validate_update_channel("latest").is_ok());
        assert!(validate_update_channel("nightly").is_ok());
        let error = validate_update_channel("stable").unwrap_err();
        assert!(error.contains("stable"), "{error}");
    }

    #[test]
    fn v2_release_notes_serialize_as_the_contract_shape() {
        let note = V2ReleaseNote {
            version: "0.20.0".into(),
            items: vec!["one".into(), "two".into()],
            total_items: 2,
        };
        let value = serde_json::to_value(note).unwrap();
        assert_eq!(value["version"], "0.20.0");
        assert_eq!(value["totalItems"], 2);
        assert_eq!(value["items"], serde_json::json!(["one", "two"]));
    }

    #[tokio::test]
    async fn stalled_update_requests_release_the_flight_for_retry() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": "fixture", "dangerousInsecureTransportProtocol": true}),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        for download in [false, true] {
            for headers_sent in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let endpoint = format!("http://{}", listener.local_addr().unwrap());
                let manifest = serde_json::json!({
                    "version": "999.0.0", "platforms": {"fixture": {
                        "url": format!("{endpoint}/installer"), "signature": "fixture"
                    }}
                })
                .to_string();
                let server = tokio::spawn(async move {
                    if download {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let mut request = [0; 4096];
                        assert!(socket.read(&mut request).await.unwrap() > 0);
                        socket.write_all(format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()
                        ).as_bytes()).await.unwrap();
                    }
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096];
                    assert!(socket.read(&mut request).await.unwrap() > 0);
                    if headers_sent {
                        socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
                            .await
                            .unwrap();
                    }
                    let _ = socket.read(&mut request).await;
                });
                let updater = bounded_updater(
                    app.updater_builder(),
                    Duration::from_millis(100),
                    Duration::from_millis(100),
                )
                .target("fixture")
                .no_proxy()
                .endpoints(vec![endpoint.parse().unwrap()])
                .unwrap()
                .build()
                .unwrap();
                let result = tokio::time::timeout(Duration::from_secs(3), async {
                    if download {
                        let update = updater.check().await.unwrap().unwrap();
                        bounded_download(update, Duration::from_millis(200))
                            .download(|_, _| {}, || {})
                            .await
                            .map(|_| ())
                    } else {
                        updater.check().await.map(|_| ())
                    }
                })
                .await;
                server.abort();
                let _ = server.await;
                let error = result
                    .expect("network deadline must end the stalled request")
                    .expect_err("the fixture never completes its response");
                assert!(
                    matches!(&error, tauri_plugin_updater::Error::Reqwest(error) if error.is_timeout()),
                    "{error}"
                );
            }
        }
    }

    #[test]
    fn the_manifest_endpoint_is_fixed() {
        assert!(
            MANIFEST_URL.contains("/releases/latest/download/latest.json"),
            "{MANIFEST_URL}"
        );
    }

    #[test]
    fn the_target_names_the_installer_bundle() {
        let linux = || Some("linux-x86_64".to_string());
        assert_eq!(
            updater_target(BundleType::Deb, linux()).unwrap(),
            "linux-x86_64-deb"
        );
        assert_eq!(
            updater_target(BundleType::AppImage, linux()).unwrap(),
            "linux-x86_64-appimage"
        );
        assert_eq!(
            updater_target(BundleType::Nsis, Some("windows-x86_64".to_string())).unwrap(),
            "windows-x86_64-nsis"
        );
    }

    #[test]
    fn an_unmapped_os_arch_is_refused_by_name() {
        let err = updater_target(BundleType::Deb, None).unwrap_err();
        assert!(err.contains("OS/architecture"), "{err}");
    }

    #[test]
    fn offers_only_a_strictly_newer_manifest() {
        assert!(offers_update("1.2.3", "1.2.4"));
        assert!(!offers_update("1.2.3", "1.2.3"));
        assert!(!offers_update("1.2.3", "1.2.2"));
    }

    #[test]
    fn a_release_without_this_platform_names_the_platform_not_a_broken_manifest() {
        let err = updater_error(
            "downloading",
            MANIFEST_URL,
            "windows-x86_64-nsis",
            tauri_plugin_updater::Error::TargetsNotFound(vec![
                "windows-x86_64-nsis".to_string(),
                "windows-x86_64".to_string(),
            ]),
        );
        assert!(err.contains("windows-x86_64-nsis"), "{err}");
        assert!(err.contains("does not ship an installer"), "{err}");
    }
}

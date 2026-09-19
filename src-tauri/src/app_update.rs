//! The Rust half of signed click-to-update: fetch the fixed manifest, refuse
//! builds a manifest cannot name, hold the operator's version to what it
//! publishes, then let the plugin download, verify and install.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};

// The ManageLiveSessions payload only reaches this module on Windows, where the
// live-session refusal is built, and in its tests.
#[cfg(any(windows, test))]
use houston_protocol as proto;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::daemon_host;

/// Progress for the About panel, emitted to the main window only.
pub const PROGRESS_EVENT: &str = "app-update://progress";

// GitHub's `latest` alias, which by definition never serves a draft or a
// prerelease: the one endpoint an installed copy can be offered from.
const MANIFEST_URL: &str =
    "https://github.com/theogmiguel/houston/releases/latest/download/latest.json";

/// One download at a time: a second click bounces off while the first is live.
#[derive(Default)]
pub struct UpdateFlight(AtomicBool);

impl UpdateFlight {
    pub fn new() -> Self {
        Self::default()
    }

    fn claim(&self) -> Result<FlightGuard<'_>, String> {
        self.0
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .map_err(|_| {
                "app_update_install: an update is already downloading; wait for it to finish or \
                 fail before starting another"
                    .to_string()
            })?;
        Ok(FlightGuard(&self.0))
    }
}

/// Clears the flight flag however the command exits, refusal or panic included.
struct FlightGuard<'a>(&'a AtomicBool);

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, AtomicOrdering::Release);
    }
}

/// Why this binary cannot install an update at all, if it cannot. The updater
/// replaces an installed bundle; a debug or unbundled build has none to replace
/// and no `latest.json` entry that names it.
fn install_refusal(debug_build: bool, bundle: Option<&BundleType>) -> Option<String> {
    if debug_build {
        return Some(
            "app_update_install: refusing in a development build; only an installed bundle can \
             be replaced. Update the packaged app instead"
                .to_string(),
        );
    }
    if bundle.is_none() {
        return Some(
            "app_update_install: refusing: this build carries no bundle type (it is not a \
             .deb/.rpm/AppImage/NSIS install), so no updater artifact describes it"
                .to_string(),
        );
    }
    None
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

/// The active-channel daemon that blocks a Windows install before a byte is
/// downloaded: the installer replaces `houston-core.exe`, which is the process
/// running every session. The live count is the refusal's whole point.
#[cfg(any(windows, test))]
fn windows_live_sessions_refusal(channel: &str, live: &proto::ManageLiveSessions) -> String {
    format!(
        "app_update_install: refusing to update: the {channel} channel's daemon has {} live \
         session(s) (ids {:?}). The Windows installer replaces houston-core.exe, which would \
         stop them; close those sessions and retry.",
        live.count, live.ids
    )
}

/// The channel the active state dir belongs to, for messages: an absent suffix
/// is the release channel, anything else names itself.
#[cfg(any(windows, test))]
fn active_channel_label(state_dir: &Path) -> String {
    match houston_core::paths::channel_of_state_dir(state_dir) {
        Some(channel) => channel,
        None => "release".to_string(),
    }
}

/// The state dir this app process resolved from its own argv (`--channel`) and
/// is driving. Managed by `main`, so update safety inspects the daemon this app
/// is actually attached to — an installed app launched on `dev` checks `dev`.
pub struct ActiveStateDir(PathBuf);

impl ActiveStateDir {
    pub fn new(state_dir: PathBuf) -> Self {
        Self(state_dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// What a Linux install leaves to hand the sessions to.
#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum HandoffPlan {
    /// The freshly installed daemon binary to spawn as the successor.
    Candidate(PathBuf),
    /// The install replaced the running AppImage; relaunch so the new mount
    /// carries the daemon binary the startup handoff then moves sessions to.
    Relaunch,
    /// No candidate this build can run; the daemon is left in place and this
    /// reason is surfaced verbatim.
    Refuse { reason: String },
}

/// How each Linux layout reaches the installed daemon binary: the sibling
/// sidecar for deb/rpm, a fresh launch for an AppImage (its sidecar is only
/// readable inside the mount).
#[cfg(any(target_os = "linux", test))]
fn linux_handoff_plan(bundle: &BundleType, daemon_bin_dir: &Path) -> HandoffPlan {
    match bundle {
        BundleType::Deb | BundleType::Rpm => {
            HandoffPlan::Candidate(daemon_bin_dir.join(crate::daemon_host::daemon_binary_name()))
        }
        BundleType::AppImage => HandoffPlan::Relaunch,
        other => HandoffPlan::Refuse {
            reason: format!(
                "this build carries bundle type {other:?}, which has no known path to a freshly \
                 installed daemon binary"
            ),
        },
    }
}

#[cfg(any(target_os = "linux", test))]
fn installed_but_daemon_stays(version: &str, reason: &str, live_sessions: u32) -> String {
    let sessions = match live_sessions {
        0 => "no sessions were running to move".to_string(),
        1 => "the 1 live session keeps running on the current daemon".to_string(),
        n => format!("all {n} live sessions keep running on the current daemon"),
    };
    format!(
        "app_update_install: Houston {version} was installed, but the daemon was left on the \
         running build: {reason}. Nothing was stopped; {sessions}."
    )
}

/// Move the running daemon onto the freshly installed build, or refuse by
/// name with the current daemon and every session untouched — sessions are
/// never killed to make room for an update.
#[cfg(any(target_os = "linux", test))]
async fn move_daemon_to_new_build(
    state_dir: &Path,
    plan: &HandoffPlan,
    version: &str,
) -> Result<(), String> {
    let live = daemon_host::probe_live_sessions(state_dir)
        .await
        .map_err(|e| {
            format!(
                "app_update_install: Houston {version} was installed, but the running daemon's \
                 live sessions could not be confirmed, so it was left exactly as it is: {e}. \
                 Nothing was stopped."
            )
        })?;
    let Some(live) = live else {
        return Ok(());
    };
    let candidate = match plan {
        HandoffPlan::Candidate(candidate) => candidate,
        HandoffPlan::Relaunch => return Ok(()),
        HandoffPlan::Refuse { reason } => {
            return Err(installed_but_daemon_stays(version, reason, live.count));
        }
    };
    if let Some(problem) = daemon_host::candidate_problem(candidate) {
        return Err(installed_but_daemon_stays(
            version,
            &format!(
                "the freshly installed daemon binary {} {problem}",
                candidate.display()
            ),
            live.count,
        ));
    }
    let result = daemon_host::request_candidate_handoff(state_dir, Some(candidate))
        .await
        .map_err(|e| {
            format!(
                "app_update_install: Houston {version} was installed, but asking the daemon to \
                 move the running sessions to it failed: {e}. Nothing was stopped; the current \
                 daemon still owns every session."
            )
        })?;
    if !result.accepted {
        let reason = result
            .reason
            .unwrap_or_else(|| "the daemon gave no reason".to_string());
        return Err(installed_but_daemon_stays(version, &reason, live.count));
    }
    Ok(())
}

/// Stable installs only a strictly newer version; an equal or older manifest is
/// not an update.
fn offers_update(running: &str, manifest: &str) -> bool {
    houston_core::updates::is_newer(manifest, running)
}

/// The manifest must still publish the exact release the operator was shown.
/// A feed that moved under the panel refuses by name instead of riding
/// `compare_versions`' unparseable-reads-as-Equal rule.
fn expected_version_matches(manifest: &str, expected: &str) -> bool {
    !expected.trim().is_empty() && houston_core::updates::same_release(manifest, expected)
}

fn updater_error(
    phase: &str,
    endpoint: &str,
    target: &str,
    err: tauri_plugin_updater::Error,
) -> String {
    use tauri_plugin_updater::Error;
    match err {
        Error::TargetsNotFound(offered) => format!(
            "app_update_install: {endpoint} publishes no updater artifact for this build: it \
             offers {offered:?} and this build needs {target:?}"
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

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppUpdateOutcome {
    UpToDate { version: String },
    Installed { version: String },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn emit_progress(app: &AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let payload = UpdateProgress {
        phase,
        downloaded,
        total,
    };
    if let Err(err) = window.emit(PROGRESS_EVENT, payload) {
        eprintln!("app_update_install: could not emit {PROGRESS_EVENT}: {err}");
    }
}

/// Downloads and installs the current release, refusing anything the operator
/// was not shown. The plugin verifies the signature before installing;
/// a verification failure reaches the caller as an error and installs nothing.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    flight: State<'_, UpdateFlight>,
    active: State<'_, ActiveStateDir>,
    expected_version: String,
) -> Result<AppUpdateOutcome, String> {
    let bundle = tauri::utils::platform::bundle_type();
    if let Some(refusal) = install_refusal(cfg!(debug_assertions), bundle.as_ref()) {
        return Err(refusal);
    }
    let bundle = bundle.expect("install_refusal returns a refusal for every absent bundle type");
    let state_dir = active.path();

    // Resolved now, while this app's own executable is still the installed
    // one: an in-place dpkg/rpm install can leave `current_exe()` reading
    // "… (deleted)" by the time the daemon needs the successor's path.
    #[cfg(target_os = "linux")]
    let handoff_plan = {
        let exe = std::env::current_exe().map_err(|e| {
            format!(
                "app_update_install: resolving this app's own path to locate the freshly \
                 installed daemon binary: {e}"
            )
        })?;
        let bin_dir =
            daemon_host::spawn_bin_dir(&houston_core::exe_path::strip_deleted_exe_suffix(&exe));
        linux_handoff_plan(&bundle, &bin_dir)
    };

    let target = updater_target(bundle, tauri_plugin_updater::target())?;
    let _flight = flight.claim()?;

    let endpoint = MANIFEST_URL;
    let endpoint_url = endpoint.parse().map_err(|e| {
        format!("app_update_install: the fixed endpoint {endpoint:?} is not a URL: {e}")
    })?;

    let updater = app
        .updater_builder()
        .target(target.clone())
        .endpoints(vec![endpoint_url])
        .map_err(|e| format!("app_update_install: endpoint {endpoint:?} was refused: {e}"))?
        .version_comparator(|running, manifest| {
            offers_update(&running.to_string(), &manifest.version.to_string())
        })
        .build()
        .map_err(|e| {
            format!("app_update_install: could not build the updater for target {target:?}: {e}")
        })?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| updater_error("checking", endpoint, &target, e))?
    else {
        return Ok(AppUpdateOutcome::UpToDate {
            version: env!("CARGO_PKG_VERSION").to_string(),
        });
    };

    if !expected_version_matches(&update.version, &expected_version) {
        return Err(format!(
            "app_update_install: refusing to install: the panel showed version \
             {expected_version:?} but {endpoint} now publishes {:?}; check for updates again",
            update.version
        ));
    }

    // Windows only, and before the download: the installer replaces the daemon
    // binary, so a live session there would die with it. Linux never refuses
    // here — it moves the daemon after the install instead.
    #[cfg(windows)]
    {
        let channel_label = active_channel_label(state_dir);
        match daemon_host::probe_live_sessions(state_dir).await {
            Ok(Some(live)) if live.count > 0 => {
                return Err(windows_live_sessions_refusal(&channel_label, &live));
            }
            Ok(_) => {}
            Err(e) => {
                return Err(format!(
                    "app_update_install: refusing to update: could not confirm whether the \
                     {channel_label} channel's daemon has live sessions: {e}. Retry once it \
                     answers."
                ));
            }
        }
    }

    emit_progress(&app, "downloading", 0, None);
    let downloaded = std::sync::Arc::new(AtomicU64::new(0));
    let on_chunk_seen = std::sync::Arc::clone(&downloaded);
    let app_on_chunk = app.clone();
    // `download` verifies the signature before it returns, so "installing" is
    // only claimed once the bytes are known good; a bad signature fails in the
    // downloading phase with nothing said about installing.
    let bytes = update
        .download(
            move |chunk_len, content_len| {
                let done = on_chunk_seen.fetch_add(chunk_len as u64, AtomicOrdering::Relaxed)
                    + chunk_len as u64;
                emit_progress(&app_on_chunk, "downloading", done, content_len);
            },
            || {},
        )
        .await
        .map_err(|e| updater_error("downloading", endpoint, &target, e))?;

    emit_progress(
        &app,
        "installing",
        downloaded.load(AtomicOrdering::Relaxed),
        None,
    );

    // Windows: retire the daemon now, after the bytes verified and before the
    // installer replaces its binary; a session that appeared since the
    // pre-download check refuses inside the daemon, never dies here.
    #[cfg(windows)]
    {
        let channel_label = active_channel_label(state_dir);
        daemon_host::retire_daemon_for_update(state_dir, &channel_label).await?;
    }

    update
        .install(bytes)
        .map_err(|e| updater_error("installing", endpoint, &target, e))?;

    // The install succeeded; now move the daemon onto it, or say by name why
    // it stays where it is. Sessions are never killed, on any path.
    #[cfg(target_os = "linux")]
    match &handoff_plan {
        HandoffPlan::Relaunch => {
            if std::env::var_os("APPIMAGE").is_some() {
                // Only a fresh launch mounts the replaced AppImage, and Tauri
                // relaunches `$APPIMAGE` itself; the new app's startup precheck
                // then hands the running daemon to the new mount's sidecar.
                eprintln!(
                    "app_update_install: Houston {} installed; relaunching into the new \
                     AppImage",
                    update.version
                );
                app.restart();
            }
            // Without `$APPIMAGE` a restart would re-exec the old mount: leave
            // the daemon alone and let the operator reopen from the new file.
            eprintln!(
                "app_update_install: Houston {} installed; $APPIMAGE is not set, so quit and \
                 reopen Houston to run it",
                update.version
            );
        }
        plan => move_daemon_to_new_build(state_dir, plan, &update.version).await?,
    }

    Ok(AppUpdateOutcome::Installed {
        version: update.version.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_endpoint_is_fixed() {
        assert!(
            MANIFEST_URL.contains("/releases/latest/download/latest.json"),
            "{MANIFEST_URL}"
        );
    }

    #[test]
    fn a_debug_build_is_refused_by_name() {
        let err = install_refusal(true, Some(&BundleType::AppImage)).expect("a refusal");
        assert!(err.contains("development build"), "{err}");
    }

    #[test]
    fn an_unbundled_release_build_is_refused_by_name() {
        let err = install_refusal(false, None).expect("a refusal");
        assert!(err.contains("bundle type"), "{err}");
    }

    #[test]
    fn a_bundled_release_build_is_accepted() {
        assert!(install_refusal(false, Some(&BundleType::AppImage)).is_none());
        assert!(install_refusal(false, Some(&BundleType::Deb)).is_none());
        assert!(install_refusal(false, Some(&BundleType::Nsis)).is_none());
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
    fn a_second_install_bounces_while_the_first_holds_the_flight() {
        let flight = UpdateFlight::new();
        let first = flight.claim().expect("the first claim holds the flight");
        let err = flight
            .claim()
            .err()
            .expect("a second claim must bounce while the first is held");
        assert!(err.contains("already"), "{err}");
        drop(first);
        assert!(
            flight.claim().is_ok(),
            "the flag clears when the holding guard drops"
        );
    }

    #[test]
    fn offers_only_a_strictly_newer_manifest() {
        assert!(offers_update("1.2.3", "1.2.4"));
        assert!(!offers_update("1.2.3", "1.2.3"));
        assert!(!offers_update("1.2.3", "1.2.2"));
    }

    #[test]
    fn the_shown_version_must_match_the_manifest() {
        assert!(expected_version_matches("1.2.3", "1.2.3"));
        assert!(expected_version_matches("v1.2.3", "1.2.3"));
        assert!(!expected_version_matches("1.2.4", "1.2.3"));
        assert!(
            !expected_version_matches("1.2.3", "  "),
            "an empty expected version must never satisfy the check"
        );
    }

    #[test]
    fn the_outcome_carries_a_kind_tag() {
        let installed = serde_json::to_value(AppUpdateOutcome::Installed {
            version: "1.2.3".to_string(),
        })
        .unwrap();
        assert_eq!(
            installed,
            serde_json::json!({ "kind": "installed", "version": "1.2.3" })
        );
        let current = serde_json::to_value(AppUpdateOutcome::UpToDate {
            version: "1.2.3".to_string(),
        })
        .unwrap();
        assert_eq!(
            current,
            serde_json::json!({ "kind": "up_to_date", "version": "1.2.3" })
        );
    }

    #[test]
    fn a_windows_refusal_names_the_live_count_channel_and_binary_replaced() {
        let live = proto::ManageLiveSessions {
            count: 3,
            ids: vec![4, 5, 6],
        };
        let refusal = windows_live_sessions_refusal("dev", &live);
        assert!(refusal.contains("3 live session"), "{refusal}");
        assert!(refusal.contains("[4, 5, 6]"), "{refusal}");
        assert!(refusal.contains("houston-core.exe"), "{refusal}");
        assert!(refusal.contains("dev channel's daemon"), "{refusal}");
    }

    #[test]
    fn the_active_channel_label_reads_the_state_dir_suffix() {
        assert_eq!(
            active_channel_label(Path::new("/home/u/.houston")),
            "release"
        );
        assert_eq!(
            active_channel_label(Path::new("/home/u/.houston-dev")),
            "dev"
        );
    }

    #[test]
    fn a_deb_handoff_plan_names_the_sidecar_in_the_daemon_bin_dir() {
        assert_eq!(
            linux_handoff_plan(&BundleType::Deb, Path::new("/usr/bin")),
            HandoffPlan::Candidate(PathBuf::from("/usr/bin/houston-core"))
        );
        assert_eq!(
            linux_handoff_plan(&BundleType::Rpm, Path::new("/usr/lib/houston")),
            HandoffPlan::Candidate(PathBuf::from("/usr/lib/houston/houston-core"))
        );
    }

    #[test]
    fn an_appimage_handoff_plan_relaunches_into_the_new_mount() {
        assert_eq!(
            linux_handoff_plan(&BundleType::AppImage, Path::new("/tmp/.mount_x/usr/bin")),
            HandoffPlan::Relaunch,
            "an AppImage's new sidecar is only reachable after a fresh launch"
        );
    }

    #[test]
    fn an_unknown_bundle_type_is_refused_by_name() {
        let plan = linux_handoff_plan(&BundleType::Nsis, Path::new("/usr/bin"));
        let HandoffPlan::Refuse { reason } = plan else {
            panic!("NSIS is not a Linux layout: {plan:?}");
        };
        assert!(reason.contains("Nsis"), "{reason}");
    }

    #[test]
    fn candidate_problem_names_each_way_a_candidate_is_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing-houston-core");
        let problem = daemon_host::candidate_problem(&missing).expect("a missing file is unusable");
        assert!(problem.contains("cannot be read"), "{problem}");
        let full = installed_but_daemon_stays(
            "1.2.4",
            &format!(
                "the freshly installed daemon binary {} {problem}",
                missing.display()
            ),
            1,
        );
        assert!(
            full.contains("missing-houston-core"),
            "the refusal must name the path it could not read: {full}"
        );

        let problem = daemon_host::candidate_problem(dir.path()).expect("a directory is unusable");
        assert!(problem.contains("not a regular file"), "{problem}");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = dir.path().join("houston-core");
            std::fs::write(&file, b"not a binary").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            let problem =
                daemon_host::candidate_problem(&file).expect("a non-executable file is unusable");
            assert!(problem.contains("not executable"), "{problem}");

            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(daemon_host::candidate_problem(&file), None);
        }
    }

    #[test]
    fn the_daemon_stays_message_counts_sessions_and_names_the_version() {
        let none = installed_but_daemon_stays("1.2.4", "a reason", 0);
        assert!(none.contains("no sessions were running"), "{none}");
        assert!(none.contains("1.2.4"), "{none}");
        assert!(none.contains("a reason"), "{none}");

        let one = installed_but_daemon_stays("1.2.4", "a reason", 1);
        assert!(one.contains("the 1 live session keeps"), "{one}");

        let many = installed_but_daemon_stays("1.2.4", "a reason", 7);
        assert!(many.contains("all 7 live sessions keep"), "{many}");
    }
}

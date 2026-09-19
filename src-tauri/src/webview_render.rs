//! WebKitGTK renderer overrides for Linux, set before the first webview.
//! Keep renderer workarounds local to the app when it launches a daemon.

#[derive(Debug, Default)]
pub struct AppliedOverrides {
    inserted: Vec<&'static str>,
    preserved: Vec<&'static str>,
    skipped: bool,
}

impl AppliedOverrides {
    pub fn remove_from_child(&self, command: &mut std::process::Command) {
        for key in &self.inserted {
            command.env_remove(key);
        }
    }

    pub fn report(&self) {
        if cfg!(target_os = "linux") {
            tracing::info!(target: "houston_core::webview_render",
                inserted = ?self.inserted, preserved = ?self.preserved, skipped = self.skipped,
                "WebKitGTK renderer environment overrides (inserted values are 1; opt out with HOUSTON_SKIP_LINUX_RENDER_WORKAROUNDS=1)"
            );
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::AppliedOverrides;
    use std::ffi::{OsStr, OsString};
    /// Set to keep WebKit's own choices, e.g. for accelerated drawing.
    pub const SKIP_ENV: &str = "HOUSTON_SKIP_LINUX_RENDER_WORKAROUNDS";

    fn enabled(value: &OsStr) -> bool {
        value == "1"
            || value
                .to_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("true"))
    }

    /// Decides from an environment snapshot so tests never touch the real one.
    fn overrides(read: impl Fn(&str) -> Option<OsString>) -> Vec<&'static str> {
        if read(SKIP_ENV).as_deref().is_some_and(enabled) {
            return Vec::new();
        }
        // Keep compositing available while avoiding hardware DMA-BUF imports.
        let mut overrides = vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"];
        // Respect explicit choices of the legacy renderer as well as the shared-memory path.
        if read("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
            overrides.clear();
        }
        overrides.retain(|key| read(key).is_none());
        overrides
    }

    fn decision(read: impl Fn(&str) -> Option<OsString>) -> AppliedOverrides {
        AppliedOverrides {
            inserted: overrides(&read),
            preserved: [
                "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
                "WEBKIT_DISABLE_DMABUF_RENDERER",
                "WEBKIT_DISABLE_COMPOSITING_MODE",
            ]
            .into_iter()
            .filter(|key| read(key).is_some())
            .collect(),
            skipped: read(SKIP_ENV).as_deref().is_some_and(enabled),
        }
    }

    pub fn apply() -> AppliedOverrides {
        let report = decision(|key| std::env::var_os(key));
        for key in &report.inserted {
            std::env::set_var(key, "1");
        }
        report
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::collections::HashMap;

        fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
            let values: HashMap<String, OsString> = pairs
                .iter()
                .map(|(key, value)| (key.to_string(), OsString::from(value)))
                .collect();
            move |key| values.get(key).cloned()
        }

        #[test]
        fn every_linux_session_uses_shared_memory_without_disabling_compositing() {
            assert_eq!(
                overrides(env(&[])),
                vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"]
            );
        }

        #[test]
        fn wayland_sessions_keep_accelerated_compositing_available() {
            for pairs in [
                [("WAYLAND_DISPLAY", "wayland-0")],
                [("XDG_SESSION_TYPE", "wayland")],
            ] {
                assert_eq!(
                    overrides(env(&pairs)),
                    vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"],
                    "expected shared memory without a compositing override for {pairs:?}"
                );
            }
        }

        #[test]
        fn desktop_markers_do_not_disable_compositing() {
            for pairs in [
                [("HYPRLAND_INSTANCE_SIGNATURE", "abcd")],
                [("SWAYSOCK", "/run/sway.sock")],
                [("RIVER_SOCKET", "/run/river.sock")],
                [("XDG_CURRENT_DESKTOP", "Hyprland")],
            ] {
                assert_eq!(
                    overrides(env(&pairs)),
                    vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"],
                    "expected shared memory without a compositing override for {pairs:?}"
                );
            }
        }

        #[test]
        fn i3_on_x11_does_not_request_a_compositing_override() {
            assert_eq!(
                overrides(env(&[
                    ("XDG_SESSION_TYPE", "x11"),
                    ("I3SOCK", "/run/i3.sock")
                ])),
                vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"]
            );
        }

        #[test]
        fn a_variable_the_user_already_set_is_never_overwritten() {
            assert!(overrides(env(&[("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "0")])).is_empty());
            assert_eq!(
                overrides(env(&[
                    ("XDG_SESSION_TYPE", "wayland"),
                    ("WEBKIT_DISABLE_COMPOSITING_MODE", "0"),
                ])),
                vec!["WEBKIT_DMABUF_RENDERER_FORCE_SHM"]
            );
        }

        #[test]
        fn explicit_legacy_renderer_choices_take_precedence() {
            for value in ["0", "1", ""] {
                let report = decision(env(&[("WEBKIT_DISABLE_DMABUF_RENDERER", value)]));
                assert!(report.inserted.is_empty());
                assert_eq!(report.preserved, ["WEBKIT_DISABLE_DMABUF_RENDERER"]);
            }
        }

        #[test]
        fn the_skip_variable_turns_everything_off() {
            assert!(overrides(env(&[(SKIP_ENV, "1")])).is_empty());
            assert!(overrides(env(&[(SKIP_ENV, "true")])).is_empty());
            assert!(!overrides(env(&[(SKIP_ENV, "0")])).is_empty());
        }

        #[test]
        fn non_utf8_values_are_preserved() {
            use std::os::unix::ffi::OsStringExt;
            let report = decision(|key| {
                (key == "WEBKIT_DMABUF_RENDERER_FORCE_SHM").then(|| OsString::from_vec(vec![0xff]))
            });
            assert!(report.inserted.is_empty());
            assert_eq!(report.preserved, ["WEBKIT_DMABUF_RENDERER_FORCE_SHM"]);
        }

        #[test]
        fn child_environment_keeps_user_values_and_drops_only_inserted_values() {
            let report = decision(env(&[
                ("XDG_SESSION_TYPE", "wayland"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "0"),
            ]));
            let mut child = houston_core::spawn::command("/usr/bin/env");
            child
                .env_clear()
                .env("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1")
                .env("WEBKIT_DISABLE_COMPOSITING_MODE", "0");
            report.remove_from_child(&mut child);
            let output = child.output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                "WEBKIT_DISABLE_COMPOSITING_MODE=0\n"
            );
        }

        #[test]
        fn supervisor_environment_and_startup_log_match_the_decision() {
            use std::os::unix::fs::PermissionsExt;
            use std::time::{Duration, Instant};

            const CHILD: &str = "HOUSTON_RENDER_TEST_CHILD";
            if std::env::var_os(CHILD).is_none() {
                let home = tempfile::tempdir().unwrap();
                let output = houston_core::spawn::command(std::env::current_exe().unwrap())
                    .args(["--exact", "webview_render::linux::tests::supervisor_environment_and_startup_log_match_the_decision", "--nocapture"])
                    .env_clear()
                    .env("HOME", home.path())
                    .env("HOUSTON_CHANNEL", "dev")
                    .env(CHILD, "1")
                    .env("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1")
                    .env("WEBKIT_DISABLE_COMPOSITING_MODE", "0")
                    .output().unwrap();
                assert!(
                    output.status.success(),
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }

            // Reconstruct the pre-application decision; the subprocess already inherited its result.
            let report = decision(env(&[
                ("XDG_SESSION_TYPE", "wayland"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "0"),
            ]));
            let dir = tempfile::tempdir().unwrap();
            let supervisor = dir.path().join("houston-supervisor");
            std::fs::write(
                &supervisor,
                "#!/bin/sh\n/usr/bin/env\nprintf 'render-test-done\\n'\n",
            )
            .unwrap();
            std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::fs::write(dir.path().join("houston-core"), "").unwrap();
            let log = dir.path().join("supervisor.log");
            crate::daemon_host::spawn_detached(
                dir.path(),
                &["--channel", "dev"],
                dir.path(),
                &log,
                &report,
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let output = loop {
                let output = std::fs::read_to_string(&log).unwrap();
                if output.contains("render-test-done") {
                    break output;
                }
                assert!(
                    Instant::now() < deadline,
                    "supervisor did not finish: {output}"
                );
                std::thread::sleep(Duration::from_millis(10));
            };
            assert!(
                !output.contains("WEBKIT_DMABUF_RENDERER_FORCE_SHM="),
                "{output}"
            );
            assert!(
                output.contains("WEBKIT_DISABLE_COMPOSITING_MODE=0"),
                "{output}"
            );

            let guard = houston_core::logging::init();
            report.report();
            decision(env(&[(SKIP_ENV, "1")])).report();
            drop(guard);
            let logs = std::fs::read_dir(houston_core::paths::log_dir().unwrap())
                .unwrap()
                .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
                .collect::<String>();
            assert!(
                logs.contains("WebKitGTK renderer environment overrides"),
                "{logs}"
            );
            assert!(
                logs.contains("inserted=[\"WEBKIT_DMABUF_RENDERER_FORCE_SHM\"]"),
                "{logs}"
            );
            assert!(
                logs.contains("preserved=[\"WEBKIT_DISABLE_COMPOSITING_MODE\"]"),
                "{logs}"
            );
            assert!(logs.contains("skipped=true"), "{logs}");
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::apply;

/// Off Linux there is no WebKitGTK to steer; the call site stays one.
#[cfg(not(target_os = "linux"))]
pub fn apply() -> AppliedOverrides {
    AppliedOverrides::default()
}

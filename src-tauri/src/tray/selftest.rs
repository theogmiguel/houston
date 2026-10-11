//! Debug-only native lifecycle fixture. The external harness owns the exit oracle.
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::{mpsc, Arc};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

use tauri::AppHandle;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[cfg(target_os = "linux")]
use super::{TrayAvailability, TrayHost};
#[cfg(target_os = "linux")]
use crate::watchdog::RendererHealth;

pub fn requested() -> bool {
    std::env::var_os("HOUSTON_EXIT_SELFTEST").is_some()
}

pub fn run(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = body(&app) {
            eprintln!("EXIT-SELFTEST failed: {error}");
            if let Ok(root) = root() {
                let _ = mark(&root, "failed", &error);
            }
        }
    });
}

fn root() -> Result<PathBuf, String> {
    let root =
        PathBuf::from(std::env::var("HOUSTON_EXIT_SELFTEST_DIR").map_err(|e| e.to_string())?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
    if !root.starts_with(
        std::env::temp_dir()
            .canonicalize()
            .map_err(|e| e.to_string())?,
    ) {
        return Err("selftest directory must be inside the temporary directory".into());
    }
    Ok(root)
}

fn mark(root: &Path, name: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::File::create(root.join(name)).map_err(|e| e.to_string())?;
    file.write_all(value.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn wait(description: &str, mut ready: impl FnMut() -> bool) -> Result<(), String> {
    wait_for(description, Duration::from_secs(15), &mut ready)
}

#[cfg(target_os = "linux")]
fn wait_for(
    description: &str,
    timeout: Duration,
    mut ready: impl FnMut() -> bool,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ready() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for {description}"))
}

#[cfg(target_os = "linux")]
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(action());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn body(app: &AppHandle) -> Result<(), String> {
    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;
    let mode = std::env::var("HOUSTON_EXIT_SELFTEST").map_err(|e| e.to_string())?;
    if !matches!(
        mode.as_str(),
        "close-crashed" | "close-wedged" | "close-healthy" | "quit-crashed" | "stop-crashed"
    ) {
        return Err(format!("unsupported native exit selftest mode {mode:?}"));
    }
    let root = root()?;
    let args: Vec<_> = std::env::args().collect();
    let channel = crate::daemon_host::parse_channel_flag(&args)
        .map_err(|e| format!("{e:?}"))?
        .filter(|c| c.starts_with("exit-selftest-"))
        .ok_or("explicit --channel exit-selftest-<unique> required")?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let host = app.state::<Arc<TrayHost>>();
    if home != root.join("home") || host.state_dir != home.join(format!(".houston-{channel}")) {
        return Err(
            "selftest HOME and channel state must be isolated under selftest directory".into(),
        );
    }
    wait("daemon connection", || {
        app.state::<crate::host::ConnectionCell>()
            .current()
            .is_some()
    })?;
    let main = app
        .get_webview_window("main")
        .ok_or("missing main window")?;
    let (tx, rx) = mpsc::sync_channel(1);
    main.with_webview(move |platform| {
        let view = platform.inner();
        let deadline = Instant::now() + Duration::from_secs(10);
        glib::timeout_add_local(Duration::from_millis(50), move || {
            if !view.is_loading() && view.uri().is_some_and(|uri| uri.as_str() != "about:blank") {
                let _ = tx.send(true);
                glib::ControlFlow::Break
            } else if Instant::now() >= deadline {
                let _ = tx.send(false);
                glib::ControlFlow::Break
            } else {
                glib::ControlFlow::Continue
            }
        });
    })
    .map_err(|e| e.to_string())?;
    if !rx
        .recv_timeout(Duration::from_secs(12))
        .map_err(|e| e.to_string())?
    {
        return Err("main native page did not load".into());
    }
    let handle = app.clone();
    on_main(app, move || {
        tauri::window::WindowBuilder::new(&handle, "exit-selftest-independent")
            .title("Native exit regression fixture")
            .build()
    })?
    .map_err(|e| e.to_string())?;
    *host.availability.lock().expect("tray availability mutex") = TrayAvailability::Available;
    host.keep_in_tray.store(true, super::Ordering::SeqCst);
    if !host.hides_on_close() || app.state::<Arc<RendererHealth>>().unavailable() {
        return Err("fixture requires healthy main and forced hide-to-tray".into());
    }
    mark(&root, "ready", &mode)?;
    wait("external PTY fixture", || root.join("go").exists())?;
    if mode == "close-wedged" {
        let terminated = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = terminated.clone();
        main.with_webview(move |platform| {
            platform
                .inner()
                .connect_web_process_terminated(move |_, _| {
                    observed.store(true, super::Ordering::SeqCst);
                });
        })
        .map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::sync_channel(1);
        main.eval_with_callback("({nativeExitReady:42})", move |payload| {
            let _ = tx.send(payload);
        })
        .map_err(|e| e.to_string())?;
        let reply = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let reply: serde_json::Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
        if reply["nativeExitReady"] != 42 || app.state::<Arc<RendererHealth>>().unavailable() {
            return Err("renderer was not responsive immediately before hang injection".into());
        }
        let watchdog_log = host.state_dir.join("watchdog.ndjson");
        let before = std::fs::read_to_string(&watchdog_log)
            .unwrap_or_default()
            .len();
        main.eval("window.__TAURI_INTERNALS__.invoke('system_log_debug', {source:'native-exit-selftest', message:'wedge-entered', payload:null}); for (;;) {}")
            .map_err(|e| e.to_string())?;
        wait("JavaScript entry receipt", || {
            std::fs::read_to_string(host.state_dir.join("app-debug.ndjson"))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .any(|record| {
                    record["source"] == "native-exit-selftest"
                        && record["message"] == "wedge-entered"
                })
        })?;
        wait_for(
            "watchdog detection of JavaScript hang",
            Duration::from_secs(40),
            || {
                let log = std::fs::read_to_string(&watchdog_log).unwrap_or_default();
                log.get(before..)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                    .any(|record| {
                        record["state"] == "unresponsive"
                            && record["trigger"]["kind"] == "probe-failed"
                            && record["incident_reason"] == "js-hang"
                    })
                    && app.state::<Arc<RendererHealth>>().unavailable()
            },
        )?;
        if terminated.load(super::Ordering::SeqCst) {
            return Err("renderer exited during the JavaScript hang fixture".into());
        }
        mark(
            &root,
            "hang-observed",
            "watchdog detected the injected JavaScript hang",
        )?;
    } else if mode != "close-healthy" {
        main.with_webview(|platform| platform.inner().terminate_web_process())
            .map_err(|e| e.to_string())?;
        wait("actual renderer termination health", || {
            app.state::<Arc<RendererHealth>>().unavailable()
        })?;
        mark(
            &root,
            "crash-observed",
            "native termination set RendererHealth.unavailable",
        )?;
    }
    // Persist before requesting exit: an exiting client cannot report success itself.
    mark(&root, "action", &mode)?;
    match mode.as_str() {
        "close-crashed" | "close-wedged" | "close-healthy" => {
            main.close().map_err(|e| e.to_string())?
        }
        "quit-crashed" => super::on_menu_event(
            app,
            tauri::menu::MenuEvent {
                id: super::MENU_ID_QUIT.into(),
            },
        ),
        "stop-crashed" => {
            let response_root = root.clone();
            on_main(app, move || {
                let deadline = Instant::now() + Duration::from_secs(10);
                glib::timeout_add_local(Duration::from_millis(50), move || {
                    let dialog = gtk::Window::list_toplevels()
                        .into_iter()
                        .filter_map(|widget| widget.downcast::<gtk::Dialog>().ok())
                        .find(|dialog| dialog.title().as_deref() == Some("Quit Houston"));
                    if let Some(dialog) = dialog {
                        if let Err(error) =
                            mark(&response_root, "confirmation", "native GTK response OK")
                        {
                            eprintln!("EXIT-SELFTEST confirmation marker failed: {error}");
                            return glib::ControlFlow::Break;
                        }
                        dialog.response(gtk::ResponseType::Ok);
                        return glib::ControlFlow::Break;
                    }
                    if Instant::now() >= deadline {
                        let _ = mark(
                            &response_root,
                            "failed",
                            "native stop confirmation did not appear",
                        );
                        glib::ControlFlow::Break
                    } else {
                        glib::ControlFlow::Continue
                    }
                });
            })?;
            super::on_menu_event(
                app,
                tauri::menu::MenuEvent {
                    id: super::MENU_ID_STOP.into(),
                },
            );
        }
        _ => unreachable!(),
    }
    if mode == "close-healthy" {
        wait("healthy main to hide", || {
            main.is_visible().is_ok_and(|v| !v)
        })?;
        if app.get_window("main").is_none()
            || app.get_window("exit-selftest-independent").is_none()
            || app.state::<Arc<RendererHealth>>().unavailable()
        {
            return Err("healthy close destroyed a window or renderer became unavailable".into());
        }
        mark(
            &root,
            "hidden",
            "healthy close retained both native windows",
        )?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn body(_app: &AppHandle) -> Result<(), String> {
    Err("native exit selftest requires Linux WebKitGTK; unsupported platform".into())
}

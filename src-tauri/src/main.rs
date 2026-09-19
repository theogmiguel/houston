#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_log;
mod app_update;
#[cfg(feature = "bench")]
mod bench;
mod browser;
mod clipboard;
mod daemon_host;
mod dialog;
mod fs;
mod fs_allowlist;
mod host;
mod shell;
mod shells;
mod skills;
mod spike_webview;
mod system;
mod tray;
mod watchdog;
mod webview_render;
mod window;
mod window_state;

use shells::ShellEntry;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::webview::PageLoadEvent;
use tauri::Manager;

#[tauri::command]
async fn detect_available_shells(
    cache: tauri::State<'_, shells::ShellsCache>,
) -> Result<Vec<ShellEntry>, ()> {
    Ok(shells::detect_available_shells(&cache).await)
}

#[tauri::command]
fn spike_report(shells: Vec<ShellEntry>) {
    println!("houston-tauri: spike_report received via JS invoke: {shells:?}");
}

fn daemon_fresh_requested() -> bool {
    std::env::args().any(|arg| arg == "--daemon-fresh")
}

fn spike_invoke_requested() -> bool {
    std::env::args().any(|arg| arg == "--spike-invoke")
        || std::env::var_os("TR_SPIKE_INVOKE").is_some()
}

#[cfg(feature = "bench")]
fn bench_requested() -> bool {
    std::env::args().any(|arg| arg == "--bench" || arg.starts_with("--bench="))
}

#[cfg(feature = "bench")]
fn spawn_bench_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(600));
        eprintln!(
            "houston-tauri: BENCH WATCHDOG: run did not finish within 600s; \
             force-exiting so the window cannot be left stuck on screen"
        );
        app.exit(1);
    });
}

// The literal `channel-` prefix is load-bearing: a D-Bus well-known name element
// must not start with a digit, but a channel name may be purely numeric.
fn dbus_id_for(identifier: &str, channel: Option<&str>) -> String {
    let label = channel.unwrap_or("release");
    format!("{identifier}.channel-{label}")
}

async fn refuse_boot(err: daemon_host::BootRefusal, state_dir: &std::path::Path) {
    eprintln!("houston-tauri: {err}");
    if boot_refusal_may_prompt() {
        if err.daemon.is_some() {
            let choice = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title("Houston cannot attach to the running daemon")
                .set_description(format!(
                    "{}\n\nKeep it running and quit, or stop it now (ends every session it \
                     owns) and quit?",
                    err.message
                ))
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    "Stop daemon and quit".to_string(),
                    "Keep running and quit".to_string(),
                ))
                .show();
            if choice == rfd::MessageDialogResult::Custom("Stop daemon and quit".to_string()) {
                if let Err(stop_err) = daemon_host::run_daemon_fresh_via_manage(state_dir).await {
                    eprintln!("houston-tauri: explicit stop failed: {stop_err}");
                }
            }
        } else {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Warning)
                .set_title("Houston cannot start")
                .set_description(err.message.clone())
                .show();
        }
    }
    if let Some(app) = APP_HANDLE.get() {
        app.exit(1);
    } else {
        std::process::exit(1);
    }
}

fn boot_refusal_may_prompt() -> bool {
    #[cfg(feature = "bench")]
    let bench = bench_requested();
    #[cfg(not(feature = "bench"))]
    let bench = false;
    boot_refusal_may_prompt_when(has_display(), bench)
}

fn boot_refusal_may_prompt_when(has_display: bool, bench_run: bool) -> bool {
    has_display && !bench_run
}

/// An exit request with a code terminates the process — except Tauri's restart
/// request, which relaunches it after the Exit callback returns.
fn should_terminate_process(code: i32) -> bool {
    code != 0 && code != tauri::RESTART_EXIT_CODE
}

#[cfg(unix)]
fn has_display() -> bool {
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}
#[cfg(windows)]
fn has_display() -> bool {
    true
}

// Per-channel renderer state: without an explicit `data_directory`, Tauri keys the
// webview's localStorage/cache by the bundle identifier alone, so a dev process
// silently overwrites the release channel's renderer state.
fn webview_data_dir_for(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join("webview")
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

static DAEMON_HANDLE: OnceLock<daemon_host::DaemonHandle> = OnceLock::new();

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Before anything that needs a window, a channel or a daemon: asking which
    // build this is must work on a headless box and must not start one.
    if matches!(args.get(1).map(String::as_str), Some("--version" | "-V")) {
        println!(
            "houston {} ({}) protocol {}",
            env!("CARGO_PKG_VERSION"),
            houston_core::daemon::build_commit(),
            houston_protocol::PROTOCOL_VERSION,
        );
        return;
    }

    if args.get(1).map(String::as_str) == Some("hook") {
        houston_core::claude_hooks::run_hook_client(&args);
        return;
    }

    if args.get(1).map(String::as_str) == Some("hs-mail") {
        eprintln!(
            "hs-mail is gone: messages between panes are inbox rows; use pane_submit, or \
             hs-pane for the CLI-only providers"
        );
        std::process::exit(1);
    }

    if args.get(1).map(String::as_str) == Some("hs-pane") {
        std::process::exit(houston_core::orchestrate::run_pane_cli(&args[2..]));
    }

    // WebKit reads these when the first webview is created; keep this above the builder.
    let render_overrides = webview_render::apply();

    #[cfg(feature = "bench")]
    if args.get(1).map(String::as_str) == Some("bench-ansi-flood") {
        let mib = args
            .get(2)
            .and_then(|a| a.parse::<usize>().ok())
            .unwrap_or(8);
        bench::run_ansi_flood(mib);
        return;
    }

    #[cfg(feature = "bench")]
    let boot_stamps = bench::BootStamps::new();

    #[cfg(not(feature = "bench"))]
    if daemon_host::bench_flag_present(&args) {
        eprintln!("{}", daemon_host::bench_feature_missing_message());
        std::process::exit(1);
    }

    #[cfg(feature = "bench")]
    let run_bench = bench_requested();
    #[cfg(feature = "bench")]
    if run_bench {
        bench::refuse_if_debug_without_escape_hatch();
        if let Some(refusal) = bench::bench_channel_refusal_if_needed(
            daemon_host::channel_flag_present(&args),
            cfg!(debug_assertions),
            std::env::var(daemon_host::CHANNEL_ENV).ok(),
        ) {
            eprintln!("{}", refusal.message());
            std::process::exit(1);
        }
    }

    if let Err(err) = daemon_host::reject_unrecognized_args(&args) {
        eprintln!("{}", err.message());
        std::process::exit(1);
    }

    let raw_pane_channel_env = std::env::var(daemon_host::CHANNEL_ENV).ok();

    let channel_flag = match daemon_host::parse_channel_flag(&args) {
        Ok(flag) => flag,
        Err(err) => {
            eprintln!("{}", err.message());
            std::process::exit(1);
        }
    };

    #[cfg(feature = "bench")]
    let bench_scenarios = if run_bench {
        match bench::parse_bench_scenarios(&args) {
            Ok(selection) => selection,
            Err(err) => {
                eprintln!("{}", err.message());
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    let daemon_fresh = daemon_fresh_requested();
    let print_target = daemon_host::print_target_requested(&args);

    let home = match houston_core::home_dir::home_dir() {
        Some(home) => home,
        None => {
            eprintln!("houston-tauri: refusing to own a daemon: cannot resolve the home directory");
            std::process::exit(1);
        }
    };

    let owning_channel = match daemon_host::resolve_owning_channel(
        cfg!(debug_assertions),
        channel_flag.as_deref(),
    ) {
        Ok(channel) => channel,
        Err(refusal) => {
            eprintln!("{}", refusal.message());
            std::process::exit(1);
        }
    };
    let state_dir = houston_core::paths::dir_for(&home, owning_channel.as_deref());
    let target_channel_label = owning_channel
        .clone()
        .unwrap_or_else(|| "release".to_string());

    let explicit_release_requested =
        daemon_host::release_warning_needed(channel_flag.is_some(), owning_channel.as_deref());

    if explicit_release_requested {
        if print_target {
            eprintln!(
                "houston-tauri: WARNING: --channel release requested — a real run would \
                 drive the INSTALLED APP's own daemon and live state dir ({}).",
                state_dir.display()
            );
        } else {
            eprintln!(
                "houston-tauri: WARNING: --channel release requested — this drives the \
                 INSTALLED APP's own daemon and live state dir ({}). This is the shared, \
                 dangerous mode: it can touch sessions the installed app owns.",
                state_dir.display()
            );
        }
    }

    match owning_channel.as_deref() {
        Some(channel) => std::env::set_var(daemon_host::CHANNEL_ENV, channel),
        None => std::env::remove_var(daemon_host::CHANNEL_ENV),
    }

    if print_target {
        let config_dir = houston_core::paths::config_dir();
        let log_dir = houston_core::paths::log_dir();
        println!(
            "houston-tauri: --print-target: channel={target_channel_label} state_dir={} \
             config_dir={} log_dir={}",
            state_dir.display(),
            config_dir
                .as_ref()
                .map(|d| d.display().to_string())
                .unwrap_or_else(|e| format!("<error: {e}>")),
            log_dir
                .as_ref()
                .map(|d| d.display().to_string())
                .unwrap_or_else(|e| format!("<error: {e}>")),
        );
        std::process::exit(0);
    }

    let _log_guard = houston_core::logging::init();
    render_overrides.report();

    houston_core::env_hygiene::scrub();
    houston_core::login_path::adopt();

    match houston_core::paths::config_dir() {
        Ok(dir) => println!("houston-tauri: houston-core state dir = {}", dir.display()),
        Err(err) => {
            eprintln!("houston-tauri: failed to resolve houston-core state dir: {err}");
        }
    }

    let channel_label = match houston_core::paths::channel() {
        Ok(channel) => channel.unwrap_or_else(|| "release".to_string()),
        Err(err) => {
            eprintln!("houston-tauri: refusing to start: {err}");
            std::process::exit(1);
        }
    };
    debug_assert_eq!(
        channel_label, target_channel_label,
        "a read site (paths::channel()) disagreed with the resolved owning channel -- the \
         finding 1b env sync above is supposed to make this impossible"
    );

    let tokio_runtime: &'static tokio::runtime::Runtime =
        Box::leak(Box::new(match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(err) => {
                eprintln!("houston-tauri: failed to build the app's tokio runtime: {err}");
                std::process::exit(1);
            }
        }));

    if daemon_fresh {
        let pane_channel_label =
            daemon_host::normalize_channel_label(raw_pane_channel_env.as_deref());
        let session_env = std::env::var(daemon_host::SESSION_ENV).ok();
        if daemon_host::daemon_fresh_self_protection(
            session_env.as_deref(),
            &pane_channel_label,
            &target_channel_label,
        ) {
            eprintln!(
                "{}",
                daemon_host::self_protection_refusal_message(
                    &target_channel_label,
                    session_env.as_deref().unwrap_or(""),
                )
            );
            std::process::exit(1);
        }
        if let Err(err) =
            tokio_runtime.block_on(daemon_host::run_daemon_fresh_via_manage(&state_dir))
        {
            eprintln!("houston-tauri: {err}");
            std::process::exit(1);
        }
    }

    let (connection_tx, connection_rx) =
        tokio::sync::watch::channel::<Option<host::ConnectionInfo>>(None);

    let spawn_reason: Option<daemon_host::StaleReason> =
        match tokio_runtime.block_on(daemon_host::precheck(&state_dir)) {
            Ok(daemon_host::BootPrecheck::Attached(handle)) => {
                let _ = connection_tx.send(Some(host::ConnectionInfo {
                    port: handle.port,
                    token: handle.token.clone(),
                }));
                if DAEMON_HANDLE.set(handle).is_err() {
                    eprintln!(
                        "houston-tauri: BUG: daemon handle set twice -- keeping the first, a \
                         second precheck should be unreachable"
                    );
                }
                None
            }
            Ok(daemon_host::BootPrecheck::NeedsSpawn(reason)) => Some(reason),
            Err(err) => {
                tokio_runtime.block_on(refuse_boot(err, &state_dir));
                std::process::exit(1);
            }
        };

    let run_spike = spike_invoke_requested();
    let run_webview_auto = spike_webview::auto_requested();
    let run_webview_interactive = spike_webview::interactive_requested() && !run_webview_auto;
    let webview_spike_fired = Arc::new(AtomicBool::new(false));
    let spike_fired = Arc::new(AtomicBool::new(false));

    let run_browser_selftest = browser::selftest::requested();
    let browser_selftest_fired = Arc::new(AtomicBool::new(false));

    #[cfg(debug_assertions)]
    let wasm_csp_probe_fired = Arc::new(AtomicBool::new(false));

    #[cfg(feature = "bench")]
    let bench_fired = Arc::new(AtomicBool::new(false));

    let context = tauri::generate_context!();
    let dbus_id = dbus_id_for(&context.config().identifier, Some(&channel_label));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(feature = "bench")]
    {
        builder = builder.manage(bench::BenchState::new(bench_scenarios));
        builder = builder.manage(boot_stamps.clone());
    }
    builder = builder.manage(host::ConnectionCell::new(connection_rx));
    builder = builder.manage(fs_allowlist::AllowedRoots::new());
    builder = builder.manage(shells::ShellsCache::new());
    builder = builder.manage(browser::BrowserRegistry::new());
    builder = builder.manage(browser::confirm::ConfirmRegistry::new());
    builder = builder.manage(app_update::UpdateFlight::new());
    builder = builder.manage(app_update::ActiveStateDir::new(state_dir.clone()));

    let tray_host = tray::TrayHost::new(state_dir.clone(), tray::probe());
    builder = builder.manage(Arc::clone(&tray_host));

    builder
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                .dbus_id(dbus_id)
                .callback(move |app, _argv, _cwd| {
                    eprintln!(
                        "houston-tauri: rejected a second launch on channel \
                         {channel_label:?} (already owned by this instance); focusing the \
                         existing window"
                    );
                    if let Some(window) = app.get_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // No `updater:default` permission anywhere: the plugin's own JS commands
        // stay unreachable, and updates run through app_update_install instead.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler({
            let commands: Box<
                dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
            > = Box::new(tauri::generate_handler![
            detect_available_shells,
            spike_report,
            app_log::system_log_debug,
            app_update::app_update_install,
            host::host_config,
            fs_allowlist::fs_add_allowed_root,
            fs_allowlist::fs_set_allowed_roots,
            fs::fs_read_directory,
            fs::fs_picker_list_dirs,
            fs::fs_read_file,
            fs::fs_read_media,
            fs::fs_write_file,
            fs::fs_stat,
            fs::fs_exists,
            fs::fs_delete,
            fs::fs_create_file,
            fs::fs_create_directory,
            fs::fs_rename,
            fs::fs_entry_count,
            fs::fs_save_image,
            fs::fs_read_capture,
            fs::fs_save_review,
            fs::fs_copy_dropped_file,
            fs::fs_set_window_background,
            fs::fs_read_window_background,
            fs::fs_window_background_info,
            fs::fs_remove_window_background,
            fs::fs_settle_window_background,
            clipboard::clipboard_save_image,
            clipboard::clipboard_read_text,
            dialog::dialog_pick_directory,
            dialog::dialog_pick_directories,
            dialog::dialog_pick_file,
            dialog::dialog_pick_image,
            dialog::dialog_save_image_url,
            shell::shell_open_external,
            shell::shell_show_item_in_folder,
            shell::shell_open_media_file,
            shell::shell_list_editors,
            shell::shell_open_in_editor,
            system::system_get_log_path,
            system::system_third_party_licenses,
            system::system_get_home_dir,
            skills::system_list_skills,
            skills::system_write_skill,
            skills::system_delete_skill,
            skills::system_preview_skill_url,
            skills::system_install_skill_url,
            window::window_button_layout,
            window::window_close,
            window::window_minimize,
            window::window_maximize,
            window::window_is_maximized,
            window::window_is_focused,
            window::window_toggle_fullscreen,
            window::window_set_zoom,
            window::window_focus,
            window::window_set_background_color,
            window::window_start_dragging,
            window::window_start_resize_dragging,
            tray::tray_sync,
            tray::tray_state,
            tray::tray_set_keep_in_tray,
            tray::app_quit,
            spike_webview::spike_wv_mount,
            spike_webview::spike_wv_set_bounds,
            spike_webview::spike_wv_geometry,
            spike_webview::spike_wv_set_visible,
            spike_webview::spike_wv_destroy,
            spike_webview::spike_wv_focus,
            spike_webview::spike_wv_labels,
            spike_webview::spike_wv_window_metrics,
            spike_webview::spike_wv_drag_probe,
            spike_webview::spike_wv_read_tick,
            spike_webview::spike_wv_eval_read,
            spike_webview::spike_wv_url,
            spike_webview::spike_wv_webkit_processes,
            spike_webview::spike_wv_gtk_layout,
            browser::browser_mount,
            browser::browser_destroy,
            browser::browser_detach,
            browser::browser_reattach,
            browser::browser_resize,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_go_back,
            browser::browser_go_forward,
            browser::browser_capture,
            browser::browser_set_workspace,
            browser::browser_confirm_respond,
            browser::browser_confirm_screenshot,
            browser::browser_confirm_trusted,
            browser::browser_confirm_revoke_trust,
            browser::browser_focus_host,
            browser::browser_browsing_data_size,
            browser::browser_clear_browsing_data,
            browser::browser_set_picker_mode,
            browser::browser_clear_picker_selection,
            browser::browser_submit_picker_prompt,
            watchdog::wd_paint_report,
            watchdog::wd_request_reload,
            watchdog::wd_report_wake,
            watchdog::wd_debug_wedge,
            #[cfg(feature = "bench")]
            bench::bench_channel_blast,
            #[cfg(feature = "bench")]
            bench::bench_channel_blast_paced,
            #[cfg(feature = "bench")]
            bench::bench_done,
            #[cfg(feature = "bench")]
            bench::bench_ws_start,
            #[cfg(feature = "bench")]
            bench::bench_config,
            #[cfg(feature = "bench")]
            bench::bench_scenario_selection,
            #[cfg(feature = "bench")]
            bench::bench_binary_info,
            #[cfg(feature = "bench")]
            bench::bench_checkpoint,
            #[cfg(feature = "bench")]
            bench::bench_log,
            #[cfg(feature = "bench")]
            bench::bench_report,
            #[cfg(feature = "bench")]
            bench::bench_failed,
            #[cfg(feature = "bench")]
            bench::bench_m10_stamp,
            #[cfg(feature = "bench")]
            bench::bench_m10_stamps,
            #[cfg(feature = "bench")]
            bench::bench_rss,
            #[cfg(feature = "bench")]
            bench::bench_session_count,
            #[cfg(feature = "bench")]
            bench::bench_stdin,
            #[cfg(feature = "bench")]
            bench::bench_session_kill,
            ]);
            // A browser pane's content webview holds no app authority: every command
            // is refused by name here before dispatch, since the page-side transport
            // sever is best-effort per engine and survives on some.
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                let label = invoke.message.webview_ref().label().to_string();
                if browser::id::is_content_only_label(&label) {
                    let command = invoke.message.command().to_string();
                    eprintln!(
                        "browser: SECURITY refused command {command:?} invoked from content-only \
                         webview {label:?}; browser panes hold no app authority"
                    );
                    invoke.resolver.reject(format!(
                        "command {command:?} is not available to a browser pane: this webview is \
                         a content-only surface and holds no app authority"
                    ));
                    return true;
                }
                commands(invoke)
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                browser::follow_window_resize(window);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !tray::is_quitting() {
                    let hides = window
                        .app_handle()
                        .try_state::<Arc<tray::TrayHost>>()
                        .map(|host| host.hides_on_close())
                        .unwrap_or(false);
                    if hides {
                        if let Some(tracker) = window
                            .app_handle()
                            .try_state::<Arc<window_state::WindowStateTracker>>()
                        {
                            tracker.flush();
                        }
                        api.prevent_close();
                        if let Err(err) = window.hide() {
                            eprintln!(
                                "houston-tauri: could not hide the window to the tray ({err}); leaving it open"
                            );
                        }
                        return;
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                browser::handle_window_closed(window.app_handle(), window.label());
            }
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        if let Some(tracker) = window
                            .app_handle()
                            .try_state::<Arc<window_state::WindowStateTracker>>()
                        {
                            tracker.record(window);
                        }
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        if let Some(tracker) = window
                            .app_handle()
                            .try_state::<Arc<window_state::WindowStateTracker>>()
                        {
                            tracker.flush();
                        }
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            {
                let app_handle = app.handle().clone();
                let state_dir = state_dir.clone();
                let owning_channel = owning_channel.clone();
                let target_channel_label = target_channel_label.clone();
                let connection_tx = connection_tx.clone();
                #[cfg(feature = "bench")]
                let boot_stamps = boot_stamps.clone();
                tokio_runtime.spawn(async move {
                    #[cfg(feature = "bench")]
                    boot_stamps.stamp("daemon-boot-start");
                    let channel_flag_args: Vec<&str> = match owning_channel.as_deref() {
                        Some(channel) => vec!["--channel", channel],
                        None => vec![],
                    };
                    let outcome = match spawn_reason {
                        Some(reason) => {
                            daemon_host::spawn_and_wait(
                                state_dir.clone(),
                                &channel_flag_args,
                                &reason,
                                &render_overrides,
                            )
                            .await
                        }
                        None => Ok(DAEMON_HANDLE
                            .get()
                            .expect("precheck attached, so it set DAEMON_HANDLE before the builder")
                            .clone()),
                    };
                    match outcome {
                        Ok(handle) => {
                            eprintln!(
                                "houston-tauri: {} daemon on port {} (channel \
                                 '{target_channel_label}')",
                                if handle.spawned {
                                    "spawned a fresh"
                                } else {
                                    "attached to the running"
                                },
                                handle.port
                            );
                            #[cfg(feature = "bench")]
                            boot_stamps.stamp("daemon-ready");
                            let _ = connection_tx.send(Some(host::ConnectionInfo {
                                port: handle.port,
                                token: handle.token.clone(),
                            }));
                            let _ = DAEMON_HANDLE.set(handle);
                            let handle = DAEMON_HANDLE
                                .get()
                                .expect("set by precheck pre-window, or on the line above");

                            tokio_runtime.spawn(browser::relay_client::run(
                                app_handle.clone(),
                                handle.port,
                                handle.token.clone(),
                            ));

                            tokio_runtime.spawn(async move {
                                daemon_host::wait_for_terminate_or_interrupt().await;
                                eprintln!("houston-tauri: shutting down (signal)…");
                                daemon_host::react_to_terminate_signal(
                                    APP_HANDLE.get().is_some(),
                                    &mut || {
                                        if let Some(h) = DAEMON_HANDLE.get() {
                                            daemon_host::shutdown(h);
                                        }
                                    },
                                    &mut || {
                                        if let Some(app) = APP_HANDLE.get() {
                                            app.exit(0);
                                        }
                                    },
                                    &mut || std::process::exit(0),
                                );
                            });
                        }
                        Err(err) => {
                            refuse_boot(err, &state_dir).await;
                        }
                    }
                });
            }

            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect(
                    "tauri.conf.json must declare the main window's config (create: false) -- \
                     item 17's builder reads it via WebviewWindowBuilder::from_config",
                );

            let webview_data_dir = webview_data_dir_for(&state_dir);

            let monitors: Vec<window_state::MonitorRect> = app
                .available_monitors()
                .unwrap_or_default()
                .into_iter()
                .map(|m| window_state::MonitorRect {
                    x: m.work_area().position.x,
                    y: m.work_area().position.y,
                    width: m.work_area().size.width as i32,
                    height: m.work_area().size.height as i32,
                    scale_factor: m.scale_factor(),
                })
                .collect();
            let startup_geometry = window_state::resolve_startup_geometry(
                window_state::load_saved_bounds(&state_dir),
                &monitors,
            );

            let main_window = tauri::WebviewWindowBuilder::from_config(app, &window_config)
                .expect("tauri.conf.json's window config failed to parse into a WebviewWindowBuilder")
                .data_directory(webview_data_dir)
                .build()
                .expect("failed to build the main window");

            if let window_state::StartupGeometry::Restore {
                x,
                y,
                width,
                height,
                maximized,
            } = startup_geometry
            {
                if let Err(err) =
                    main_window.set_size(tauri::PhysicalSize::new(width as u32, height as u32))
                {
                    eprintln!("houston-tauri: failed to restore window size: {err}");
                }
                if let Err(err) = main_window.set_position(tauri::PhysicalPosition::new(x, y)) {
                    eprintln!("houston-tauri: failed to restore window position: {err}");
                }
                if maximized {
                    if let Err(err) = main_window.maximize() {
                        eprintln!("houston-tauri: failed to restore maximized state: {err}");
                    }
                }
            }

            let tracker_initial = window_state::SavedBounds {
                x: main_window.outer_position().map(|p| p.x).unwrap_or(0),
                y: main_window.outer_position().map(|p| p.y).unwrap_or(0),
                width: main_window
                    .outer_size()
                    .map(|s| s.width as i32)
                    .unwrap_or(1400),
                height: main_window
                    .outer_size()
                    .map(|s| s.height as i32)
                    .unwrap_or(900),
                maximized: main_window.is_maximized().unwrap_or(false),
            };
            app.manage(window_state::WindowStateTracker::new(
                state_dir.clone(),
                tracker_initial,
            ));

            tray::install(app.handle(), &tray_host);

            #[cfg(debug_assertions)]
            if std::env::var("HOUSTON_DEVTOOLS").as_deref() == Ok("1") {
                main_window.open_devtools();
                println!("houston-tauri: devtools opened for the main window");
            }

            #[cfg(feature = "bench")]
            app.state::<Arc<bench::BootStamps>>().stamp("window-created");

            let app_log_path = match houston_core::paths::config_dir() {
                Ok(dir) => dir.join("app-debug.ndjson"),
                Err(err) => {
                    eprintln!(
                        "houston-tauri: app debug log falling back to the temp dir: cannot \
                         resolve the channel state dir: {err}"
                    );
                    std::env::temp_dir().join("houston-app-debug.ndjson")
                }
            };
            app.manage(app_log::AppDebugSink::new(app_log_path));

            #[cfg(feature = "bench")]
            if run_bench {
                spawn_bench_watchdog(app.handle().clone());
            }
            let log_path = match houston_core::paths::config_dir() {
                Ok(dir) => dir.join("watchdog.ndjson"),
                Err(err) => {
                    eprintln!(
                        "houston-tauri: watchdog log falling back to the temp dir: \
                         cannot resolve the channel state dir: {err}"
                    );
                    std::env::temp_dir().join("houston-watchdog.ndjson")
                }
            };
            watchdog::install_termination_logger(app.handle(), "main");

            if let Some(config) = watchdog::Config::from_env(log_path) {
                watchdog::install(app.handle(), "main", config);
            }
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                watchdog::note_page_loaded(webview.app_handle());
                watchdog::maybe_selftest_wedge(webview.app_handle());
            }
            #[cfg(debug_assertions)]
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && std::env::var("HOUSTON_DOM_PROBE").as_deref() == Ok("1")
            {
                if let Err(err) = webview.eval(include_str!("dom_probe.js")) {
                    eprintln!("houston-tauri: dom-probe eval failed: {err}");
                }
            }
            #[cfg(feature = "bench")]
            if webview.label() == "main" {
                let stamps = webview.app_handle().state::<Arc<bench::BootStamps>>();
                match payload.event() {
                    PageLoadEvent::Started => stamps.stamp("page-load-started"),
                    PageLoadEvent::Finished => stamps.stamp("page-load-finished"),
                }
            }
            #[cfg(debug_assertions)]
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && std::env::var("HOUSTON_M8_PROBE").as_deref() == Ok("1")
            {
                if let Err(err) = webview.eval(include_str!("m8_probe.js")) {
                    eprintln!("houston-tauri: m8-probe eval failed: {err}");
                }
            }
            #[cfg(debug_assertions)]
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && !wasm_csp_probe_fired.swap(true, Ordering::SeqCst)
            {
                if let Err(err) = webview.eval(include_str!("wasm_csp_probe.js")) {
                    eprintln!("houston-tauri: wasm-csp-probe eval failed: {err}");
                }
            }
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && (run_webview_auto || run_webview_interactive)
                && !webview_spike_fired.swap(true, Ordering::SeqCst)
            {
                if run_webview_auto {
                    spike_webview::run_auto_probe(webview.app_handle().clone());
                } else if let Err(err) = webview.eval(spike_webview::HARNESS_SCRIPT) {
                    eprintln!("houston-tauri: spike-webview harness eval failed: {err}");
                }
            }
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && run_browser_selftest
                && !browser_selftest_fired.swap(true, Ordering::SeqCst)
            {
                browser::selftest::run(webview.app_handle().clone());
            }
            #[cfg(feature = "bench")]
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && run_bench
                && !bench_fired.swap(true, Ordering::SeqCst)
            {
                if let Ok(raw) = std::env::var("TR_BENCH_WRITE_BURST_MS") {
                    match raw.parse::<f64>() {
                        Ok(ms) if ms.is_finite() && ms > 0.0 => {
                            if let Err(err) = webview
                                .eval(format!("window.__TR_WRITE_BURST_BUDGET_MS = {ms};"))
                            {
                                eprintln!(
                                    "houston-tauri: burst-budget override eval failed: {err}"
                                );
                            }
                        }
                        _ => eprintln!(
                            "houston-tauri: TR_BENCH_WRITE_BURST_MS={raw:?} is not a \
                             positive finite number of milliseconds -- using the built-in \
                             default"
                        ),
                    }
                }
                let _ = webview.set_focus();
                if let Err(err) = webview.eval(include_str!("bench_harness.js")) {
                    eprintln!("houston-tauri: bench harness eval failed: {err}");
                    webview.app_handle().exit(1);
                }
            }
            if !run_spike
                || webview.label() != "main"
                || payload.event() != PageLoadEvent::Finished
                || spike_fired.swap(true, Ordering::SeqCst)
            {
                return;
            }
            let script = r#"
                (function () {
                    window.__TAURI_INTERNALS__.invoke('detect_available_shells')
                        .then(function (shells) {
                            return window.__TAURI_INTERNALS__.invoke('spike_report', { shells: shells });
                        })
                        .catch(function (err) {
                            console.error('houston-tauri spike-invoke failed:', err);
                        });
                })();
            "#;
            if let Err(err) = webview.eval(script) {
                eprintln!("houston-tauri: spike-invoke eval failed: {err}");
            }
        })
        .build(context)
        .expect("error while building houston-tauri")
        .run({
            let requested_code = std::cell::Cell::new(0);
            move |_app_handle, event| {
                if let tauri::RunEvent::ExitRequested { code: Some(code), .. } = &event {
                    requested_code.set(*code);
                }
                if let tauri::RunEvent::Exit = event {
                    if let Some(handle) = DAEMON_HANDLE.get() {
                        daemon_host::shutdown(handle);
                    }
                    let code = requested_code.get();
                    if should_terminate_process(code) {
                        std::process::exit(code);
                    }
                }
            }
        });
}

#[cfg(test)]
mod exit_code_tests {
    use super::should_terminate_process;

    #[test]
    fn a_restart_request_is_not_a_terminate() {
        assert!(
            !should_terminate_process(tauri::RESTART_EXIT_CODE),
            "Tauri relaunches after an Exit with its restart code; process::exit would eat it"
        );
        assert!(!should_terminate_process(0));
        assert!(should_terminate_process(1));
    }
}

#[cfg(test)]
mod dbus_id_tests {
    use super::dbus_id_for;

    #[test]
    fn none_channel_uses_release_label() {
        assert_eq!(
            dbus_id_for("com.example.app", None),
            "com.example.app.channel-release"
        );
    }

    #[test]
    fn normal_channel_is_appended() {
        assert_eq!(
            dbus_id_for("com.example.app", Some("dev")),
            "com.example.app.channel-dev"
        );
    }

    #[test]
    fn purely_numeric_channel_does_not_start_the_element_with_a_digit() {
        let id = dbus_id_for("com.example.app", Some("123"));
        let element = id.rsplit('.').next().expect("id has a final segment");
        assert!(
            !element.starts_with(|c: char| c.is_ascii_digit()),
            "well-known name element {element:?} must not start with a digit"
        );
        assert_eq!(id, "com.example.app.channel-123");
    }

    #[test]
    fn different_channels_produce_distinct_non_prefixing_ids() {
        let dev = dbus_id_for("com.example.app", Some("dev"));
        let beta = dbus_id_for("com.example.app", Some("beta"));
        assert_ne!(dev, beta);
        assert!(!dev.starts_with(&beta) && !beta.starts_with(&dev));
    }
}

#[cfg(test)]
mod boot_refusal_prompt_tests {
    use super::boot_refusal_may_prompt_when;

    #[test]
    fn a_bench_run_never_prompts_even_with_a_display() {
        assert!(
            !boot_refusal_may_prompt_when(true, true),
            "a bench run is unattended: a modal there waits forever on a button nobody presses"
        );
    }

    #[test]
    fn a_headless_run_never_prompts() {
        assert!(!boot_refusal_may_prompt_when(false, false));
        assert!(!boot_refusal_may_prompt_when(false, true));
    }

    #[test]
    fn an_ordinary_run_with_a_display_still_prompts() {
        assert!(boot_refusal_may_prompt_when(true, false));
    }
}

#[cfg(test)]
mod webview_data_dir_tests {
    use super::webview_data_dir_for;
    use std::path::PathBuf;

    #[test]
    fn joins_webview_under_the_given_state_dir() {
        let state_dir = PathBuf::from("/synthetic/state/dir");
        assert_eq!(
            webview_data_dir_for(&state_dir),
            PathBuf::from("/synthetic/state/dir/webview")
        );
    }

    #[test]
    fn the_result_stays_strictly_under_the_state_dir_it_was_given() {
        let state_dir = PathBuf::from("/home/user/.houston-dev");
        let resolved = webview_data_dir_for(&state_dir);
        assert!(
            resolved.starts_with(&state_dir) && resolved != state_dir,
            "expected a path strictly inside {state_dir:?}, got {resolved:?}"
        );
    }
}

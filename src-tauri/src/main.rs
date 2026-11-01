#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_log;
mod app_menu;
mod app_update;
mod clipboard;
mod dialog;
mod fs;
mod fs_allowlist;
mod notifications;
mod provider_auth;
mod shell;
mod shells;
mod skills;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod snapshot;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
#[path = "snapshot/unsupported.rs"]
mod snapshot;
mod sys;
mod system;
#[cfg(test)]
mod test_home;
mod transfer_open;
mod tray;
mod v1_cleanup;
mod v2_server;
mod v2_ssh;
mod window;
mod window_state;
mod wsl;

use shells::ShellEntry;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};

#[tauri::command]
async fn detect_available_shells(
    cache: tauri::State<'_, shells::ShellsCache>,
) -> Result<Vec<ShellEntry>, ()> {
    Ok(shells::detect_available_shells(&cache).await)
}

const CHANNEL_ENV: &str = crate::sys::paths::CHANNEL_ENV;
const KNOWN_STANDALONE_FLAGS: &[&str] = &["--print-target"];

fn accepted_flags_description() -> String {
    "--channel <name> (or --channel=<name>), --print-target".to_string()
}

#[derive(Debug, PartialEq, Eq)]
struct UnrecognizedArgError {
    token: String,
}

impl UnrecognizedArgError {
    fn message(&self) -> String {
        format!(
            "houston-tauri: unrecognized argument: {:?}. Accepted flags: {}",
            self.token,
            accepted_flags_description()
        )
    }
}

fn reject_unrecognized_args(args: &[String]) -> Result<(), UnrecognizedArgError> {
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--channel" {
            i += 2;
            continue;
        }
        if arg.starts_with("--channel=") || KNOWN_STANDALONE_FLAGS.contains(&arg.as_str()) {
            i += 1;
            continue;
        }
        // Opening a transfer file with the app passes its path; `transfer_open` reads it.
        if crate::transfer_open::is_transfer_path(arg) {
            i += 1;
            continue;
        }
        return Err(UnrecognizedArgError { token: arg.clone() });
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ChannelFlagError {
    MissingValue,
    EmptyValue(String),
}

impl ChannelFlagError {
    fn message(&self) -> String {
        match self {
            ChannelFlagError::MissingValue => "houston-tauri: --channel requires a value \
                 (got none). Expected: --channel <name>, e.g. --channel release"
                .to_string(),
            ChannelFlagError::EmptyValue(raw) => format!(
                "houston-tauri: --channel was given {raw:?}, which is empty or \
                 whitespace-only after trimming. Expected: 1-32 characters of [a-z0-9-] (not \
                 starting or ending with '-'), or the literal \"release\"."
            ),
        }
    }
}

fn parse_channel_flag(args: &[String]) -> Result<Option<String>, ChannelFlagError> {
    let mut last: Option<Result<String, ChannelFlagError>> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--channel" {
            last = Some(match args.get(i + 1) {
                Some(value) if !value.trim().is_empty() => Ok(value.clone()),
                Some(value) => Err(ChannelFlagError::EmptyValue(value.clone())),
                None => Err(ChannelFlagError::MissingValue),
            });
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--channel=") {
            last = Some(if value.trim().is_empty() {
                Err(ChannelFlagError::EmptyValue(value.to_string()))
            } else {
                Ok(value.to_string())
            });
        }
        i += 1;
    }
    last.map_or(Ok(None), |result| result.map(Some))
}

fn print_target_requested(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--print-target")
}

fn resolve_owning_channel(
    debug_build: bool,
    channel_flag: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(raw) = channel_flag {
        return crate::sys::paths::validate_channel(raw).map_err(|_| {
            format!(
                "houston-tauri: refusing to own a state directory: --channel {raw:?} is not a \
                 valid channel name ({})",
                crate::sys::paths::channel_shape_rule()
            )
        });
    }
    if debug_build {
        return Ok(Some("dev".to_string()));
    }
    Ok(None)
}

fn release_warning_needed(channel_flag_present: bool, owning_channel: Option<&str>) -> bool {
    channel_flag_present && owning_channel.is_none()
}

// The literal `channel-` prefix is load-bearing: a D-Bus well-known name element
// must not start with a digit, but a channel name may be purely numeric.
fn dbus_id_for(identifier: &str, channel: Option<&str>) -> String {
    let label = channel.unwrap_or("release");
    format!("{identifier}.channel-{label}")
}

/// An exit request with a code terminates the process — except Tauri's restart
/// request, which relaunches it after the Exit callback returns.
fn should_terminate_process(code: i32) -> bool {
    code != 0 && code != tauri::RESTART_EXIT_CODE
}

// Per-channel renderer state: without an explicit `data_directory`, Tauri keys the
// webview's localStorage/cache by the bundle identifier alone, so a dev process
// silently overwrites the release channel's renderer state.
fn webview_data_dir_for(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join("webview")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Before anything that needs a window or a channel: asking which build this is
    // must work on a headless box and must not start anything.
    if matches!(args.get(1).map(String::as_str), Some("--version" | "-V")) {
        println!(
            "houston {} ({})",
            env!("CARGO_PKG_VERSION"),
            crate::sys::build_commit(),
        );
        return;
    }

    if let Err(err) = reject_unrecognized_args(&args) {
        eprintln!("{}", err.message());
        std::process::exit(1);
    }

    let channel_flag = match parse_channel_flag(&args) {
        Ok(flag) => flag,
        Err(err) => {
            eprintln!("{}", err.message());
            std::process::exit(1);
        }
    };

    let print_target = print_target_requested(&args);

    let home = match crate::sys::home_dir::home_dir() {
        Some(home) => home,
        None => {
            eprintln!("houston-tauri: refusing to start: cannot resolve the home directory");
            std::process::exit(1);
        }
    };

    let owning_channel =
        match resolve_owning_channel(cfg!(debug_assertions), channel_flag.as_deref()) {
            Ok(channel) => channel,
            Err(refusal) => {
                eprintln!("{refusal}");
                std::process::exit(1);
            }
        };
    let state_dir = crate::sys::paths::dir_for(&home, owning_channel.as_deref());
    let target_channel_label = owning_channel
        .clone()
        .unwrap_or_else(|| "release".to_string());

    let explicit_release_requested =
        release_warning_needed(channel_flag.is_some(), owning_channel.as_deref());

    if explicit_release_requested {
        if print_target {
            eprintln!(
                "houston-tauri: WARNING: --channel release requested — a real run would \
                 drive the INSTALLED APP's own live state dir ({}).",
                state_dir.display()
            );
        } else {
            eprintln!(
                "houston-tauri: WARNING: --channel release requested — this drives the \
                 INSTALLED APP's own live state dir ({}). This is the shared, dangerous \
                 mode: it can touch sessions the installed app owns.",
                state_dir.display()
            );
        }
    }

    match owning_channel.as_deref() {
        Some(channel) => std::env::set_var(CHANNEL_ENV, channel),
        None => std::env::remove_var(CHANNEL_ENV),
    }

    if print_target {
        let config_dir = crate::sys::paths::config_dir();
        let log_dir = crate::sys::paths::log_dir();
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

    let _log_guard = crate::sys::logging::init();

    crate::sys::env_hygiene::scrub();
    crate::sys::login_path::adopt();

    match crate::sys::paths::config_dir() {
        Ok(dir) => println!("houston-tauri: state dir = {}", dir.display()),
        Err(err) => {
            eprintln!("houston-tauri: failed to resolve the state dir: {err}");
        }
    }

    let channel_label = match crate::sys::paths::channel() {
        Ok(channel) => channel.unwrap_or_else(|| "release".to_string()),
        Err(err) => {
            eprintln!("houston-tauri: refusing to start: {err}");
            std::process::exit(1);
        }
    };
    debug_assert_eq!(
        channel_label, target_channel_label,
        "a read site (paths::channel()) disagreed with the resolved owning channel -- the \
         env sync above is supposed to make this impossible"
    );

    v1_cleanup::start(
        &v1_cleanup::HOST_START,
        v1_cleanup::Target::from_env(
            &crate::sys::host_env::HostEnv::capture(),
            &home,
            owning_channel.as_deref(),
        ),
    );

    let tokio_runtime: &'static tokio::runtime::Runtime =
        Box::leak(Box::new(match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(err) => {
                eprintln!("houston-tauri: failed to build the app's tokio runtime: {err}");
                std::process::exit(1);
            }
        }));

    let context = tauri::generate_context!();
    let v2_resource_dir =
        tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default()).ok();
    let v2_base_dir = v2_server::base_dir(&state_dir);
    let v2_entry = v2_server::resolve_server_entry(
        std::env::var_os("HOUSTON_V2_SERVER_ENTRY").map(std::path::PathBuf::from),
        v2_resource_dir.as_deref(),
    )
    .unwrap_or_else(|error| {
        eprintln!("houston-tauri: v2 server entry not found: {error}");
        v2_server::ServerEntry::Node(v2_server::dev_server_entry())
    });
    let v2_node =
        v2_server::resolve_node(std::env::var_os("HOUSTON_NODE").map(std::path::PathBuf::from));
    let v2_ssh = Arc::new(v2_ssh::V2SshHost::new(v2_node.clone(), v2_entry.clone()));
    let v2_host = Arc::new(v2_server::V2Host::new(
        v2_base_dir.clone(),
        v2_node,
        v2_entry,
    ));
    let snapshot_host = Arc::new(snapshot::SnapShotHost::new(
        v2_base_dir.clone(),
        context.config().identifier.clone(),
    ));
    eprintln!(
        "houston-tauri: v2 server state directory {} (log {})",
        v2_base_dir.display(),
        v2_server::log_path(&v2_base_dir).display()
    );

    #[cfg(debug_assertions)]
    let wasm_csp_probe_fired = Arc::new(AtomicBool::new(false));

    let dbus_id = dbus_id_for(&context.config().identifier, Some(&channel_label));
    let mut builder = tauri::Builder::default();
    builder = builder.manage(Arc::clone(&v2_host));
    builder = builder.manage(Arc::clone(&v2_ssh));
    builder = builder.manage(Arc::clone(&snapshot_host));
    builder = builder.manage(fs_allowlist::AllowedRoots::new());
    builder = builder.manage(shells::ShellsCache::new());
    builder = builder.manage(std::sync::Arc::new(app_update::V2UpdateHandle::new()));
    builder = builder.manage(window::ContextMenuState::default());
    builder = builder.manage(provider_auth::ProviderAuthCallbacks::default());
    builder = builder.manage(app_menu::ZoomState::default());

    let launch_transfer = std::env::current_dir()
        .ok()
        .and_then(|cwd| transfer_open::file_argument(&args, &cwd));
    builder = builder.manage(transfer_open::LaunchFile::new(launch_transfer));

    let tray_host = tray::TrayHost::new(state_dir.clone(), tray::probe());
    builder = builder.manage(Arc::clone(&tray_host));

    // Windows keys the single-instance mutex on the bundle identifier, so a dev
    // app would refuse to start beside the installed release app. Register it only
    // where it is channel-scoped (Linux dbus id) or no channel owns the process.
    let single_instance_enabled = cfg!(target_os = "linux") || owning_channel.is_none();
    if single_instance_enabled {
        builder = builder.plugin(
            tauri_plugin_single_instance::Builder::new()
                .dbus_id(dbus_id)
                .callback(move |app, argv, cwd| {
                    transfer_open::forward(app, &argv, &cwd);
                    eprintln!(
                        "houston-tauri: rejected a second launch on channel \
                         {channel_label:?} (already owned by this instance); focusing the \
                         existing window"
                    );
                    tray::show_main_window(app);
                })
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        // No `updater:default` permission anywhere: the plugin's own JS commands
        // stay unreachable, and updates run through v2_update_install instead.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            detect_available_shells,
            app_log::system_log_debug,
            app_update::v2_update_state,
            app_update::v2_update_set_channel,
            app_update::v2_update_check,
            app_update::v2_update_download,
            app_update::v2_update_install,
            v2_server::v2_local_environment_bootstrap,
            v2_server::v2_local_environment_bearer_token,
            v2_server::v2_server_status,
            v2_server::v2_server_exposure_state,
            v2_server::v2_server_set_exposure_mode,
            v2_server::v2_server_set_tailscale_serve,
            v2_server::v2_server_advertised_endpoints,
            v2_ssh::v2_ssh_discover_hosts,
            v2_ssh::v2_ssh_resolve_host,
            v2_ssh::v2_ssh_ensure_environment,
            v2_ssh::v2_ssh_disconnect_environment,
            v2_ssh::v2_ssh_fetch_environment_descriptor,
            v2_ssh::v2_ssh_bootstrap_bearer_session,
            v2_ssh::v2_ssh_fetch_session_state,
            v2_ssh::v2_ssh_resolve_password_prompt,
            v2_ssh::v2_probe_remote_editors,
            fs_allowlist::fs_add_allowed_root,
            fs_allowlist::fs_set_allowed_roots,
            fs::fs_read_directory,
            fs::fs_picker_list_dirs,
            fs::fs_read_file,
            fs::fs_read_media,
            fs::fs_write_file,
            fs::fs_write_file_checked,
            notifications::native_notify,
            notifications::native_notifications_supported,
            provider_auth::provider_auth_receive,
            provider_auth::provider_auth_cancel,
            fs::fs_stat,
            fs::fs_exists,
            fs::fs_delete,
            fs::fs_create_file,
            fs::fs_create_directory,
            fs::fs_rename,
            fs::fs_entry_count,
            fs::fs_search_paths,
            fs::content_search::fs_search_contents,
            fs::fs_watch_dirs,
            fs::fs_unwatch,
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
            dialog::dialog_pick_theme_files,
            dialog::dialog_save_image_url,
            dialog::dialog_save_transfer,
            dialog::dialog_pick_transfer,
            transfer_open::transfer_launch_file,
            shell::shell_open_external,
            shell::shell_show_item_in_folder,
            shell::shell_reveal_item_in_folder,
            shell::shell_open_media_file,
            shell::shell_list_editors,
            shell::shell_open_in_editor,
            system::system_get_log_path,
            system::system_third_party_licenses,
            system::system_get_home_dir,
            system::v2_open_system_settings,
            system::v2_check_system_permission,
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
            window::window_is_fullscreen,
            window::window_set_theme,
            window::window_set_badge_count,
            window::v2_show_context_menu,
            window::window_is_focused,
            window::window_toggle_fullscreen,
            window::window_set_zoom,
            app_menu::window_zoom,
            window::window_focus,
            window::window_set_background_color,
            window::window_start_dragging,
            window::window_start_resize_dragging,
            tray::tray_sync,
            tray::tray_state,
            tray::tray_set_keep_in_tray,
            tray::app_quit,
            wsl::v2::v2_wsl_state,
            wsl::v2::v2_wsl_set_enabled,
            wsl::v2::v2_wsl_set_distro,
            wsl::v2::v2_wsl_set_only,
            snapshot::snap_shot_configure,
            snapshot::snap_shot_state,
            snapshot::snap_shot_capture,
            snapshot::snap_shot_check_shortcut,
            snapshot::snap_shot_setup,
            snapshot::snap_shot_preview_config,
            snapshot::snap_shot_apply_config,
            snapshot::snap_shot_set_shortcut_suppressed,
            snapshot::snap_shot_list_pending,
            snapshot::snap_shot_read,
            snapshot::snap_shot_acknowledge,
            snapshot::snap_shot_set_animation_destination,
            snapshot::snap_shot_dismiss_animation,
            snapshot::snap_shot_request_permissions,
        ])
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if app_menu::handle_menu_event(app, id) {
                return;
            }
            if !window::handle_context_menu_event(app, id) {
                let _ = app.emit_to("main", "v2-menu-action", id);
            }
        })
        .on_window_event(|window, event| {
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
                        } else if let Err(err) = window.emit_to("main", tray::EVENT_WINDOW_HIDDEN, true) {
                            eprintln!(
                                "houston-tauri: could not tell the renderer the window is hidden ({err}); its polls keep running"
                            );
                        }
                        return;
                    }
                }
            }
            if window.label() == "main" {
                if let Ok(fullscreen) = window.is_fullscreen() {
                    let _ = window.emit_to("main", "v2-window-fullscreen", fullscreen);
                }
                if matches!(event, tauri::WindowEvent::Focused(true)) {
                    let _ = window.emit_to("main", "v2-notification-badge-clear", ());
                }
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
            notifications::start_action_listener(app.handle().clone());

            let host = Arc::clone(&v2_host);
            match tokio_runtime.block_on(v2_server::ensure_running(&host)) {
                Ok(running) => eprintln!(
                    "houston-tauri: v2 server ready at {} (pid {}, {})",
                    running.origin,
                    running.pid,
                    if running.attached {
                        "attached"
                    } else {
                        "spawned detached"
                    }
                ),
                Err(error) => eprintln!(
                    "houston-tauri: v2 server failed to start: {error}; the window will \
                     show no local environment"
                ),
            }
            let snapshot = host
                .bootstrap_list()
                .unwrap_or_else(|_| serde_json::json!([]));
            let status = host.status();
            let monitor = Arc::clone(&host);
            tokio_runtime.spawn(v2_server::monitor(monitor));
            let platform = match std::env::consts::OS {
                "windows" => "win32",
                "macos" => "darwin",
                other => other,
            };
            let v2_init_script = format!(
                "window.__HOUSTON_V2_BOOTSTRAP__ = {};\n\
                 window.__HOUSTON_V2_STATUS__ = {};\n\
                 window.__HOUSTON_V2_PLATFORM__ = {:?};\n\
                 window.__HOUSTON_V2_VERSION__ = {:?};\n\
                 window.__HOUSTON_V2_LOCALE__ = {};\n\
                 window.__HOUSTON_V2_BRANDING__ = {};\n\
                 {}",
                snapshot,
                status,
                platform,
                env!("CARGO_PKG_VERSION"),
                serde_json::Value::Null,
                serde_json::json!({
                    "baseName": "Houston",
                    "stageLabel": "Dev",
                    "displayName": "Houston Dev",
                }),
                include_str!("v2_bridge.js"),
            );

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

            let mut window_builder =
                tauri::WebviewWindowBuilder::from_config(app, &window_config)
                    .expect(
                        "tauri.conf.json's window config failed to parse into a \
                         WebviewWindowBuilder",
                    )
                    .data_directory(webview_data_dir);
            if !v2_init_script.is_empty() {
                window_builder = window_builder.initialization_script(&v2_init_script);
            }
            let main_window = window_builder
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
            app_menu::install(app.handle()).expect("failed to install the application menu");

            #[cfg(debug_assertions)]
            if std::env::var("HOUSTON_DEVTOOLS").as_deref() == Ok("1") {
                main_window.open_devtools();
                println!("houston-tauri: devtools opened for the main window");
            }

            let app_log_path = match crate::sys::paths::config_dir() {
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

            Ok(())
        })
        .on_page_load(move |webview, payload| {
            #[cfg(debug_assertions)]
            if webview.label() == "main"
                && payload.event() == PageLoadEvent::Finished
                && !wasm_csp_probe_fired.swap(true, Ordering::SeqCst)
            {
                if let Err(err) = webview.eval(include_str!("wasm_csp_probe.js")) {
                    eprintln!("houston-tauri: wasm-csp-probe eval failed: {err}");
                }
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

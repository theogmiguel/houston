use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview};

pub const EVENT_ZOOM: &str = "v2-window-zoom";
pub const ZOOM_GLOBAL: &str = "__HOUSTON_V2_ZOOM__";

const DISPLAY_NAME: &str = "Houston Dev";
const ZOOM_STEP: f64 = 1.095_445_389_066_381; // Chromium's 1.2^0.5 half zoom-level step.
const ZOOM_MIN: f64 = 0.25;
const ZOOM_MAX: f64 = 5.0;

pub struct ZoomState(Mutex<f64>);

impl Default for ZoomState {
    fn default() -> Self {
        Self(Mutex::new(1.0))
    }
}

impl ZoomState {
    pub fn factor(&self) -> f64 {
        self.0.lock().map(|factor| *factor).unwrap_or(1.0)
    }

    fn set(&self, factor: f64) {
        if let Ok(mut current) = self.0.lock() {
            *current = factor;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoomDirection {
    In,
    Out,
    Reset,
}

fn parse_zoom_direction(value: &str) -> Result<ZoomDirection, String> {
    match value {
        "in" => Ok(ZoomDirection::In),
        "out" => Ok(ZoomDirection::Out),
        "reset" => Ok(ZoomDirection::Reset),
        other => Err(format!(
            "window_zoom: direction must be \"in\", \"out\" or \"reset\", got {other:?}"
        )),
    }
}

pub fn zoom_step(current: f64, direction: ZoomDirection) -> f64 {
    let next = match direction {
        ZoomDirection::In => current * ZOOM_STEP,
        ZoomDirection::Out => current / ZOOM_STEP,
        ZoomDirection::Reset => 1.0,
    };
    next.clamp(ZOOM_MIN, ZOOM_MAX)
}

fn apply_zoom<R: Runtime>(
    webview: &Webview<R>,
    state: &ZoomState,
    direction: ZoomDirection,
) -> Result<f64, String> {
    let factor = zoom_step(state.factor(), direction);
    state.set(factor);
    // The bridge reads this global synchronously; set it before the viewport resizes.
    webview
        .eval(format!("window.{ZOOM_GLOBAL} = {factor};"))
        .map_err(|e| format!("window_zoom: failed to update the renderer zoom factor: {e}"))?;
    webview.set_zoom(factor).map_err(|e| {
        format!(
            "window_zoom: failed to set zoom {factor} on webview {:?}: {e}",
            webview.label()
        )
    })?;
    let _ = webview
        .app_handle()
        .emit_to(webview.label(), EVENT_ZOOM, factor);
    Ok(factor)
}

#[tauri::command]
pub fn window_zoom<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, ZoomState>,
    direction: String,
) -> Result<f64, String> {
    let direction = parse_zoom_direction(&direction)?;
    apply_zoom(&webview, &state, direction)
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build(app)?;
    app.set_menu(menu)?;
    // Upstream hides the menu bar on Linux and Windows; accelerators stay registered.
    #[cfg(not(target_os = "macos"))]
    app.hide_menu()?;
    Ok(())
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut menu = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let about = tauri::menu::PredefinedMenuItem::about(
            app,
            Some(format!("About {DISPLAY_NAME}").as_str()),
            None,
        )?;
        let check = MenuItem::with_id(
            app,
            "check-for-updates",
            "Check for Updates...",
            true,
            None::<&str>,
        )?;
        let settings = MenuItem::with_id(
            app,
            "open-settings",
            "Settings...",
            true,
            Some("CmdOrCtrl+,"),
        )?;
        let services = tauri::menu::PredefinedMenuItem::services(app, None)?;
        let hide = tauri::menu::PredefinedMenuItem::hide(
            app,
            Some(format!("Hide {DISPLAY_NAME}").as_str()),
        )?;
        let hide_others = tauri::menu::PredefinedMenuItem::hide_others(app, None)?;
        let show_all = tauri::menu::PredefinedMenuItem::show_all(app, None)?;
        let quit = MenuItem::with_id(
            app,
            "quit-app",
            format!("Quit {DISPLAY_NAME}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?;
        let app_menu = SubmenuBuilder::new(app, DISPLAY_NAME)
            .item(&about)
            .item(&check)
            .separator()
            .item(&settings)
            .separator()
            .item(&services)
            .separator()
            .item(&hide)
            .item(&hide_others)
            .item(&show_all)
            .separator()
            .item(&quit)
            .build()?;
        menu = menu.item(&app_menu);
    }

    menu = menu.item(&build_file_menu(app)?);
    menu = menu.item(&build_edit_menu(app)?);
    menu = menu.item(&build_view_menu(app)?);
    menu = menu.item(&build_window_menu(app)?);
    menu = menu.item(&build_help_menu(app)?);
    menu.build()
}

fn build_file_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut file = SubmenuBuilder::new(app, "File");
    #[cfg(target_os = "macos")]
    {
        let close = MenuItem::with_id(app, "close-window", "Close Window", true, None::<&str>)?;
        file = file.item(&close);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let settings = MenuItem::with_id(
            app,
            "open-settings",
            "Settings...",
            true,
            Some("CmdOrCtrl+,"),
        )?;
        let quit = MenuItem::with_id(
            app,
            "quit-app",
            format!("Quit {DISPLAY_NAME}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?;
        file = file.item(&settings).separator().item(&quit);
    }
    file.build()
}

fn build_edit_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let paste_as_text = MenuItem::with_id(
        app,
        "paste-as-text",
        "Paste as Text",
        true,
        Some("CmdOrCtrl+Shift+V"),
    )?;
    SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&paste_as_text)
        .separator()
        .select_all()
        .build()
}

fn build_view_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let force_reload = MenuItem::with_id(
        app,
        "force-reload",
        "Force Reload",
        true,
        Some("Shift+CmdOrCtrl+R"),
    )?;
    let developer_tools = MenuItem::with_id(
        app,
        "toggle-devtools",
        "Toggle Developer Tools",
        true,
        Some(if cfg!(target_os = "macos") {
            "Alt+Command+I"
        } else {
            "Ctrl+Shift+I"
        }),
    )?;
    let actual_size =
        MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let fullscreen = MenuItem::with_id(
        app,
        "toggle-fullscreen",
        "Toggle Full Screen",
        true,
        Some(if cfg!(target_os = "macos") {
            "Ctrl+Cmd+F"
        } else {
            "F11"
        }),
    )?;
    SubmenuBuilder::new(app, "View")
        .item(&reload)
        .item(&force_reload)
        .item(&developer_tools)
        .separator()
        .item(&actual_size)
        .item(&zoom_in)
        .item(&zoom_out)
        .separator()
        .item(&fullscreen)
        .build()
}

fn build_window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let minimize = MenuItem::with_id(app, "window-minimize", "Minimize", true, None::<&str>)?;
    let zoom = MenuItem::with_id(app, "window-zoom", "Zoom", true, None::<&str>)?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&minimize)
        .item(&zoom);
    #[cfg(target_os = "macos")]
    let window = {
        let front = tauri::menu::PredefinedMenuItem::bring_all_to_front(app, None)?;
        window.separator().item(&front)
    };
    window.build()
}

fn build_help_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let check = MenuItem::with_id(
        app,
        "help-check-for-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    SubmenuBuilder::new(app, "Help").item(&check).build()
}

/// Handles menu ids that act inside the host. Returns false for ids the renderer owns.
pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        "quit-app" => {
            crate::tray::quit(app);
            true
        }
        "reload" => {
            eval_main(app, "window.location.reload();");
            true
        }
        "force-reload" => {
            eval_main(app, "window.location.reload();");
            true
        }
        "toggle-devtools" => {
            if let Some(webview) = app.get_webview("main") {
                if webview.is_devtools_open() {
                    webview.close_devtools();
                } else {
                    webview.open_devtools();
                }
            }
            true
        }
        "zoom-in" => zoom(app, ZoomDirection::In),
        "zoom-out" => zoom(app, ZoomDirection::Out),
        "zoom-reset" => zoom(app, ZoomDirection::Reset),
        "toggle-fullscreen" => {
            if let Some(window) = app.get_webview("main").map(|webview| webview.window()) {
                if let Ok(current) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(!current);
                }
            }
            true
        }
        "window-minimize" => {
            if let Some(window) = app.get_webview("main").map(|webview| webview.window()) {
                let _ = window.minimize();
            }
            true
        }
        "window-zoom" => {
            if let Some(window) = app.get_webview("main").map(|webview| webview.window()) {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
            true
        }
        "close-window" => {
            if let Some(window) = app.get_webview("main").map(|webview| webview.window()) {
                let _ = window.close();
            }
            true
        }
        "check-for-updates" | "help-check-for-updates" => {
            spawn_update_check(app);
            true
        }
        _ => false,
    }
}

fn eval_main<R: Runtime>(app: &AppHandle<R>, script: &str) {
    if let Some(webview) = app.get_webview("main") {
        if let Err(error) = webview.eval(script) {
            eprintln!("houston-tauri: menu script failed: {error}");
        }
    }
}

fn zoom(app: &AppHandle, direction: ZoomDirection) -> bool {
    let Some(webview) = app.get_webview("main") else {
        return true;
    };
    let state = app.state::<ZoomState>();
    if let Err(error) = apply_zoom(&webview, &state, direction) {
        eprintln!("houston-tauri: zoom failed: {error}");
    }
    true
}

fn spawn_update_check(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        match crate::app_update::check_for_updates_from_menu(&app).await {
            Ok(None) => {
                app.dialog()
                    .message(format!(
                        "Houston {} is currently the newest version available.",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .title("You're up to date!")
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
            Ok(Some(_)) => {}
            Err(message) => {
                app.dialog()
                    .message("Could not check for updates.")
                    .title("Update check failed")
                    .kind(MessageDialogKind::Warning)
                    .show(move |_| eprintln!("houston-tauri: update check failed: {message}"));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_in_and_out_step_by_half_a_chromium_zoom_level() {
        let inned = zoom_step(1.0, ZoomDirection::In);
        assert!((inned - 1.095_445_389_066_381).abs() < 1e-12);
        let outed = zoom_step(inned, ZoomDirection::Out);
        assert!((outed - 1.0).abs() < 1e-12);
    }

    #[test]
    fn reset_always_returns_to_one() {
        assert_eq!(zoom_step(2.5, ZoomDirection::Reset), 1.0);
    }

    #[test]
    fn zoom_steps_stay_within_the_renderer_limits() {
        assert_eq!(zoom_step(ZOOM_MIN, ZoomDirection::Out), ZOOM_MIN);
        assert_eq!(zoom_step(ZOOM_MAX, ZoomDirection::In), ZOOM_MAX);
    }

    #[test]
    fn directions_accept_only_the_three_bridge_values() {
        assert_eq!(
            parse_zoom_direction("in").expect("in is valid"),
            ZoomDirection::In
        );
        assert_eq!(
            parse_zoom_direction("out").expect("out is valid"),
            ZoomDirection::Out
        );
        assert_eq!(
            parse_zoom_direction("reset").expect("reset is valid"),
            ZoomDirection::Reset
        );
        let error = parse_zoom_direction("sideways").expect_err("unknown directions are refused");
        assert!(error.contains("sideways"), "{error}");
    }
}

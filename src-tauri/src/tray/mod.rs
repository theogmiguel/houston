pub mod model;
mod probe;
mod settings;

use model::{TrayIconState, TrayItem, TrayPayload};
pub use probe::{probe, TrayAvailability};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

macro_rules! tray_png {
    ($state:literal, $size:literal) => {
        include_bytes!(concat!("../../icons/tray/", $state, "-", $size, ".png"))
    };
}

const MENU_ID_OPEN: &str = "tray:open";
const MENU_ID_STOP: &str = "tray:stop";
const MENU_ID_HEADER: &str = "tray:header";
const MENU_ID_OVERFLOW: &str = "tray:overflow";
const MENU_ID_AGENTS: &str = "tray:agents";
const MENU_ID_GROUP_PREFIX: &str = "tray:group:";
const MENU_ID_SESSION_PREFIX: &str = "tray:session:";

pub const EVENT_FOCUS_PANE: &str = "tray://focus-pane";
pub const EVENT_STOP_DAEMON: &str = "tray://stop-daemon";

static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

pub struct TrayHost {
    state_dir: PathBuf,
    availability: Mutex<TrayAvailability>,
    keep_in_tray: AtomicBool,
    payload: Mutex<TrayPayload>,
    icon: Mutex<Option<TrayIcon<Wry>>>,
    painted: Mutex<Option<TrayIconState>>,
    base_icon_size: AtomicU32,
}

impl TrayHost {
    pub fn new(state_dir: PathBuf, availability: TrayAvailability) -> Arc<Self> {
        let stored = settings::load(&state_dir);
        Arc::new(TrayHost {
            state_dir,
            availability: Mutex::new(availability),
            keep_in_tray: AtomicBool::new(stored.keep_in_tray),
            payload: Mutex::new(TrayPayload::connecting()),
            icon: Mutex::new(None),
            painted: Mutex::new(None),
            base_icon_size: AtomicU32::new(base_icon_size(None)),
        })
    }

    pub fn hides_on_close(&self) -> bool {
        self.availability
            .lock()
            .expect("tray availability mutex")
            .is_available()
            && self.keep_in_tray.load(Ordering::SeqCst)
    }

    fn refuse(&self, reason: String) {
        eprintln!("houston-tauri: {reason}");
        *self.availability.lock().expect("tray availability mutex") =
            TrayAvailability::Unavailable(reason);
    }

    fn view(&self) -> TrayStateView {
        let availability = self.availability.lock().expect("tray availability mutex");
        TrayStateView {
            available: availability.is_available(),
            reason: availability.reason().map(str::to_string),
            keep_in_tray: self.keep_in_tray.load(Ordering::SeqCst),
            hides_on_close: availability.is_available() && self.keep_in_tray.load(Ordering::SeqCst),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayStateView {
    pub available: bool,
    pub reason: Option<String>,
    pub keep_in_tray: bool,
    pub hides_on_close: bool,
}

macro_rules! tray_cut {
    ($size:expr, $state:literal) => {
        match $size {
            16 => tray_png!($state, "16"),
            20 => tray_png!($state, "20"),
            24 => tray_png!($state, "24"),
            32 => tray_png!($state, "32"),
            40 => tray_png!($state, "40"),
            44 => tray_png!($state, "44"),
            48 => tray_png!($state, "48"),
            _ => tray_png!($state, "22"),
        }
    };
}

fn icon_bytes(state: TrayIconState, size: u32) -> &'static [u8] {
    match state {
        TrayIconState::Idle => tray_cut!(size, "idle"),
        TrayIconState::Active => tray_cut!(size, "active"),
        TrayIconState::Attention => tray_cut!(size, "attention"),
    }
}

const ICON_CUTS: [u32; 8] = [16, 20, 22, 24, 32, 40, 44, 48];

#[cfg(not(windows))]
fn base_icon_size(desktop: Option<&str>) -> u32 {
    match desktop {
        Some(list)
            if list
                .split(':')
                .any(|name| name.eq_ignore_ascii_case("GNOME")) =>
        {
            16
        }
        _ => 22,
    }
}

#[cfg(windows)]
fn base_icon_size(_desktop: Option<&str>) -> u32 {
    16
}

fn icon_size_for(base: u32, scale_factor: Option<f64>) -> u32 {
    let Some(scale) = scale_factor else {
        return base;
    };
    let wanted = (base as f64 * scale).round() as i64;
    ICON_CUTS
        .into_iter()
        .min_by_key(|cut| (*cut as i64 - wanted).abs())
        .expect("ICON_CUTS is never empty")
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn build_menu(app: &AppHandle, payload: &TrayPayload) -> tauri::Result<Menu<Wry>> {
    let mut disabled_row_counter: u32 = 0;
    let owned = build_items(app, &model::menu_model(payload), &mut disabled_row_counter)?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = owned.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

fn build_items(
    app: &AppHandle,
    items: &[TrayItem],
    disabled_row_counter: &mut u32,
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>>> {
    let mut owned: Vec<Box<dyn tauri::menu::IsMenuItem<Wry>>> = Vec::new();
    for item in items {
        let boxed: Box<dyn tauri::menu::IsMenuItem<Wry>> = match item {
            TrayItem::Header(text) => Box::new(MenuItem::with_id(
                app,
                MENU_ID_HEADER,
                text,
                false,
                None::<&str>,
            )?),
            TrayItem::Open => Box::new(MenuItem::with_id(
                app,
                MENU_ID_OPEN,
                "Open Houston",
                true,
                None::<&str>,
            )?),
            TrayItem::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            TrayItem::Session { id, label } => Box::new(MenuItem::with_id(
                app,
                format!("{MENU_ID_SESSION_PREFIX}{id}"),
                label,
                true,
                None::<&str>,
            )?),
            TrayItem::Overflow(text) => {
                let id = format!("{MENU_ID_OVERFLOW}:{disabled_row_counter}");
                *disabled_row_counter += 1;
                Box::new(MenuItem::with_id(app, id, text, false, None::<&str>)?)
            }
            TrayItem::Group(text) => {
                let id = format!("{MENU_ID_GROUP_PREFIX}{disabled_row_counter}");
                *disabled_row_counter += 1;
                Box::new(MenuItem::with_id(app, id, text, false, None::<&str>)?)
            }
            TrayItem::Submenu { label, items } => {
                let sub_owned = build_items(app, items, disabled_row_counter)?;
                let sub_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
                    sub_owned.iter().map(|b| b.as_ref()).collect();
                Box::new(tauri::menu::Submenu::with_id_and_items(
                    app,
                    MENU_ID_AGENTS,
                    label,
                    true,
                    &sub_refs,
                )?)
            }
            TrayItem::StopDaemon => Box::new(MenuItem::with_id(
                app,
                MENU_ID_STOP,
                "Quit Houston…",
                true,
                None::<&str>,
            )?),
        };
        owned.push(boxed);
    }
    Ok(owned)
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        MENU_ID_OPEN => show_main_window(app),
        MENU_ID_STOP => confirm_and_stop(app),
        MENU_ID_HEADER | MENU_ID_AGENTS => {}
        _ if id.starts_with(MENU_ID_OVERFLOW) || id.starts_with(MENU_ID_GROUP_PREFIX) => {}
        _ => {
            let Some(rest) = id.strip_prefix(MENU_ID_SESSION_PREFIX) else {
                return;
            };
            let Ok(session) = rest.parse::<i64>() else {
                eprintln!(
                    "houston-tauri: tray menu id {id:?} is not \
                     '{MENU_ID_SESSION_PREFIX}<session id>'; ignoring the click"
                );
                return;
            };
            show_main_window(app);
            if let Err(err) = app.emit(EVENT_FOCUS_PANE, session) {
                eprintln!(
                    "houston-tauri: could not tell the renderer to focus pane {session}: {err}"
                );
            }
        }
    }
}

fn confirm_and_stop(app: &AppHandle) {
    let message = {
        let host = app.state::<Arc<TrayHost>>();
        let payload = host.payload.lock().expect("tray payload mutex");
        model::stop_confirm_message(&payload)
    };
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Quit Houston")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit and stop daemon".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            if let Err(err) = handle.emit(EVENT_STOP_DAEMON, ()) {
                eprintln!(
                    "houston-tauri: could not ask the renderer to stop the daemon ({err}); \
                     quitting without stopping it, same as an ordinary quit"
                );
                quit(&handle);
            }
        });
}

pub fn install(app: &AppHandle, host: &Arc<TrayHost>) {
    if let Some(reason) = host
        .availability
        .lock()
        .expect("tray availability mutex")
        .reason()
    {
        eprintln!("houston-tauri: {reason}");
        return;
    }
    let payload = host.payload.lock().expect("tray payload mutex").clone();
    let menu = match build_menu(app, &payload) {
        Ok(menu) => menu,
        Err(err) => {
            host.refuse(format!(
                "No tray on this desktop: the tray menu could not be built: {err}"
            ));
            return;
        }
    };
    let base = base_icon_size(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref());
    host.base_icon_size.store(base, Ordering::SeqCst);
    let size = icon_size_for(
        base,
        app.primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor()),
    );
    let state = model::icon_state(&payload);
    let image = match Image::from_bytes(icon_bytes(state, size)) {
        Ok(image) => image,
        Err(err) => {
            host.refuse(format!(
                "No tray on this desktop: the {size}px tray icon failed to decode: {err}"
            ));
            return;
        }
    };
    let built = TrayIconBuilder::with_id("houston")
        .icon(image)
        .menu(&menu)
        .tooltip(model::header_text(&payload))
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event)
        .build(app);
    match built {
        Ok(icon) => {
            *host.icon.lock().expect("tray icon mutex") = Some(icon);
            *host.painted.lock().expect("tray painted mutex") = Some(state);
        }
        Err(err) => {
            host.refuse(format!(
                "No tray on this desktop: the tray icon refused to build: {err}"
            ));
        }
    }
}

fn repaint(app: &AppHandle, host: &Arc<TrayHost>) {
    let payload = host.payload.lock().expect("tray payload mutex").clone();
    let guard = host.icon.lock().expect("tray icon mutex");
    let Some(icon) = guard.as_ref() else {
        return;
    };
    match build_menu(app, &payload) {
        Ok(menu) => {
            if let Err(err) = icon.set_menu(Some(menu)) {
                eprintln!("houston-tauri: tray menu update failed: {err}");
            }
        }
        Err(err) => eprintln!("houston-tauri: tray menu rebuild failed: {err}"),
    }
    let header = model::header_text(&payload);
    if let Err(err) = icon.set_tooltip(Some(&header)) {
        eprintln!("houston-tauri: tray tooltip update failed: {err}");
    }
    let state = model::icon_state(&payload);
    let mut painted = host.painted.lock().expect("tray painted mutex");
    if *painted == Some(state) {
        return;
    }
    let size = icon_size_for(
        host.base_icon_size.load(Ordering::SeqCst),
        app.primary_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor()),
    );
    match Image::from_bytes(icon_bytes(state, size)) {
        Ok(image) => {
            if let Err(err) = icon.set_icon(Some(image)) {
                eprintln!("houston-tauri: tray icon update failed: {err}");
            } else {
                *painted = Some(state);
            }
        }
        Err(err) => eprintln!("houston-tauri: tray icon {size}px failed to decode: {err}"),
    }
}

#[tauri::command]
pub fn tray_sync(app: AppHandle, payload: TrayPayload) {
    let host = app.state::<Arc<TrayHost>>().inner().clone();
    *host.payload.lock().expect("tray payload mutex") = payload;
    repaint(&app, &host);
}

#[tauri::command]
pub fn tray_state(host: tauri::State<'_, Arc<TrayHost>>) -> TrayStateView {
    host.view()
}

#[tauri::command]
pub fn tray_set_keep_in_tray(
    host: tauri::State<'_, Arc<TrayHost>>,
    enabled: bool,
) -> Result<TrayStateView, String> {
    host.keep_in_tray.store(enabled, Ordering::SeqCst);
    settings::save(
        &host.state_dir,
        &settings::TraySettings {
            keep_in_tray: enabled,
        },
    )
    .map_err(|err| {
        format!(
            "Could not save the tray setting to {}: {err}. It applies until Houston restarts.",
            host.state_dir.join("tray.json").display()
        )
    })?;
    Ok(host.view())
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    quit(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn gnome_panels_are_sized_from_16_and_everything_else_from_22() {
        assert_eq!(base_icon_size(Some("GNOME")), 16);
        assert_eq!(base_icon_size(Some("ubuntu:GNOME")), 16);
        assert_eq!(base_icon_size(Some("KDE")), 22);
        assert_eq!(base_icon_size(Some("sway:wlroots")), 22);
        assert_eq!(
            base_icon_size(None),
            22,
            "an unset desktop takes Plasma's size"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_notification_area_is_always_sized_from_16() {
        assert_eq!(base_icon_size(None), 16);
        assert_eq!(base_icon_size(Some("GNOME")), 16);
    }

    #[test]
    fn the_icon_cut_is_the_base_size_times_the_scale_factor() {
        for (scale, cut) in [(1.0, 16), (1.25, 20), (1.5, 24), (2.0, 32), (2.5, 40)] {
            assert_eq!(icon_size_for(16, Some(scale)), cut, "GNOME at {scale}x");
        }
        assert_eq!(icon_size_for(22, Some(1.0)), 22);
        assert_eq!(icon_size_for(22, Some(2.0)), 44);
        assert_eq!(
            icon_size_for(22, None),
            22,
            "a monitor we cannot ask for a scale factor takes the base size"
        );
    }

    #[test]
    fn every_state_and_cut_is_a_real_png() {
        for state in [
            TrayIconState::Idle,
            TrayIconState::Active,
            TrayIconState::Attention,
        ] {
            for size in ICON_CUTS {
                let bytes = icon_bytes(state, size);
                assert!(
                    bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "{state:?} at {size}px is not a PNG"
                );
            }
        }
    }

    #[test]
    fn hide_to_tray_needs_both_a_tray_and_the_users_consent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let with_tray = TrayHost::new(dir.path().to_path_buf(), TrayAvailability::Available);
        assert!(with_tray.hides_on_close(), "default is on");
        with_tray.keep_in_tray.store(false, Ordering::SeqCst);
        assert!(!with_tray.hides_on_close());

        let without = TrayHost::new(
            dir.path().to_path_buf(),
            TrayAvailability::Unavailable("nothing owns it".into()),
        );
        assert!(
            !without.hides_on_close(),
            "no tray means the close button must still close"
        );
        with_tray.keep_in_tray.store(true, Ordering::SeqCst);
        with_tray.refuse("No tray on this desktop: the tray icon refused to build: boom".into());
        assert!(
            !with_tray.hides_on_close(),
            "an icon that failed to build must reopen the way out, not trap the window"
        );
        let view = without.view();
        assert!(
            view.keep_in_tray,
            "the stored choice survives a missing tray"
        );
        assert!(!view.hides_on_close);
        assert_eq!(view.reason.as_deref(), Some("nothing owns it"));
    }
}

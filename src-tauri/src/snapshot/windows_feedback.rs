//! The capture flash overlay, mirroring upstream `WindowsCaptureFeedback.ts` plus the
//! `SnapShotFlash` it feeds: a non-activating, click-through window over the captured
//! window that fades out, shown without DWM's show transition.

use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;
use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};

use super::platform::{Bounds, CaptureFeedback, CaptureOptions, NormalizedFrame};

const ANIMATION_MS: u64 = 180;
const STATIC_MS: u64 = 60;
const PEAK_OPACITY: f64 = 0.08;
const BUILD_DEADLINE: Duration = Duration::from_secs(2);

pub struct WindowFlash {
    window: tauri::WebviewWindow,
}

/// Returns `None` when the platform cannot show feedback; a failed flash never fails
/// the capture itself, matching upstream's best-effort overlay.
pub fn show(
    app: &tauri::AppHandle,
    bounds: Bounds,
    options: CaptureOptions,
) -> Option<WindowFlash> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    let duration_ms = if options.animate {
        ANIMATION_MS
    } else {
        STATIC_MS
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(flash_html(duration_ms));
    let url = url::Url::parse(&format!("data:text/html;base64,{encoded}")).ok()?;
    let label = format!("snapshot-flash-{}", uuid::Uuid::new_v4().simple());
    let position = tauri::PhysicalPosition::new(bounds.x as i32, bounds.y as i32);
    let size = tauri::PhysicalSize::new(bounds.width as u32, bounds.height as u32);
    let (sender, receiver) = mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = build_window(&app_handle, &label, url)
            .and_then(|window| {
                window
                    .set_position(position)
                    .map_err(|error| error.to_string())?;
                window.set_size(size).map_err(|error| error.to_string())?;
                window
                    .set_ignore_cursor_events(true)
                    .map_err(|error| error.to_string())?;
                disable_show_animation(&window);
                window.show().map_err(|error| error.to_string())?;
                Ok(window)
            })
            .map_err(|error| format!("showing the snapshot feedback: {error}"));
        let _ = sender.send(result);
    })
    .ok()?;
    let window = receiver.recv_timeout(BUILD_DEADLINE).ok()?.ok()?;
    let closing = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(duration_ms));
        let _ = closing.destroy();
    });
    Some(WindowFlash { window })
}

fn build_window(
    app: &tauri::AppHandle,
    label: &str,
    url: url::Url,
) -> Result<tauri::WebviewWindow, String> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .title("Houston Snapshot Flash")
        .inner_size(1.0, 1.0)
        .min_inner_size(1.0, 1.0)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|error| format!("creating the snapshot feedback window: {error}"))
}

/// Upstream toggles Electron's `wm-window-animations-disabled` switch so the overlay
/// does not get Aura's extra fade and scale. `DWMWA_TRANSITIONS_FORCEDISABLED` is the
/// equivalent per-window control; a refusal only costs the transition.
fn disable_show_animation(window: &tauri::WebviewWindow) {
    let Ok(handle) = window.hwnd() else {
        return;
    };
    let disabled: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            handle.0,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            (&disabled as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        );
    }
}

fn flash_html(duration_ms: u64) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
html,body{{margin:0;height:100%;background:transparent;overflow:hidden}}\
body::after{{content:\"\";position:fixed;inset:0;background:#fff;opacity:{PEAK_OPACITY};\
animation:snapshot-flash {duration_ms}ms linear forwards}}\
@keyframes snapshot-flash{{from{{opacity:{PEAK_OPACITY}}}to{{opacity:0}}}}\
</style></head><body></body></html>"
    )
}

impl CaptureFeedback for WindowFlash {
    fn animation_started(&self) -> bool {
        false
    }

    fn animate_to(&mut self, _frame: NormalizedFrame) -> Result<(), String> {
        Ok(())
    }

    fn complete(&mut self) {}

    fn close(&mut self) {
        let _ = self.window.destroy();
    }
}

impl Drop for WindowFlash {
    fn drop(&mut self) {
        let _ = self.window.destroy();
    }
}

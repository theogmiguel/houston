#[cfg(windows)]
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const VIEW_HOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(windows)]
pub(crate) fn run_on_view<T, F>(
    webview: &tauri::webview::Webview,
    id: &str,
    verb: &str,
    f: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
{
    use std::sync::mpsc::channel;

    let (tx, rx) = channel();
    let id_owned = id.to_string();
    let verb_owned = verb.to_string();
    webview
        .with_webview(move |platform| {
            let _ = tx.send(f(&platform));
        })
        .map_err(|err| {
            format!("browser: could not hop to the UI thread to {verb_owned} for child {id_owned:?}: {err}")
        })?;
    rx.recv_timeout(VIEW_HOP_TIMEOUT).map_err(|err| {
        format!(
            "browser: {verb} for child {id:?} did not report back within {}s: {err}",
            VIEW_HOP_TIMEOUT.as_secs()
        )
    })?
}

#[cfg(windows)]
pub(crate) fn host_zoom_factor(app: &AppHandle, window_label: &str) -> f64 {
    let Some(webview) = app.get_webview(window_label) else {
        return 1.0;
    };
    run_on_view(&webview, window_label, "read the host zoom", |platform| {
        let controller = platform.controller();
        let mut zoom = 1.0_f64;
        // SAFETY: run_on_view puts us on the main thread, the only one
        // allowed to touch this COM object graph.
        if unsafe { controller.ZoomFactor(&mut zoom) }.is_err() {
            return Ok(1.0_f64);
        }
        Ok(zoom)
    })
    .unwrap_or(1.0)
}

#[cfg(windows)]
pub(crate) mod geometry {
    use super::{host_zoom_factor, run_on_view};
    use crate::browser::rect::{clamp_to_window, spec_to_logical, Rect, RectSpec};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::MapWindowPoints;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetClientRect, GetWindowThreadProcessId, IsWindowVisible,
        SetParent, SetWindowPos, GA_PARENT, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER,
    };

    pub(super) fn child_hwnd(controller: &ICoreWebView2Controller) -> Result<HWND, String> {
        let mut hwnd: windows::Win32::Foundation::HWND = Default::default();
        // SAFETY: main-thread-only COM call (run_on_view guarantees it).
        unsafe { controller.ParentWindow(&mut hwnd) }
            .map_err(|err| format!("browser: could not read the child's HWND: {err}"))?;
        Ok(hwnd.0 as usize as HWND)
    }

    fn apply_rect(
        controller: &ICoreWebView2Controller,
        hwnd: HWND,
        rect: &Rect,
    ) -> Result<(), String> {
        let com_rect = windows_core_rect(rect.width, rect.height);
        // SAFETY: main-thread-only COM/Win32 calls.
        unsafe {
            controller
                .SetBounds(com_rect)
                .map_err(|err| format!("browser: SetBounds on the child webview: {err}"))?;
            if SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
            ) == 0
            {
                return Err("browser: SetWindowPos moving the child webview failed".to_string());
            }
        }
        Ok(())
    }

    fn windows_core_rect(width: i32, height: i32) -> windows::Win32::Foundation::RECT {
        windows::Win32::Foundation::RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        }
    }

    pub(crate) fn adopt_child(
        _app: &AppHandle,
        _window_label: &str,
        _child_label: &str,
        _webview: &tauri::webview::Webview,
    ) -> Result<(), String> {
        Ok(())
    }

    pub(crate) fn commit_rect(
        app: &AppHandle,
        window_label: &str,
        child_label: &str,
        spec: RectSpec,
    ) -> Result<Rect, String> {
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        let inner_size = window
            .inner_size()
            .map_err(|err| format!("browser: inner_size() on window {window_label:?}: {err}"))?;
        let win_w = inner_size.width as i32;
        let win_h = inner_size.height as i32;

        let scale = window.scale_factor().unwrap_or(1.0);
        let zoom = host_zoom_factor(app, window_label);
        let logical = spec_to_logical(spec, scale * zoom);
        let (clamped, note) = clamp_to_window(logical, win_w, win_h);
        if let Some(note) = &note {
            eprintln!("{note}");
        }

        let webview = app.get_webview(child_label).ok_or_else(|| {
            format!(
                "browser: no widget named {child_label:?} inside window {window_label:?}; it \
                 may not have been mounted yet"
            )
        })?;
        run_on_view(&webview, child_label, "commit a rect", move |platform| {
            let controller = platform.controller();
            let hwnd = child_hwnd(&controller)?;
            apply_rect(&controller, hwnd, &clamped)
        })?;

        if std::env::var("HOUSTON_BROWSER_GEOMETRY").as_deref() == Ok("1") {
            println!(
                "BROWSER-GEOMETRY child={child_label:?} window={window_label:?} \
                 spec={}x{}@{},{} committed={}x{}@{},{} scale={scale} zoom={zoom} \
                 win={win_w}x{win_h}",
                spec.width,
                spec.height,
                spec.x,
                spec.y,
                clamped.width,
                clamped.height,
                clamped.x,
                clamped.y,
            );
        }
        Ok(clamped)
    }

    pub(crate) fn move_child(
        app: &AppHandle,
        _from_window: &str,
        to_window: &str,
        child_label: &str,
    ) -> Result<Rect, String> {
        let dest = app
            .get_window(to_window)
            .ok_or_else(|| format!("browser: no destination window labelled {to_window:?}"))?;
        let dest_hwnd_raw = dest
            .hwnd()
            .map_err(|err| format!("browser: hwnd() on destination window {to_window:?}: {err}"))?;
        let dest_hwnd: HWND = dest_hwnd_raw.0 as usize as HWND;
        let inner = dest.inner_size().map_err(|err| {
            format!("browser: inner_size() on destination window {to_window:?}: {err}")
        })?;
        let full = Rect {
            x: 0,
            y: 0,
            width: inner.width as i32,
            height: inner.height as i32,
        };

        let webview = app.get_webview(child_label).ok_or_else(|| {
            format!("browser: no webview labelled {child_label:?}; mount it before moving it")
        })?;
        let dest_raw = dest_hwnd as usize;
        run_on_view(&webview, child_label, "reparent", move |platform| {
            let controller = platform.controller();
            let hwnd = child_hwnd(&controller)?;
            // SAFETY: main thread; both windows belong to this process.
            let dest_hwnd: HWND = dest_raw as HWND;
            if unsafe { SetParent(hwnd, dest_hwnd) }.is_null() {
                return Err("browser: SetParent reparenting the child webview failed".to_string());
            }
            apply_rect(&controller, hwnd, &full)
        })?;
        Ok(full)
    }

    fn resolve_surface_label(child_label: &str) -> &str {
        if child_label == crate::browser::gtk_host::HOST_WIDGET_NAME {
            crate::browser::gtk_host::HOST_WINDOW
        } else {
            child_label
        }
    }

    pub(crate) fn read_allocation(
        app: &AppHandle,
        _window_label: &str,
        child_label: &str,
    ) -> Result<Option<(i32, i32, i32, i32)>, String> {
        let child_label = resolve_surface_label(child_label);
        let Some(webview) = app.get_webview(child_label) else {
            return Err(format!(
                "browser: no widget named {child_label:?} has been mounted"
            ));
        };
        run_on_view(
            &webview,
            child_label,
            "read the allocation of",
            |platform| {
                let controller = platform.controller();
                let hwnd = child_hwnd(&controller)?;
                let mut client = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                // SAFETY: main-thread-only Win32 calls.
                unsafe {
                    if GetClientRect(hwnd, &mut client) == 0 {
                        return Err(
                            "browser: GetClientRect on the child webview failed".to_string()
                        );
                    }
                    let parent = GetAncestor(hwnd, GA_PARENT);
                    let mut pt = [windows_sys::Win32::Foundation::POINT {
                        x: client.left,
                        y: client.top,
                    }];
                    MapWindowPoints(hwnd, parent, pt.as_mut_ptr(), 1);
                    Ok(Some((
                        pt[0].x,
                        pt[0].y,
                        client.right - client.left,
                        client.bottom - client.top,
                    )))
                }
            },
        )
    }

    pub(crate) fn is_widget_visible(
        app: &AppHandle,
        _window_label: &str,
        child_label: &str,
    ) -> Result<Option<bool>, String> {
        let child_label = resolve_surface_label(child_label);
        let Some(webview) = app.get_webview(child_label) else {
            return Err(format!(
                "browser: no widget named {child_label:?} has been mounted"
            ));
        };
        run_on_view(
            &webview,
            child_label,
            "read the visibility of",
            |platform| {
                let controller = platform.controller();
                let hwnd = child_hwnd(&controller)?;
                // SAFETY: main-thread-only Win32 call on a HWND read moments
                // earlier from the live controller.
                Ok(Some(unsafe { IsWindowVisible(hwnd) } != 0))
            },
        )
    }

    pub(crate) fn focus_host(app: &AppHandle, window_label: &str) -> Result<bool, String> {
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        window
            .set_focus()
            .map_err(|err| format!("browser: set_focus() on window {window_label:?}: {err}"))?;
        Ok(window.is_focused().unwrap_or(false))
    }

    pub(crate) fn toplevel_window_signatures(_app: &AppHandle) -> Result<Vec<String>, String> {
        thread_local! {
            static FOUND: std::cell::RefCell<Vec<HWND>> = const { std::cell::RefCell::new(Vec::new()) };
        }

        unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: isize) -> i32 {
            let mut pid = 0_u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != GetCurrentProcessId() {
                return 1;
            }
            if !GetAncestor(hwnd, GA_PARENT).is_null() {
                return 1;
            }
            FOUND.with(|found| found.borrow_mut().push(hwnd));
            1
        }

        FOUND.with(|found| found.borrow_mut().clear());
        // SAFETY: `enum_proc` only reads window metadata and appends to a
        // thread-local, and EnumWindows runs it synchronously on this thread.
        unsafe { EnumWindows(Some(enum_proc), 0) };
        let mut signatures = Vec::new();
        FOUND.with(|found| {
            for &hwnd in found.borrow().iter() {
                let mut buf = [0_u16; 256];
                // SAFETY: `hwnd` came from `enum_proc` moments ago and is
                // still this process's; `buf` is sized to the call's max.
                let len = unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
                        hwnd,
                        buf.as_mut_ptr(),
                        256,
                    )
                };
                let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
                signatures.push(format!("{:x}|{}", hwnd as usize, title));
            }
        });
        signatures.sort();
        Ok(signatures)
    }

    pub(crate) fn set_host_zoom_for_selftest(
        app: &AppHandle,
        window_label: &str,
        zoom: f64,
    ) -> Result<(), String> {
        let webview = app.get_webview(window_label).ok_or_else(|| {
            format!("browser: no webview labelled {window_label:?} for the zoom probe")
        })?;
        let label_owned = window_label.to_string();
        run_on_view(
            &webview,
            window_label,
            "set the host zoom for the probe",
            move |platform| {
                let controller = platform.controller();
                // SAFETY: main-thread-only COM call.
                unsafe { controller.SetZoomFactor(zoom) }.map_err(|err| {
                    format!("browser: SetZoomFactor({zoom}) on {label_owned:?}: {err}")
                })
            },
        )
    }

    pub(crate) fn host_zoom_for_selftest(
        app: &AppHandle,
        window_label: &str,
    ) -> Result<f64, String> {
        host_zoom_factor_checked(app, window_label)
    }

    fn host_zoom_factor_checked(app: &AppHandle, window_label: &str) -> Result<f64, String> {
        let webview = app.get_webview(window_label).ok_or_else(|| {
            format!("browser: no webview labelled {window_label:?} for the zoom probe")
        })?;
        let label_owned = window_label.to_string();
        run_on_view(
            &webview,
            window_label,
            "read the host zoom for the probe",
            move |platform| {
                let controller = platform.controller();
                let mut zoom = 0.0_f64;
                // SAFETY: main-thread-only COM call.
                unsafe { controller.ZoomFactor(&mut zoom) }
                    .map_err(|err| format!("browser: ZoomFactor() on {label_owned:?}: {err}"))?;
                Ok(zoom)
            },
        )
    }

    pub(crate) fn follow_window_resize(_app: &AppHandle, _window_label: &str) {}

    pub(crate) fn corner_report(
        _app: &AppHandle,
        _window_label: &str,
        _widget_label: &str,
    ) -> Result<Option<crate::browser::gtk_host::CornerShapeReport>, String> {
        Ok(None)
    }
}

#[cfg(windows)]
pub(crate) use geometry::{
    adopt_child, commit_rect, corner_report, focus_host, follow_window_resize,
    host_zoom_for_selftest, is_widget_visible, move_child, read_allocation,
    set_host_zoom_for_selftest, toplevel_window_signatures,
};

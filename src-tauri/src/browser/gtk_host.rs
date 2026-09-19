#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
use super::corner::{paint_bottom_corners, CornerPaint};
#[cfg(target_os = "linux")]
use super::rect::{clamp_to_window, scale_corner_paint, spec_to_logical, Rect, RectSpec};

pub const HOST_WINDOW: &str = "main";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CornerShapeReport {
    pub has_native: bool,
    pub paint: crate::browser::corner::CornerPaint,
    pub paints_applied: u64,
}

pub const HOST_WIDGET_NAME: &str = "tr-browser-host";

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::mpsc::channel;

    use gtk::prelude::*;

    const LAYOUT_WIDGET_NAME: &str = "tr-browser-layout";

    pub fn adopt_child(
        app: &AppHandle,
        window_label: &str,
        child_label: &str,
        webview: &tauri::webview::Webview,
    ) -> Result<(), String> {
        let (tx, rx) = channel();
        let app_owned = app.clone();
        let window_label_owned = window_label.to_string();
        let child_label_owned = child_label.to_string();
        webview
            .with_webview(move |platform| {
                let result = adopt_child_on_main(
                    &app_owned,
                    &window_label_owned,
                    &child_label_owned,
                    platform.inner(),
                );
                let _ = tx.send(result);
            })
            .map_err(|err| {
                format!(
                    "browser: could not hop to the GTK main thread to adopt {child_label:?} \
                     into window {window_label:?}'s gtk::Layout: {err}"
                )
            })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: adopting {child_label:?} into window {window_label:?}'s gtk::Layout \
                 did not report back within 5s: {err}"
            )
        })?
    }

    fn adopt_child_on_main(
        app: &AppHandle,
        window_label: &str,
        child_label: &str,
        raw_webview: webkit2gtk::WebView,
    ) -> Result<(), String> {
        let vbox = find_vbox(app, window_label)?;
        let layout = find_or_create_layout(&vbox);
        let widget = raw_webview.upcast::<gtk::Widget>();
        adopt_host_if_needed(&vbox, &layout, Some(&widget));
        widget.set_widget_name(child_label);
        connect_corner_paint(&widget);
        vbox.remove(&widget);
        layout.put(&widget, 0, 0);
        widget.show();
        follow_window_resize_on_main(app, window_label)
    }

    pub fn move_child(
        app: &AppHandle,
        from_window: &str,
        to_window: &str,
        child_label: &str,
    ) -> Result<Rect, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let from_owned = from_window.to_string();
        let to_owned = to_window.to_string();
        let child_owned = child_label.to_string();
        app.run_on_main_thread(move || {
            let result = move_child_on_main(&app_for_main, &from_owned, &to_owned, &child_owned);
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to move {child_label:?} from \
                 window {from_window:?} to window {to_window:?}: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: moving {child_label:?} from window {from_window:?} to window \
                 {to_window:?} did not report back within 5s: {err}"
            )
        })?
    }

    fn move_child_on_main(
        app: &AppHandle,
        from_window: &str,
        to_window: &str,
        child_label: &str,
    ) -> Result<Rect, String> {
        let from_vbox = find_vbox(app, from_window)?;
        let Some(from_layout) = find_layout(&from_vbox) else {
            return Err(format!(
                "browser: window {from_window:?} has no gtk::Layout; {child_label:?} was never \
                 adopted there"
            ));
        };
        let Some(widget) = from_layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == child_label)
        else {
            return Err(format!(
                "browser: no widget named {child_label:?} inside window {from_window:?}'s \
                 gtk::Layout; it may already have been moved or destroyed"
            ));
        };
        from_layout.remove(&widget);

        let to_vbox = find_vbox(app, to_window)?;
        let to_layout = find_or_create_layout(&to_vbox);
        adopt_host_if_needed(&to_vbox, &to_layout, None);
        to_layout.put(&widget, 0, 0);
        widget.show();

        let to_window_handle = app
            .get_window(to_window)
            .ok_or_else(|| format!("browser: no window labelled {to_window:?}"))?;
        let inner_size = to_window_handle
            .inner_size()
            .map_err(|err| format!("browser: inner_size() on window {to_window:?}: {err}"))?;
        commit_rect_on_main(
            app,
            to_window,
            child_label,
            RectSpec {
                x: 0.0,
                y: 0.0,
                width: f64::from(inner_size.width),
                height: f64::from(inner_size.height),
                corners: CornerPaint::default(),
            },
        )
    }

    pub fn commit_rect(
        app: &AppHandle,
        window_label: &str,
        child_label: &str,
        spec: RectSpec,
    ) -> Result<Rect, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_label_owned = window_label.to_string();
        let child_label_owned = child_label.to_string();
        app.run_on_main_thread(move || {
            let result =
                commit_rect_on_main(&app_for_main, &window_label_owned, &child_label_owned, spec);
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to position {child_label:?} in \
                 window {window_label:?}: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: GTK layout for {child_label:?} in window {window_label:?} did not \
                 report back within 5s: {err}"
            )
        })?
    }

    pub fn read_allocation(
        app: &AppHandle,
        window_label: &str,
        widget_label: &str,
    ) -> Result<Option<(i32, i32, i32, i32)>, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_label_owned = window_label.to_string();
        let widget_label_owned = widget_label.to_string();
        app.run_on_main_thread(move || {
            let result =
                read_allocation_on_main(&app_for_main, &window_label_owned, &widget_label_owned);
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!("browser: could not hop to the GTK main thread to read {widget_label:?}: {err}")
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!("browser: reading {widget_label:?}'s allocation did not report back within 5s: {err}")
        })?
    }

    pub fn is_widget_visible(
        app: &AppHandle,
        window_label: &str,
        widget_label: &str,
    ) -> Result<Option<bool>, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_label_owned = window_label.to_string();
        let widget_label_owned = widget_label.to_string();
        app.run_on_main_thread(move || {
            let result = is_widget_visible_on_main(&app_for_main, &window_label_owned, &widget_label_owned);
            let _ = tx.send(result);
        })
        .map_err(|err| format!("browser: could not hop to the GTK main thread to read {widget_label:?}'s visibility: {err}"))?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!("browser: reading {widget_label:?}'s visibility did not report back within 5s: {err}")
        })?
    }

    fn is_widget_visible_on_main(
        app: &AppHandle,
        window_label: &str,
        widget_label: &str,
    ) -> Result<Option<bool>, String> {
        let vbox = find_vbox(app, window_label)?;
        let Some(layout) = find_layout(&vbox) else {
            return Ok(None);
        };
        let widget = layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == widget_label);
        Ok(widget.map(|w| w.is_visible()))
    }

    pub fn toplevel_window_signatures(app: &AppHandle) -> Result<Vec<String>, String> {
        let (tx, rx) = channel();
        app.run_on_main_thread(move || {
            let mut signatures: Vec<String> = gtk::Window::list_toplevels()
                .iter()
                .map(|widget| format!("{}:{}", widget.type_().name(), widget.widget_name()))
                .collect();
            signatures.sort();
            let _ = tx.send(signatures);
        })
        .map_err(|err| {
            format!("browser: could not hop to the GTK main thread to list toplevels: {err}")
        })?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|err| format!("browser: listing GTK toplevels did not report back: {err}"))
    }

    pub fn focus_host(app: &AppHandle, window_label: &str) -> Result<bool, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_label_owned = window_label.to_string();
        app.run_on_main_thread(move || {
            let _ = tx.send(focus_host_on_main(&app_for_main, &window_label_owned));
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to focus the host of \
                 {window_label:?}: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!("browser: focusing the host of {window_label:?} did not report back: {err}")
        })?
    }

    fn focus_host_on_main(app: &AppHandle, window_label: &str) -> Result<bool, String> {
        let vbox = find_vbox(app, window_label)?;
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        let gtk_window = window
            .gtk_window()
            .map_err(|err| format!("browser: gtk_window() on window {window_label:?}: {err}"))?;

        let host = find_layout(&vbox)
            .and_then(|layout| {
                layout
                    .children()
                    .into_iter()
                    .find(|child| child.widget_name() == HOST_WIDGET_NAME)
            })
            .or_else(|| {
                let candidates: Vec<_> = vbox
                    .children()
                    .into_iter()
                    .filter(|child| child.type_().name().contains("WebKitWebView"))
                    .collect();
                match candidates.len() {
                    1 => candidates.into_iter().next(),
                    _ => None,
                }
            })
            .ok_or_else(|| {
                format!(
                    "browser: window {window_label:?} has no host WebKitWebView to focus (looked \
                     for a Layout child named {HOST_WIDGET_NAME:?}, then for any WebKitWebView in \
                     its default vbox); the keyboard cannot be taken back from a browser child"
                )
            })?;

        host.set_can_focus(true);
        gtk_window.set_focus(Some(&host));
        host.grab_focus();
        Ok(host.is_focus())
    }

    fn find_vbox(app: &AppHandle, window_label: &str) -> Result<gtk::Box, String> {
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        window
            .default_vbox()
            .map_err(|err| format!("browser: default_vbox() on window {window_label:?}: {err}"))
    }

    fn find_layout(vbox: &gtk::Box) -> Option<gtk::Layout> {
        vbox.children()
            .into_iter()
            .find(|child| child.widget_name() == LAYOUT_WIDGET_NAME)
            .and_then(|child| child.downcast::<gtk::Layout>().ok())
    }

    // gtk::Layout, never gtk::Fixed: Fixed caused a real runaway
    // window-growth incident here.
    fn find_or_create_layout(vbox: &gtk::Box) -> gtk::Layout {
        find_layout(vbox).unwrap_or_else(|| {
            let layout = gtk::Layout::new(gtk::Adjustment::NONE, gtk::Adjustment::NONE);
            layout.set_widget_name(LAYOUT_WIDGET_NAME);
            vbox.pack_start(&layout, true, true, 0);
            layout.show();
            layout
        })
    }

    fn read_allocation_on_main(
        app: &AppHandle,
        window_label: &str,
        widget_label: &str,
    ) -> Result<Option<(i32, i32, i32, i32)>, String> {
        let vbox = find_vbox(app, window_label)?;
        let Some(layout) = find_layout(&vbox) else {
            return Ok(None);
        };
        let widget = layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == widget_label);
        Ok(widget.map(|w| {
            let a = w.allocation();
            (a.x(), a.y(), a.width(), a.height())
        }))
    }

    pub fn follow_window_resize(app: &AppHandle, window_label: &str) {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_label_owned = window_label.to_string();
        let hop = app.run_on_main_thread(move || {
            let result = follow_window_resize_on_main(&app_for_main, &window_label_owned);
            let _ = tx.send(result);
        });
        if let Err(err) = hop {
            eprintln!("browser: could not hop to the GTK main thread to follow a resize of window {window_label:?}: {err}");
            return;
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                eprintln!("browser: following a resize of window {window_label:?} failed: {err}")
            }
            Err(err) => eprintln!(
                "browser: following a resize of window {window_label:?} did not report back \
                 within 5s: {err}"
            ),
        }
    }

    fn follow_window_resize_on_main(app: &AppHandle, window_label: &str) -> Result<(), String> {
        let vbox = find_vbox(app, window_label)?;
        let Some(layout) = find_layout(&vbox) else {
            return Ok(());
        };
        if !layout
            .children()
            .iter()
            .any(|child| child.widget_name() == HOST_WIDGET_NAME)
        {
            return Ok(());
        }
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        let inner_size = window
            .inner_size()
            .map_err(|err| format!("browser: inner_size() on window {window_label:?}: {err}"))?;
        commit_rect_on_main(
            app,
            window_label,
            HOST_WIDGET_NAME,
            RectSpec {
                x: 0.0,
                y: 0.0,
                width: f64::from(inner_size.width),
                height: f64::from(inner_size.height),
                corners: CornerPaint::default(),
            },
        )
        .map(|_| ())
    }

    fn adopt_host_if_needed(vbox: &gtk::Box, layout: &gtk::Layout, exclude: Option<&gtk::Widget>) {
        if layout
            .children()
            .iter()
            .any(|child| child.widget_name() == HOST_WIDGET_NAME)
        {
            return;
        }
        if let Some(host_widget) = vbox.children().into_iter().find(|child| {
            child.type_().name().contains("WebKitWebView")
                && exclude.is_none_or(|ex| ex.as_ptr() != child.as_ptr())
        }) {
            host_widget.set_widget_name(HOST_WIDGET_NAME);
            vbox.remove(&host_widget);
            layout.put(&host_widget, 0, 0);
            host_widget.show();
        }
    }

    fn host_zoom(vbox: &gtk::Box, layout: &gtk::Layout) -> f64 {
        use webkit2gtk::WebViewExt;
        find_host_webview(vbox, layout)
            .map(|view| view.zoom_level())
            .unwrap_or(1.0)
    }

    fn find_host_webview(vbox: &gtk::Box, layout: &gtk::Layout) -> Option<webkit2gtk::WebView> {
        layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == HOST_WIDGET_NAME)
            .or_else(|| {
                let candidates: Vec<_> = vbox
                    .children()
                    .into_iter()
                    .filter(|child| child.type_().name().contains("WebKitWebView"))
                    .collect();
                match candidates.len() {
                    1 => candidates.into_iter().next(),
                    _ => None,
                }
            })
            .and_then(|widget| widget.downcast::<webkit2gtk::WebView>().ok())
    }

    pub fn host_zoom_for_selftest(app: &AppHandle, window_label: &str) -> Result<f64, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_owned = window_label.to_string();
        app.run_on_main_thread(move || {
            let result = (|| -> Result<f64, String> {
                let vbox = find_vbox(&app_for_main, &window_owned)?;
                let layout = find_or_create_layout(&vbox);
                Ok(host_zoom(&vbox, &layout))
            })();
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to read the host zoom of \
                 {window_label:?}: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: reading the host zoom of {window_label:?} did not report back within \
                 5s: {err}"
            )
        })?
    }

    pub fn set_host_zoom_for_selftest(
        app: &AppHandle,
        window_label: &str,
        zoom: f64,
    ) -> Result<(), String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_owned = window_label.to_string();
        app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                use webkit2gtk::WebViewExt;
                let vbox = find_vbox(&app_for_main, &window_owned)?;
                let layout = find_or_create_layout(&vbox);
                let view = find_host_webview(&vbox, &layout).ok_or_else(|| {
                    format!("browser: window {window_owned:?} has no host WebKitWebView to zoom")
                })?;
                view.set_zoom_level(zoom);
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to zoom the host of \
                 {window_label:?}: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: zooming the host of {window_label:?} did not report back within 5s: \
                 {err}"
            )
        })?
    }

    pub fn corner_report(
        app: &AppHandle,
        window_label: &str,
        widget_label: &str,
    ) -> Result<Option<CornerShapeReport>, String> {
        let (tx, rx) = channel();
        let app_for_main = app.clone();
        let window_owned = window_label.to_string();
        let widget_owned = widget_label.to_string();
        app.run_on_main_thread(move || {
            let result = (|| -> Result<Option<CornerShapeReport>, String> {
                let vbox = find_vbox(&app_for_main, &window_owned)?;
                let Some(layout) = find_layout(&vbox) else {
                    return Ok(None);
                };
                let Some(widget) = layout
                    .children()
                    .into_iter()
                    .find(|child| child.widget_name() == widget_owned)
                else {
                    return Ok(None);
                };
                let state = CORNERS.with(|corners| {
                    corners
                        .borrow()
                        .get(widget_owned.as_str())
                        .copied()
                        .unwrap_or_default()
                });
                Ok(Some(CornerShapeReport {
                    has_native: widget.window().is_some_and(|w| w.has_native()),
                    paint: state.paint,
                    paints_applied: state.paints_applied,
                }))
            })();
            let _ = tx.send(result);
        })
        .map_err(|err| {
            format!(
                "browser: could not hop to the GTK main thread to read {widget_label:?}'s corners: {err}"
            )
        })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!(
                "browser: reading {widget_label:?}'s corners did not report back within 5s: {err}"
            )
        })?
    }

    fn commit_rect_on_main(
        app: &AppHandle,
        window_label: &str,
        child_label: &str,
        spec: RectSpec,
    ) -> Result<Rect, String> {
        let vbox = find_vbox(app, window_label)?;
        let window = app
            .get_window(window_label)
            .ok_or_else(|| format!("browser: no window labelled {window_label:?}"))?;
        let inner_size = window
            .inner_size()
            .map_err(|err| format!("browser: inner_size() on window {window_label:?}: {err}"))?;
        let win_w = inner_size.width as i32;
        let win_h = inner_size.height as i32;

        let layout = find_or_create_layout(&vbox);

        let zoom = if child_label == HOST_WIDGET_NAME {
            1.0
        } else {
            host_zoom(&vbox, &layout)
        };
        let rect = spec_to_logical(spec, zoom);

        let Some(widget) = layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == child_label)
        else {
            return Err(format!(
                "browser: no widget named {child_label:?} inside window {window_label:?}'s \
                 gtk::Layout; it may not have been mounted yet"
            ));
        };

        let (clamped, note) = clamp_to_window(rect, win_w, win_h);
        if let Some(note) = note {
            eprintln!("{note}");
        }
        widget.set_size_request(clamped.width, clamped.height);
        layout.move_(&widget, clamped.x, clamped.y);

        if std::env::var("HOUSTON_BROWSER_GEOMETRY").as_deref() == Ok("1") {
            let prev = widget.allocation();
            println!(
                "BROWSER-GEOMETRY child={child_label:?} window={window_label:?} \
                 spec={}x{}@{},{} req={}x{}@{},{} zoom={zoom} clamped={}x{}@{},{} \
                 win={win_w}x{win_h} prev_alloc={}x{}@{},{}",
                spec.width,
                spec.height,
                spec.x,
                spec.y,
                rect.width,
                rect.height,
                rect.x,
                rect.y,
                clamped.width,
                clamped.height,
                clamped.x,
                clamped.y,
                prev.width(),
                prev.height(),
                prev.x(),
                prev.y(),
            );
            let widget_for_settle = widget.clone();
            let child_owned = child_label.to_string();
            glib::idle_add_local_once(move || {
                let a = widget_for_settle.allocation();
                println!(
                    "BROWSER-GEOMETRY child={child_owned:?} settled_alloc={}x{}@{},{}",
                    a.width(),
                    a.height(),
                    a.x(),
                    a.y(),
                );
            });
        }
        if child_label != HOST_WIDGET_NAME {
            if let Some(gdk_window) = widget.window() {
                gdk_window.raise();
            }
        }

        if child_label != HOST_WIDGET_NAME {
            set_corner_paint(child_label, scale_corner_paint(spec.corners, zoom));
            widget.queue_draw();
        }

        layout.queue_resize();
        Ok(clamped)
    }

    #[derive(Debug, Clone, Copy, Default)]
    struct CornerState {
        paint: CornerPaint,
        paints_applied: u64,
    }

    thread_local! {
        static CORNERS: RefCell<HashMap<String, CornerState>> = RefCell::new(HashMap::new());
    }

    fn set_corner_paint(child_label: &str, paint: CornerPaint) {
        CORNERS.with(|corners| {
            corners
                .borrow_mut()
                .entry(child_label.to_string())
                .or_default()
                .paint = paint;
        });
    }

    fn connect_corner_paint(widget: &gtk::Widget) {
        widget.connect_local("draw", true, |values| {
            let target = values.first()?.get::<gtk::Widget>().ok()?;
            let cr = values.get(1)?.get::<gtk::cairo::Context>().ok()?;
            let name = target.widget_name();
            let paint = CORNERS.with(|corners| {
                corners
                    .borrow()
                    .get(name.as_str())
                    .map(|state| state.paint)
                    .unwrap_or_default()
            });
            if paint.is_noop() {
                return Some(false.to_value());
            }
            let allocation = target.allocation();
            paint_bottom_corners(
                &cr,
                f64::from(allocation.width()),
                f64::from(allocation.height()),
                &paint,
            );
            CORNERS.with(|corners| {
                if let Some(state) = corners.borrow_mut().get_mut(name.as_str()) {
                    state.paints_applied = state.paints_applied.saturating_add(1);
                }
            });
            Some(false.to_value())
        });
        widget.connect_destroy(|w| {
            let name = w.widget_name();
            CORNERS.with(|corners| {
                corners.borrow_mut().remove(name.as_str());
            });
        });
    }
}

#[cfg(target_os = "linux")]
pub use linux::{
    adopt_child, commit_rect, corner_report, focus_host, follow_window_resize,
    host_zoom_for_selftest, is_widget_visible, move_child, read_allocation,
    set_host_zoom_for_selftest, toplevel_window_signatures,
};

#[cfg(target_os = "windows")]
pub(crate) use crate::browser::webview2_host::{
    adopt_child, commit_rect, corner_report, focus_host, follow_window_resize,
    host_zoom_for_selftest, is_widget_visible, move_child, read_allocation,
    set_host_zoom_for_selftest, toplevel_window_signatures,
};

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod fallback {
    use super::*;

    const NOT_LINUX_MSG: &str = "browser: native child-webview positioning is GTK-only \
        (Linux); this platform has no equivalent mechanism yet";

    pub fn adopt_child(
        _app: &AppHandle,
        _window_label: &str,
        _child_label: &str,
        _webview: &tauri::webview::Webview,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn commit_rect(
        _app: &AppHandle,
        _window_label: &str,
        _child_label: &str,
        _spec: RectSpec,
    ) -> Result<Rect, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn move_child(
        _app: &AppHandle,
        _from_window: &str,
        _to_window: &str,
        _child_label: &str,
    ) -> Result<Rect, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn read_allocation(
        _app: &AppHandle,
        _window_label: &str,
        _widget_label: &str,
    ) -> Result<Option<(i32, i32, i32, i32)>, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn is_widget_visible(
        _app: &AppHandle,
        _window_label: &str,
        _widget_label: &str,
    ) -> Result<Option<bool>, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn toplevel_window_signatures(_app: &AppHandle) -> Result<Vec<String>, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn focus_host(_app: &AppHandle, _window_label: &str) -> Result<bool, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn set_host_zoom_for_selftest(
        _app: &AppHandle,
        _window_label: &str,
        _zoom: f64,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn host_zoom_for_selftest(_app: &AppHandle, _window_label: &str) -> Result<f64, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn corner_report(
        _app: &AppHandle,
        _window_label: &str,
        _widget_label: &str,
    ) -> Result<Option<CornerShapeReport>, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn follow_window_resize(_app: &AppHandle, _window_label: &str) {}
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub use fallback::{
    adopt_child, commit_rect, corner_report, focus_host, follow_window_resize,
    host_zoom_for_selftest, is_widget_visible, move_child, read_allocation,
    set_host_zoom_for_selftest, toplevel_window_signatures,
};

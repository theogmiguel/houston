#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

//! A spike proving native child webviews under Tauri v2 / WebKitGTK. Headline
//! finding: `set_position`/`set_size`/`set_bounds` are silent no-ops on Linux, so the
//! GTK section driving `default_vbox` directly is the only working layout path.

#[cfg(target_os = "linux")]
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
};

const HOST_WINDOW: &str = "main";

pub fn interactive_requested() -> bool {
    std::env::args().any(|arg| arg == "--spike-webview")
        || std::env::var_os("TR_SPIKE_WEBVIEW").is_some()
}

pub fn auto_requested() -> bool {
    std::env::args().any(|arg| arg == "--spike-webview-auto")
        || std::env::var_os("TR_SPIKE_WEBVIEW_AUTO").is_some()
}

#[derive(serde::Serialize, Clone, Copy, Debug)]
pub struct Geometry {
    pub physical_x: i32,
    pub physical_y: i32,
    pub physical_width: u32,
    pub physical_height: u32,
}

impl Geometry {
    fn from_parts(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Self {
        Self {
            physical_x: position.x,
            physical_y: position.y,
            physical_width: size.width,
            physical_height: size.height,
        }
    }
}

#[derive(serde::Deserialize, Debug)]
pub struct MountSpec {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: String,
    pub text: String,
}

#[derive(serde::Serialize, Clone, Copy, Debug)]
pub struct ProbeSample {
    pub step: u32,
    pub commanded_x: i32,
    pub commanded_width: u32,
    pub actual_x: i32,
    pub actual_width: u32,
    pub micros: u128,
}

#[derive(serde::Serialize, Debug)]
pub struct WindowMetrics {
    pub scale_factor: f64,
    pub inner_position: (i32, i32),
    pub outer_position: (i32, i32),
    pub inner_size: (u32, u32),
    pub outer_size: (u32, u32),
}

#[derive(serde::Serialize, Debug)]
pub struct ProcessSample {
    pub pid: u32,
    pub comm: String,
    pub rss_kib: u64,
}

fn is_hex_color(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 6) && digits.bytes().all(|b| b.is_ascii_hexdigit())
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn html_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn child_data_url(color: &str, text: &str) -> Result<String, String> {
    if !is_hex_color(color) {
        return Err(format!(
            "spike_wv: color must be a hex color like \"#c04040\" or \"#c44\", got {color:?}"
        ));
    }
    let label = html_escape(text);
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{label}</title>\
         <body style=\"margin:0;height:100vh;display:flex;flex-direction:column;\
         align-items:center;justify-content:center;gap:8px;background:{color};color:#0b0b0b;\
         font:700 40px/1.05 system-ui,sans-serif;text-align:center\">{label}\
         <div id=\"tick\" style=\"font:600 18px/1 system-ui,sans-serif;opacity:.75\"></div>"
    );
    Ok(format!("data:text/html,{}", percent_encode(&html)))
}

fn child_tick_script() -> String {
    r#"(function () {
  window.__spikeTick = 0;
  if (!window.__spikeTimer) {
    window.__spikeTimer = setInterval(function () { window.__spikeTick++; }, 50);
  }
  var paint = function () {
    var el = document.getElementById('tick');
    if (!el) return;
    setInterval(function () { el.textContent = 'tick ' + window.__spikeTick; }, 100);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint);
  } else {
    paint();
  }
})();"#
        .to_string()
}

#[tauri::command]
pub fn spike_wv_mount(app: AppHandle, spec: MountSpec) -> Result<Geometry, String> {
    let window = app.get_window(HOST_WINDOW).ok_or_else(|| {
        format!("spike_wv: no window labelled {HOST_WINDOW:?}; expected the scaffold's main window")
    })?;
    if app.get_webview(&spec.label).is_some() {
        return Err(format!(
            "spike_wv: a webview labelled {:?} already exists; use a fresh label or destroy it first",
            spec.label
        ));
    }
    let script = child_tick_script();
    let url = child_data_url(&spec.color, &spec.text)?
        .parse()
        .map_err(|err| format!("spike_wv: could not parse the generated data: URL: {err}"))?;

    let builder = WebviewBuilder::new(&spec.label, WebviewUrl::External(url))
        .initialization_script(script)
        .focused(false);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(spec.x, spec.y),
            LogicalSize::new(spec.width, spec.height),
        )
        .map_err(|err| {
            format!(
                "spike_wv: add_child failed for label {:?} at ({}, {}) size {}x{}: {err}",
                spec.label, spec.x, spec.y, spec.width, spec.height
            )
        })?;

    PENDING_MIGRATION
        .lock()
        .map_err(|err| format!("spike_wv: PENDING_MIGRATION mutex poisoned: {err}"))?
        .push(spec.label.clone());

    read_geometry(&webview)
}

fn read_geometry<R: tauri::Runtime>(
    webview: &tauri::webview::Webview<R>,
) -> Result<Geometry, String> {
    let position = webview
        .position()
        .map_err(|err| format!("spike_wv: reading position of {:?}: {err}", webview.label()))?;
    let size = webview
        .size()
        .map_err(|err| format!("spike_wv: reading size of {:?}: {err}", webview.label()))?;
    Ok(Geometry::from_parts(position, size))
}

fn webview_by_label(app: &AppHandle, label: &str) -> Result<tauri::webview::Webview, String> {
    app.get_webview(label).ok_or_else(|| {
        format!(
            "spike_wv: no webview labelled {label:?}; known labels: {:?}",
            app.webviews().keys().collect::<Vec<_>>()
        )
    })
}

#[tauri::command]
pub fn spike_wv_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<Geometry, String> {
    let webview = webview_by_label(&app, &label)?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|err| format!("spike_wv: set_position({x}, {y}) on {label:?}: {err}"))?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("spike_wv: set_size({width}, {height}) on {label:?}: {err}"))?;
    read_geometry(&webview)
}

#[tauri::command]
pub fn spike_wv_geometry(app: AppHandle, label: String) -> Result<Geometry, String> {
    read_geometry(&webview_by_label(&app, &label)?)
}

#[tauri::command]
pub fn spike_wv_set_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let webview = webview_by_label(&app, &label)?;
    if visible {
        webview.show()
    } else {
        webview.hide()
    }
    .map_err(|err| format!("spike_wv: set_visible({visible}) on {label:?}: {err}"))
}

#[tauri::command]
pub fn spike_wv_destroy(app: AppHandle, label: String) -> Result<(), String> {
    webview_by_label(&app, &label)?
        .close()
        .map_err(|err| format!("spike_wv: close() on {label:?}: {err}"))
}

#[tauri::command]
pub fn spike_wv_focus(app: AppHandle, label: Option<String>) -> Result<(), String> {
    match label {
        Some(label) => webview_by_label(&app, &label)?
            .set_focus()
            .map_err(|err| format!("spike_wv: set_focus() on {label:?}: {err}")),
        None => app
            .get_window(HOST_WINDOW)
            .ok_or_else(|| format!("spike_wv: no window labelled {HOST_WINDOW:?}"))?
            .set_focus()
            .map_err(|err| format!("spike_wv: set_focus() on the host window: {err}")),
    }
}

#[tauri::command]
pub fn spike_wv_labels(app: AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webviews().into_keys().collect();
    labels.sort();
    labels
}

#[tauri::command]
pub fn spike_wv_window_metrics(app: AppHandle) -> Result<WindowMetrics, String> {
    let window = app
        .get_window(HOST_WINDOW)
        .ok_or_else(|| format!("spike_wv: no window labelled {HOST_WINDOW:?}"))?;
    let m = |what: &str, err: tauri::Error| format!("spike_wv: reading window {what}: {err}");
    let inner_position = window
        .inner_position()
        .map_err(|e| m("inner_position", e))?;
    let outer_position = window
        .outer_position()
        .map_err(|e| m("outer_position", e))?;
    let inner_size = window.inner_size().map_err(|e| m("inner_size", e))?;
    let outer_size = window.outer_size().map_err(|e| m("outer_size", e))?;
    Ok(WindowMetrics {
        scale_factor: window.scale_factor().map_err(|e| m("scale_factor", e))?,
        inner_position: (inner_position.x, inner_position.y),
        outer_position: (outer_position.x, outer_position.y),
        inner_size: (inner_size.width, inner_size.height),
        outer_size: (outer_size.width, outer_size.height),
    })
}

#[tauri::command]
pub fn spike_wv_drag_probe(
    app: AppHandle,
    label: String,
    steps: u32,
    from_x: f64,
    to_x: f64,
    y: f64,
    height: f64,
) -> Result<Vec<ProbeSample>, String> {
    let webview = webview_by_label(&app, &label)?;
    let steps = steps.clamp(1, 2000);
    let mut samples = Vec::with_capacity(steps as usize);
    for step in 0..steps {
        let t = f64::from(step) / f64::from(steps.max(2) - 1);
        let x = from_x + (to_x - from_x) * t;
        let width = (to_x - x).max(1.0);
        let started = Instant::now();
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|err| format!("spike_wv: drag probe set_position at step {step}: {err}"))?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|err| format!("spike_wv: drag probe set_size at step {step}: {err}"))?;
        let geometry = read_geometry(&webview)?;
        samples.push(ProbeSample {
            step,
            commanded_x: x.round() as i32,
            commanded_width: width.round().max(0.0) as u32,
            actual_x: geometry.physical_x,
            actual_width: geometry.physical_width,
            micros: started.elapsed().as_micros(),
        });
    }
    Ok(samples)
}

#[cfg(target_os = "linux")]
#[tauri::command]
// The failure mode this exposes: wry drops the callback entirely until the webview
// reaches `LoadEvent::Committed`, so a timeout here means "no commit", not "the JS threw".
pub fn spike_wv_eval_read(app: AppHandle, label: String, js: String) -> Result<String, String> {
    let webview = webview_by_label(&app, &label)?;
    let (tx, rx) = channel();
    webview
        .eval_with_callback(js.clone(), move |value| {
            let _ = tx.send(value);
        })
        .map_err(|err| format!("spike_wv: eval_with_callback({js:?}) on {label:?}: {err}"))?;
    rx.recv_timeout(Duration::from_secs(3)).map_err(|err| {
        format!(
            "spike_wv: no result back from {label:?} for {js:?} within 3s \
             (wry drops the callback when the webview has not committed a load yet): {err}"
        )
    })
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn spike_wv_eval_read(_app: AppHandle, _label: String, _js: String) -> Result<String, String> {
    Err(
        "spike_wv: eval_with_callback probing is Linux-only; this platform has no \
         equivalent yet"
            .to_string(),
    )
}

#[tauri::command]
pub fn spike_wv_url(app: AppHandle, label: String) -> Result<String, String> {
    webview_by_label(&app, &label)?
        .url()
        .map(|url| url.to_string())
        .map_err(|err| format!("spike_wv: url() on {label:?}: {err}"))
}

#[tauri::command]
pub fn spike_wv_read_tick(app: AppHandle, label: String) -> Result<i64, String> {
    let raw = spike_wv_eval_read(app, label.clone(), "window.__spikeTick".into())?;
    raw.trim().parse::<i64>().map_err(|err| {
        format!("spike_wv: tick value from {label:?} was {raw:?}, expected a JSON integer: {err}")
    })
}

#[tauri::command]
pub fn spike_wv_webkit_processes() -> Vec<ProcessSample> {
    let mut samples = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return samples;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(comm) = std::fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        let comm = comm.trim().to_string();
        if !comm.starts_with("WebKit") {
            continue;
        }
        let rss_kib = std::fs::read_to_string(entry.path().join("status"))
            .ok()
            .and_then(|status| {
                status.lines().find_map(|line| {
                    line.strip_prefix("VmRSS:")?
                        .split_whitespace()
                        .next()?
                        .parse::<u64>()
                        .ok()
                })
            })
            .unwrap_or(0);
        samples.push(ProcessSample { pid, comm, rss_kib });
    }
    samples.sort_by_key(|s| s.pid);
    samples
}

static PENDING_MIGRATION: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[derive(serde::Deserialize, Debug, Clone)]
pub struct GtkRect {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Serialize, Debug, Clone)]
pub struct GtkLayoutReport {
    pub migrated: Vec<String>,
    pub allocations: Vec<(String, i32, i32, i32, i32)>,
    pub notes: Vec<String>,
}

pub const HOST_WIDGET_NAME: &str = "spike-host";

#[cfg(target_os = "linux")]
#[tauri::command]
pub fn spike_wv_gtk_layout(
    app: AppHandle,
    rects: Vec<GtkRect>,
    adopt_host: bool,
) -> Result<GtkLayoutReport, String> {
    let (tx, rx) = channel();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(gtk_layout_on_main(&app_for_main, rects, adopt_host));
    })
    .map_err(|err| format!("spike_wv: could not hop to the GTK main thread: {err}"))?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
        format!("spike_wv: GTK layout did not report back within 5s (expected a report): {err}")
    })?
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn spike_wv_gtk_layout(
    _app: AppHandle,
    _rects: Vec<GtkRect>,
    _adopt_host: bool,
) -> Result<GtkLayoutReport, String> {
    Err(
        "spike_wv: GTK layout is GTK-only (Linux); this platform has no \
         equivalent child-webview layout mechanism yet"
            .to_string(),
    )
}

#[cfg(target_os = "linux")]
fn clamp_to_window(
    rect: &GtkRect,
    win_w: i32,
    win_h: i32,
    notes: &mut Vec<String>,
) -> (i32, i32, i32, i32) {
    let x = rect.x.clamp(0, win_w.max(0));
    let y = rect.y.clamp(0, win_h.max(0));
    let width = rect.width.max(1).min((win_w - x).max(1));
    let height = rect.height.max(1).min((win_h - y).max(1));
    if x != rect.x || y != rect.y || width != rect.width || height != rect.height {
        notes.push(format!(
            "spike_wv: clamped {:?} commanded ({}, {}) {}x{} -> ({}, {}) {}x{} to fit window {}x{}",
            rect.label, rect.x, rect.y, rect.width, rect.height, x, y, width, height, win_w, win_h
        ));
    }
    (x, y, width, height)
}

#[cfg(target_os = "linux")]
fn gtk_layout_on_main(
    app: &AppHandle,
    rects: Vec<GtkRect>,
    adopt_host: bool,
) -> Result<GtkLayoutReport, String> {
    use gtk::prelude::*;

    let window = app
        .get_window(HOST_WINDOW)
        .ok_or_else(|| format!("spike_wv: no window labelled {HOST_WINDOW:?}"))?;
    let vbox = window
        .default_vbox()
        .map_err(|err| format!("spike_wv: default_vbox() on the host window: {err}"))?;

    let inner_size = window
        .inner_size()
        .map_err(|err| format!("spike_wv: inner_size() on the host window: {err}"))?;
    let win_w = inner_size.width as i32;
    let win_h = inner_size.height as i32;

    let mut notes = Vec::new();

    let layout = vbox
        .children()
        .into_iter()
        .find(|child| child.widget_name() == "spike-layout")
        .and_then(|child| child.downcast::<gtk::Layout>().ok())
        .unwrap_or_else(|| {
            let layout = gtk::Layout::new(gtk::Adjustment::NONE, gtk::Adjustment::NONE);
            layout.set_widget_name("spike-layout");
            vbox.pack_start(&layout, true, true, 0);
            layout.show();
            notes.push("created the gtk::Layout inside default_vbox".to_string());
            layout
        });

    if adopt_host
        && !layout
            .children()
            .iter()
            .any(|child| child.widget_name() == HOST_WIDGET_NAME)
    {
        match vbox
            .children()
            .into_iter()
            .find(|child| child.type_().name().contains("WebKitWebView"))
        {
            Some(host_widget) => {
                host_widget.set_widget_name(HOST_WIDGET_NAME);
                vbox.remove(&host_widget);
                layout.put(&host_widget, 0, 0);
                host_widget.show();
                notes.push(format!("adopted the host webview as {HOST_WIDGET_NAME:?}"));
            }
            None => notes.push(
                "adopt_host requested but default_vbox has no WebKitWebView child left".to_string(),
            ),
        }
    }

    let mut pending = PENDING_MIGRATION
        .lock()
        .map_err(|err| format!("spike_wv: PENDING_MIGRATION mutex poisoned: {err}"))?;
    let mut migrated = Vec::new();
    if !pending.is_empty() {
        let mut in_vbox: Vec<gtk::Widget> = vbox
            .children()
            .into_iter()
            .filter(|child| child.type_().name().contains("WebKitWebView"))
            .collect();
        let host_still_in_vbox = !layout
            .children()
            .iter()
            .any(|child| child.widget_name() == HOST_WIDGET_NAME);
        if host_still_in_vbox && !in_vbox.is_empty() {
            in_vbox.remove(0);
        }
        let movable = in_vbox;
        if movable.len() != pending.len() {
            notes.push(format!(
                "expected {} un-migrated WebKitWebView children in default_vbox, found {} — \
                 pairing by mount order may be wrong",
                pending.len(),
                movable.len()
            ));
        }
        for (widget, label) in movable.into_iter().zip(pending.drain(..)) {
            widget.set_widget_name(&label);
            vbox.remove(&widget);
            layout.put(&widget, 0, 0);
            widget.show();
            migrated.push(label);
        }
    }
    drop(pending);

    let mut allocations = Vec::new();
    for rect in &rects {
        let Some(widget) = layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == rect.label.as_str())
        else {
            notes.push(format!(
                "no widget named {:?} inside the gtk::Layout; known: {:?}",
                rect.label,
                layout
                    .children()
                    .iter()
                    .map(|c| c.widget_name().to_string())
                    .collect::<Vec<_>>()
            ));
            continue;
        };
        let (x, y, width, height) = clamp_to_window(rect, win_w, win_h, &mut notes);
        widget.set_size_request(width, height);
        layout.move_(&widget, x, y);
        if let Some(gdk_window) = widget.window() {
            gdk_window.raise();
        }
    }
    layout.queue_resize();
    for rect in &rects {
        if let Some(widget) = layout
            .children()
            .into_iter()
            .find(|child| child.widget_name() == rect.label.as_str())
        {
            let allocation = widget.allocation();
            allocations.push((
                rect.label.clone(),
                allocation.x(),
                allocation.y(),
                allocation.width(),
                allocation.height(),
            ));
        }
    }

    Ok(GtkLayoutReport {
        migrated,
        allocations,
        notes,
    })
}

pub const HARNESS_SCRIPT: &str = include_str!("spike_webview_harness.js");

pub fn run_auto_probe(app: AppHandle) {
    std::thread::spawn(move || {
        let result = auto_probe_body(&app);
        if let Err(err) = &result {
            println!("SPIKE-AUTO error: {err}");
        }
        for label in spike_wv_labels(app.clone()) {
            if label == HOST_WINDOW {
                continue;
            }
            match spike_wv_destroy(app.clone(), label.clone()) {
                Ok(()) => println!("SPIKE-AUTO teardown: closed {label:?}"),
                Err(err) => println!("SPIKE-AUTO teardown: FAILED to close {label:?}: {err}"),
            }
        }
        std::thread::sleep(Duration::from_millis(300));
        println!("SPIKE-AUTO done; exiting");
        app.exit(0);
    });
}

fn hold_ms() -> u64 {
    match std::env::var("TR_SPIKE_HOLD_MS") {
        Ok(raw) => raw.trim().parse().unwrap_or_else(|_| {
            eprintln!("spike_wv: TR_SPIKE_HOLD_MS={raw:?} is not a whole number of ms; using 800");
            800
        }),
        Err(_) => 800,
    }
}

fn auto_probe_body(app: &AppHandle) -> Result<(), String> {
    std::thread::sleep(Duration::from_millis(600));

    println!(
        "SPIKE-AUTO q2 window metrics: {:?}",
        spike_wv_window_metrics(app.clone())?
    );

    let mount = spike_wv_mount(
        app.clone(),
        MountSpec {
            label: "spike-a".into(),
            x: 40.0,
            y: 140.0,
            width: 480.0,
            height: 320.0,
            color: "#c04040".into(),
            text: "PANE A".into(),
        },
    );
    match &mount {
        Ok(geometry) => println!(
            "SPIKE-AUTO q1 add_child OK; commanded logical (40,140) 480x320 -> reported {geometry:?}"
        ),
        Err(err) => {
            println!("SPIKE-AUTO q1 add_child FAILED: {err}");
            return Ok(());
        }
    }

    for (index, color) in ["#3a7bd5", "#2fa84f", "#d58f2f", "#8a4fd5"]
        .iter()
        .enumerate()
    {
        let label = format!("spike-{}", index + 1);
        let geometry = spike_wv_mount(
            app.clone(),
            MountSpec {
                label: label.clone(),
                x: 560.0 + (index as f64 % 2.0) * 340.0,
                y: 140.0 + (index as f64 / 2.0).floor() * 240.0,
                width: 320.0,
                height: 220.0,
                color: (*color).into(),
                text: format!("PANE {}", index + 1),
            },
        )?;
        println!("SPIKE-AUTO q7 mounted {label:?} -> {geometry:?}");
    }
    std::thread::sleep(Duration::from_millis(1200));
    println!(
        "SPIKE-AUTO q7 webkit processes with 5 children: {:?}",
        spike_wv_webkit_processes()
    );

    println!(
        "SPIKE-AUTO positioning via Webview::set_position/set_size: {:?}",
        spike_wv_set_bounds(app.clone(), "spike-a".into(), 300.0, 300.0, 400.0, 250.0)?
    );

    #[cfg(target_os = "linux")]
    {
        let rects = vec![
            GtkRect {
                label: "spike-a".into(),
                x: 40,
                y: 150,
                width: 480,
                height: 320,
            },
            GtkRect {
                label: "spike-1".into(),
                x: 560,
                y: 150,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-2".into(),
                x: 900,
                y: 150,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-3".into(),
                x: 560,
                y: 390,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-4".into(),
                x: 900,
                y: 390,
                width: 320,
                height: 220,
            },
        ];
        match spike_wv_gtk_layout(app.clone(), rects, false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout (children only): {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(800));

        let metrics = spike_wv_window_metrics(app.clone())?;
        let (w, h) = (metrics.inner_size.0 as i32, metrics.inner_size.1 as i32);
        let overlap = vec![
            GtkRect {
                label: HOST_WIDGET_NAME.into(),
                x: 0,
                y: 0,
                width: w,
                height: h,
            },
            GtkRect {
                label: "spike-a".into(),
                x: 40,
                y: 150,
                width: 480,
                height: 320,
            },
            GtkRect {
                label: "spike-1".into(),
                x: 560,
                y: 150,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-2".into(),
                x: 900,
                y: 150,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-3".into(),
                x: 560,
                y: 390,
                width: 320,
                height: 220,
            },
            GtkRect {
                label: "spike-4".into(),
                x: 900,
                y: 390,
                width: 320,
                height: 220,
            },
        ];
        match spike_wv_gtk_layout(app.clone(), overlap.clone(), true) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout (host adopted, overlapping): {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout with adopt_host FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(500));
        match spike_wv_gtk_layout(app.clone(), overlap.clone(), false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout settled pass 1: {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout settled pass 1 FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(500));
        match spike_wv_gtk_layout(app.clone(), overlap, false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout settled pass 2: {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout settled pass 2 FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(hold_ms()));

        let strip = 140;
        let cell_w = (w - 30) / 3;
        let cell_h = (h - strip - 30) / 2;
        let tiled = vec![
            GtkRect {
                label: HOST_WIDGET_NAME.into(),
                x: 0,
                y: 0,
                width: w,
                height: strip,
            },
            GtkRect {
                label: "spike-a".into(),
                x: 0,
                y: strip,
                width: cell_w,
                height: cell_h,
            },
            GtkRect {
                label: "spike-1".into(),
                x: cell_w + 10,
                y: strip,
                width: cell_w,
                height: cell_h,
            },
            GtkRect {
                label: "spike-2".into(),
                x: 2 * (cell_w + 10),
                y: strip,
                width: cell_w,
                height: cell_h,
            },
            GtkRect {
                label: "spike-3".into(),
                x: 0,
                y: strip + cell_h + 10,
                width: cell_w,
                height: cell_h,
            },
            GtkRect {
                label: "spike-4".into(),
                x: cell_w + 10,
                y: strip + cell_h + 10,
                width: cell_w,
                height: cell_h,
            },
        ];
        match spike_wv_gtk_layout(app.clone(), tiled.clone(), false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout tiled (no overlap): {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout tiled FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(500));
        match spike_wv_gtk_layout(app.clone(), tiled.clone(), false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout tiled settled: {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout tiled settled FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(hold_ms()));

        let mut overlay = tiled;
        overlay.retain(|rect| rect.label != "spike-4");
        overlay.push(GtkRect {
            label: "spike-4".into(),
            x: 120,
            y: strip + 60,
            width: 300,
            height: 200,
        });
        match spike_wv_gtk_layout(app.clone(), overlay.clone(), false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout child-over-child: {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout child-over-child FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(500));
        match spike_wv_gtk_layout(app.clone(), overlay, false) {
            Ok(report) => println!("SPIKE-AUTO gtk_layout child-over-child settled: {report:?}"),
            Err(err) => println!("SPIKE-AUTO gtk_layout child-over-child settled FAILED: {err}"),
        }
        std::thread::sleep(Duration::from_millis(hold_ms()));
        let started = Instant::now();
        let mut worst = 0u128;
        for step in 0..120 {
            let x = 40 + step * 6;
            let call = Instant::now();
            let report = spike_wv_gtk_layout(
                app.clone(),
                vec![GtkRect {
                    label: "spike-a".into(),
                    x,
                    y: 150,
                    width: 480,
                    height: 320,
                }],
                false,
            )?;
            worst = worst.max(call.elapsed().as_micros());
            if step == 119 {
                println!("SPIKE-AUTO gtk drag last step commanded x={x} -> {report:?}");
            }
        }
        println!(
            "SPIKE-AUTO gtk drag: 120 moves in {} ms, worst single move {worst} us",
            started.elapsed().as_millis()
        );
        std::thread::sleep(Duration::from_millis(400));
        let settled = spike_wv_gtk_layout(
            app.clone(),
            vec![GtkRect {
                label: "spike-a".into(),
                x: 754,
                y: 150,
                width: 480,
                height: 320,
            }],
            false,
        )?;
        println!(
            "SPIKE-AUTO gtk drag settled (commanded x=754, host origin offsets it): {settled:?}"
        );

        {
            let before = spike_wv_window_metrics(app.clone())?;
            println!(
                "SPIKE-AUTO regression: window inner_size before = {:?}",
                before.inner_size
            );

            spike_wv_mount(
                app.clone(),
                MountSpec {
                    label: "spike-b".into(),
                    x: 0.0,
                    y: 0.0,
                    width: 400.0,
                    height: 300.0,
                    color: "#3a7bd5".into(),
                    text: "PANE B".into(),
                },
            )?;

            let win_w = before.inner_size.0 as i32;
            let win_h = before.inner_size.1 as i32;
            let (top, gutter) = (150, 8);
            let range = (win_w - gutter - 120).max(1) as f64;
            let total_steps = 150u32;

            let mut in_bounds = true;
            let mut distinct_x = true;
            let is_unrealized = |x: i32, y: i32, width: i32, height: i32| {
                (x == -1 && y == -1 && width == 1 && height == 1) || width <= 0 || height <= 0
            };
            let mut realized_samples: u32 = 0;
            for step in 0..total_steps {
                let t = f64::from(step) / f64::from(total_steps - 1);
                let triangle = if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 };
                let split_x = 60 + (range * triangle).round() as i32;
                let body_h = win_h - top;
                let rects = vec![
                    GtkRect {
                        label: HOST_WIDGET_NAME.into(),
                        x: 0,
                        y: 0,
                        width: win_w,
                        height: top,
                    },
                    GtkRect {
                        label: "spike-a".into(),
                        x: 0,
                        y: top,
                        width: split_x.max(1),
                        height: body_h,
                    },
                    GtkRect {
                        label: "spike-b".into(),
                        x: split_x + gutter,
                        y: top,
                        width: (win_w - split_x - gutter).max(1),
                        height: body_h,
                    },
                ];
                let report = spike_wv_gtk_layout(app.clone(), rects, true)?;
                let mut step_fully_realized = !report.allocations.is_empty();
                for (label, x, y, width, height) in &report.allocations {
                    if is_unrealized(*x, *y, *width, *height) {
                        step_fully_realized = false;
                        continue;
                    }
                    if *x < 0 || *y < 0 || *x + *width > win_w || *y + *height > win_h {
                        in_bounds = false;
                        println!(
                            "SPIKE-AUTO regression FAIL: {label} allocation ({x},{y}) \
                             {width}x{height} exceeds window {win_w}x{win_h} at step {step}"
                        );
                    }
                }
                if step_fully_realized {
                    realized_samples += 1;
                }
                if let (Some(a), Some(b)) = (
                    report
                        .allocations
                        .iter()
                        .find(|(label, ..)| label.as_str() == "spike-a"),
                    report
                        .allocations
                        .iter()
                        .find(|(label, ..)| label.as_str() == "spike-b"),
                ) {
                    let (_, ax, ay, aw, ah) = a;
                    let (_, bx, by, bw, bh) = b;
                    let both_realized =
                        !is_unrealized(*ax, *ay, *aw, *ah) && !is_unrealized(*bx, *by, *bw, *bh);
                    if both_realized && a.1 == b.1 {
                        distinct_x = false;
                        println!(
                            "SPIKE-AUTO regression FAIL: spike-a and spike-b share x={} at step {step}",
                            a.1
                        );
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(300));
            let after = spike_wv_window_metrics(app.clone())?;
            println!(
                "SPIKE-AUTO regression: window inner_size after = {:?}",
                after.inner_size
            );
            let size_stable = before.inner_size == after.inner_size;
            const MIN_REALIZED_SAMPLES: u32 = 75;
            let quorum_met = realized_samples >= MIN_REALIZED_SAMPLES;
            let pass = size_stable && in_bounds && distinct_x && quorum_met;
            println!(
                "SPIKE-AUTO regression: size_stable={size_stable} in_bounds={in_bounds} \
                 distinct_x_origins={distinct_x} realized_samples={realized_samples}/{total_steps} -> {}",
                if pass { "PASS" } else { "FAIL" }
            );
            if !quorum_met {
                println!(
                    "SPIKE-AUTO regression FAIL: only {realized_samples}/{total_steps} steps \
                     produced realized allocations (need >= {MIN_REALIZED_SAMPLES}); the check \
                     did not assert enough to be trusted"
                );
            }
        }

        for (name, x, y) in [
            ("half-off-left", -240, 150),
            ("past-right", 1300, 150),
            ("past-bottom", 40, 900),
        ] {
            let _ = spike_wv_gtk_layout(
                app.clone(),
                vec![GtkRect {
                    label: "spike-a".into(),
                    x,
                    y,
                    width: 480,
                    height: 320,
                }],
                false,
            )?;
            std::thread::sleep(Duration::from_millis(350));
            let report = spike_wv_gtk_layout(
                app.clone(),
                vec![GtkRect {
                    label: "spike-a".into(),
                    x,
                    y,
                    width: 480,
                    height: 320,
                }],
                false,
            )?;
            println!("SPIKE-AUTO gtk clip {name}: commanded ({x},{y}) 480x320 -> {report:?}");
        }
        let _ = spike_wv_gtk_layout(
            app.clone(),
            vec![GtkRect {
                label: "spike-a".into(),
                x: 40,
                y: 150,
                width: 480,
                height: 320,
            }],
            false,
        )?;

        for js in ["document.readyState", "location.href", "document.title"] {
            match spike_wv_eval_read(app.clone(), "spike-a".into(), js.to_string()) {
                Ok(value) => println!("SPIKE-AUTO child eval {js} = {value}"),
                Err(err) => println!("SPIKE-AUTO child eval {js} FAILED: {err}"),
            }
        }
        match spike_wv_url(app.clone(), "spike-a".into()) {
            Ok(url) => println!("SPIKE-AUTO child url = {url:?}"),
            Err(err) => println!("SPIKE-AUTO child url FAILED: {err}"),
        }
    }

    for (name, x, y, w, h) in [
        ("half-off-left", -240.0_f64, 140.0_f64, 480.0_f64, 320.0_f64),
        ("half-off-right", 1240.0, 140.0, 480.0, 320.0),
        ("below-bottom", 40.0, 800.0, 480.0, 320.0),
    ] {
        let geometry = spike_wv_set_bounds(app.clone(), "spike-a".into(), x, y, w, h)?;
        println!("SPIKE-AUTO q4 clipping {name}: commanded ({x},{y}) {w}x{h} -> {geometry:?}");
        std::thread::sleep(Duration::from_millis(250));
    }
    spike_wv_set_bounds(app.clone(), "spike-a".into(), 40.0, 140.0, 480.0, 320.0)?;

    let before = spike_wv_read_tick(app.clone(), "spike-a".into());
    spike_wv_set_visible(app.clone(), "spike-a".into(), false)?;
    let hide_started = Instant::now();
    std::thread::sleep(Duration::from_millis(1500));
    let hidden_elapsed = hide_started.elapsed();
    let during = spike_wv_read_tick(app.clone(), "spike-a".into());
    spike_wv_set_visible(app.clone(), "spike-a".into(), true)?;
    println!(
        "SPIKE-AUTO q5 timers: tick {before:?} -> {during:?} across {} ms hidden \
         (50 ms interval: ~{} ticks expected if timers keep running)",
        hidden_elapsed.as_millis(),
        hidden_elapsed.as_millis() / 50
    );

    let destroy_started = Instant::now();
    spike_wv_destroy(app.clone(), "spike-4".into())?;
    println!(
        "SPIKE-AUTO q5 destroy took {} us",
        destroy_started.elapsed().as_micros()
    );
    let remount_started = Instant::now();
    spike_wv_mount(
        app.clone(),
        MountSpec {
            label: "spike-4".into(),
            x: 900.0,
            y: 380.0,
            width: 320.0,
            height: 220.0,
            color: "#8a4fd5".into(),
            text: "PANE 4".into(),
        },
    )?;
    println!(
        "SPIKE-AUTO q5 remount took {} us",
        remount_started.elapsed().as_micros()
    );
    let hide_call = Instant::now();
    spike_wv_set_visible(app.clone(), "spike-4".into(), false)?;
    let hide_us = hide_call.elapsed().as_micros();
    let show_call = Instant::now();
    spike_wv_set_visible(app.clone(), "spike-4".into(), true)?;
    println!(
        "SPIKE-AUTO q5 hide took {hide_us} us, show took {} us",
        show_call.elapsed().as_micros()
    );

    spike_wv_focus(app.clone(), Some("spike-a".into()))?;
    println!("SPIKE-AUTO q6 set_focus on child returned Ok");
    spike_wv_focus(app.clone(), None)?;
    println!("SPIKE-AUTO q6 set_focus back on host window returned Ok");

    let samples = spike_wv_drag_probe(
        app.clone(),
        "spike-a".into(),
        120,
        40.0,
        900.0,
        140.0,
        320.0,
    )?;
    let mismatches = samples
        .iter()
        .filter(|s| (s.commanded_x - s.actual_x).abs() > 1)
        .count();
    let total: u128 = samples.iter().map(|s| s.micros).sum();
    let worst = samples.iter().map(|s| s.micros).max().unwrap_or(0);
    println!(
        "SPIKE-AUTO q8 drag probe: {} steps, {mismatches} with |commanded-actual| > 1px, \
         mean {} us/step, worst {worst} us/step",
        samples.len(),
        total / samples.len().max(1) as u128
    );
    for sample in samples.iter().take(3).chain(samples.iter().rev().take(3)) {
        println!("SPIKE-AUTO q8   {sample:?}");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{child_data_url, html_escape, is_hex_color, percent_encode};

    #[test]
    fn hex_colors_accepted_in_both_lengths() {
        assert!(is_hex_color("#c04040"));
        assert!(is_hex_color("#c44"));
    }

    #[test]
    fn non_hex_colors_rejected() {
        for value in ["red", "#12345", "c04040", "#gggggg", "", "#"] {
            assert!(!is_hex_color(value), "{value:?} must be rejected");
        }
    }

    #[test]
    fn color_rejection_names_the_offending_value() {
        let err = child_data_url("red; background:url(x)", "x").unwrap_err();
        assert!(err.contains("red; background:url(x)"), "got {err:?}");
    }

    #[test]
    fn percent_encode_escapes_everything_outside_the_unreserved_set() {
        assert_eq!(percent_encode("aZ0-_.~"), "aZ0-_.~");
        assert_eq!(percent_encode("<a b>"), "%3Ca%20b%3E");
        assert_eq!(percent_encode("é"), "%C3%A9");
    }

    #[test]
    fn html_escape_neutralises_markup() {
        assert_eq!(
            html_escape(r#"<img src="x" onerror='y'>&"#),
            "&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;"
        );
    }

    #[test]
    fn data_url_is_local_and_carries_the_validated_color() {
        let url = child_data_url("#c04040", "PANE A").unwrap();
        assert!(url.starts_with("data:text/html,"), "{url}");
        assert!(!url.contains("http"), "{url}");
        assert!(url.contains(&percent_encode("background:#c04040")), "{url}");
        assert!(url.contains(&percent_encode("PANE A")), "{url}");
    }

    #[test]
    fn data_url_escapes_markup_in_the_label() {
        let url = child_data_url("#c44", "</title><script>bad()</script>").unwrap();
        assert!(!url.contains(&percent_encode("<script>")), "{url}");
        assert!(url.contains(&percent_encode("&lt;script&gt;")), "{url}");
    }
}

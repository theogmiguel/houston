pub const CHILD_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 \
                                    (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

pub const ALLOWED_CHILD_SCHEMES: &[&str] = &["http", "https", "data", "file", "about", "blob"];

pub fn scheme_is_allowed(scheme: &str) -> bool {
    ALLOWED_CHILD_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str())
}

pub fn url_scheme_is_allowed(url: &str) -> bool {
    scheme_is_allowed(&scheme_of(url))
}

pub fn scheme_of(url: &str) -> String {
    url.split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

pub struct Capture {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub const MAX_CAPTURE_RGBA_BYTES: usize = 256 * 1024 * 1024;

pub const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};
    use std::rc::Rc;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    use gtk::glib::object::Cast;
    use tauri::{AppHandle, Emitter, EventTarget};
    use webkit2gtk::{
        LoadEvent, NavigationAction, NavigationPolicyDecision, NavigationPolicyDecisionExt,
        PolicyDecisionExt, PolicyDecisionType, URIRequestExt, WebProcessTerminationReason,
        WebViewExt,
    };

    use crate::browser::picker;
    use crate::browser::state::{
        self, BrowserError, LiveProps, Sticky, FOCUS_EVENT, MAX_FAVICON_EDGE, OPEN_URL_EVENT,
        STATE_EVENT,
    };

    const PROGRESS_EMIT_STEP: f64 = 0.02;

    pub fn wire_signals(
        app: &AppHandle,
        id: &str,
        host_label: &str,
        webview: &tauri::webview::Webview,
    ) -> Result<(), String> {
        let (tx, rx) = channel();
        let app_owned = app.clone();
        let id_owned = id.to_string();
        let host_owned = host_label.to_string();
        let id_for_err = id.to_string();
        webview
            .with_webview(move |platform| {
                wire_signals_on_main(&app_owned, &id_owned, &host_owned, &platform.inner());
                let _ = tx.send(());
            })
            .map_err(|err| {
                format!(
                    "browser: could not hop to the GTK main thread to wire {id_for_err:?}'s \
                     WebKit signals: {err}"
                )
            })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!("browser: wiring {id:?}'s WebKit signals did not report back within 5s: {err}")
        })
    }

    fn wire_signals_on_main(
        app: &AppHandle,
        id: &str,
        host_label: &str,
        webview: &webkit2gtk::WebView,
    ) {
        let last_progress = Rc::new(Cell::new(-1.0_f64));

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            let last_progress = last_progress.clone();
            webview.connect_load_changed(move |view, event| {
                let sticky = crate::browser::update_sticky(&app, &id, |sticky| match event {
                    LoadEvent::Started => sticky.load_started(),
                    LoadEvent::Committed => sticky.load_committed(),
                    _ => {}
                });
                if matches!(event, LoadEvent::Started) {
                    last_progress.set(-1.0);
                }
                let Some(sticky) = sticky else { return };
                emit_state(&app, &id, &host, view, &sticky);
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            webview.connect_load_failed(move |view, _event, failing_uri, error| {
                if error.matches(webkit2gtk::NetworkError::Cancelled) {
                    return false;
                }
                if let Some(sticky) = crate::browser::update_sticky(&app, &id, |sticky| {
                    sticky.error = Some(BrowserError::load(failing_uri, error.to_string()));
                }) {
                    emit_state(&app, &id, &host, view, &sticky);
                }
                true
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            webview.connect_title_notify(move |view| {
                let Some(sticky) = crate::browser::sticky_for(&app, &id) else {
                    return;
                };
                emit_state(&app, &id, &host, view, &sticky);
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            webview.connect_favicon_notify(move |view| {
                let encoded = favicon_data_url(&id, view);
                let Some(sticky) =
                    crate::browser::update_sticky(&app, &id, |sticky| sticky.favicon = encoded)
                else {
                    return;
                };
                emit_state(&app, &id, &host, view, &sticky);
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            let last_progress = last_progress.clone();
            webview.connect_estimated_load_progress_notify(move |view| {
                let progress = view.estimated_load_progress();
                let previous = last_progress.get();
                let finished_now = progress >= 1.0 && previous < 1.0;
                if (progress - previous).abs() < PROGRESS_EMIT_STEP && !finished_now {
                    return;
                }
                last_progress.set(progress);
                let Some(sticky) = crate::browser::sticky_for(&app, &id) else {
                    return;
                };
                emit_state(&app, &id, &host, view, &sticky);
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            webview.connect_web_process_terminated(move |view, reason| {
                let Some(sticky) = crate::browser::update_sticky(&app, &id, |sticky| {
                    sticky.mount_failed = true;
                    sticky.error = Some(BrowserError::web_process_terminated(reason_label(reason)));
                }) else {
                    return;
                };
                emit_state(&app, &id, &host, view, &sticky);
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            let host = host_label.to_string();
            webview.connect_decide_policy(move |view, decision, kind| {
                if !matches!(kind, PolicyDecisionType::NewWindowAction) {
                    return false;
                }
                let Some(navigation) = decision.downcast_ref::<NavigationPolicyDecision>() else {
                    return false;
                };
                let Some(url) = navigation
                    .navigation_action()
                    .and_then(|action| action.request())
                    .and_then(|request| request.uri())
                    .map(|uri| uri.to_string())
                else {
                    return false;
                };
                if url_scheme_is_allowed(&url) {
                    return false;
                }
                decision.ignore();
                let scheme = scheme_of(&url);
                let shown: String = url.chars().take(200).collect();
                eprintln!(
                    "browser: refused to open a {scheme:?}-scheme popup from {id:?} (url \
                     {shown:?}); browser panes may only load {}",
                    ALLOWED_CHILD_SCHEMES.join(", ")
                );
                if let Some(sticky) = crate::browser::update_sticky(&app, &id, |sticky| {
                    sticky.error = Some(BrowserError::blocked_scheme(&shown, &scheme));
                }) {
                    emit_state(&app, &id, &host, view, &sticky);
                }
                true
            });
        }

        {
            let app = app.clone();
            let id = id.to_string();
            webview.connect_create(move |_view, action| {
                match navigation_action_url(action) {
                    Some(url) => {
                        if let Err(err) = app.emit_to(
                            EventTarget::AnyLabel {
                                label: crate::browser::popup_event_target().to_string(),
                            },
                            OPEN_URL_EVENT,
                            serde_json::json!({ "id": &id, "url": url }),
                        ) {
                            eprintln!("browser: could not emit {OPEN_URL_EVENT} for {id:?}: {err}");
                        }
                    }
                    None => eprintln!(
                        "browser: {id:?} tried to open a popup whose navigation action carries no \
                         request URI; refused"
                    ),
                }
                None
            });
        }

        {
            use gtk::prelude::WidgetExt;
            let emit_focus = {
                let app = app.clone();
                let id = id.to_string();
                let host = host_label.to_string();
                move |path: &str| {
                    if std::env::var("HOUSTON_BROWSER_FOCUS").as_deref() == Ok("1") {
                        eprintln!("browser-focus: {path} fired for {id:?}");
                    }
                    let host_label = resolve_host_label(&app, &id, &host);
                    if let Err(err) = app.emit_to(
                        EventTarget::AnyLabel { label: host_label },
                        FOCUS_EVENT,
                        serde_json::json!({ "id": &id }),
                    ) {
                        eprintln!("browser: could not emit {FOCUS_EVENT} for {id:?}: {err}");
                    }
                }
            };
            {
                let emit_focus = emit_focus.clone();
                webview.connect_focus_in_event(move |_view, _event| {
                    emit_focus("focus-in-event");
                    gtk::glib::Propagation::Proceed
                });
            }
            match webview.user_content_manager() {
                Some(manager) => {
                    use webkit2gtk::UserContentManagerExt;
                    let script = webkit2gtk::UserScript::for_world(
                        FOCUS_FORWARDER_JS,
                        webkit2gtk::UserContentInjectedFrames::AllFrames,
                        webkit2gtk::UserScriptInjectionTime::Start,
                        FOCUS_WORLD,
                        &[],
                        &[],
                    );
                    manager.add_script(&script);
                    if manager.register_script_message_handler_in_world("trFocus", FOCUS_WORLD) {
                        manager.connect_script_message_received(
                            Some("trFocus"),
                            move |_manager, _result| {
                                emit_focus("trFocus script message");
                            },
                        );
                    }
                    webview.evaluate_javascript(
                        FOCUS_FORWARDER_JS,
                        Some(FOCUS_WORLD),
                        None,
                        None::<&gtk::gio::Cancellable>,
                        |result| {
                            if let Err(err) = result {
                                eprintln!(
                                    "browser: evaluating the focus forwarder against the current \
                                     document failed: {err}"
                                );
                            }
                        },
                    );
                }
                None => eprintln!(
                    "browser: child {id:?} has no WebKitUserContentManager; page clicks will not \
                     select its pane (chrome clicks still do)"
                ),
            }
        }
    }

    const FOCUS_WORLD: &str = "trFocus";

    const FOCUS_FORWARDER_JS: &str = "(() => { if (window.__trFocusInstalled) return; \
         window.__trFocusInstalled = true; \
         window.addEventListener('mousedown', () => { \
         try { window.webkit.messageHandlers.trFocus.postMessage(0); } catch (e) {} \
         }, { capture: true, passive: true }); })();";

    fn reason_label(reason: WebProcessTerminationReason) -> &'static str {
        match reason {
            WebProcessTerminationReason::Crashed => "crashed",
            WebProcessTerminationReason::ExceededMemoryLimit => "exceeded its memory limit",
            WebProcessTerminationReason::TerminatedByApi => "terminated by API",
            _ => "terminated for an unknown reason",
        }
    }

    fn navigation_action_url(action: &NavigationAction) -> Option<String> {
        action
            .request()
            .and_then(|request| request.uri())
            .map(|uri| uri.to_string())
    }

    fn resolve_host_label(app: &AppHandle, id: &str, fallback: &str) -> String {
        crate::browser::window_label_for(app, id).unwrap_or_else(|| fallback.to_string())
    }

    fn emit_state(
        app: &AppHandle,
        id: &str,
        host_label: &str,
        view: &webkit2gtk::WebView,
        sticky: &Sticky,
    ) {
        let live = LiveProps {
            url: view.uri().map(|u| u.to_string()),
            title: view
                .title()
                .map(|t| t.to_string())
                .filter(|t| !t.is_empty()),
            favicon: sticky.favicon.clone(),
            loading: view.is_loading(),
            progress: view.estimated_load_progress(),
            can_go_back: view.can_go_back(),
            can_go_forward: view.can_go_forward(),
        };
        let payload = state::merge(id, live, sticky);
        crate::browser::cache_last_state(app, id, &payload);
        let host_label = resolve_host_label(app, id, host_label);
        if let Err(err) = app.emit_to(
            EventTarget::AnyLabel { label: host_label },
            STATE_EVENT,
            payload,
        ) {
            eprintln!("browser: could not emit {STATE_EVENT} for {id:?}: {err}");
        }
    }

    fn favicon_data_url(id: &str, view: &webkit2gtk::WebView) -> Option<String> {
        let surface = view.favicon()?;
        surface.flush();
        let mut image = match gtk::cairo::ImageSurface::try_from(surface) {
            Ok(image) => image,
            Err(_) => {
                eprintln!("browser: {id:?} favicon is not an image surface; skipping it");
                return None;
            }
        };
        let (width, height) = (image.width(), image.height());
        if !(1..=MAX_FAVICON_EDGE).contains(&width) || !(1..=MAX_FAVICON_EDGE).contains(&height) {
            eprintln!(
                "browser: {id:?} favicon is {width}x{height}, outside the 1..={MAX_FAVICON_EDGE}px \
                 MAX_FAVICON_EDGE range; dropping it rather than inlining or scaling"
            );
            return None;
        }
        if image.format() != gtk::cairo::Format::ARgb32 {
            eprintln!(
                "browser: {id:?} favicon is in cairo format {:?}, not ARgb32; skipping it",
                image.format()
            );
            return None;
        }
        let stride = image.stride();
        let data = match image.data() {
            Ok(data) => data,
            Err(err) => {
                eprintln!("browser: {id:?} favicon surface data is unavailable: {err}");
                return None;
            }
        };
        let rgba = match state::argb32_premultiplied_to_rgba(
            &data[..],
            width as usize,
            height as usize,
            stride as usize,
        ) {
            Ok(rgba) => rgba,
            Err(err) => {
                eprintln!("browser: {id:?} favicon conversion failed: {err}");
                return None;
            }
        };
        match state::rgba_to_png_data_url(&rgba, width as u32, height as u32) {
            Ok(url) => Some(url),
            Err(err) => {
                eprintln!("browser: {id:?} favicon PNG encode failed: {err}");
                None
            }
        }
    }

    pub fn navigate(webview: &tauri::webview::Webview, id: &str, url: &str) -> Result<(), String> {
        if !url_scheme_is_allowed(url) {
            return Err(format!(
                "browser: refusing to navigate id {id:?} to the {:?} scheme (url {url:?}); \
                 browser panes may only load {}",
                scheme_of(url),
                ALLOWED_CHILD_SCHEMES.join(", ")
            ));
        }
        let url_owned = url.to_string();
        run_on_view(webview, id, "navigate", move |view| {
            view.load_uri(&url_owned);
            Ok(())
        })
    }

    pub fn reload(
        webview: &tauri::webview::Webview,
        id: &str,
        bypass_cache: bool,
    ) -> Result<(), String> {
        run_on_view(webview, id, "reload", move |view| {
            if bypass_cache {
                view.reload_bypass_cache();
            } else {
                view.reload();
            }
            Ok(())
        })
    }

    pub fn go_back(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        let id_owned = id.to_string();
        run_on_view(webview, id, "go_back", move |view| {
            if !view.can_go_back() {
                return Err(format!(
                    "browser: id {id_owned:?} has no back history entry (canGoBack=false); \
                     refusing to go back"
                ));
            }
            view.go_back();
            Ok(())
        })
    }

    pub fn go_forward(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        let id_owned = id.to_string();
        run_on_view(webview, id, "go_forward", move |view| {
            if !view.can_go_forward() {
                return Err(format!(
                    "browser: id {id_owned:?} has no forward history entry \
                     (canGoForward=false); refusing to go forward"
                ));
            }
            view.go_forward();
            Ok(())
        })
    }

    pub fn allow_automatic_popups_for_selftest(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        use webkit2gtk::SettingsExt;
        let id_owned = id.to_string();
        run_on_view(webview, id, "allow automatic popups", move |view| {
            let settings = view.settings().ok_or_else(|| {
                format!("browser: child {id_owned:?} has no WebKitSettings object")
            })?;
            settings.set_javascript_can_open_windows_automatically(true);
            Ok(())
        })
    }

    pub fn enable_console_logging_if_asked(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        if std::env::var("HOUSTON_BROWSER_CONSOLE").as_deref() != Ok("1") {
            return Ok(());
        }
        let id_owned = id.to_string();
        run_on_view(webview, id, "enable console logging for", move |view| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            let settings = view.settings().ok_or_else(|| {
                format!("browser: child {id_owned:?} has no WebKitSettings; cannot log its console")
            })?;
            settings.set_enable_write_console_messages_to_stdout(true);
            println!("BROWSER-CONSOLE enabled for child {id_owned:?}");
            Ok(())
        })
    }

    pub fn sever_ipc_transport(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        use webkit2gtk::UserContentManagerExt;

        let id_owned = id.to_string();
        run_on_view(webview, id, "sever the IPC transport of", move |view| {
            let manager = view.user_content_manager().ok_or_else(|| {
                format!(
                    "browser: child {id_owned:?} has no WebKitUserContentManager, so its IPC \
                     transport cannot be severed; refusing to mount a child that would keep it"
                )
            })?;
            manager.remove_all_scripts();
            manager.unregister_script_message_handler("ipc");
            let blocked = block_wrys_unfiltered_receiver(&manager);
            if blocked > 0 {
                WRY_RECEIVER_BLOCKED.with(|set| {
                    set.borrow_mut().insert(id_owned.clone());
                });
            } else {
                WRY_RECEIVER_BLOCKED.with(|set| {
                    set.borrow_mut().remove(&id_owned);
                });
                eprintln!(
                    "browser: child {id_owned:?} mounted, but g_signal_handlers_block_matched \
                     matched 0 unfiltered \"script-message-received\" handlers on its \
                     UserContentManager (expected at least 1 with wry \
                     {WRY_VERSION_THIS_DEFENCE_MATCHES}); the picker will refuse to enable on \
                     this surface (P4-X1)"
                );
            }
            Ok(())
        })
    }

    const PICKER_WORLD: &str = "trPicker";

    const TOOLS_WORLD: &str = "trTools";

    const TOOLS_EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    const MAX_TOOLS_RESULT_BYTES: usize = 1024 * 1024;

    thread_local! {
        static PICKER_SCRIPTS: RefCell<HashMap<String, webkit2gtk::UserScript>> =
            RefCell::new(HashMap::new());
        static PICKER_HANDLERS_CONNECTED: RefCell<HashSet<String>> =
            RefCell::new(HashSet::new());
        static WRY_RECEIVER_BLOCKED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    }

    pub const WRY_VERSION_THIS_DEFENCE_MATCHES: &str = "0.55.1";

    // Works around a wry defect: its script-message handler has no detail,
    // so it fires for every message and unwraps `webview.uri()`, which
    // panics (aborting the process) on a data:/file:/blob: page.
    fn block_wrys_unfiltered_receiver(manager: &webkit2gtk::UserContentManager) -> u32 {
        use gtk::glib::gobject_ffi;
        use gtk::glib::object::ObjectType;
        use gtk::glib::translate::IntoGlib;
        use gtk::glib::StaticType;

        // SAFETY: the name is a valid NUL-terminated C string and the type
        // is a registered GObject type; this only looks up a signal id.
        let signal_id = unsafe {
            gobject_ffi::g_signal_lookup(
                c"script-message-received".as_ptr(),
                webkit2gtk::UserContentManager::static_type().into_glib(),
            )
        };
        if signal_id == 0 {
            return 0;
        }
        let instance = manager.as_ptr() as *mut gobject_ffi::GObject;
        // SAFETY: `instance` is a live `WebKitUserContentManager`, which is a
        // valid GObject for as long as `manager` is borrowed here.
        unsafe {
            gobject_ffi::g_signal_handlers_block_matched(
                instance,
                gobject_ffi::G_SIGNAL_MATCH_ID | gobject_ffi::G_SIGNAL_MATCH_DETAIL,
                signal_id,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        }
    }

    pub fn picker_defence_is_armed(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<bool, String> {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let id_owned = id.to_string();
        let armed = Arc::new(AtomicBool::new(false));
        let sink = Arc::clone(&armed);
        run_on_view(
            webview,
            id,
            "read the picker defence state of",
            move |_view| {
                sink.store(
                    WRY_RECEIVER_BLOCKED.with(|set| set.borrow().contains(&id_owned)),
                    Ordering::SeqCst,
                );
                Ok(())
            },
        )?;
        Ok(armed.load(Ordering::SeqCst))
    }

    pub fn enable_picker(
        app: &AppHandle,
        webview: &tauri::webview::Webview,
        id: &str,
        host_label: &str,
        source: &str,
    ) -> Result<(), String> {
        let app_owned = app.clone();
        let id_owned = id.to_string();
        let host_owned = host_label.to_string();
        let source_owned = source.to_string();
        run_on_view(webview, id, "enable the picker for", move |view| {
            enable_picker_on_main(&app_owned, view, &id_owned, &host_owned, &source_owned)
        })
    }

    fn enable_picker_on_main(
        app: &AppHandle,
        view: &webkit2gtk::WebView,
        id: &str,
        host_label: &str,
        source: &str,
    ) -> Result<(), String> {
        use webkit2gtk::UserContentManagerExt;

        if !WRY_RECEIVER_BLOCKED.with(|set| set.borrow().contains(id)) {
            return Err(format!(
                "browser: refusing to enable the picker for surface {id:?}: wry's unfiltered \
                 \"script-message-received\" handler was not blocked on this child's \
                 UserContentManager at mount (g_signal_handlers_block_matched matched 0 handlers \
                 with detail 0; at least 1 expected with wry \
                 {WRY_VERSION_THIS_DEFENCE_MATCHES}). With it live, the first picker message from \
                 a page whose URI does not parse as an http::Uri -- every data:, file: and blob: \
                 page, all three of which ALLOWED_CHILD_SCHEMES permits -- aborts the whole \
                 process (P4-X1, block_wrys_unfiltered_receiver's docs)"
            ));
        }

        let manager = view.user_content_manager().ok_or_else(|| {
            format!(
                "browser: child {id:?} has no WebKitUserContentManager; cannot enable its picker"
            )
        })?;
        if let Some(old) = PICKER_SCRIPTS.with(|scripts| scripts.borrow_mut().remove(id)) {
            manager.remove_script(&old);
        }
        let script = webkit2gtk::UserScript::for_world(
            source,
            webkit2gtk::UserContentInjectedFrames::TopFrame,
            webkit2gtk::UserScriptInjectionTime::Start,
            PICKER_WORLD,
            &[],
            &[],
        );
        manager.add_script(&script);
        PICKER_SCRIPTS.with(|scripts| {
            scripts.borrow_mut().insert(id.to_string(), script);
        });
        let registered = manager.register_script_message_handler_in_world("trPicker", PICKER_WORLD);
        let already_connected = PICKER_HANDLERS_CONNECTED.with(|set| set.borrow().contains(id));
        if !registered && !already_connected {
            return Err(format!(
                "browser: registering the \"trPicker\" script-message handler in world \
                 {PICKER_WORLD:?} for surface {id:?} returned false and this surface has no \
                 handler connected yet; expected true (a first registration) or false with an \
                 already-connected handler (a re-enable). Refusing to report an enabled picker \
                 no message could reach"
            ));
        }
        let already_connected = PICKER_HANDLERS_CONNECTED.with(|set| set.borrow().contains(id));
        if !already_connected {
            let app_for_handler = app.clone();
            let id_for_handler = id.to_string();
            let host_for_handler = host_label.to_string();
            manager.connect_script_message_received(Some("trPicker"), move |_manager, result| {
                handle_picker_message(&app_for_handler, &id_for_handler, &host_for_handler, result);
            });
            PICKER_HANDLERS_CONNECTED.with(|set| {
                set.borrow_mut().insert(id.to_string());
            });
        }
        view.evaluate_javascript(
            source,
            Some(PICKER_WORLD),
            None,
            None::<&gtk::gio::Cancellable>,
            |result| {
                if let Err(err) = result {
                    eprintln!(
                        "browser: evaluating the picker script against the current document \
                     failed: {err}"
                    );
                }
            },
        );
        Ok(())
    }

    pub fn disable_picker(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        let id_owned = id.to_string();
        run_on_view(webview, id, "disable the picker for", move |view| {
            use webkit2gtk::UserContentManagerExt;
            if let Some(manager) = view.user_content_manager() {
                if let Some(script) =
                    PICKER_SCRIPTS.with(|scripts| scripts.borrow_mut().remove(&id_owned))
                {
                    manager.remove_script(&script);
                }
                manager.unregister_script_message_handler_in_world("trPicker", PICKER_WORLD);
            }
            view.evaluate_javascript(
                "if (window.__trPickerTeardown) { window.__trPickerTeardown(); }",
                Some(PICKER_WORLD),
                None,
                None::<&gtk::gio::Cancellable>,
                |result| {
                    if let Err(err) = result {
                        eprintln!("browser: picker teardown script failed: {err}");
                    }
                },
            );
            Ok(())
        })
    }

    pub fn clear_picker_selection(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        run_on_view(webview, id, "clear the picker selection for", move |view| {
            view.evaluate_javascript(
                "if (window.__trPickerClear) { window.__trPickerClear(); }",
                Some(PICKER_WORLD),
                None,
                None::<&gtk::gio::Cancellable>,
                |result| {
                    if let Err(err) = result {
                        eprintln!("browser: picker clear script failed: {err}");
                    }
                },
            );
            Ok(())
        })
    }

    pub fn submit_picker_prompt(
        webview: &tauri::webview::Webview,
        id: &str,
        user_prompt: &str,
        agent_id: &str,
    ) -> Result<(), String> {
        let prompt_literal = serde_json::Value::String(user_prompt.to_string()).to_string();
        let agent_literal = serde_json::Value::String(agent_id.to_string()).to_string();
        let script = format!(
            "if (window.__trPickerSubmit) {{ window.__trPickerSubmit({prompt_literal}, \
             {agent_literal}); }}"
        );
        run_on_view(webview, id, "submit the picker prompt for", move |view| {
            view.evaluate_javascript(
                &script,
                Some(PICKER_WORLD),
                None,
                None::<&gtk::gio::Cancellable>,
                |result| {
                    if let Err(err) = result {
                        eprintln!("browser: picker submit script failed: {err}");
                    }
                },
            );
            Ok(())
        })
    }

    pub fn forget_picker_state(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        let id_owned = id.to_string();
        run_on_view(webview, id, "forget the picker state of", move |_view| {
            PICKER_SCRIPTS.with(|scripts| {
                scripts.borrow_mut().remove(&id_owned);
            });
            PICKER_HANDLERS_CONNECTED.with(|set| {
                set.borrow_mut().remove(&id_owned);
            });
            WRY_RECEIVER_BLOCKED.with(|set| {
                set.borrow_mut().remove(&id_owned);
            });
            Ok(())
        })
    }

    fn handle_picker_message(
        app: &AppHandle,
        id: &str,
        host_label: &str,
        result: &webkit2gtk::JavascriptResult,
    ) {
        use javascriptcore::ValueExt;

        let Some(value) = result.js_value() else {
            eprintln!("browser: a picker message from {id:?} carried no JS value; dropped");
            return;
        };
        let raw = value.to_str().to_string();

        if raw.len() > picker::MAX_RAW_MESSAGE_BYTES {
            eprintln!(
                "browser: dropped a picker message for {id:?}: it is {} bytes, over the {}-byte \
                 MAX_RAW_MESSAGE_BYTES cap",
                raw.len(),
                picker::MAX_RAW_MESSAGE_BYTES
            );
            return;
        }

        let Some((expected_token, label)) = crate::browser::picker_state_for(app, id) else {
            eprintln!(
                "browser: dropped a picker message for {id:?}: its picker is not enabled \
                 (disabled or the surface was destroyed since the message was sent)"
            );
            return;
        };
        let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(parsed) => parsed,
            Err(err) => {
                eprintln!(
                    "browser: dropped a picker message for {id:?} ({} bytes): it is not valid \
                     JSON: {err}",
                    raw.len()
                );
                return;
            }
        };
        let sent_token = parsed.get("token").and_then(|t| t.as_str());
        if !sent_token.is_some_and(|sent| picker::constant_time_eq(sent, &expected_token)) {
            eprintln!(
                "browser: dropped a picker message for {id:?} (type {:?}, {} bytes): its token \
                 did not match the surface's current picker token (forged, stale, or the picker \
                 was re-enabled since this message was sent)",
                parsed.get("type").and_then(|t| t.as_str()).unwrap_or("?"),
                raw.len()
            );
            return;
        }

        let event = match picker::parse_picker_value(id, &parsed) {
            Ok(event) => event,
            Err(err) => {
                eprintln!("browser: {err}");
                return;
            }
        };
        let event = match event {
            picker::PickerEvent::PromptSubmitted {
                id,
                user_prompt,
                agent_id,
                selections,
                ..
            } => {
                let wrapped_prompt = picker::wrap_picked_markup(&label, &user_prompt, &selections);
                picker::PickerEvent::PromptSubmitted {
                    id,
                    user_prompt,
                    agent_id,
                    selections,
                    wrapped_prompt,
                }
            }
            other => other,
        };
        if let Err(err) = app.emit_to(
            EventTarget::AnyLabel {
                label: host_label.to_string(),
            },
            picker::PICKER_EVENT,
            &event,
        ) {
            eprintln!(
                "browser: could not emit {} for {id:?}: {err}",
                picker::PICKER_EVENT
            );
        }
    }

    pub async fn eval_tools(
        webview: &tauri::webview::Webview,
        id: &str,
        op: &str,
    ) -> Result<String, String> {
        const TEMPLATE: &str = include_str!("tools.js");
        let source = TEMPLATE.replace("__TR_TOOLS_OP__", op);

        let (tx, rx) = tokio::sync::oneshot::channel();
        let id_owned = id.to_string();
        webview
            .with_webview(move |platform| {
                use javascriptcore::ValueExt;
                let view = platform.inner();
                view.evaluate_javascript(
                    &source,
                    Some(TOOLS_WORLD),
                    None,
                    None::<&gtk::gio::Cancellable>,
                    move |result| {
                        let answer = match result {
                            Ok(value) => {
                                let raw = value.to_str().to_string();
                                if raw.len() > MAX_TOOLS_RESULT_BYTES {
                                    Err(format!(
                                        "browser: a page operation on surface {id_owned:?} \
                                         returned {} bytes; the limit is \
                                         {MAX_TOOLS_RESULT_BYTES} bytes \
                                         (MAX_TOOLS_RESULT_BYTES)",
                                        raw.len()
                                    ))
                                } else {
                                    Ok(raw)
                                }
                            }
                            Err(err) => Err(format!(
                                "browser: evaluating a page operation on surface {id_owned:?} \
                                 failed: {err}"
                            )),
                        };
                        let _ = tx.send(answer);
                    },
                );
            })
            .map_err(|err| {
                format!(
                    "browser: could not hop to the GTK main thread to run a page operation on \
                     id {id:?}: {err}"
                )
            })?;
        match tokio::time::timeout(TOOLS_EVAL_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(format!(
                "browser: the page-operation callback for id {id:?} was dropped without \
                 reporting; the child was most likely destroyed mid-call"
            )),
            Err(_) => Err(format!(
                "browser: a page operation on id {id:?} did not complete within \
                 {TOOLS_EVAL_TIMEOUT:?}"
            )),
        }
    }

    pub async fn capture_rgba(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<Capture, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id_owned = id.to_string();
        webview
            .with_webview(move |platform| {
                let view = platform.inner();
                view.snapshot(
                    webkit2gtk::SnapshotRegion::Visible,
                    webkit2gtk::SnapshotOptions::NONE,
                    None::<&gtk::gio::Cancellable>,
                    move |result| {
                        let capture = result
                            .map_err(|err| {
                                format!(
                                    "browser: WebKit refused to snapshot id {id_owned:?}: {err}"
                                )
                            })
                            .and_then(|surface| surface_to_capture(&id_owned, surface));
                        let _ = tx.send(capture);
                    },
                );
            })
            .map_err(|err| {
                format!("browser: could not hop to the GTK main thread to capture id {id:?}: {err}")
            })?;
        match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
            Ok(Ok(capture)) => capture,
            Ok(Err(_)) => Err(format!(
                "browser: the snapshot callback for id {id:?} was dropped without reporting; \
                 the child was most likely destroyed mid-capture"
            )),
            Err(_) => Err(format!(
                "browser: capture of id {id:?} did not complete within {CAPTURE_TIMEOUT:?}"
            )),
        }
    }

    fn surface_to_capture(id: &str, surface: gtk::cairo::Surface) -> Result<Capture, String> {
        surface.flush();
        let mut image = gtk::cairo::ImageSurface::try_from(surface).map_err(|_| {
            format!("browser: the snapshot of id {id:?} is not a cairo image surface")
        })?;
        let (width, height) = (image.width(), image.height());
        if width < 1 || height < 1 {
            return Err(format!(
                "browser: the snapshot of id {id:?} is {width}x{height}; expected both extents >= 1"
            ));
        }
        let rgba_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                format!("browser: the snapshot of id {id:?} is {width}x{height}, whose RGBA size overflows")
            })?;
        if rgba_bytes > MAX_CAPTURE_RGBA_BYTES {
            return Err(format!(
                "browser: the snapshot of id {id:?} is {width}x{height} = {rgba_bytes} RGBA bytes, \
                 over the {MAX_CAPTURE_RGBA_BYTES}-byte MAX_CAPTURE_RGBA_BYTES cap; refusing to \
                 decode it"
            ));
        }
        if image.format() != gtk::cairo::Format::ARgb32 {
            return Err(format!(
                "browser: the snapshot of id {id:?} is in cairo format {:?}, not ARgb32",
                image.format()
            ));
        }
        let stride = image.stride();
        let data = image
            .data()
            .map_err(|err| format!("browser: snapshot data for id {id:?} is unavailable: {err}"))?;
        let rgba = state::argb32_premultiplied_to_rgba(
            &data[..],
            width as usize,
            height as usize,
            stride as usize,
        )?;
        Ok(Capture {
            rgba,
            width: width as u32,
            height: height as u32,
        })
    }

    pub fn terminate_web_process_for_selftest(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        run_on_view(webview, id, "terminate the web process", move |view| {
            view.terminate_web_process();
            Ok(())
        })
    }

    pub fn dispatch_mousedown_for_selftest(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        run_on_view(webview, id, "dispatch a synthetic mousedown", move |view| {
            view.evaluate_javascript(
                "window.dispatchEvent(new MouseEvent('mousedown'))",
                None,
                None,
                None::<&gtk::gio::Cancellable>,
                |result| {
                    if let Err(err) = result {
                        eprintln!("browser: selftest mousedown dispatch failed: {err}");
                    }
                },
            );
            Ok(())
        })
    }

    fn run_on_view(
        webview: &tauri::webview::Webview,
        id: &str,
        what: &str,
        op: impl FnOnce(&webkit2gtk::WebView) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        let (tx, rx) = channel();
        webview
            .with_webview(move |platform| {
                let _ = tx.send(op(&platform.inner()));
            })
            .map_err(|err| {
                format!("browser: could not hop to the GTK main thread to {what} id {id:?}: {err}")
            })?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|err| {
            format!("browser: {what} for id {id:?} did not report back within 5s: {err}")
        })?
    }
}

#[cfg(target_os = "linux")]
pub use linux::{
    allow_automatic_popups_for_selftest, capture_rgba, clear_picker_selection, disable_picker,
    dispatch_mousedown_for_selftest, enable_console_logging_if_asked, enable_picker, eval_tools,
    forget_picker_state, go_back, go_forward, navigate, picker_defence_is_armed, reload,
    sever_ipc_transport, submit_picker_prompt, terminate_web_process_for_selftest, wire_signals,
};

#[cfg(target_os = "windows")]
pub(crate) use crate::browser::webview2_commands::imp::{
    allow_automatic_popups_for_selftest, capture_rgba, clear_picker_selection, disable_picker,
    dispatch_mousedown_for_selftest, enable_console_logging_if_asked, enable_picker, eval_tools,
    forget_picker_state, go_back, go_forward, navigate, picker_defence_is_armed, reload,
    sever_ipc_transport, submit_picker_prompt, terminate_web_process_for_selftest,
};
#[cfg(target_os = "windows")]
pub(crate) use crate::browser::webview2_engine::wire_signals;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod fallback {
    use super::*;

    const NOT_LINUX_MSG: &str = "browser: WebKit signal wiring and navigation are GTK-only \
        (Linux); this platform has no equivalent mechanism yet";

    pub fn wire_signals(
        _app: &AppHandle,
        _id: &str,
        _host_label: &str,
        _webview: &tauri::webview::Webview,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn navigate(
        _webview: &tauri::webview::Webview,
        _id: &str,
        _url: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn reload(
        _webview: &tauri::webview::Webview,
        _id: &str,
        _bypass_cache: bool,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn go_back(_webview: &tauri::webview::Webview, _id: &str) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn go_forward(_webview: &tauri::webview::Webview, _id: &str) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn allow_automatic_popups_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn sever_ipc_transport(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn enable_console_logging_if_asked(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    pub fn enable_picker(
        _app: &AppHandle,
        _webview: &tauri::webview::Webview,
        _id: &str,
        _host_label: &str,
        _source: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn disable_picker(_webview: &tauri::webview::Webview, _id: &str) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn clear_picker_selection(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn submit_picker_prompt(
        _webview: &tauri::webview::Webview,
        _id: &str,
        _user_prompt: &str,
        _agent_id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn picker_defence_is_armed(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<bool, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn forget_picker_state(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub async fn capture_rgba(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<Capture, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub async fn eval_tools(
        _webview: &tauri::webview::Webview,
        _id: &str,
        _op: &str,
    ) -> Result<String, String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn terminate_web_process_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }

    pub fn dispatch_mousedown_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(NOT_LINUX_MSG.to_string())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub use fallback::{
    allow_automatic_popups_for_selftest, capture_rgba, clear_picker_selection, disable_picker,
    dispatch_mousedown_for_selftest, enable_console_logging_if_asked, enable_picker, eval_tools,
    forget_picker_state, go_back, go_forward, navigate, picker_defence_is_armed, reload,
    sever_ipc_transport, submit_picker_prompt, terminate_web_process_for_selftest, wire_signals,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_child_user_agent_claims_only_what_this_engine_can_back() {
        let ua = CHILD_USER_AGENT;
        assert!(
            ua.contains("AppleWebKit/605.1.15") && ua.contains("Safari/605.1.15"),
            "the child UA must keep WebKitGTK's real engine tokens; got {ua:?}"
        );
        for brand in ["Chrome/", "Chromium/", "Edg/", "Firefox/", "Gecko/2"] {
            assert!(
                !ua.contains(brand),
                "the child UA claims {brand:?}, which WebKitGTK cannot back — that \
                 inconsistency is what M2's first fix got wrong; got {ua:?}"
            );
        }
        assert!(
            !ua.contains("Ubuntu"),
            "the child UA leaks the Ubuntu platform token real Safari never sends; got {ua:?}"
        );
        let version = ua
            .split("Version/")
            .nth(1)
            .and_then(|rest| rest.split(['.', ' ']).next())
            .and_then(|major| major.parse::<u32>().ok())
            .unwrap_or_else(|| panic!("the child UA has no parseable Version/ token; got {ua:?}"));
        assert!(
            (15..=30).contains(&version),
            "Version/{version} is not a Safari version that has shipped — the stock \
             WebKitGTK string's Version/60.5 is one of the two tells this constant \
             exists to drop; got {ua:?}"
        );
    }

    #[test]
    fn the_child_schemes_that_wry_cannot_parse_are_still_the_ones_we_think() {
        use tauri::http::Uri;

        for url in [
            "data:text/html,<h1>hi</h1>",
            "data:text/html;charset=utf-8,%3Ch1%3E",
            "file:///home/u/x.html",
            "blob:http://example.test/1234-5678",
        ] {
            assert!(
                url.parse::<Uri>().is_err(),
                "{url} now parses as an http::Uri; P4-X1's affected-scheme set has changed"
            );
            assert!(
                url_scheme_is_allowed(url),
                "{url} is no longer an allowed child scheme; this test's premise has moved"
            );
        }

        for url in [
            "http://example.test/a?b=c",
            "https://example.test/",
            "about:blank",
        ] {
            assert!(
                url.parse::<Uri>().is_ok(),
                "{url} no longer parses as an http::Uri; it has JOINED the affected set"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_wry_version_the_defence_was_measured_against_is_the_one_we_build() {
        let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
            .expect("src-tauri/Cargo.lock must be readable");
        let resolved = lock
            .split("[[package]]")
            .find(|block| block.contains("name = \"wry\""))
            .and_then(|block| {
                block
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("version = "))
            })
            .map(|version| version.trim().trim_matches('"').to_string())
            .expect("Cargo.lock must contain a [[package]] entry named \"wry\" with a version");

        assert_eq!(
            resolved,
            linux::WRY_VERSION_THIS_DEFENCE_MATCHES,
            "wry resolves to {resolved} but P4-X1's defence was measured against {}. Re-verify \
             that attach_ipc_handler still connects script-message-received with no detail and \
             still unwraps an http::Uri built from the page URI, then update the constant (or \
             drop the defence if upstream fixed it)",
            linux::WRY_VERSION_THIS_DEFENCE_MATCHES
        );
    }

    #[test]
    fn the_schemes_a_browser_pane_needs_are_allowed() {
        for scheme in ["http", "https", "data", "file", "about", "blob"] {
            assert!(scheme_is_allowed(scheme), "{scheme} must be allowed");
        }
    }

    #[test]
    fn the_privileged_schemes_are_refused() {
        for scheme in ["tauri", "ipc", "asset"] {
            assert!(!scheme_is_allowed(scheme), "{scheme} must be refused");
        }
    }

    #[test]
    fn scheme_matching_is_case_insensitive() {
        assert!(!scheme_is_allowed("TAURI"));
        assert!(!url_scheme_is_allowed("Tauri://localhost"));
        assert!(url_scheme_is_allowed("HTTPS://example.test/"));
    }

    #[test]
    fn a_url_with_no_scheme_is_refused() {
        assert!(!url_scheme_is_allowed("localhost/index.html"));
        assert!(!url_scheme_is_allowed(""));
    }

    #[test]
    fn scheme_of_names_what_was_refused() {
        assert_eq!(scheme_of("tauri://localhost"), "tauri");
        assert_eq!(scheme_of("data:text/html,x"), "data");
    }
}

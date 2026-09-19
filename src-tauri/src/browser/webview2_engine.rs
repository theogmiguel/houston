use std::cell::Cell;
use std::rc::Rc;

use tauri::{AppHandle, Emitter, EventTarget};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2NavigationCompletedEventArgs,
    ICoreWebView2NewWindowRequestedEventArgs, ICoreWebView2PermissionRequestedEventArgs,
    ICoreWebView2_4, COREWEBVIEW2_PERMISSION_STATE_DENY,
    COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT, COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED,
    COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET,
    COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED,
};
use webview2_com::{
    ContentLoadingEventHandler, DocumentTitleChangedEventHandler, FocusChangedEventHandler,
    HistoryChangedEventHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    SourceChangedEventHandler,
};
use windows_core::{IUnknown, Interface, PWSTR};

use crate::browser::state::{self, BrowserError, LiveProps, FOCUS_EVENT, OPEN_URL_EVENT};
use crate::browser::webview2_host::run_on_view;

pub(crate) fn web_error_status_text(status: i32) -> String {
    match status {
        s if s == COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT.0 => "cannot connect".into(),
        s if s == COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED.0 => "connection aborted".into(),
        s if s == COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET.0 => "connection reset".into(),
        s if s == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED.0 => {
            "authentication credentials no longer valid".into()
        }
        other => format!("web error status {other}"),
    }
}

type Cells = (Rc<Cell<bool>>, Rc<Cell<f64>>);

fn live_props(core: &ICoreWebView2, cells: &Cells) -> LiveProps {
    // SAFETY: callers run inside a with_webview closure on the UI thread,
    // the only one allowed to touch this COM object graph.
    unsafe {
        let mut url_pwstr = PWSTR(std::ptr::null_mut());
        let url =
            (core.Source(&mut url_pwstr).is_ok()).then(|| webview2_com::take_pwstr(url_pwstr));
        let mut title_pwstr = PWSTR(std::ptr::null_mut());
        let title = (core.DocumentTitle(&mut title_pwstr).is_ok())
            .then(|| webview2_com::take_pwstr(title_pwstr))
            .filter(|t| !t.is_empty());
        let mut can_back = Default::default();
        core.CanGoBack(&mut can_back).ok();
        let mut can_fwd = Default::default();
        core.CanGoForward(&mut can_fwd).ok();
        LiveProps {
            url,
            title,
            favicon: None,
            loading: cells.0.get(),
            progress: cells.1.get(),
            can_go_back: can_back.as_bool(),
            can_go_forward: can_fwd.as_bool(),
        }
    }
}

fn emit_state(app: &AppHandle, id: &str, host_label: &str, core: &ICoreWebView2, cells: &Cells) {
    let sticky = crate::browser::sticky_for(app, id);
    let Some(sticky) = sticky else { return };
    let live = live_props(core, cells);
    let payload = state::merge(id, live, &sticky);
    crate::browser::cache_last_state(app, id, &payload);
    let host_label =
        crate::browser::window_label_for(app, id).unwrap_or_else(|| host_label.to_string());
    if let Err(err) = app.emit_to(
        EventTarget::AnyLabel { label: host_label },
        state::STATE_EVENT,
        payload,
    ) {
        eprintln!(
            "browser: could not emit {} for {id:?}: {err}",
            state::STATE_EVENT
        );
    }
}

fn update_and_emit(
    app: &AppHandle,
    id: &str,
    host_label: &str,
    core: &Option<ICoreWebView2>,
    cells: &Cells,
    mutate: impl FnOnce(&mut state::Sticky),
) {
    if crate::browser::update_sticky(app, id, mutate).is_some() {
        if let Some(core) = core {
            emit_state(app, id, host_label, core, cells);
        }
    }
}

pub(crate) fn wire_signals(
    app: &AppHandle,
    id: &str,
    host_label: &str,
    webview: &tauri::webview::Webview,
) -> Result<(), String> {
    let app_owned = app.clone();
    let id_owned = id.to_string();
    let host_owned = host_label.to_string();
    // SAFETY: run_on_view guarantees the main thread; COM calls only.
    run_on_view(webview, id, "wire signals for", move |platform| unsafe {
        let core: ICoreWebView2 = platform
            .controller()
            .CoreWebView2()
            .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
        let cells: Cells = (Rc::new(Cell::new(false)), Rc::new(Cell::new(0.0_f64)));

        macro_rules! wire {
            ($label:literal, $add:ident, $handler:ty, $body:expr) => {{
                let handler = <$handler>::create($body);
                let mut token: i64 = 0;
                // SAFETY: main thread (we are inside with_webview); the
                core.$add(&handler, &mut token)
                    .map_err(|err| format!("browser: {} on child {:?}: {err}", $label, id_owned))?;
            }};
        }

        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_NavigationStarting",
                add_NavigationStarting,
                NavigationStartingEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, _args| {
                    cells.1.set(0.02);
                    cells.0.set(true);
                    update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |s| s.load_started());
                    Ok(())
                })
            );
        }

        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_ContentLoading",
                add_ContentLoading,
                ContentLoadingEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, _args| {
                    cells.1.set(0.7);
                    update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |_| {});
                    Ok(())
                })
            );
        }

        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!("add_NavigationCompleted", add_NavigationCompleted,
                NavigationCompletedEventHandler,
                Box::new(move |core: Option<ICoreWebView2>,
                               args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
                    cells.0.set(false);
                    cells.1.set(1.0);
                    if let Some(args) = args.as_ref() {
                        let mut success = Default::default();
                        args.IsSuccess(&mut success).ok();
                        if success.as_bool() {
                            update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |s| {
                                s.load_committed()
                            });
                        } else {
                            let mut status = Default::default();
                            args.WebErrorStatus(&mut status).ok();
                            if status.0 == COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED.0 {
                                eprintln!(
                                    "browser: child {id_h:?} navigation aborted (superseded or \
                                     cancelled load); not reporting it as a failure"
                                );
                                update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |_| {});
                                return Ok(());
                            }
                            let text = web_error_status_text(status.0);
                            let failing: Option<String> = core.as_ref().map(|c| {
                                let mut fail_url = PWSTR(std::ptr::null_mut());
                                if c.Source(&mut fail_url).is_ok() {
                                    webview2_com::take_pwstr(fail_url)
                                } else {
                                    String::new()
                                }
                            });
                            let shown = failing.as_deref().unwrap_or("<unknown url>");
                            eprintln!("browser: child {id_h:?} navigation failed: {text} ({shown})");
                            update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |s| {
                                s.error = Some(BrowserError::load(shown, text));
                            });
                        }
                    }
                    Ok(())
                }));
        }

        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_SourceChanged",
                add_SourceChanged,
                SourceChangedEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, _args| {
                    update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |_| {});
                    Ok(())
                })
            );
        }
        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_HistoryChanged",
                add_HistoryChanged,
                HistoryChangedEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, _args| {
                    if let Some(core) = &core {
                        emit_state(&app_h, &id_h, &host_h, core, &cells);
                    }
                    Ok(())
                })
            );
        }
        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_DocumentTitleChanged",
                add_DocumentTitleChanged,
                DocumentTitleChangedEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, _args| {
                    if let Some(core) = &core {
                        emit_state(&app_h, &id_h, &host_h, core, &cells);
                    }
                    Ok(())
                })
            );
        }

        {
            let (app_h, id_h, host_h, cells) = (
                app_owned.clone(),
                id_owned.clone(),
                host_owned.clone(),
                cells.clone(),
            );
            wire!(
                "add_ProcessFailed",
                add_ProcessFailed,
                ProcessFailedEventHandler,
                Box::new(move |core: Option<ICoreWebView2>, args| {
                    let kind = args
                        .as_ref()
                        .map(|a| {
                            let mut kind = Default::default();
                            if a.ProcessFailedKind(&mut kind).is_ok() {
                                kind.0
                            } else {
                                -1
                            }
                        })
                        .unwrap_or(-1);
                    let reason = format!("process failed (kind {kind})");
                    update_and_emit(&app_h, &id_h, &host_h, &core, &cells, |s| {
                        s.mount_failed = true;
                        s.error = Some(BrowserError::web_process_terminated(&reason));
                    });
                    Ok(())
                })
            );
        }

        {
            let (app_h, id_h) = (app_owned.clone(), id_owned.clone());
            wire!("add_NewWindowRequested", add_NewWindowRequested,
                NewWindowRequestedEventHandler,
                Box::new(move |_core: Option<ICoreWebView2>,
                               args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        let mut url_pwstr = PWSTR(std::ptr::null_mut());
                        let url = if args.Uri(&mut url_pwstr).is_ok() {
                            webview2_com::take_pwstr(url_pwstr)
                        } else {
                            String::new()
                        };
                        args.SetHandled(true).ok();
                        if let Err(err) = app_h.emit_to(
                            EventTarget::AnyLabel {
                                label: crate::browser::popup_event_target().to_string(),
                            },
                            OPEN_URL_EVENT,
                            serde_json::json!({ "id": &id_h, "url": url }),
                        ) {
                            eprintln!(
                                "browser: could not emit {OPEN_URL_EVENT} for {id_h:?}: {err}"
                            );
                        }
                    }
                    Ok(())
                }));
        }

        {
            // Page clicks must select the pane, as they do on Linux: a child
            // HWND's clicks never reach the host page's DOM listeners. No JS
            // forwarder is needed -- the child controller owns its focus.
            let (app_h, id_h, host_h) = (app_owned.clone(), id_owned.clone(), host_owned.clone());
            let handler = FocusChangedEventHandler::create(Box::new(
                move |_controller: Option<ICoreWebView2Controller>, _args: Option<IUnknown>| {
                    let host_label = crate::browser::window_label_for(&app_h, &id_h)
                        .unwrap_or_else(|| host_h.clone());
                    if let Err(err) = app_h.emit_to(
                        EventTarget::AnyLabel { label: host_label },
                        FOCUS_EVENT,
                        serde_json::json!({ "id": &id_h }),
                    ) {
                        eprintln!("browser: could not emit {FOCUS_EVENT} for {id_h:?}: {err}");
                    }
                    Ok(())
                },
            ));
            let mut token: i64 = 0;
            platform
                .controller()
                .add_GotFocus(&handler, &mut token)
                .map_err(|err| format!("browser: add_GotFocus on child {id_owned:?}: {err}"))?;
        }

        {
            wire!("add_PermissionRequested", add_PermissionRequested,
                PermissionRequestedEventHandler,
                Box::new(move |_core: Option<ICoreWebView2>,
                               args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY).ok();
                    }
                    Ok(())
                }));
        }

        {
            let download_core = core.cast::<ICoreWebView2_4>().map_err(|_| {
                "browser: this WebView2 runtime lacks ICoreWebView2_4; downloads cannot be \
                 suppressed"
                    .to_string()
            })?;
            use webview2_com::DownloadStartingEventHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs;
            let handler = DownloadStartingEventHandler::create(Box::new(
                move |_core: Option<ICoreWebView2>,
                      args: Option<ICoreWebView2DownloadStartingEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        args.SetHandled(true).ok();
                    }
                    Ok(())
                },
            ));
            let mut token: i64 = 0;
            download_core
                .add_DownloadStarting(&handler, &mut token)
                .map_err(|err| {
                    format!("browser: add_DownloadStarting on child {id_owned:?}: {err}")
                })?;
        }

        Ok(())
    })
}

// Delete-then-freeze: `__TAURI_INTERNALS__`/`ipc` are already non-configurable
// (Tauri/wry defined them with `value`), so `delete` no-ops there and only
// `chrome.webview`, an ordinary property, actually goes — killing postMessage.
pub(crate) const IPC_NEUTER_SCRIPT: &str = r#"(() => {
  const freezeUndef = (name) => {
    try { delete window[name]; } catch (_) {}
    try {
      Object.defineProperty(window, name, {
        value: undefined, writable: false, configurable: false,
      });
    } catch (_) {}
  };
  freezeUndef('__TAURI_INTERNALS__');
  freezeUndef('__TAURI__');
  freezeUndef('ipc');
  try { if (window.chrome) { delete window.chrome.webview; } } catch (_) {}
  freezeUndef('chrome');
})();"#;

// Names survivors instead of returning a bare bool: "still reachable" alone
// isn't actionable, and any non-"true" result (including a thrown
// expression) already marks the pane errored, so naming costs no strictness.
pub(crate) const IPC_VERIFY_EXPRESSION: &str = "(() => { const live = []; \
const bridge = typeof window.chrome !== 'undefined' \
&& typeof window.chrome.webview !== 'undefined'; \
if (bridge) live.push('window.chrome.webview'); \
if (bridge && typeof window.ipc !== 'undefined') live.push('window.ipc'); \
return live.length === 0 ? 'true' : live.join(','); })()";

#[cfg(windows)]
pub(crate) mod imp {
    use std::sync::mpsc::channel;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use webview2_com::{
        AddScriptToExecuteOnDocumentCreatedCompletedHandler, CapturePreviewCompletedHandler,
        ExecuteScriptCompletedHandler, NavigationCompletedEventHandler,
    };
    use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
    use windows::Win32::System::Com::IStream;
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, GetHGlobalFromStream,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_core::{Interface, HSTRING};

    use super::{IPC_NEUTER_SCRIPT, IPC_VERIFY_EXPRESSION};
    use crate::browser::webkit::Capture;
    use crate::browser::webview2_host::run_on_view;
    use tauri::{AppHandle, Manager};

    pub(crate) fn navigate(
        webview: &tauri::webview::Webview,
        id: &str,
        url: &str,
    ) -> Result<(), String> {
        if !crate::browser::webkit::url_scheme_is_allowed(url) {
            return Err(format!(
                "browser: refusing to navigate id {id:?} to the {:?} scheme (url {url:?}); \
                 browser panes may only load {}",
                crate::browser::webkit::scheme_of(url),
                crate::browser::webkit::ALLOWED_CHILD_SCHEMES.join(", ")
            ));
        }
        let url_owned = HSTRING::from(url);
        // SAFETY: run_on_view guarantees this closure runs on the main
        // thread, the only one allowed to touch this COM object graph.
        run_on_view(webview, id, "navigate", move |platform| unsafe {
            let core: ICoreWebView2 = platform
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
            core.Navigate(&url_owned)
                .map_err(|err| format!("browser: Navigate({url_owned:?}): {err}"))
        })
    }

    pub(crate) fn reload(
        webview: &tauri::webview::Webview,
        id: &str,
        bypass_cache: bool,
    ) -> Result<(), String> {
        if bypass_cache {
            return Err(
                "browser: bypass-cache reload has no equivalent in these WebView2 bindings; \
                 refusing rather than silently doing a cached reload"
                    .to_string(),
            );
        }
        // SAFETY: run_on_view guarantees the main thread; COM call only.
        run_on_view(webview, id, "reload", move |platform| unsafe {
            let core: ICoreWebView2 = platform
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
            core.Reload()
                .map_err(|err| format!("browser: Reload(): {err}"))
        })
    }

    pub(crate) fn go_back(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        // SAFETY: run_on_view guarantees the main thread; COM calls only.
        run_on_view(webview, id, "go_back", move |platform| unsafe {
            let core: ICoreWebView2 = platform
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
            let mut can = Default::default();
            core.CanGoBack(&mut can)
                .map_err(|err| format!("browser: CanGoBack(): {err}"))?;
            if !can.as_bool() {
                return Err(
                    "browser: child has no back history entry (canGoBack=false); refusing to \
                     go back"
                        .to_string(),
                );
            }
            core.GoBack()
                .map_err(|err| format!("browser: GoBack(): {err}"))
        })
    }

    pub(crate) fn go_forward(webview: &tauri::webview::Webview, id: &str) -> Result<(), String> {
        // SAFETY: run_on_view guarantees the main thread; COM calls only.
        run_on_view(webview, id, "go_forward", move |platform| unsafe {
            let core: ICoreWebView2 = platform
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
            let mut can = Default::default();
            core.CanGoForward(&mut can)
                .map_err(|err| format!("browser: CanGoForward(): {err}"))?;
            if !can.as_bool() {
                return Err(
                    "browser: child has no forward history entry (canGoForward=false); \
                     refusing to go forward"
                        .to_string(),
                );
            }
            core.GoForward()
                .map_err(|err| format!("browser: GoForward(): {err}"))
        })
    }

    pub(crate) fn sever_ipc_transport(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        let app_owned = webview.app_handle().clone();
        let id_owned = id.to_string();
        run_on_view(
            webview,
            id,
            "sever the IPC transport of",
            // SAFETY: run_on_view guarantees the main thread; COM calls only.
            move |platform| unsafe {
                let core: ICoreWebView2 = platform
                    .controller()
                    .CoreWebView2()
                    .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;

                core.Settings()
                    .and_then(|s| s.SetAreDevToolsEnabled(false))
                    .map_err(|err| format!("browser: disabling child DevTools: {err}"))?;

                core.Settings()
                    .and_then(|s| s.SetIsWebMessageEnabled(false))
                    .map_err(|err| {
                        format!("browser: disabling child web messages (the IPC transport): {err}")
                    })?;

                let neuter = HSTRING::from(IPC_NEUTER_SCRIPT);
                core.AddScriptToExecuteOnDocumentCreated(
                    &neuter,
                    &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
                        |_, _| Ok(()),
                    )),
                )
                .map_err(|err| format!("browser: installing the IPC neuter script: {err}"))?;

                let now = HSTRING::from(IPC_NEUTER_SCRIPT);
                core.ExecuteScript(
                    &now,
                    &ExecuteScriptCompletedHandler::create(Box::new(move |_, _| Ok(()))),
                )
                .map_err(|err| {
                    format!("browser: applying the IPC neuter to the live document: {err}")
                })?;

                let handler = NavigationCompletedEventHandler::create(Box::new(
                    move |core: Option<ICoreWebView2>, _args| {
                        let Some(core) = core else { return Ok(()) };
                        let check = HSTRING::from(IPC_VERIFY_EXPRESSION);
                        let app_v = app_owned.clone();
                        let id_v = id_owned.clone();
                        core.ExecuteScript(
                            &check,
                            &ExecuteScriptCompletedHandler::create(Box::new(
                                move |error_code, result: String| {
                                    if error_code.is_ok() && result.trim_matches('"') != "true" {
                                        eprintln!(
                                            "browser: SECURITY child {id_v:?} still has an \
                                         IPC transport after severing (verdict {result:?}); \
                                         marking the pane errored"
                                        );
                                        crate::browser::update_sticky(&app_v, &id_v, |s| {
                                            s.error =
                                                Some(crate::browser::state::BrowserError::load(
                                                    "",
                                                    format!(
                                                        "IPC transport survived severing (page \
                                                     verdict {result})"
                                                    ),
                                                ));
                                        });
                                    }
                                    Ok(())
                                },
                            )),
                        )?;
                        Ok(())
                    },
                ));
                let mut token = 0_i64;
                core.add_NavigationCompleted(&handler, &mut token)
                    .map_err(|err| format!("browser: installing the sever verifier: {err}"))?;
                Ok(())
            },
        )
    }

    pub(crate) fn enable_console_logging_if_asked(
        _webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        if std::env::var("HOUSTON_BROWSER_CONSOLE").as_deref() == Ok("1") {
            eprintln!(
                "browser: HOUSTON_BROWSER_CONSOLE=1 requested but console capture has \
                 no WebView2 equivalent in these bindings; child {id:?} runs unlogged"
            );
        }
        Ok(())
    }

    pub(crate) async fn capture_rgba(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<Capture, String> {
        let (tx, rx) = channel::<Result<Vec<u8>, String>>();
        let id_owned = id.to_string();
        // SAFETY: run_on_view guarantees the main thread; COM calls only.
        run_on_view(webview, id, "capture", move |platform| unsafe {
            let core: ICoreWebView2 = platform
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("browser: CoreWebView2(): {err}"))?;
            let core_2: ICoreWebView2_2 = core.cast().map_err(|err| {
                format!("browser: this WebView2 runtime lacks ICoreWebView2_2: {err}")
            })?;
            let capture_stream_handle = capture_stream()?;
            let done_stream = capture_stream_handle.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |error_code| {
                if let Err(code) = error_code {
                    let _ = tx.send(Err(format!("capture failed: {code}")));
                    return Ok(());
                }
                let _ = tx.send(read_stream_bytes(&done_stream));
                Ok(())
            }));
            core_2
                .CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &capture_stream_handle,
                    &handler,
                )
                .map_err(|err| format!("browser: starting the capture of {id_owned:?}: {err}"))
        })?;

        let bytes = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(10))
        })
        .await
        .map_err(|err| format!("browser: capture waiter panicked: {err:?}"))?
        .map_err(|err| format!("browser: capture of child {id:?} timed out: {err}"))?
        .map_err(|err| format!("browser: capturing child {id:?}: {err}"))?;
        decode_png_rgba(&bytes)
    }

    fn decode_png_rgba(png_bytes: &[u8]) -> Result<Capture, String> {
        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut reader = decoder
            .read_info()
            .map_err(|err| format!("browser: capture PNG header: {err}"))?;
        let mut buf = vec![0_u8; reader.output_buffer_size()];
        let info = reader
            .next_frame(&mut buf)
            .map_err(|err| format!("browser: capture PNG frame: {err}"))?;
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => {
                let mut out = Vec::with_capacity(info.width as usize * info.height as usize * 4);
                for px in buf[..info.buffer_size()].as_chunks::<3>().0 {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
                out
            }
            other => {
                return Err(format!(
                    "browser: capture decoded as {other:?}; expected RGBA or RGB"
                ));
            }
        };
        Ok(Capture {
            width: info.width,
            height: info.height,
            rgba,
        })
    }

    unsafe fn capture_stream() -> Result<IStream, String> {
        // SAFETY: no source HGLOBAL; delete-on-release keeps ownership
        CreateStreamOnHGlobal(HGLOBAL::default(), true)
            .map_err(|err| format!("browser: CreateStreamOnHGlobal: {err}"))
    }

    // SAFETY: `hglobal` comes from the stream we just created and locked;
    // `size` is its own reported length, so the slice never overruns it.
    unsafe fn read_stream_bytes(stream: &IStream) -> Result<Vec<u8>, String> {
        let hglobal = GetHGlobalFromStream(stream)
            .map_err(|err| format!("browser: GetHGlobalFromStream: {err}"))?;
        let size = GlobalSize(hglobal);
        if size == 0 {
            return Err("browser: captured PNG is empty".to_string());
        }
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return Err("browser: GlobalLock on the captured PNG failed".to_string());
        }
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), size).to_vec();
        GlobalUnlock(hglobal).ok();
        GlobalFree(Some(hglobal)).ok();
        Ok(bytes)
    }

    const NO_ISOLATED_WORLDS: &str =
        "browser: the element picker needs an isolated script world; these WebView2 bindings \
         expose none, and shipping the picker in the shared main world would hand the page \
         the per-enable token (D22's defect class). Unsupported on this engine yet";

    pub(crate) fn enable_picker(
        _app: &AppHandle,
        _webview: &tauri::webview::Webview,
        _id: &str,
        _host_label: &str,
        _source: &str,
    ) -> Result<(), String> {
        Err(NO_ISOLATED_WORLDS.to_string())
    }

    pub(crate) fn disable_picker(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        let _ = (webview, id);
        Err(NO_ISOLATED_WORLDS.to_string())
    }

    pub(crate) fn clear_picker_selection(
        webview: &tauri::webview::Webview,
        id: &str,
    ) -> Result<(), String> {
        let _ = (webview, id);
        Err(NO_ISOLATED_WORLDS.to_string())
    }

    pub(crate) fn submit_picker_prompt(
        webview: &tauri::webview::Webview,
        id: &str,
        _user_prompt: &str,
        _agent_id: &str,
    ) -> Result<(), String> {
        let _ = (webview, id);
        Err(NO_ISOLATED_WORLDS.to_string())
    }

    pub(crate) fn picker_defence_is_armed(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<bool, String> {
        Ok(false)
    }

    pub(crate) fn forget_picker_state(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    pub(crate) async fn eval_tools(
        _webview: &tauri::webview::Webview,
        _id: &str,
        _op: &str,
    ) -> Result<String, String> {
        Err(
            "browser: the page toolkit needs an isolated script world; these WebView2 bindings \
             expose none. Unsupported on this engine yet"
                .to_string(),
        )
    }

    pub(crate) fn allow_automatic_popups_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(
            "browser: not applicable — popups are governed by NewWindowRequested, wired for \
             every child at mount"
                .to_string(),
        )
    }

    pub(crate) fn terminate_web_process_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err("browser: no TerminateProcess-equivalent exists in these WebView2 bindings".to_string())
    }

    pub(crate) fn dispatch_mousedown_for_selftest(
        _webview: &tauri::webview::Webview,
        _id: &str,
    ) -> Result<(), String> {
        Err(
            "browser: no synthesized-input equivalent exists in these WebView2 bindings"
                .to_string(),
        )
    }
}

#[cfg(all(windows, test))]
mod tests {
    use super::{IPC_NEUTER_SCRIPT, IPC_VERIFY_EXPRESSION};
    use crate::browser::webview2_engine::web_error_status_text;

    #[test]
    fn the_neuter_script_pins_every_transport_surface_unwritable() {
        for surface in ["__TAURI_INTERNALS__", "__TAURI__", "ipc", "chrome"] {
            assert!(
                IPC_NEUTER_SCRIPT.contains(&format!("freezeUndef('{surface}')")),
                "the neuter never mentions {surface:?}"
            );
        }
        assert!(
            IPC_NEUTER_SCRIPT.contains("configurable: false"),
            "the neuter leaves frozen properties configurable"
        );
        assert!(
            IPC_NEUTER_SCRIPT.contains("delete window.chrome.webview"),
            "the native chrome.webview bridge survives the neuter"
        );
    }

    #[test]
    fn the_verify_expression_covers_every_surface_the_neuter_kills() {
        for surface in ["window.chrome", "window.ipc"] {
            assert!(
                IPC_VERIFY_EXPRESSION.contains(surface),
                "the verifier never checks {surface:?}"
            );
        }
        assert!(
            IPC_VERIFY_EXPRESSION.contains("typeof window.chrome.webview !== 'undefined'"),
            "the verifier does not check the native bridge itself"
        );
    }

    #[test]
    fn a_browser_childs_label_reads_as_content_only() {
        use crate::browser::id::{derive_label, is_content_only_label};
        assert!(is_content_only_label(&derive_label("grid-leaf-3")));
        assert!(!is_content_only_label("main"));
    }

    #[test]
    fn the_neuter_script_is_structurally_balanced() {
        for (open, close) in [('{', '}'), ('(', ')')] {
            assert_eq!(
                IPC_NEUTER_SCRIPT.matches(open).count(),
                IPC_NEUTER_SCRIPT.matches(close).count(),
                "the neuter's {open}/{close} do not balance"
            );
        }
        assert_eq!(
            IPC_NEUTER_SCRIPT.matches("try {").count(),
            IPC_NEUTER_SCRIPT.matches("catch (_) {}").count(),
            "every try in the neuter must have its own catch"
        );
    }

    #[test]
    fn the_verify_expression_names_the_surfaces_that_survive() {
        assert!(
            IPC_VERIFY_EXPRESSION.contains("live.push('window.chrome.webview')")
                && IPC_VERIFY_EXPRESSION.contains("live.push('window.ipc')"),
            "the verifier does not report survivors by name"
        );
        assert!(
            IPC_VERIFY_EXPRESSION.contains("live.length === 0 ? 'true' : live.join(',')"),
            "the verifier's all-clear is not the literal the caller checks for"
        );
    }

    #[test]
    fn web_error_status_text_names_known_statuses_and_numbers_unknowns() {
        assert_eq!(web_error_status_text(12), "cannot connect");
        assert_eq!(web_error_status_text(9), "connection aborted");
        assert_eq!(web_error_status_text(10), "connection reset");
        assert_eq!(web_error_status_text(5), "web error status 5");
        assert_eq!(web_error_status_text(999_999), "web error status 999999");
    }
}

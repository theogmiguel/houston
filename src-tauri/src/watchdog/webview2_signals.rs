use super::ingress::EventSender;
use super::machine::Event;
#[cfg(windows)]
use super::machine::TerminationReason;
use super::RendererHealth;
use std::sync::Arc;
use tauri::webview::PlatformWebview;

#[cfg(windows)]
pub(super) fn install(platform: &PlatformWebview, tx: EventSender) {
    let outcome = install_with(platform, move |_kind, event| {
        if let Some(event) = event {
            let _ = tx.send(event);
        }
    });
    if let Err(err) = outcome {
        eprintln!(
            "houston-tauri: watchdog could not reach the WebView2 process-failed event: \
             {err:#}"
        );
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub(super) fn install(_platform: &PlatformWebview, _tx: EventSender) {}

#[cfg(windows)]
pub fn install_termination_logger(platform: &PlatformWebview, health: Arc<RendererHealth>) {
    let outcome = install_with(platform, move |kind, event| {
        if matches!(event, Some(Event::WebProcessTerminated { .. })) {
            health.record_termination();
        }
        eprintln!(
            "houston-tauri: WebView2 process failed (kind {}, event {event:?})",
            kind.0
        );
    });
    if let Err(err) = outcome {
        eprintln!("houston-tauri: renderer-crash logging not installed: {err:#}");
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn install_termination_logger(_platform: &PlatformWebview, _health: Arc<RendererHealth>) {}

#[cfg(windows)]
pub fn poll(_platform: &PlatformWebview) -> Vec<Event> {
    Vec::new()
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn poll(_platform: &PlatformWebview) -> Vec<Event> {
    Vec::new()
}

#[cfg(windows)]
fn map_event(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> Option<Event> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
        | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
            Some(Event::WebProcessTerminated {
                reason: TerminationReason::Crashed,
            })
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            Some(Event::ResponsivenessChanged { responsive: false })
        }
        _ => None,
    }
}

#[cfg(windows)]
fn install_with<F>(platform: &PlatformWebview, mut on_failed: F) -> windows_core::Result<()>
where
    F: FnMut(
            webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
            Option<Event>,
        ) + Send
        + 'static,
{
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ProcessFailedEventArgs,
    };
    use webview2_com::ProcessFailedEventHandler;

    // SAFETY: called from `with_webview`, which runs us on the main thread —
    // the only thread allowed to touch the controller's COM object graph.
    unsafe {
        let core: ICoreWebView2 = platform.controller().CoreWebView2()?;

        let handler = ProcessFailedEventHandler::create(Box::new(
            move |_sender, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let mut kind = Default::default();
                    if args.ProcessFailedKind(&mut kind).is_ok() {
                        on_failed(kind, map_event(kind));
                    }
                }
                Ok(())
            },
        ));
        let mut token: i64 = 0;
        core.add_ProcessFailed(&handler, &mut token)?;
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn only_main_process_exits_are_reported_as_gone() {
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        ] {
            assert!(matches!(
                map_event(kind),
                Some(Event::WebProcessTerminated { .. })
            ));
        }
        assert_eq!(
            map_event(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE),
            Some(Event::ResponsivenessChanged { responsive: false })
        );
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
        ] {
            assert_eq!(map_event(kind), None);
        }
    }
}

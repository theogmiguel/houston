use super::machine::Event;
#[cfg(windows)]
use super::machine::TerminationReason;
use std::sync::mpsc::Sender;
use tauri::webview::PlatformWebview;

#[cfg(windows)]
pub fn install(platform: &PlatformWebview, tx: Sender<Event>) {
    let outcome = install_with(platform, move |reason| {
        let _ = tx.send(Event::WebProcessTerminated { reason });
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
pub fn install(_platform: &PlatformWebview, _tx: Sender<Event>) {}

#[cfg(windows)]
pub fn install_termination_logger(platform: &PlatformWebview) {
    let outcome = install_with(platform, |reason| {
        eprintln!(
            "houston-tauri: webview process failed ({})",
            reason.as_str()
        );
    });
    if let Err(err) = outcome {
        eprintln!("houston-tauri: renderer-crash logging not installed: {err:#}");
    }
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn install_termination_logger(_platform: &PlatformWebview) {}

#[cfg(windows)]
pub fn poll(_platform: &PlatformWebview) -> Vec<Event> {
    Vec::new()
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn poll(_platform: &PlatformWebview) -> Vec<Event> {
    Vec::new()
}

// The pinned webview2-com-sys SDK only declares the exit-shaped kinds; every
// kind it can deliver here reads as a crash to the recovery ladder, which is
// the correct conservative mapping until the SDK exposes finer ones.
#[cfg(windows)]
fn map_reason(
    _kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> TerminationReason {
    TerminationReason::Crashed
}

#[cfg(windows)]
fn install_with<F>(platform: &PlatformWebview, mut on_failed: F) -> windows_core::Result<()>
where
    F: FnMut(TerminationReason) + Send + 'static,
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
                        on_failed(map_reason(kind));
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

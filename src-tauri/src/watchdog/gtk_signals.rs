use std::sync::mpsc::Sender;

use tauri::webview::PlatformWebview;

#[cfg(target_os = "linux")]
use webkit2gtk::{WebInspectorExt, WebProcessTerminationReason, WebViewExt};

use super::machine::{Event, TerminationReason};

#[cfg(target_os = "linux")]
fn map_reason(reason: WebProcessTerminationReason) -> TerminationReason {
    match reason {
        WebProcessTerminationReason::ExceededMemoryLimit => TerminationReason::ExceededMemoryLimit,
        WebProcessTerminationReason::TerminatedByApi => TerminationReason::TerminatedByApi,
        _ => TerminationReason::Crashed,
    }
}

pub fn termination_log_line(reason: TerminationReason) -> String {
    match reason {
        TerminationReason::TerminatedByApi => {
            "houston-tauri: renderer process gone: TerminatedByApi \
             (deliberate — the watchdog's recovery terminated it; not a crash)"
                .to_string()
        }
        other => format!("houston-tauri: renderer process gone: {other:?}"),
    }
}

#[cfg(target_os = "linux")]
pub fn install_termination_logger(platform: &PlatformWebview) {
    platform
        .inner()
        .connect_web_process_terminated(move |_, reason| {
            eprintln!("{}", termination_log_line(map_reason(reason)));
        });
}

#[cfg(not(target_os = "linux"))]
pub fn install_termination_logger(_platform: &PlatformWebview) {}

#[cfg(target_os = "linux")]
pub fn install(platform: &PlatformWebview, tx: Sender<Event>) {
    let webview = platform.inner();

    let terminated_tx = tx.clone();
    webview.connect_web_process_terminated(move |_, reason| {
        let _ = terminated_tx.send(Event::WebProcessTerminated {
            reason: map_reason(reason),
        });
    });

    let responsive_tx = tx;
    webview.connect_is_web_process_responsive_notify(move |view| {
        let _ = responsive_tx.send(Event::ResponsivenessChanged {
            responsive: view.is_web_process_responsive(),
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn install(_platform: &PlatformWebview, _tx: Sender<Event>) {}

#[cfg(target_os = "linux")]
pub fn poll(platform: &PlatformWebview) -> Vec<Event> {
    let webview = platform.inner();
    vec![
        Event::ResponsivenessChanged {
            responsive: webview.is_web_process_responsive(),
        },
        Event::InspectorAttached(
            webview
                .inspector()
                .map(|inspector| inspector.is_attached())
                .unwrap_or(false),
        ),
    ]
}

#[cfg(not(target_os = "linux"))]
pub fn poll(_platform: &PlatformWebview) -> Vec<Event> {
    Vec::new()
}

#[cfg(target_os = "linux")]
pub fn terminate_web_process(platform: &PlatformWebview) {
    platform.inner().terminate_web_process();
}

#[cfg(not(target_os = "linux"))]
pub fn terminate_web_process(_platform: &PlatformWebview) {}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn known_reasons_map_one_to_one() {
        assert_eq!(
            map_reason(WebProcessTerminationReason::Crashed),
            TerminationReason::Crashed
        );
        assert_eq!(
            map_reason(WebProcessTerminationReason::ExceededMemoryLimit),
            TerminationReason::ExceededMemoryLimit
        );
        assert_eq!(
            map_reason(WebProcessTerminationReason::TerminatedByApi),
            TerminationReason::TerminatedByApi
        );
    }

    #[test]
    fn an_unknown_reason_is_treated_as_a_crash() {
        assert_eq!(
            map_reason(WebProcessTerminationReason::__Unknown(99)),
            TerminationReason::Crashed
        );
    }

    #[test]
    fn termination_log_line_names_the_reason_and_keeps_electrons_wording() {
        let crashed = termination_log_line(TerminationReason::Crashed);
        assert!(
            crashed.contains("renderer process gone"),
            "must keep the Electron wording an operator greps for, got {crashed:?}"
        );
        assert!(
            crashed.contains("Crashed"),
            "must name the termination reason, got {crashed:?}"
        );
        let oom = termination_log_line(TerminationReason::ExceededMemoryLimit);
        let by_api = termination_log_line(TerminationReason::TerminatedByApi);
        assert_ne!(crashed, oom);
        assert_ne!(crashed, by_api);
        assert_ne!(oom, by_api);
    }

    #[test]
    fn a_deliberate_termination_says_so_rather_than_reading_as_a_crash() {
        let by_api = termination_log_line(TerminationReason::TerminatedByApi);
        assert!(
            by_api.contains("deliberate") && by_api.contains("not a crash"),
            "our own recovery kill must not read as a crash, got {by_api:?}"
        );
        for reason in [
            TerminationReason::Crashed,
            TerminationReason::ExceededMemoryLimit,
        ] {
            let line = termination_log_line(reason);
            assert!(
                !line.contains("deliberate"),
                "a real termination must not be excused as deliberate, got {line:?}"
            );
        }
    }
}

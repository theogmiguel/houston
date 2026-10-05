use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

pub const EVENT_FOCUS_PANE: &str = "native-notification://focus-pane";

// Keep only recent notifications so ignored desktop notifications cannot grow this map forever.
const NOTIFICATION_TARGET_TTL: Duration = Duration::from_secs(60 * 60);
const NOTIFICATION_TARGET_CAP: usize = 256;

static NOTIFICATION_TARGETS: OnceLock<Mutex<HashMap<u32, (i64, Instant)>>> = OnceLock::new();

fn targets() -> &'static Mutex<HashMap<u32, (i64, Instant)>> {
    NOTIFICATION_TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_target(notification: u32, session: i64) {
    let now = Instant::now();
    let mut targets = targets().lock().expect("notification targets mutex");
    targets.retain(|_, (_, at)| now.duration_since(*at) < NOTIFICATION_TARGET_TTL);
    if targets.len() >= NOTIFICATION_TARGET_CAP {
        if let Some(oldest) = targets
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(id, _)| *id)
        {
            targets.remove(&oldest);
        }
    }
    targets.insert(notification, (session, now));
}

fn take_target(notification: u32) -> Option<i64> {
    targets()
        .lock()
        .expect("notification targets mutex")
        .remove(&notification)
        .and_then(|(session, at)| (at.elapsed() < NOTIFICATION_TARGET_TTL).then_some(session))
}

#[cfg(any(target_os = "linux", test))]
const NOTIFICATION_TITLE_MAX_CHARS: usize = 200;
#[cfg(any(target_os = "linux", test))]
const NOTIFICATION_BODY_MAX_CHARS: usize = 2000;

#[cfg(any(target_os = "linux", test))]
fn notification_text(title: &str, body: &str) -> (String, String) {
    let title = title.chars().take(NOTIFICATION_TITLE_MAX_CHARS).collect();
    let body = body
        .chars()
        .take(NOTIFICATION_BODY_MAX_CHARS)
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    (title, body)
}

#[tauri::command]
pub async fn native_notify(
    _app: AppHandle,
    title: String,
    body: String,
    session_id: i64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (title, body) = notification_text(&title, &body);
        let connection = zbus::Connection::session()
            .await
            .map_err(|e| format!("Linux notification session bus: {e}"))?;
        let proxy = zbus::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await
        .map_err(|e| format!("Linux notification service: {e}"))?;
        let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
        let notification: u32 = proxy
            .call(
                "Notify",
                &(
                    "Houston",
                    0u32,
                    "",
                    title,
                    body,
                    vec!["default", "Open pane"],
                    hints,
                    -1i32,
                ),
            )
            .await
            .map_err(|e| format!("Linux notification delivery: {e}"))?;
        remember_target(notification, session_id);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (_app, title, body, session_id);
        Err(format!(
            "native notifications unsupported on {}; supported platform: Linux",
            std::env::consts::OS
        ))
    }
}

#[tauri::command]
pub async fn native_notifications_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(connection) = zbus::Connection::session().await else {
            return false;
        };
        let Ok(proxy) = zbus::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await
        else {
            return false;
        };
        let Ok(capabilities) = proxy
            .call::<_, _, Vec<String>>("GetCapabilities", &())
            .await
        else {
            return false;
        };
        capabilities
            .iter()
            .any(|capability| capability == "actions")
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn start_action_listener(app: AppHandle) {
    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn(async move {
        use futures_util::StreamExt;

        let connection = match zbus::Connection::session().await {
            Ok(connection) => connection,
            Err(error) => {
                eprintln!("houston-tauri: notification action listener: {error}");
                return;
            }
        };
        let proxy = match zbus::Proxy::new(
            &connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await
        {
            Ok(proxy) => proxy,
            Err(error) => {
                eprintln!("houston-tauri: notification action listener: {error}");
                return;
            }
        };
        let mut actions = match proxy.receive_signal("ActionInvoked").await {
            Ok(actions) => actions,
            Err(error) => {
                eprintln!("houston-tauri: notification action listener: {error}");
                return;
            }
        };
        while let Some(message) = actions.next().await {
            let Ok((notification, _action)) = message.body().deserialize::<(u32, String)>() else {
                continue;
            };
            let Some(session) = take_target(notification) else {
                continue;
            };
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.unminimize().and_then(|()| window.set_focus()) {
                    eprintln!("houston-tauri: could not focus notification target: {error}");
                }
            }
            if let Err(error) = app.emit(EVENT_FOCUS_PANE, session) {
                eprintln!("houston-tauri: could not emit notification pane action: {error}");
            }
        }
    });
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_markup_is_escaped() {
        let (_, body) = notification_text("title", "<&>你好");
        assert_eq!(body, "&lt;&amp;&gt;你好");
    }

    #[test]
    fn notification_unicode_text_is_bounded() {
        let (title, _) = notification_text(&"é".repeat(201), "body");
        assert_eq!(title.chars().count(), NOTIFICATION_TITLE_MAX_CHARS);
        let (_, body) = notification_text("title", &"<".repeat(2001));
        assert_eq!(body, "&lt;".repeat(NOTIFICATION_BODY_MAX_CHARS));
    }

    #[test]
    fn action_target_is_consumed_once() {
        remember_target(42, 7);
        assert_eq!(take_target(42), Some(7));
        assert_eq!(take_target(42), None);
    }
}

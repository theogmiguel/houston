use tauri::AppHandle;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::{Emitter, Manager};

#[cfg(any(target_os = "linux", target_os = "windows"))]
use targets::{remember_target, take_target};

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub const EVENT_FOCUS_PANE: &str = "native-notification://focus-pane";

// Clicking a desktop notification must reach the pane it announced; both platforms
// hand back a per-notification id that maps to a session here.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
mod targets {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    // Keep only recent notifications so ignored desktop notifications cannot grow this map forever.
    const NOTIFICATION_TARGET_TTL: Duration = Duration::from_secs(60 * 60);
    const NOTIFICATION_TARGET_CAP: usize = 256;

    static NOTIFICATION_TARGETS: OnceLock<Mutex<HashMap<u32, (i64, Instant)>>> = OnceLock::new();

    fn targets() -> &'static Mutex<HashMap<u32, (i64, Instant)>> {
        NOTIFICATION_TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn remember_target(notification: u32, session: i64) {
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

    pub(super) fn take_target(notification: u32) -> Option<i64> {
        targets()
            .lock()
            .expect("notification targets mutex")
            .remove(&notification)
            .and_then(|(session, at)| (at.elapsed() < NOTIFICATION_TARGET_TTL).then_some(session))
    }
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
const NOTIFICATION_TITLE_MAX_CHARS: usize = 200;
#[cfg(any(target_os = "linux", target_os = "windows", test))]
const NOTIFICATION_BODY_MAX_CHARS: usize = 2000;

#[cfg(any(target_os = "linux", target_os = "windows", test))]
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

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn focus_notification_target(app: &AppHandle, notification: u32) {
    let Some(session) = take_target(notification) else {
        return;
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
        let hints: std::collections::HashMap<&str, zbus::zvariant::Value<'_>> =
            std::collections::HashMap::new();
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
    #[cfg(windows)]
    {
        windows_toasts::show(&_app, &title, &body, session_id)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (_app, title, body, session_id);
        Err(format!(
            "native notifications unsupported on {}; supported platforms: Linux, Windows",
            std::env::consts::OS
        ))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeNotificationSupport {
    supported: bool,
    reason: Option<String>,
}

#[tauri::command]
pub async fn native_notifications_supported(app: AppHandle) -> NativeNotificationSupport {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        NativeNotificationSupport {
            supported: linux_notifications_supported().await,
            reason: None,
        }
    }
    #[cfg(windows)]
    {
        let reason = windows_toasts::enabled_notifier(&app).err();
        NativeNotificationSupport {
            supported: reason.is_none(),
            reason,
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        NativeNotificationSupport {
            supported: false,
            reason: Some(format!(
                "native notifications unsupported on {}; supported platforms: Linux, Windows",
                std::env::consts::OS
            )),
        }
    }
}

#[cfg(target_os = "linux")]
async fn linux_notifications_supported() -> bool {
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

// Windows shows toasts under the AppUserModelID the NSIS installer writes as
// System.AppUserModel.ID on its Start Menu shortcut: the bundle identifier. Without
// that shortcut (Houston not installed) there is no identity, so support is refused.
#[cfg(windows)]
mod windows_toasts {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    use tauri::AppHandle;
    use windows::core::{Ref, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationSetting, ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs,
        ToastNotification, ToastNotificationManager, ToastNotifier,
    };
    use windows_sys::core::PWSTR;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_CommonPrograms, FOLDERID_Programs, SHGetKnownFolderPath,
    };

    use super::{focus_notification_target, notification_text, remember_target, take_target};

    // Windows caps tag and group at 64 characters and drops longer ones.
    pub(super) const TOAST_TAG_MAX_CHARS: usize = 64;
    const TOAST_GROUP: &str = "houston";
    // One live toast per pane (its tag replaces older ones); same bound as the click targets.
    const LIVE_TOAST_CAP: usize = 256;

    // Activated is raised on this toast object, so hold it until it is clicked, closed or
    // replaced; a toast that timed out into Action Center can still be clicked.
    static LIVE_TOASTS: OnceLock<Mutex<HashMap<i64, (u32, ToastNotification)>>> = OnceLock::new();

    fn live_toasts() -> &'static Mutex<HashMap<i64, (u32, ToastNotification)>> {
        LIVE_TOASTS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn keep_toast(session_id: i64, notification_id: u32, toast: ToastNotification) {
        let mut toasts = live_toasts().lock().expect("live toasts mutex");
        if toasts.len() >= LIVE_TOAST_CAP && !toasts.contains_key(&session_id) {
            if let Some(oldest) = toasts
                .iter()
                .min_by_key(|(_, (id, _))| *id)
                .map(|(session, _)| *session)
            {
                toasts.remove(&oldest);
            }
        }
        toasts.insert(session_id, (notification_id, toast));
    }

    fn release_toast(session_id: i64, notification_id: u32) {
        let mut toasts = live_toasts().lock().expect("live toasts mutex");
        if toasts
            .get(&session_id)
            .is_some_and(|(held, _)| *held == notification_id)
        {
            toasts.remove(&session_id);
        }
    }

    pub(super) fn toast_tag(session_id: i64) -> String {
        format!("pane-{session_id}")
            .chars()
            .take(TOAST_TAG_MAX_CHARS)
            .collect()
    }

    // XML 1.0 rejects these code points even as entities, so LoadXml would refuse the toast.
    fn strip_xml_invalid(text: &str) -> String {
        text.chars()
            .filter(|c| {
                let c = *c;
                (c >= ' ' || matches!(c, '\t' | '\n' | '\r'))
                    && !matches!(c, '\u{FFFE}' | '\u{FFFF}')
            })
            .collect()
    }

    // notification_text escapes only the body (Linux markup); a toast is XML, so the
    // title needs the same treatment and both lose characters XML cannot carry.
    pub(super) fn toast_xml(title: &str, body: &str) -> String {
        let (title, body) = notification_text(title, body);
        let title = strip_xml_invalid(&title)
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let body = strip_xml_invalid(&body);
        // The renderer owns notification sound, so the toast stays silent.
        format!(
            "<toast><visual><binding template=\"ToastGeneric\"><text>{title}</text>\
             <text>{body}</text></binding></visual><audio silent=\"true\"/></toast>"
        )
    }

    fn start_menu_programs(common: bool) -> Option<PathBuf> {
        let folder = if common {
            FOLDERID_CommonPrograms
        } else {
            FOLDERID_Programs
        };
        let mut path: PWSTR = std::ptr::null_mut();
        // SAFETY: folder points at a static GUID and path receives a CoTaskMem-allocated,
        // NUL-terminated string that is copied below and freed before return.
        let result = unsafe { SHGetKnownFolderPath(&folder, 0, std::ptr::null_mut(), &mut path) };
        if result < 0 || path.is_null() {
            return None;
        }
        let mut len = 0usize;
        while unsafe { *path.add(len) } != 0 {
            len += 1;
        }
        let dir = PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(path, len)
        }));
        unsafe { CoTaskMemFree(path.cast()) };
        Some(dir)
    }

    pub(super) fn app_id_from_shortcuts(
        start_menu_programs_dirs: &[PathBuf],
        shortcut: &str,
        identifier: &str,
    ) -> Result<String, String> {
        if start_menu_programs_dirs
            .iter()
            .any(|dir| dir.join(shortcut).is_file())
        {
            return Ok(identifier.to_string());
        }
        let looked_in = start_menu_programs_dirs
            .iter()
            .map(|dir| dir.join(shortcut).display().to_string())
            .collect::<Vec<_>>()
            .join(" or ");
        Err(format!(
            "no installed app identity: expected the Start Menu shortcut {looked_in} carrying AppUserModelID '{identifier}'; install Houston with its Windows installer"
        ))
    }

    fn installed_app_id(app: &AppHandle) -> Result<String, String> {
        let config = app.config();
        let product = config.product_name.as_deref().ok_or_else(|| {
            "no productName in tauri.conf.json; it names the Start Menu shortcut that carries the notification identity".to_string()
        })?;
        let dirs = [start_menu_programs(false), start_menu_programs(true)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        app_id_from_shortcuts(&dirs, &format!("{product}.lnk"), &config.identifier)
    }

    pub(super) fn enabled_notifier(app: &AppHandle) -> Result<ToastNotifier, String> {
        let app_id = installed_app_id(app)?;
        let notifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id.as_str()))
                .map_err(|e| format!("Windows toast notifier for '{app_id}': {e}"))?;
        let setting = notifier
            .Setting()
            .map_err(|e| format!("Windows notification setting for '{app_id}': {e}"))?;
        if setting == NotificationSetting::Enabled {
            Ok(notifier)
        } else {
            Err(format!(
                "Windows reports notifications for '{app_id}' as {}, expected enabled; allow Houston in Windows Settings ▸ System ▸ Notifications",
                setting_name(setting)
            ))
        }
    }

    pub(super) fn setting_name(setting: NotificationSetting) -> String {
        match setting {
            NotificationSetting::DisabledForApplication => "disabled for this app".to_string(),
            NotificationSetting::DisabledForUser => "disabled for this user".to_string(),
            NotificationSetting::DisabledByGroupPolicy => "disabled by group policy".to_string(),
            NotificationSetting::DisabledByManifest => "disabled by the app manifest".to_string(),
            other => format!("setting {}", other.0),
        }
    }

    fn next_notification_id() -> u32 {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        session_id: i64,
    ) -> Result<(), String> {
        let notifier = enabled_notifier(app)?;
        let xml = XmlDocument::new().map_err(|e| format!("Windows toast XML document: {e}"))?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body)))
            .map_err(|e| format!("Windows toast XML: {e}"))?;
        let toast = ToastNotification::CreateToastNotification(&xml)
            .map_err(|e| format!("Windows toast creation: {e}"))?;
        toast
            .SetTag(&HSTRING::from(toast_tag(session_id)))
            .map_err(|e| format!("Windows toast tag: {e}"))?;
        toast
            .SetGroup(&HSTRING::from(TOAST_GROUP))
            .map_err(|e| format!("Windows toast group: {e}"))?;
        let notification_id = next_notification_id();
        let activation_app = app.clone();
        toast
            .Activated(&TypedEventHandler::new(move |_, _| {
                release_toast(session_id, notification_id);
                focus_notification_target(&activation_app, notification_id);
                Ok(())
            }))
            .map_err(|e| format!("Windows toast activation handler: {e}"))?;
        toast
            .Dismissed(&TypedEventHandler::new(
                move |_, args: Ref<'_, ToastDismissedEventArgs>| {
                    let reason = args.as_ref().and_then(|dismissal| dismissal.Reason().ok());
                    if reason != Some(ToastDismissalReason::TimedOut) {
                        release_toast(session_id, notification_id);
                        take_target(notification_id);
                    }
                    Ok(())
                },
            ))
            .map_err(|e| format!("Windows toast dismissal handler: {e}"))?;
        toast
            .Failed(&TypedEventHandler::new(
                move |_, args: Ref<'_, ToastFailedEventArgs>| {
                    release_toast(session_id, notification_id);
                    take_target(notification_id);
                    let code = args
                        .as_ref()
                        .and_then(|failure| failure.ErrorCode().ok())
                        .map_or(0, |code| code.0);
                    eprintln!(
                        "houston-tauri: Windows toast delivery failed (HRESULT 0x{code:08X})"
                    );
                    Ok(())
                },
            ))
            .map_err(|e| format!("Windows toast failure handler: {e}"))?;
        remember_target(notification_id, session_id);
        keep_toast(session_id, notification_id, toast.clone());
        if let Err(error) = notifier.Show(&toast) {
            release_toast(session_id, notification_id);
            take_target(notification_id);
            return Err(format!("Windows toast delivery: {error}"));
        }
        Ok(())
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
            focus_notification_target(&app, notification);
        }
    });
    // Windows wires activation per toast in windows_toasts::show; macOS is refused.
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
        targets::remember_target(42, 7);
        assert_eq!(targets::take_target(42), Some(7));
        assert_eq!(targets::take_target(42), None);
    }

    #[cfg(windows)]
    #[test]
    fn toast_xml_is_silent_and_escapes_both_texts() {
        let xml = windows_toasts::toast_xml("<&>你好", "b&<");
        assert!(xml.contains("<binding template=\"ToastGeneric\">"));
        assert!(xml.contains("<text>&lt;&amp;&gt;你好</text>"), "{xml}");
        assert!(xml.contains("<text>b&amp;&lt;</text>"), "{xml}");
        assert!(xml.contains("<audio silent=\"true\"/>"));
    }

    #[cfg(windows)]
    #[test]
    fn toast_xml_drops_characters_xml_rejects_and_stays_bounded() {
        let body = format!("x\ty\u{7}{}", "&".repeat(2001));
        let xml = windows_toasts::toast_xml("a\u{1b}[1mb\u{0}", &body);
        assert!(xml.contains("<text>a[1mb</text>"), "{xml}");
        let bounded_body = format!("<text>x\ty{}</text>", "&amp;".repeat(1996));
        assert!(xml.contains(&bounded_body), "{xml}");
        let parsed = windows::Data::Xml::Dom::XmlDocument::new().expect("xml document");
        parsed
            .LoadXml(&windows::core::HSTRING::from(xml.as_str()))
            .expect("the toast payload is well-formed XML");
    }

    #[cfg(windows)]
    #[test]
    fn disabled_notification_settings_are_named() {
        use windows::UI::Notifications::NotificationSetting;
        assert_eq!(
            windows_toasts::setting_name(NotificationSetting::DisabledForUser),
            "disabled for this user"
        );
        assert_eq!(
            windows_toasts::setting_name(NotificationSetting(9)),
            "setting 9"
        );
    }

    #[cfg(windows)]
    #[test]
    fn toast_tag_names_the_session_within_the_windows_cap() {
        for session in [7i64, -7, i64::MAX, i64::MIN] {
            let tag = windows_toasts::toast_tag(session);
            assert!(tag.chars().count() <= windows_toasts::TOAST_TAG_MAX_CHARS);
            assert!(tag.contains(&session.to_string()));
        }
    }

    #[cfg(windows)]
    #[test]
    fn app_id_requires_the_installed_start_menu_shortcut() {
        let dir = tempfile::tempdir().expect("temp dir");
        let dirs = [dir.path().to_path_buf()];
        let error =
            windows_toasts::app_id_from_shortcuts(&dirs, "Houston.lnk", "dev.houston.desktop")
                .expect_err("no shortcut, so no app identity");
        assert!(
            error.contains("Houston.lnk"),
            "names the missing value: {error}"
        );
        assert!(
            error.contains("dev.houston.desktop"),
            "names the identity: {error}"
        );
        std::fs::write(dir.path().join("Houston.lnk"), b"").expect("write shortcut fixture");
        let app_id =
            windows_toasts::app_id_from_shortcuts(&dirs, "Houston.lnk", "dev.houston.desktop")
                .expect("the shortcut registers the identity");
        assert_eq!(app_id, "dev.houston.desktop");
    }
}

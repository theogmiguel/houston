// Short summaries remain legible in desktop notification headers.
#[cfg(any(target_os = "linux", test))]
const NOTIFICATION_TITLE_MAX_CHARS: usize = 200;
// Bound bus payloads while leaving room for actionable operator context.
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
pub async fn native_notify(title: String, body: String) -> Result<(), String> {
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
        let _: u32 = proxy
            .call(
                "Notify",
                &(
                    "Houston",
                    0u32,
                    "",
                    title,
                    body,
                    Vec::<String>::new(),
                    hints,
                    -1i32,
                ),
            )
            .await
            .map_err(|e| format!("Linux notification delivery: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (title, body);
        Err(format!(
            "native notifications unsupported on {}; supported platform: Linux",
            std::env::consts::OS
        ))
    }
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
}

/// What a `webkit_user_media_permission_request` asks the host to capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaCaptureRequest {
    pub audio: bool,
    pub video: bool,
}

/// Grants microphone capture only: audio without video, from the app's own page.
/// Video and display capture are never part of the product, so a request that
/// asks for them is denied rather than partially granted.
pub fn allows_user_media(request: MediaCaptureRequest, origin: Option<&str>) -> bool {
    request.audio && !request.video && origin.is_some_and(is_app_origin)
}

/// True for the origins Tauri serves the app from: `tauri://localhost` on Linux
/// and macOS, `http(s)://tauri.localhost` on Windows.
pub fn is_app_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

/// Enables microphone capture in the main webview and answers its permission
/// requests. wry leaves `enable-media-stream` off and does not connect
/// `permission-request`, so WebKitGTK denies `getUserMedia` until this runs.
#[cfg(target_os = "linux")]
pub fn install_media_capture(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use glib::prelude::Cast;
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt,
    };

    window.with_webview(|webview| {
        let widget = webview.inner();
        if let Some(settings) = WebViewExt::settings(&widget) {
            settings.set_enable_media_stream(true);
        }
        widget.connect_permission_request(|view, request| {
            let Some(media) = request.dynamic_cast_ref::<webkit2gtk::UserMediaPermissionRequest>()
            else {
                request.deny();
                return true;
            };
            let capture = MediaCaptureRequest {
                audio: media.is_for_audio_device(),
                video: media.is_for_video_device(),
            };
            if allows_user_media(capture, view.uri().as_deref()) {
                request.allow();
            } else {
                request.deny();
            }
            // Claim the decision either way so WebKitGTK never falls back to its
            // default handler, which would grant or deny a different capture set.
            true
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUDIO: MediaCaptureRequest = MediaCaptureRequest {
        audio: true,
        video: false,
    };

    #[test]
    fn allows_audio_from_the_app_origin() {
        assert!(allows_user_media(AUDIO, Some("tauri://localhost")));
        assert!(allows_user_media(
            AUDIO,
            Some("tauri://localhost/index.html")
        ));
        assert!(allows_user_media(AUDIO, Some("http://tauri.localhost/")));
        assert!(allows_user_media(AUDIO, Some("https://tauri.localhost/")));
    }

    #[test]
    fn denies_video_and_audio_with_video() {
        assert!(!allows_user_media(
            MediaCaptureRequest {
                audio: false,
                video: true,
            },
            Some("tauri://localhost")
        ));
        assert!(!allows_user_media(
            MediaCaptureRequest {
                audio: true,
                video: true,
            },
            Some("tauri://localhost")
        ));
        assert!(!allows_user_media(
            MediaCaptureRequest {
                audio: false,
                video: false,
            },
            Some("tauri://localhost")
        ));
    }

    #[test]
    fn denies_foreign_origins() {
        for origin in [
            "https://example.com/",
            "http://localhost:5173/",
            "https://tauri.localhost.example.com/",
            "tauri://evil.localhost",
            "not a url",
        ] {
            assert!(
                !allows_user_media(AUDIO, Some(origin)),
                "{origin} must not capture audio"
            );
        }
        assert!(!allows_user_media(AUDIO, None));
    }
}

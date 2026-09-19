use serde::Serialize;

pub const STATE_EVENT: &str = "browser://state";

pub const OPEN_URL_EVENT: &str = "browser://open-url";

pub const OPEN_REQUEST_EVENT: &str = "browser://open-request";

pub const FOCUS_EVENT: &str = "browser://focus";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserError {
    pub kind: &'static str,
    pub message: String,
    pub failing_url: Option<String>,
}

impl BrowserError {
    pub fn load(failing_url: &str, message: impl Into<String>) -> Self {
        Self {
            kind: "load",
            message: message.into(),
            failing_url: Some(failing_url.to_string()),
        }
    }

    pub fn blocked_scheme(url: &str, scheme: &str) -> Self {
        Self {
            kind: "blocked-scheme",
            message: format!(
                "refused to navigate a browser pane to the {scheme:?} scheme; browser panes may \
                 only load {}",
                super::webkit::ALLOWED_CHILD_SCHEMES.join(", ")
            ),
            failing_url: Some(url.to_string()),
        }
    }

    pub fn web_process_terminated(reason: &str) -> Self {
        Self {
            kind: "web-process-terminated",
            message: format!("the child's WebKit web process is gone: {reason}"),
            failing_url: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sticky {
    pub error: Option<BrowserError>,
    pub mount_failed: bool,
    pub favicon: Option<String>,
}

impl Sticky {
    // Does not clear `mount_failed`: a load can start against a child whose
    // web process never came back, and clearing on intent rather than on
    // evidence would make the recovery UI claim a recovery that never happened.
    pub fn load_started(&mut self) {
        if !self.mount_failed {
            self.error = None;
        }
    }

    pub fn load_committed(&mut self) {
        self.mount_failed = false;
        self.error = None;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub id: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub favicon: Option<String>,
    pub loading: bool,
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub error: Option<BrowserError>,
    pub mount_failed: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LiveProps {
    pub url: Option<String>,
    pub title: Option<String>,
    pub favicon: Option<String>,
    pub loading: bool,
    pub progress: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

pub fn merge(id: &str, live: LiveProps, sticky: &Sticky) -> BrowserState {
    BrowserState {
        id: id.to_string(),
        url: clamp_page_text(live.url, MAX_URL_CHARS),
        title: clamp_page_text(live.title, MAX_TITLE_CHARS),
        favicon: live.favicon,
        loading: live.loading,
        progress: live.progress,
        can_go_back: live.can_go_back,
        can_go_forward: live.can_go_forward,
        error: sticky.error.clone(),
        mount_failed: sticky.mount_failed,
    }
}

// Caps page-chosen text (document.title, a self-navigated data: URL), which
// can be megabytes long and re-serializes on every state event. Deliberately
// silent: only the page itself can trip this, so logging it would just spam.
pub const MAX_TITLE_CHARS: usize = 1024;
pub const MAX_URL_CHARS: usize = 8192;

fn clamp_page_text(value: Option<String>, max_chars: usize) -> Option<String> {
    let value = value?;
    if value.chars().count() <= max_chars {
        return Some(value);
    }
    Some(value.chars().take(max_chars).collect())
}

// A favicon is chrome-sized (16-64px), but the page chooses the source image;
// a 1024x1024 icon would mean a ~1MB base64 string on an event that fires
// several times per load. Oversized icons are dropped, not scaled.
pub const MAX_FAVICON_EDGE: i32 = 256;

// Cairo's ARgb32 is premultiplied, native-endian, so on Houston's
// little-endian targets the bytes are B,G,R,A — hence the channel swap and
// the divide-by-alpha to reach PNG's straight RGBA.
pub fn argb32_premultiplied_to_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Result<Vec<u8>, String> {
    let needed = stride * height;
    if stride < width * 4 || data.len() < needed {
        return Err(format!(
            "browser: image surface is {width}x{height} with stride {stride} and {} bytes; \
             expected stride >= {} and at least {needed} bytes",
            data.len(),
            width * 4
        ));
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = &data[y * stride..y * stride + width * 4];
        for &[b, g, r, a] in row.as_chunks::<4>().0 {
            if a == 0 {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                rgba.extend_from_slice(&[
                    unpremultiply(r, a),
                    unpremultiply(g, a),
                    unpremultiply(b, a),
                    a,
                ]);
            }
        }
    }
    Ok(rgba)
}

fn unpremultiply(channel: u8, alpha: u8) -> u8 {
    let value = (u32::from(channel) * 255 + u32::from(alpha) / 2) / u32::from(alpha);
    value.min(255) as u8
}

pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use std::io::Cursor;

    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected {
        return Err(format!(
            "browser: RGBA buffer is {} bytes for {width}x{height}; expected {expected}",
            rgba.len()
        ));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut out), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|err| format!("browser: PNG header for {width}x{height}: {err}"))?;
        writer
            .write_image_data(&rgba[..expected])
            .map_err(|err| format!("browser: PNG data for {width}x{height}: {err}"))?;
        writer
            .finish()
            .map_err(|err| format!("browser: PNG finish for {width}x{height}: {err}"))?;
    }
    Ok(out)
}

pub fn rgba_to_png_data_url(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    use base64::Engine;

    let png = rgba_to_png(rgba, width, height)?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_takes_live_properties_and_sticky_events() {
        let live = LiveProps {
            url: Some("https://example.test/".into()),
            title: Some("Example".into()),
            favicon: None,
            loading: true,
            progress: 0.5,
            can_go_back: true,
            can_go_forward: false,
        };
        let sticky = Sticky {
            error: Some(BrowserError::load("https://bad.test/", "boom")),
            mount_failed: true,
            favicon: None,
        };
        let state = merge("pane-1", live, &sticky);
        assert_eq!(state.id, "pane-1");
        assert_eq!(state.url.as_deref(), Some("https://example.test/"));
        assert!(state.loading && state.can_go_back && !state.can_go_forward);
        assert!(state.mount_failed);
        assert_eq!(
            state.error.unwrap().failing_url.as_deref(),
            Some("https://bad.test/")
        );
    }

    #[test]
    fn state_serializes_camel_case_for_the_renderer() {
        let state = merge("pane-1", LiveProps::default(), &Sticky::default());
        let json = serde_json::to_value(&state).unwrap();
        for key in [
            "id",
            "url",
            "title",
            "favicon",
            "loading",
            "progress",
            "canGoBack",
            "canGoForward",
            "error",
            "mountFailed",
        ] {
            assert!(json.get(key).is_some(), "missing {key} in {json}");
        }
        assert!(json.get("can_go_back").is_none(), "{json}");
        assert!(json.get("mount_failed").is_none(), "{json}");
    }

    #[test]
    fn error_payload_names_the_failing_url_and_the_kind() {
        let json =
            serde_json::to_value(BrowserError::load("file:///gone.html", "not found")).unwrap();
        assert_eq!(json["kind"], "load");
        assert_eq!(json["failingUrl"], "file:///gone.html");
        let json = serde_json::to_value(BrowserError::web_process_terminated("Crashed")).unwrap();
        assert_eq!(json["kind"], "web-process-terminated");
        assert!(json["message"].as_str().unwrap().contains("Crashed"));
        assert!(json["failingUrl"].is_null());
    }

    #[test]
    fn a_standing_mount_failure_keeps_its_reason_when_a_new_load_starts() {
        let mut sticky = Sticky {
            error: Some(BrowserError::web_process_terminated("crashed")),
            mount_failed: true,
            favicon: None,
        };
        sticky.load_started();
        assert!(sticky.mount_failed);
        assert_eq!(
            sticky.error.as_ref().map(|e| e.kind),
            Some("web-process-terminated"),
            "the flag must not travel without the reason it stands on"
        );
    }

    #[test]
    fn a_committed_load_clears_the_flag_and_the_reason_together() {
        let mut sticky = Sticky {
            error: Some(BrowserError::web_process_terminated("crashed")),
            mount_failed: true,
            favicon: None,
        };
        sticky.load_committed();
        assert!(!sticky.mount_failed);
        assert!(
            sticky.error.is_none(),
            "a displayed document must not keep an error from before it"
        );
    }

    #[test]
    fn page_chosen_title_and_url_are_clamped_on_the_way_into_the_payload() {
        let live = LiveProps {
            title: Some("é".repeat(MAX_TITLE_CHARS + 500)),
            url: Some(format!(
                "data:text/html,{}",
                "ü".repeat(MAX_URL_CHARS + 500)
            )),
            ..LiveProps::default()
        };
        let state = merge("pane-1", live, &Sticky::default());
        assert_eq!(
            state.title.as_ref().unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
        assert_eq!(state.url.as_ref().unwrap().chars().count(), MAX_URL_CHARS);
    }

    #[test]
    fn text_within_the_caps_is_untouched() {
        let live = LiveProps {
            title: Some("Houston".into()),
            url: Some("https://example.test/".into()),
            ..LiveProps::default()
        };
        let state = merge("pane-1", live, &Sticky::default());
        assert_eq!(state.title.as_deref(), Some("Houston"));
        assert_eq!(state.url.as_deref(), Some("https://example.test/"));
    }

    #[test]
    fn a_new_load_clears_the_previous_error_but_not_a_dead_web_process() {
        let mut sticky = Sticky {
            error: Some(BrowserError::load("https://bad.test/", "boom")),
            mount_failed: false,
            favicon: None,
        };
        sticky.load_started();
        assert!(sticky.error.is_none());

        let mut crashed = Sticky {
            error: Some(BrowserError::web_process_terminated("crashed")),
            mount_failed: true,
            favicon: None,
        };
        crashed.load_started();
        assert!(
            crashed.mount_failed,
            "mount_failed must survive load-started"
        );
        crashed.load_committed();
        assert!(!crashed.mount_failed);
    }

    #[test]
    fn opaque_argb32_round_trips_to_rgba() {
        let data = vec![0, 0, 255, 255];
        let rgba = argb32_premultiplied_to_rgba(&data, 1, 1, 4).unwrap();
        assert_eq!(rgba, vec![255, 0, 0, 255]);
    }

    #[test]
    fn premultiplied_half_alpha_white_becomes_straight_white() {
        let data = vec![128, 128, 128, 128];
        let rgba = argb32_premultiplied_to_rgba(&data, 1, 1, 4).unwrap();
        assert_eq!(rgba, vec![255, 255, 255, 128]);
    }

    #[test]
    fn fully_transparent_pixels_do_not_divide_by_zero() {
        let data = vec![0, 0, 0, 0];
        let rgba = argb32_premultiplied_to_rgba(&data, 1, 1, 4).unwrap();
        assert_eq!(rgba, vec![0, 0, 0, 0]);
    }

    #[test]
    fn row_padding_is_not_treated_as_pixels() {
        let data = vec![0, 0, 255, 255, 7, 7, 7, 7, 255, 0, 0, 255, 9, 9, 9, 9];
        let rgba = argb32_premultiplied_to_rgba(&data, 1, 2, 8).unwrap();
        assert_eq!(rgba, vec![255, 0, 0, 255, 0, 0, 255, 255]);
    }

    #[test]
    fn a_short_buffer_is_refused_naming_the_shape_expected() {
        let err = argb32_premultiplied_to_rgba(&[0, 0, 0], 1, 1, 4).unwrap_err();
        assert!(err.contains("stride 4"), "{err}");
        assert!(err.contains("3 bytes"), "{err}");
        assert!(err.contains("at least 4 bytes"), "{err}");
    }

    #[test]
    fn png_data_url_decodes_back_to_the_same_pixels() {
        use std::io::Cursor;
        let rgba = vec![255, 0, 0, 255, 0, 0, 255, 255];
        let url = rgba_to_png_data_url(&rgba, 2, 1).unwrap();
        let b64 = url
            .strip_prefix("data:image/png;base64,")
            .expect("data url prefix");
        let bytes = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap()
        };
        let decoder = png::Decoder::new(Cursor::new(&bytes));
        let mut reader = decoder.read_info().expect("decodes");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("frame decodes");
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..info.buffer_size()], rgba.as_slice());
    }
}

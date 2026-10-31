use std::sync::Mutex;

use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuBuilder, MenuItem, MenuItemKind, SubmenuBuilder,
};
use tauri::utils::config::Color;
use tauri::{AppHandle, Emitter, Runtime, State, Webview, Window};

fn unquote_gsettings(raw: &str) -> &str {
    let t = raw.trim();
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        &t[1..t.len() - 1]
    } else {
        t
    }
}

#[tauri::command]
pub fn window_button_layout() -> Option<String> {
    let out = crate::sys::spawn::command("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    let value = unquote_gsettings(&raw);
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[tauri::command]
pub fn window_close<R: Runtime>(window: Window<R>) -> Result<(), String> {
    window.close().map_err(|e| {
        format!(
            "window_close: failed to close window {:?}: {e}",
            window.label()
        )
    })
}

#[tauri::command]
pub fn window_minimize<R: Runtime>(window: Window<R>) -> Result<(), String> {
    window.minimize().map_err(|e| {
        format!(
            "window_minimize: failed to minimize window {:?}: {e}",
            window.label()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MaximizeOp {
    Maximize,
    Unmaximize,
}

fn maximize_action(currently_maximized: bool) -> MaximizeOp {
    if currently_maximized {
        MaximizeOp::Unmaximize
    } else {
        MaximizeOp::Maximize
    }
}

#[tauri::command]
pub fn window_maximize<R: Runtime>(window: Window<R>) -> Result<(), String> {
    let currently = window.is_maximized().map_err(|e| {
        format!(
            "window_maximize: failed to read maximized state for window {:?}: {e}",
            window.label()
        )
    })?;
    let result = match maximize_action(currently) {
        MaximizeOp::Maximize => window.maximize(),
        MaximizeOp::Unmaximize => window.unmaximize(),
    };
    result.map_err(|e| {
        format!(
            "window_maximize: failed to {} window {:?}: {e}",
            if currently { "unmaximize" } else { "maximize" },
            window.label()
        )
    })
}

#[tauri::command]
pub fn window_is_maximized<R: Runtime>(window: Window<R>) -> Result<bool, String> {
    window.is_maximized().map_err(|e| {
        format!(
            "window_is_maximized: failed to read maximized state for window {:?}: {e}",
            window.label()
        )
    })
}

#[tauri::command]
pub fn window_is_focused<R: Runtime>(window: Window<R>) -> Result<bool, String> {
    window.is_focused().map_err(|e| {
        format!(
            "window_is_focused: failed to read focus state for window {:?}: {e}",
            window.label()
        )
    })
}

fn fullscreen_target(currently_fullscreen: bool) -> bool {
    !currently_fullscreen
}

#[tauri::command]
pub fn window_is_fullscreen<R: Runtime>(window: Window<R>) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| {
        format!(
            "window_is_fullscreen: failed to read fullscreen state for window {:?}: {e}",
            window.label()
        )
    })
}

#[tauri::command]
pub fn window_set_theme<R: Runtime>(window: Window<R>, theme: String) -> Result<(), String> {
    let theme = parse_theme(&theme)?;
    window.set_theme(theme).map_err(|e| {
        format!(
            "window_set_theme: failed to set theme on window {:?} ({}): {e}",
            window.label(),
            theme_name(theme)
        )
    })
}

fn parse_theme(value: &str) -> Result<Option<tauri::Theme>, String> {
    match value {
        "light" => Ok(Some(tauri::Theme::Light)),
        "dark" => Ok(Some(tauri::Theme::Dark)),
        "system" => Ok(None),
        other => Err(format!(
            "window_set_theme: theme must be light, dark or system, got {other:?}"
        )),
    }
}

fn theme_name(theme: Option<tauri::Theme>) -> &'static str {
    match theme {
        Some(tauri::Theme::Light) => "light",
        Some(tauri::Theme::Dark) => "dark",
        None => "system",
        Some(_) => "unknown",
    }
}

#[tauri::command]
pub fn window_set_badge_count<R: Runtime>(window: Window<R>, count: i64) -> Result<(), String> {
    if count < 0 {
        return Err(format!(
            "window_set_badge_count: count must be >= 0, got {count}"
        ));
    }
    window
        .set_badge_count((count > 0).then_some(count))
        .map_err(|e| {
            format!(
                "window_set_badge_count: failed to set badge count {count} on window {:?}: {e}",
                window.label()
            )
        })
}

#[tauri::command]
pub fn window_toggle_fullscreen<R: Runtime>(window: Window<R>) -> Result<(), String> {
    let currently = window.is_fullscreen().map_err(|e| {
        format!(
            "window_toggle_fullscreen: failed to read fullscreen state for window {:?}: {e}",
            window.label()
        )
    })?;
    window
        .set_fullscreen(fullscreen_target(currently))
        .map_err(|e| {
            format!(
                "window_toggle_fullscreen: failed to set fullscreen={} on window {:?}: {e}",
                fullscreen_target(currently),
                window.label()
            )
        })
}

trait FocusOps {
    fn show(&self) -> Result<(), String>;
    fn set_focus(&self) -> Result<(), String>;
    /// Unparks the renderer's background polls: WebView2 reports a hidden window visible.
    fn announce_shown(&self);
}

impl<R: Runtime> FocusOps for Window<R> {
    fn show(&self) -> Result<(), String> {
        Window::show(self).map_err(|e| {
            format!(
                "window_focus: failed to show window {:?}: {e}",
                self.label()
            )
        })
    }

    fn set_focus(&self) -> Result<(), String> {
        Window::set_focus(self).map_err(|e| {
            format!(
                "window_focus: failed to focus window {:?}: {e}",
                self.label()
            )
        })
    }

    fn announce_shown(&self) {
        use tauri::Emitter;
        if let Err(err) = self.emit_to(self.label(), crate::tray::EVENT_WINDOW_HIDDEN, false) {
            eprintln!(
                "houston-tauri: could not tell window {:?} it is shown ({err}); its polls resume on focus",
                self.label()
            );
        }
    }
}

/// Announces the show before focusing: Windows may refuse focus to a background
/// process, and then no `focus` event would unpark the renderer either.
fn focus_via<W: FocusOps>(window: &W) -> Result<(), String> {
    window.show()?;
    window.announce_shown();
    window.set_focus()
}

#[tauri::command]
pub fn window_focus<R: Runtime>(window: Window<R>) -> Result<(), String> {
    focus_via(&window)
}

#[tauri::command]
pub fn window_start_dragging<R: Runtime>(window: Window<R>) -> Result<(), String> {
    window.start_dragging().map_err(|e| {
        format!(
            "window_start_dragging: failed to start dragging window {:?}: {e}",
            window.label()
        )
    })
}

fn resize_direction(name: &str) -> Result<tauri_runtime::ResizeDirection, String> {
    use tauri_runtime::ResizeDirection as D;
    Ok(match name {
        "north" => D::North,
        "south" => D::South,
        "east" => D::East,
        "west" => D::West,
        "north-east" => D::NorthEast,
        "north-west" => D::NorthWest,
        "south-east" => D::SouthEast,
        "south-west" => D::SouthWest,
        other => {
            return Err(format!(
                "window_start_resize_dragging: unknown direction {other:?}; expected one of \
                 north, south, east, west, north-east, north-west, south-east, south-west"
            ))
        }
    })
}

#[tauri::command]
pub fn window_start_resize_dragging<R: Runtime>(
    window: Window<R>,
    direction: String,
) -> Result<(), String> {
    window
        .start_resize_dragging(resize_direction(&direction)?)
        .map_err(|e| {
            format!(
                "window_start_resize_dragging: failed to resize window {:?} to the {direction}: {e}",
                window.label()
            )
        })
}

#[tauri::command]
pub fn window_set_zoom<R: Runtime>(webview: Webview<R>, factor: f64) -> Result<(), String> {
    validate_zoom_factor(factor)?;
    webview.set_zoom(factor).map_err(|e| {
        format!(
            "window_set_zoom: failed to set zoom {factor} on webview {:?}: {e}",
            webview.label()
        )
    })
}

fn validate_zoom_factor(factor: f64) -> Result<(), String> {
    if !factor.is_finite() || factor <= 0.0 {
        return Err(format!(
            "window_set_zoom: factor must be a finite number > 0, got {factor}"
        ));
    }
    Ok(())
}

fn parse_background_color(hex: &str) -> Result<Color, String> {
    let digits = hex
        .strip_prefix('#')
        .filter(|rest| rest.len() == 6 && rest.chars().all(|c| c.is_ascii_hexdigit()));
    let Some(digits) = digits else {
        return Err(format!(
            "window_set_background_color: hex must match #RRGGBB (6 hex digits after '#'), got {hex:?}"
        ));
    };
    let byte = |slice: &str| {
        u8::from_str_radix(slice, 16)
            .unwrap_or_else(|e| panic!("validated hex digits {slice:?} failed to parse: {e}"))
    };
    let r = byte(&digits[0..2]);
    let g = byte(&digits[2..4]);
    let b = byte(&digits[4..6]);
    Ok(Color(r, g, b, 255))
}

#[tauri::command]
pub fn window_set_background_color<R: Runtime>(
    webview: Webview<R>,
    hex: String,
) -> Result<(), String> {
    let color = parse_background_color(&hex)?;
    webview
        .window()
        .set_background_color(Some(color))
        .map_err(|e| {
            format!(
                "window_set_background_color: failed to set background {hex:?} on window {:?}: {e}",
                webview.window().label()
            )
        })?;
    webview.set_background_color(Some(color)).map_err(|e| {
        format!(
            "window_set_background_color: failed to set background {hex:?} on webview {:?}: {e}",
            webview.label()
        )
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn unquote_gsettings_strips_a_matched_pair() {
        assert_eq!(
            super::unquote_gsettings("'close,minimize,maximize:'\n"),
            "close,minimize,maximize:"
        );
        assert_eq!(super::unquote_gsettings("'appmenu:close'"), "appmenu:close");
    }

    #[test]
    fn unquote_gsettings_leaves_an_unmatched_quote_alone() {
        assert_eq!(super::unquote_gsettings("'appmenu:close"), "'appmenu:close");
        assert_eq!(super::unquote_gsettings("appmenu:close'"), "appmenu:close'");
        assert_eq!(super::unquote_gsettings("''"), "");
        assert_eq!(super::unquote_gsettings("'"), "'");
    }

    use super::*;
    use tauri::WebviewWindow;

    #[test]
    fn maximize_action_toggles_both_ways() {
        assert_eq!(maximize_action(false), MaximizeOp::Maximize);
        assert_eq!(maximize_action(true), MaximizeOp::Unmaximize);
    }

    #[test]
    fn fullscreen_target_toggles_both_ways() {
        assert!(fullscreen_target(false));
        assert!(!fullscreen_target(true));
    }

    #[test]
    fn context_menu_ids_round_trip_through_colons_in_the_item_id() {
        let encoded = context_menu_id("abc-123", "group:delete");
        assert_eq!(encoded, "v2ctx:abc-123:group:delete");
        assert_eq!(
            decode_context_menu_id(&encoded),
            Some(("abc-123", "group:delete"))
        );
        assert_eq!(decode_context_menu_id("other:abc:id"), None);
        assert_eq!(decode_context_menu_id("v2ctx::id"), None);
    }

    #[test]
    fn context_menu_nonces_reject_separators() {
        assert!(super::valid_nonce("abc-123_X"));
        assert!(!super::valid_nonce("abc:123"));
        assert!(!super::valid_nonce(""));
    }

    #[test]
    fn parse_theme_maps_the_three_contract_values() {
        assert_eq!(parse_theme("light").unwrap(), Some(tauri::Theme::Light));
        assert_eq!(parse_theme("dark").unwrap(), Some(tauri::Theme::Dark));
        assert_eq!(parse_theme("system").unwrap(), None);
        let error = parse_theme("sepia").expect_err("unknown theme must be refused");
        assert!(error.contains("sepia"), "{error}");
    }

    #[test]
    fn validate_zoom_factor_accepts_ordinary_values() {
        validate_zoom_factor(1.0).expect("1.0 must be accepted");
        validate_zoom_factor(0.5).expect("0.5 must be accepted");
        validate_zoom_factor(3.0).expect("3.0 must be accepted");
    }

    #[test]
    fn validate_zoom_factor_rejects_zero_and_negative() {
        let err = validate_zoom_factor(0.0).expect_err("0.0 must be rejected");
        assert!(
            err.contains('0'),
            "error must name the offending value: {err}"
        );
        let err = validate_zoom_factor(-1.5).expect_err("-1.5 must be rejected");
        assert!(
            err.contains("-1.5"),
            "error must name the offending value: {err}"
        );
    }

    #[test]
    fn validate_zoom_factor_rejects_non_finite_values() {
        assert!(validate_zoom_factor(f64::NAN).is_err());
        assert!(validate_zoom_factor(f64::INFINITY).is_err());
    }

    fn build_mock_window(
        commands: impl Fn(
            tauri::Builder<tauri::test::MockRuntime>,
        ) -> tauri::Builder<tauri::test::MockRuntime>,
    ) -> WebviewWindow<tauri::test::MockRuntime> {
        let app = commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .expect("mock window builds")
    }

    fn invoke(
        window: &WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        tauri::test::get_ipc_response(
            window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    }

    #[test]
    fn window_is_maximized_round_trips_and_reports_the_mock_runtimes_false() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_is_maximized]));
        let response = invoke(&window, "window_is_maximized", serde_json::json!({}))
            .expect("command must resolve");
        let value: bool = response.deserialize().expect("valid JSON bool");
        assert!(!value);
    }

    #[test]
    fn window_is_focused_round_trips_through_the_ipc_boundary() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_is_focused]));
        let response = invoke(&window, "window_is_focused", serde_json::json!({}))
            .expect("command must resolve");
        let _value: bool = response.deserialize().expect("valid JSON bool");
    }

    #[test]
    fn window_maximize_succeeds_through_the_ipc_boundary() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_maximize]));
        let response = invoke(&window, "window_maximize", serde_json::json!({}));
        assert!(
            response.is_ok(),
            "window_maximize must succeed against the mock runtime: {response:?}"
        );
    }

    fn build_mock_window_with_a_browser_child(
        commands: impl Fn(
            tauri::Builder<tauri::test::MockRuntime>,
        ) -> tauri::Builder<tauri::test::MockRuntime>,
    ) -> WebviewWindow<tauri::test::MockRuntime> {
        let window = build_mock_window(commands);
        window
            .as_ref()
            .window()
            .add_child(
                tauri::webview::WebviewBuilder::new(
                    "tr-browser-test",
                    tauri::WebviewUrl::App("index.html".into()),
                ),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(1.0, 1.0),
            )
            .expect("mock child webview builds");
        window
    }

    #[test]
    fn window_commands_still_resolve_once_a_browser_child_exists() {
        let window = build_mock_window_with_a_browser_child(|b| {
            b.invoke_handler(tauri::generate_handler![
                window_set_zoom,
                window_focus,
                window_is_maximized
            ])
        });

        let zoom = invoke(
            &window,
            "window_set_zoom",
            serde_json::json!({ "factor": 1.5 }),
        );
        assert!(
            zoom.is_ok(),
            "window_set_zoom must still resolve with a browser child mounted \
             (M4 -- a WebviewWindow-typed argument does not): {zoom:?}"
        );
        let focus = invoke(&window, "window_focus", serde_json::json!({}));
        assert!(focus.is_ok(), "window_focus must still resolve: {focus:?}");
        let maximized = invoke(&window, "window_is_maximized", serde_json::json!({}));
        assert!(
            maximized.is_ok(),
            "window_is_maximized must still resolve: {maximized:?}"
        );
    }

    #[test]
    fn every_retyped_window_command_still_resolves_with_a_browser_child() {
        let window = build_mock_window_with_a_browser_child(|b| {
            b.invoke_handler(tauri::generate_handler![
                window_minimize,
                window_maximize,
                window_is_focused,
                window_toggle_fullscreen,
                window_start_dragging,
                window_start_resize_dragging,
                window_set_background_color
            ])
        });

        for (cmd, args) in [
            ("window_minimize", serde_json::json!({})),
            ("window_maximize", serde_json::json!({})),
            ("window_is_focused", serde_json::json!({})),
            ("window_toggle_fullscreen", serde_json::json!({})),
            ("window_start_dragging", serde_json::json!({})),
            (
                "window_start_resize_dragging",
                serde_json::json!({ "direction": "east" }),
            ),
            (
                "window_set_background_color",
                serde_json::json!({ "hex": "#151515" }),
            ),
        ] {
            let response = invoke(&window, cmd, args);
            assert!(
                response.is_ok(),
                "{cmd} must still resolve with a browser child mounted (M4): {response:?}"
            );
        }
    }

    #[test]
    fn window_set_background_color_still_resolves_once_a_browser_child_exists() {
        let window = build_mock_window_with_a_browser_child(|b| {
            b.invoke_handler(tauri::generate_handler![window_set_background_color])
        });
        let response = invoke(
            &window,
            "window_set_background_color",
            serde_json::json!({ "hex": "#151515" }),
        );
        assert!(
            response.is_ok(),
            "window_set_background_color must still resolve with a browser child mounted: \
             {response:?}"
        );
    }

    #[test]
    fn window_close_succeeds_through_the_ipc_boundary() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_close]));
        let response = invoke(&window, "window_close", serde_json::json!({}));
        assert!(
            response.is_ok(),
            "window_close must succeed against the mock runtime: {response:?}"
        );
    }

    struct FocusSpy {
        calls: std::cell::RefCell<Vec<&'static str>>,
    }

    impl FocusOps for FocusSpy {
        fn show(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("show");
            Ok(())
        }

        fn set_focus(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("set_focus");
            Ok(())
        }

        fn announce_shown(&self) {
            self.calls.borrow_mut().push("announce_shown");
        }
    }

    #[test]
    fn focus_via_shows_announces_then_focuses_in_order() {
        let spy = FocusSpy {
            calls: std::cell::RefCell::new(Vec::new()),
        };
        focus_via(&spy).expect("focus_via must succeed");
        assert_eq!(
            spy.calls.into_inner(),
            vec!["show", "announce_shown", "set_focus"]
        );
    }

    #[test]
    fn window_focus_succeeds_through_the_ipc_boundary() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_focus]));
        let response = invoke(&window, "window_focus", serde_json::json!({}));
        assert!(
            response.is_ok(),
            "window_focus must succeed against the mock runtime: {response:?}"
        );
    }

    #[test]
    fn window_focus_tells_the_renderer_the_window_is_shown() {
        use tauri::Listener;
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_focus]));
        let (shown, heard) = std::sync::mpsc::channel();
        window.listen(crate::tray::EVENT_WINDOW_HIDDEN, move |event| {
            let _ = shown.send(event.payload().to_string());
        });
        invoke(&window, "window_focus", serde_json::json!({})).expect("window_focus resolves");
        assert_eq!(
            heard
                .recv_timeout(std::time::Duration::from_secs(5))
                .as_deref(),
            Ok("false"),
            "a window focused by command must unpark the renderer's polls"
        );
    }

    #[test]
    fn window_start_dragging_succeeds_through_the_ipc_boundary() {
        let window = build_mock_window(|b| {
            b.invoke_handler(tauri::generate_handler![window_start_dragging])
        });
        let response = invoke(&window, "window_start_dragging", serde_json::json!({}));
        assert!(
            response.is_ok(),
            "window_start_dragging must succeed against the mock runtime: {response:?}"
        );
    }

    #[test]
    fn window_set_zoom_accepts_the_factor_argument_name_and_rejects_an_invalid_value() {
        let window =
            build_mock_window(|b| b.invoke_handler(tauri::generate_handler![window_set_zoom]));
        let ok = invoke(
            &window,
            "window_set_zoom",
            serde_json::json!({ "factor": 1.5 }),
        );
        assert!(ok.is_ok(), "a valid factor must succeed: {ok:?}");

        let err = invoke(
            &window,
            "window_set_zoom",
            serde_json::json!({ "factor": -1.0 }),
        );
        assert!(
            err.is_err(),
            "an invalid factor must be rejected, not silently applied"
        );
    }

    #[test]
    fn parse_background_color_accepts_uppercase_and_lowercase() {
        assert_eq!(
            parse_background_color("#1a2b3c").expect("lowercase must be accepted"),
            Color(0x1a, 0x2b, 0x3c, 255)
        );
        assert_eq!(
            parse_background_color("#1A2B3C").expect("uppercase must be accepted"),
            Color(0x1a, 0x2b, 0x3c, 255)
        );
    }

    #[test]
    fn parse_background_color_accepts_boundary_values() {
        assert_eq!(
            parse_background_color("#000000").expect("all-zero must be accepted"),
            Color(0, 0, 0, 255)
        );
        assert_eq!(
            parse_background_color("#ffffff").expect("all-f must be accepted"),
            Color(255, 255, 255, 255)
        );
    }

    #[test]
    fn parse_background_color_rejects_malformed_values() {
        for bad in ["1a2b3c", "#1a2b3", "#1a2b3cf", "#gggggg", "", "#"] {
            let err = parse_background_color(bad).expect_err(&format!("{bad:?} must be rejected"));
            let expected = format!("{bad:?}");
            assert!(
                err.contains(&expected),
                "error must name the offending value {expected}: {err}"
            );
        }
    }

    #[test]
    fn window_set_background_color_accepts_a_valid_hex_and_rejects_a_malformed_one() {
        let window = build_mock_window(|b| {
            b.invoke_handler(tauri::generate_handler![window_set_background_color])
        });
        let ok = invoke(
            &window,
            "window_set_background_color",
            serde_json::json!({ "hex": "#1a2b3c" }),
        );
        assert!(ok.is_ok(), "a valid hex must succeed: {ok:?}");

        let err = invoke(
            &window,
            "window_set_background_color",
            serde_json::json!({ "hex": "not-a-color" }),
        );
        assert!(
            err.is_err(),
            "a malformed hex must be rejected, not silently ignored"
        );
    }

    #[test]
    fn every_direction_token_maps() {
        use tauri_runtime::ResizeDirection as D;
        for (token, expected) in [
            ("north", D::North),
            ("south", D::South),
            ("east", D::East),
            ("west", D::West),
            ("north-east", D::NorthEast),
            ("north-west", D::NorthWest),
            ("south-east", D::SouthEast),
            ("south-west", D::SouthWest),
        ] {
            assert_eq!(
                super::resize_direction(token).expect("known token"),
                expected,
                "token {token} must map to its own direction"
            );
        }
    }

    #[test]
    fn an_unknown_direction_names_the_value_and_the_accepted_set() {
        let err = super::resize_direction("up").expect_err("not a direction");
        assert!(
            err.contains("\"up\""),
            "the error must quote what was sent; got {err}"
        );
        assert!(
            err.contains("north-east") && err.contains("south-west"),
            "the error must list what is accepted; got {err}"
        );
    }
}

/// The v2 bridge's native context menu. Menus must outlive the popup call: the
/// platform shows them asynchronously, so the host retains the most recent
/// menus until a newer one replaces them.
#[derive(Default)]
pub struct ContextMenuState {
    menus: Mutex<Vec<Menu<tauri::Wry>>>,
    pending: Mutex<Option<String>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub header: bool,
    #[serde(default)]
    pub separator_before: bool,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub children: Option<Vec<ContextMenuItem>>,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct ContextMenuPosition {
    pub x: f64,
    pub y: f64,
}

pub fn context_menu_id(nonce: &str, id: &str) -> String {
    format!("v2ctx:{nonce}:{id}")
}

/// Splits `v2ctx:<nonce>:<id>` without trimming colons from the caller's id.
pub fn decode_context_menu_id(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("v2ctx"), Some(nonce), Some(id)) if !nonce.is_empty() => Some((nonce, id)),
        _ => None,
    }
}

fn valid_nonce(nonce: &str) -> bool {
    !nonce.is_empty()
        && nonce
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn build_context_item<R: Runtime>(
    app: &AppHandle<R>,
    nonce: &str,
    item: &ContextMenuItem,
) -> Result<MenuItemKind<R>, String> {
    let id = context_menu_id(nonce, &item.id);
    if let Some(children) = &item.children {
        let mut builder = SubmenuBuilder::new(app, &item.label);
        for child in children {
            if child.separator_before {
                builder = builder.separator();
            }
            let kind = build_context_item(app, nonce, child)?;
            builder = builder.item(&kind);
        }
        return Ok(builder.build().map_err(|e| e.to_string())?.kind());
    }
    if item.header {
        return MenuItem::with_id(app, id, &item.label, false, None::<&str>)
            .map(|item| item.kind())
            .map_err(|e| e.to_string());
    }
    match item.checked {
        Some(checked) => {
            CheckMenuItem::with_id(app, id, &item.label, !item.disabled, checked, None::<&str>)
                .map(|item| item.kind())
                .map_err(|e| e.to_string())
        }
        None => MenuItem::with_id(app, id, &item.label, !item.disabled, None::<&str>)
            .map(|item| item.kind())
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn v2_show_context_menu(
    app: AppHandle,
    window: Window,
    state: State<'_, ContextMenuState>,
    nonce: String,
    items: Vec<ContextMenuItem>,
    position: Option<ContextMenuPosition>,
) -> Result<(), String> {
    if !valid_nonce(&nonce) {
        return Err(format!(
            "v2_show_context_menu: nonce must be non-empty ASCII letters, digits, '-' or '_', got {nonce:?}"
        ));
    }
    let mut builder = MenuBuilder::new(&app);
    for item in &items {
        if item.separator_before {
            builder = builder.separator();
        }
        let kind = build_context_item(&app, &nonce, item)?;
        builder = builder.item(&kind);
    }
    let menu = builder.build().map_err(|e| e.to_string())?;

    let previous = state
        .pending
        .lock()
        .map(|mut pending| pending.replace(nonce))
        .unwrap_or(None);
    if let Some(previous) = previous {
        let _ = app.emit_to(
            "main",
            "v2-context-menu",
            serde_json::json!({ "nonce": previous, "id": serde_json::Value::Null }),
        );
    }

    if let Some(position) = position {
        window
            .popup_menu_at(&menu, tauri::LogicalPosition::new(position.x, position.y))
            .map_err(|e| format!("v2_show_context_menu: popup failed: {e}"))?;
    } else {
        window
            .popup_menu(&menu)
            .map_err(|e| format!("v2_show_context_menu: popup failed: {e}"))?;
    }
    if let Ok(mut menus) = state.menus.lock() {
        menus.push(menu);
        if menus.len() > 8 {
            menus.remove(0);
        }
    }
    Ok(())
}

/// Routes a menu event to the waiting `desktopBridge.showContextMenu` call.
/// Returns false for ids this host did not create.
pub fn handle_context_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let Some((nonce, item)) = decode_context_menu_id(id) else {
        return false;
    };
    let _ = app.emit_to(
        "main",
        "v2-context-menu",
        serde_json::json!({ "nonce": nonce, "id": item }),
    );
    true
}

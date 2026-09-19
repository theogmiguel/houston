use super::corner::CornerPaint;

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct RectSpec {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub corners: CornerPaint,
}

impl From<RectSpec> for Rect {
    fn from(spec: RectSpec) -> Self {
        Rect {
            x: spec.x.round() as i32,
            y: spec.y.round() as i32,
            width: spec.width.round().max(1.0) as i32,
            height: spec.height.round().max(1.0) as i32,
        }
    }
}

// The hard safety net: a commanded rect is clamped to the window's current inner
// bounds regardless of whether the GTK layout decoupling is complete, and nothing
// here may grow the toplevel to fit a child.
pub fn clamp_to_window(rect: Rect, win_w: i32, win_h: i32) -> (Rect, Option<String>) {
    let win_w = win_w.max(0);
    let win_h = win_h.max(0);
    let x = rect.x.clamp(0, win_w);
    let y = rect.y.clamp(0, win_h);
    let width = if win_w - x <= 0 {
        0
    } else {
        rect.width.max(1).min(win_w - x)
    };
    let height = if win_h - y <= 0 {
        0
    } else {
        rect.height.max(1).min(win_h - y)
    };
    let clamped = Rect {
        x,
        y,
        width,
        height,
    };
    let note = if clamped != rect {
        Some(format!(
            "browser: clamped commanded ({}, {}) {}x{} -> ({}, {}) {}x{} to fit window {}x{}",
            rect.x, rect.y, rect.width, rect.height, x, y, width, height, win_w, win_h
        ))
    } else {
        None
    };
    (clamped, note)
}

// Round ONCE, at the four EDGES: `round(x·z) + round(w·z)` can land the right/bottom
// edge a pixel past where the host painted the CSS edge, thinning the selection ring.
// Edges, not sizes, is what puts every child edge on the nearest integer.
pub fn spec_to_logical(spec: RectSpec, zoom: f64) -> Rect {
    let x = (spec.x * zoom).round();
    let y = (spec.y * zoom).round();
    let right = ((spec.x + spec.width) * zoom).round();
    let bottom = ((spec.y + spec.height) * zoom).round();
    Rect {
        x: x as i32,
        y: y as i32,
        width: ((right - x) as i32).max(1),
        height: ((bottom - y) as i32).max(1),
    }
}

pub fn scale_corner_paint(corners: CornerPaint, zoom: f64) -> CornerPaint {
    let scale = |v: f64| {
        let scaled = v * zoom;
        if scaled.is_finite() && scaled > 0.0 {
            scaled
        } else {
            0.0
        }
    };
    CornerPaint {
        radius: scale(corners.radius),
        border_width: scale(corners.border_width),
        ..corners
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_lengths_scale_with_zoom_and_floor_at_zero() {
        let border = crate::browser::corner::Rgba {
            r: 0.25,
            g: 0.5,
            b: 0.75,
            a: 1.0,
        };
        let spec = CornerPaint {
            radius: 9.0,
            border_width: 1.0,
            border,
            surround: crate::browser::corner::Rgba::default(),
        };
        assert_eq!(scale_corner_paint(spec, 1.0), spec);
        let zoomed = scale_corner_paint(spec, 1.3);
        assert!((zoomed.radius - 11.7).abs() < 1e-9);
        assert!((zoomed.border_width - 1.3).abs() < 1e-9);
        assert_eq!(zoomed.border, border);

        for broken in [-4.0, f64::NAN, f64::INFINITY, 0.0] {
            let out = scale_corner_paint(
                CornerPaint {
                    radius: broken,
                    border_width: broken,
                    ..spec
                },
                1.0,
            );
            assert_eq!(out.radius, 0.0, "radius {broken} must floor to 0");
            assert_eq!(out.border_width, 0.0, "border width {broken} must floor");
        }
    }

    #[test]
    fn integer_spec_at_zoom_one_is_identity() {
        let spec = RectSpec {
            x: 3.0,
            y: 7.0,
            width: 101.0,
            height: 53.0,
            corners: CornerPaint::default(),
        };
        assert_eq!(
            spec_to_logical(spec, 1.0),
            Rect {
                x: 3,
                y: 7,
                width: 101,
                height: 53,
            }
        );
    }

    #[test]
    fn integral_zoom_scales_exactly() {
        let spec = RectSpec {
            x: 30.0,
            y: 40.0,
            width: 200.0,
            height: 100.0,
            corners: CornerPaint::default(),
        };
        assert_eq!(
            spec_to_logical(spec, 2.0),
            Rect {
                x: 60,
                y: 80,
                width: 400,
                height: 200,
            }
        );
    }

    #[test]
    fn fractional_zoom_rounds_edges_not_sizes() {
        let gutter = RectSpec {
            x: 2.0,
            y: 2.0,
            width: 2.0,
            height: 2.0,
            corners: CornerPaint::default(),
        };
        let scaled = spec_to_logical(gutter, 1.3);
        assert_eq!(scaled.x, 3, "left edge: round(2·1.3) = round(2.6)");
        assert_eq!(
            scaled.x + scaled.width,
            5,
            "right edge must be round(4·1.3) = round(5.2), not x + round(w·z) = 6"
        );
        assert_eq!(scaled.y, 3);
        assert_eq!(scaled.y + scaled.height, 5);
    }

    #[test]
    fn fractional_spec_edges_are_not_pre_rounded_to_css_integers() {
        let spec = RectSpec {
            x: 320.6,
            y: 88.4,
            width: 1076.6,
            height: 820.2,
            corners: CornerPaint::default(),
        };
        let scaled = spec_to_logical(spec, 1.0);
        assert_eq!(scaled.x, 321, "round(320.6)");
        assert_eq!(
            scaled.x + scaled.width,
            1397,
            "right edge round(320.6 + 1076.6) = round(1397.2), not 321 + round(1076.6) = 1398"
        );
        assert_eq!(scaled.y, 88, "round(88.4)");
        assert_eq!(
            scaled.y + scaled.height,
            909,
            "bottom edge round(88.4 + 820.2) = round(908.6)"
        );
    }

    #[test]
    fn degenerate_spec_floors_to_one_pixel() {
        let spec = RectSpec {
            x: 10.0,
            y: 10.0,
            width: 0.2,
            height: 0.0,
            corners: CornerPaint::default(),
        };
        let scaled = spec_to_logical(spec, 1.0);
        assert_eq!(scaled.width, 1);
        assert_eq!(scaled.height, 1);
    }

    #[test]
    fn in_bounds_rect_is_unchanged_and_unnoted() {
        let rect = Rect {
            x: 10,
            y: 10,
            width: 100,
            height: 100,
        };
        let (clamped, note) = clamp_to_window(rect, 800, 600);
        assert_eq!(clamped, rect);
        assert!(note.is_none());
    }

    #[test]
    fn negative_origin_clamps_to_zero_and_notes_the_offending_value() {
        let rect = Rect {
            x: -50,
            y: -20,
            width: 100,
            height: 100,
        };
        let (clamped, note) = clamp_to_window(rect, 800, 600);
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 0);
        let note = note.expect("clamp must be logged");
        assert!(note.contains("-50"), "{note}");
        assert!(note.contains("-20"), "{note}");
        assert!(note.contains("800"), "{note}");
        assert!(note.contains("600"), "{note}");
    }

    #[test]
    fn oversized_rect_is_clamped_to_remaining_window_space() {
        let rect = Rect {
            x: 700,
            y: 500,
            width: 400,
            height: 400,
        };
        let (clamped, note) = clamp_to_window(rect, 800, 600);
        assert_eq!(clamped.x, 700);
        assert_eq!(clamped.y, 500);
        assert_eq!(clamped.width, 100);
        assert_eq!(clamped.height, 100);
        assert!(note.is_some());
    }

    #[test]
    fn zero_or_negative_size_floors_to_one_pixel() {
        let rect = Rect {
            x: 0,
            y: 0,
            width: 0,
            height: -10,
        };
        let (clamped, _) = clamp_to_window(rect, 800, 600);
        assert_eq!(clamped.width, 1);
        assert_eq!(clamped.height, 1);
    }

    #[test]
    fn zero_size_window_clamps_the_child_to_zero_too() {
        let rect = Rect {
            x: 5,
            y: 5,
            width: 50,
            height: 50,
        };
        let (clamped, _) = clamp_to_window(rect, 0, 0);
        assert_eq!(clamped.x, 0);
        assert_eq!(clamped.y, 0);
        assert_eq!(
            clamped.width, 0,
            "a 0x0 window must not receive a nonzero-width child"
        );
        assert_eq!(
            clamped.height, 0,
            "a 0x0 window must not receive a nonzero-height child"
        );
    }

    #[test]
    fn rect_spec_rounds_and_floors_size_to_one() {
        let rect: Rect = RectSpec {
            x: 10.4,
            y: 10.6,
            width: 0.2,
            height: -3.0,
            corners: CornerPaint::default(),
        }
        .into();
        assert_eq!(rect.x, 10);
        assert_eq!(rect.y, 11);
        assert_eq!(rect.width, 1);
        assert_eq!(rect.height, 1);
    }
}

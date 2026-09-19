#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq, Default)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    fn sane(self) -> Rgba {
        let fix = |v: f64| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Rgba {
            r: fix(self.r),
            g: fix(self.g),
            b: fix(self.b),
            a: fix(self.a),
        }
    }
}

#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CornerPaint {
    pub radius: f64,
    pub border_width: f64,
    pub border: Rgba,
    pub surround: Rgba,
}

impl CornerPaint {
    pub fn is_noop(&self) -> bool {
        !drawable(self.radius)
    }
}

// The obvious spelling of the same test, `!(v > 0.0)`, is a negated comparison on a
// partially ordered type, which clippy refuses; this says the same thing and says it once.
fn drawable(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CornerBox {
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub center_x: f64,
    pub center_y: f64,
}

pub fn bottom_corner_boxes(width: f64, height: f64, radius: f64) -> Vec<CornerBox> {
    if !drawable(width) || !drawable(height) || !drawable(radius) {
        return Vec::new();
    }
    let r = radius.min(width / 2.0).min(height / 2.0);
    if !drawable(r) {
        return Vec::new();
    }
    vec![
        CornerBox {
            x: 0.0,
            y: height - r,
            size: r,
            center_x: r,
            center_y: height - r,
        },
        CornerBox {
            x: width - r,
            y: height - r,
            size: r,
            center_x: width - r,
            center_y: height - r,
        },
    ]
}

// Runs AFTER WebKitGTK's own draw, and that ordering is the whole mechanism: this
// repaints the corner with the colour BEHIND the pane, covering page pixels rather than
// preventing them. It never paints the pane's own chrome colour over page content.
#[cfg(target_os = "linux")]
pub fn paint_bottom_corners(
    cr: &gtk::cairo::Context,
    width: f64,
    height: f64,
    paint: &CornerPaint,
) {
    use std::f64::consts::PI;

    if paint.is_noop() {
        return;
    }
    let border_width = if drawable(paint.border_width) {
        paint.border_width
    } else {
        0.0
    };
    let surround = paint.surround.sane();
    let border = paint.border.sane();

    for corner in bottom_corner_boxes(width, height, paint.radius) {
        let _ = cr.save();

        cr.new_path();
        cr.rectangle(corner.x, corner.y, corner.size, corner.size);
        cr.set_fill_rule(gtk::cairo::FillRule::Winding);
        cr.clip();

        cr.new_path();
        cr.rectangle(corner.x, corner.y, corner.size, corner.size);
        cr.new_sub_path();
        cr.arc(corner.center_x, corner.center_y, corner.size, 0.0, 2.0 * PI);
        cr.set_fill_rule(gtk::cairo::FillRule::EvenOdd);
        cr.clip();

        cr.set_source_rgba(surround.r, surround.g, surround.b, surround.a);
        let _ = cr.paint();

        if drawable(border_width) && border.a > 0.0 {
            cr.new_path();
            cr.arc(
                corner.center_x,
                corner.center_y,
                corner.size + border_width,
                0.0,
                2.0 * PI,
            );
            cr.set_fill_rule(gtk::cairo::FillRule::Winding);
            cr.set_source_rgba(border.r, border.g, border.b, border.a);
            let _ = cr.fill();
        }
        let _ = cr.restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paint(radius: f64) -> CornerPaint {
        CornerPaint {
            radius,
            border_width: 1.0,
            border: Rgba {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
            surround: Rgba {
                r: 0.0,
                g: 0.0,
                b: 1.0,
                a: 1.0,
            },
        }
    }

    #[test]
    fn a_zero_or_broken_radius_is_a_no_op() {
        assert!(CornerPaint::default().is_noop());
        assert!(paint(0.0).is_noop());
        assert!(paint(-3.0).is_noop());
        assert!(paint(f64::NAN).is_noop());
        assert!(paint(f64::INFINITY).is_noop());
        assert!(!paint(0.5).is_noop());
    }

    #[test]
    fn the_two_boxes_sit_in_the_bottom_corners_with_concentric_centres() {
        let boxes = bottom_corner_boxes(400.0, 300.0, 9.0);
        assert_eq!(
            boxes,
            vec![
                CornerBox {
                    x: 0.0,
                    y: 291.0,
                    size: 9.0,
                    center_x: 9.0,
                    center_y: 291.0,
                },
                CornerBox {
                    x: 391.0,
                    y: 291.0,
                    size: 9.0,
                    center_x: 391.0,
                    center_y: 291.0,
                },
            ]
        );
    }

    #[test]
    fn degenerate_inputs_produce_no_boxes_rather_than_nonsense_ones() {
        assert!(bottom_corner_boxes(0.0, 300.0, 9.0).is_empty());
        assert!(bottom_corner_boxes(400.0, 0.0, 9.0).is_empty());
        assert!(bottom_corner_boxes(400.0, 300.0, 0.0).is_empty());
        assert!(bottom_corner_boxes(400.0, 300.0, f64::NAN).is_empty());
        assert!(bottom_corner_boxes(-1.0, -1.0, 9.0).is_empty());
    }

    #[test]
    fn an_over_large_radius_clamps_to_half_the_box_so_the_two_arcs_cannot_cross() {
        let boxes = bottom_corner_boxes(40.0, 30.0, 200.0);
        assert_eq!(boxes.len(), 2);
        assert!(boxes.iter().all(|b| b.size == 15.0), "{boxes:?}");
        assert!(boxes[0].x + boxes[0].size <= boxes[1].x, "{boxes:?}");
    }

    #[test]
    fn out_of_range_colour_channels_clamp_instead_of_reaching_cairo() {
        let wild = Rgba {
            r: 4.0,
            g: -1.0,
            b: f64::NAN,
            a: f64::INFINITY,
        };
        assert_eq!(
            wild.sane(),
            Rgba {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 0.0
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn painting_covers_the_corner_in_surround_and_border_and_spares_the_page() {
        use gtk::cairo::{Context, Format, ImageSurface};

        const W: i32 = 60;
        const H: i32 = 40;
        const R: f64 = 9.0;
        let surface = ImageSurface::create(Format::Rgb24, W, H).expect("image surface");
        let cr = Context::new(&surface).expect("cairo context");
        cr.set_source_rgb(0.0, 1.0, 0.0);
        cr.paint().expect("prefill");
        paint_bottom_corners(&cr, f64::from(W), f64::from(H), &paint(R));
        drop(cr);

        let stride = surface.stride() as usize;
        let data = surface.take_data().expect("surface data");
        let rgb_at = |x: i32, y: i32| -> (u8, u8, u8) {
            let i = y as usize * stride + x as usize * 4;
            (data[i + 2], data[i + 1], data[i])
        };
        let is_page = |p: (u8, u8, u8)| p.1 > 200 && p.0 < 60 && p.2 < 60;
        let is_surround = |p: (u8, u8, u8)| p.2 > 200 && p.0 < 60 && p.1 < 60;

        assert!(
            is_surround(rgb_at(0, H - 1)),
            "bottom-left corner should be the surround, got {:?}",
            rgb_at(0, H - 1)
        );
        assert!(
            is_surround(rgb_at(W - 1, H - 1)),
            "bottom-right corner should be the surround, got {:?}",
            rgb_at(W - 1, H - 1)
        );
        for x in (R as i32 + 1)..(W - R as i32 - 1) {
            for y in (H - R as i32 - 1)..H {
                assert!(
                    is_page(rgb_at(x, y)),
                    "({x}, {y}) is between the two corners and must be untouched page, got {:?}",
                    rgb_at(x, y)
                );
            }
        }
        for y in 0..(H - R as i32 - 1) {
            assert!(
                is_page(rgb_at(0, y)),
                "(0, {y}) is above the corner square and must be untouched page, got {:?}",
                rgb_at(0, y)
            );
        }
        assert!(is_page(rgb_at(0, 0)), "top-left must still be the page");
        assert!(
            is_page(rgb_at(W - 1, 0)),
            "top-right must still be the page"
        );
        assert!(is_page(rgb_at(W / 2, H - 1)), "the bottom edge is the page");
        assert!(is_page(rgb_at(6, H - 6)), "inside the bottom-left arc");
        assert!(
            is_page(rgb_at(3, H - 3)),
            "3px in on the diagonal is inside the r=9 arc, got {:?}",
            rgb_at(3, H - 3)
        );
        assert!(
            !is_page(rgb_at(1, H - 1)),
            "1px in on the diagonal is outside the r=9 arc, got {:?}",
            rgb_at(1, H - 1)
        );
        let bl_red = (0..R as i32)
            .flat_map(|dx| (0..R as i32).map(move |dy| (dx, H - 1 - dy)))
            .filter(|&(x, y)| {
                let (r, g, b) = rgb_at(x, y);
                r > g && r > b
            })
            .count();
        assert!(
            bl_red >= 3,
            "the border arc should tint several pixels of the bottom-left corner, found {bl_red}"
        );
    }
}

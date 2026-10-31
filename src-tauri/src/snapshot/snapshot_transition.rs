//! Geometry helpers from upstream `SnapShotTransition.ts`. The Electron overlay
//! windows themselves have no Tauri equivalent yet; the renderer keeps its own
//! animation, so only the pure geometry is used here.

use super::platform::Bounds;

const MIN_DURATION_MS: f64 = 280.0;
const MAX_DURATION_MS: f64 = 680.0;
const DURATION_DISTANCE_SCALE: f64 = 2_000.0;

pub fn animation_duration_ms(source: Bounds, target: Bounds) -> f64 {
    let distance = (((source.x as f64 + source.width as f64 / 2.0)
        - (target.x as f64 + target.width as f64 / 2.0))
        .powi(2)
        + ((source.y as f64 + source.height as f64 / 2.0)
            - (target.y as f64 + target.height as f64 / 2.0))
            .powi(2))
    .sqrt();
    MAX_DURATION_MS
        - (MAX_DURATION_MS - MIN_DURATION_MS) * (-distance / DURATION_DISTANCE_SCALE).exp()
}

fn overlay_bounds(displays: &[Bounds]) -> Bounds {
    let first = displays.first().copied().unwrap_or(Bounds {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
    });
    let mut left = first.x;
    let mut top = first.y;
    let mut right = first.x + first.width;
    let mut bottom = first.y + first.height;
    for display in displays.iter().skip(1) {
        left = left.min(display.x);
        top = top.min(display.y);
        right = right.max(display.x + display.width);
        bottom = bottom.max(display.y + display.height);
    }
    Bounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

pub fn animation_display_bounds(
    displays: &[Bounds],
    source: Bounds,
    destination: Bounds,
) -> Vec<Bounds> {
    let flight = overlay_bounds(&[source, destination]);
    displays
        .iter()
        .copied()
        .filter(|bounds| {
            bounds.x < flight.x + flight.width
                && bounds.x + bounds.width > flight.x
                && bounds.y < flight.y + flight.height
                && bounds.y + bounds.height > flight.y
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: i64, y: i64, width: i64, height: i64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn duration_shrinks_toward_the_minimum_with_distance() {
        let near = animation_duration_ms(bounds(0, 0, 10, 10), bounds(0, 0, 10, 10));
        let far = animation_duration_ms(bounds(0, 0, 10, 10), bounds(10_000, 10_000, 10, 10));
        assert!((near - MIN_DURATION_MS).abs() < 0.001);
        assert!(far > near);
        assert!(far <= MAX_DURATION_MS);
    }

    #[test]
    fn covers_straddling_captures_and_intervening_monitors() {
        let displays = [
            bounds(-1_920, 0, 1_920, 1_080),
            bounds(0, 0, 1_440, 900),
            bounds(1_440, 0, 1_280, 720),
            bounds(0, -1_080, 1_920, 1_080),
        ];
        let source = bounds(-200, 100, 800, 600);
        assert_eq!(
            animation_display_bounds(&displays, source, source),
            displays[..2].to_vec()
        );
        assert_eq!(
            animation_display_bounds(
                &displays,
                bounds(-1_800, 100, 800, 600),
                bounds(1_600, 200, 200, 112)
            ),
            displays[..3].to_vec()
        );
    }
}

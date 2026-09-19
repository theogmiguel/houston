use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SavedBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale_factor: f64,
}

const MIN_VISIBLE_HEIGHT_LOGICAL: f64 = 44.0;

const MIN_VISIBLE_WIDTH_LOGICAL: f64 = 200.0;

const MAX_REASONABLE_DIMENSION: i32 = 20_000;

fn plausible_dimensions(bounds: &SavedBounds) -> bool {
    bounds.width > 0
        && bounds.height > 0
        && bounds.width <= MAX_REASONABLE_DIMENSION
        && bounds.height <= MAX_REASONABLE_DIMENSION
}

fn overlap_len(a: i32, a_len: i32, b: i32, b_len: i32) -> i32 {
    let start = a.max(b);
    let end = (a + a_len).min(b + b_len);
    (end - start).max(0)
}

fn is_meaningfully_visible(bounds: &SavedBounds, monitors: &[MonitorRect]) -> bool {
    monitors.iter().any(|m| {
        let min_w = (MIN_VISIBLE_WIDTH_LOGICAL * m.scale_factor).round() as i32;
        let min_h = (MIN_VISIBLE_HEIGHT_LOGICAL * m.scale_factor).round() as i32;
        let visible_w = overlap_len(bounds.x, bounds.width, m.x, m.width);
        let visible_h = overlap_len(bounds.y, bounds.height, m.y, m.height);
        visible_w >= min_w && visible_h >= min_h
    })
}

pub fn validate_saved_bounds(bounds: &SavedBounds, monitors: &[MonitorRect]) -> bool {
    plausible_dimensions(bounds) && is_meaningfully_visible(bounds, monitors)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StartupGeometry {
    Default,
    Restore {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        maximized: bool,
    },
}

pub fn resolve_startup_geometry(
    saved: Option<SavedBounds>,
    monitors: &[MonitorRect],
) -> StartupGeometry {
    let Some(bounds) = saved else {
        return StartupGeometry::Default;
    };
    if !validate_saved_bounds(&bounds, monitors) {
        return StartupGeometry::Default;
    }
    StartupGeometry::Restore {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: bounds.maximized,
    }
}

pub fn load_saved_bounds(state_dir: &Path) -> Option<SavedBounds> {
    let path = state_dir.join("window.json");
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        Err(err) => {
            eprintln!(
                "houston-tauri: {} unreadable ({err}), using default window geometry",
                path.display()
            );
            return None;
        }
    };
    match serde_json::from_str::<SavedBounds>(&body) {
        Ok(bounds) => Some(bounds),
        Err(err) => {
            eprintln!(
                "houston-tauri: {} is corrupt ({err}), using default window geometry",
                path.display()
            );
            None
        }
    }
}

pub fn save_bounds(state_dir: &Path, bounds: &SavedBounds) -> io::Result<()> {
    let dest = state_dir.join("window.json");
    let tmp = state_dir.join("window.json.tmp");
    let body = serde_json::to_string_pretty(bounds)
        .expect("SavedBounds is a plain struct of primitives; serialization cannot fail");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &dest)
}

const WRITE_DEBOUNCE: Duration = Duration::from_millis(400);

/// Only a restored, non-maximized window has bounds a user chose: a minimized
/// one reports the offscreen (-32000, -32000) corner with a few pixels of
/// size, and saving that loses the real one for good.
fn records_bounds(maximized: bool, minimized: bool) -> bool {
    !maximized && !minimized
}

pub struct WindowStateTracker {
    state_dir: PathBuf,
    pending: Mutex<SavedBounds>,
    generation: AtomicU64,
}

impl WindowStateTracker {
    pub fn new(state_dir: PathBuf, initial: SavedBounds) -> Arc<Self> {
        Arc::new(Self {
            state_dir,
            pending: Mutex::new(initial),
            generation: AtomicU64::new(0),
        })
    }

    pub fn record(self: &Arc<Self>, window: &tauri::Window) {
        let maximized = window.is_maximized().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        {
            let mut pending = self.pending.lock().unwrap();
            if records_bounds(maximized, minimized) {
                if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                    pending.x = pos.x;
                    pending.y = pos.y;
                    pending.width = size.width as i32;
                    pending.height = size.height as i32;
                }
            }
            // A minimized window is not a restored one: clobbering the flag
            // would turn a maximized-then-minimized quit into a restored,
            // small window on the next launch.
            if !minimized {
                pending.maximized = maximized;
            }
        }
        self.schedule_write();
    }

    fn schedule_write(self: &Arc<Self>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(WRITE_DEBOUNCE);
            if this.generation.load(Ordering::SeqCst) == generation {
                this.flush();
            }
        });
    }

    pub fn flush(&self) {
        let bounds = *self.pending.lock().unwrap();
        if let Err(err) = save_bounds(&self.state_dir, &bounds) {
            eprintln!(
                "houston-tauri: failed to save {}: {err}",
                self.state_dir.join("window.json").display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: i32, height: i32, scale_factor: f64) -> MonitorRect {
        MonitorRect {
            x,
            y,
            width,
            height,
            scale_factor,
        }
    }

    fn bounds(x: i32, y: i32, width: i32, height: i32, maximized: bool) -> SavedBounds {
        SavedBounds {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn a_minimized_window_is_not_recorded() {
        assert!(!records_bounds(false, true));
        assert!(!records_bounds(true, true));
    }

    #[test]
    fn a_maximized_window_does_not_record_its_maximized_rect_as_its_bounds() {
        assert!(!records_bounds(true, false));
    }

    #[test]
    fn a_restored_window_records_both_bounds_and_flags() {
        assert!(records_bounds(false, false));
    }

    #[test]
    fn saved_rect_fully_inside_one_monitor_is_accepted() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        let b = bounds(100, 100, 1400, 900, false);
        assert!(validate_saved_bounds(&b, &monitors));
    }

    #[test]
    fn saved_rect_on_a_monitor_that_no_longer_exists_is_rejected() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        let b = bounds(2500, 200, 1400, 900, false);
        assert!(!validate_saved_bounds(&b, &monitors));
    }

    #[test]
    fn saved_rect_overlapping_by_a_sliver_is_rejected() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        let b = bounds(1915, 1075, 1400, 900, false);
        assert!(!validate_saved_bounds(&b, &monitors));
    }

    #[test]
    fn saved_rect_straddling_two_monitors_is_accepted() {
        let monitors = [
            monitor(0, 0, 1920, 1080, 1.0),
            monitor(1920, 0, 1920, 1080, 1.0),
        ];
        let b = bounds(1800, 100, 1400, 900, false);
        assert!(validate_saved_bounds(&b, &monitors));
    }

    #[test]
    fn zero_negative_and_absurd_dimensions_are_rejected() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        for (w, h) in [(0, 900), (1400, 0), (-100, 900), (1400, -1), (50_000, 900)] {
            let b = bounds(100, 100, w, h, false);
            assert!(
                !validate_saved_bounds(&b, &monitors),
                "{w}x{h} must be rejected"
            );
        }
    }

    #[test]
    fn hidpi_monitor_uses_physical_thresholds_not_logical() {
        let monitors = [monitor(0, 0, 3840, 2160, 2.0)];
        let b = bounds(3630, 100, 1400, 900, false);
        assert!(!validate_saved_bounds(&b, &monitors));

        let b = bounds(3430, 100, 1400, 900, false);
        assert!(validate_saved_bounds(&b, &monitors));
    }

    #[test]
    fn maximized_true_keeps_the_restored_bounds() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        let saved = bounds(100, 100, 1400, 900, true);
        let geometry = resolve_startup_geometry(Some(saved), &monitors);
        assert_eq!(
            geometry,
            StartupGeometry::Restore {
                x: 100,
                y: 100,
                width: 1400,
                height: 900,
                maximized: true,
            }
        );
    }

    #[test]
    fn no_saved_bounds_resolves_to_default() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        assert_eq!(
            resolve_startup_geometry(None, &monitors),
            StartupGeometry::Default
        );
    }

    #[test]
    fn offscreen_saved_bounds_resolve_to_default() {
        let monitors = [monitor(0, 0, 1920, 1080, 1.0)];
        let saved = bounds(5000, 5000, 1400, 900, false);
        assert_eq!(
            resolve_startup_geometry(Some(saved), &monitors),
            StartupGeometry::Default
        );
    }

    #[test]
    fn missing_window_json_returns_none_without_a_panic() {
        let dir = std::env::temp_dir().join(format!(
            "houston-window-state-test-missing-{}",
            std::process::id()
        ));
        assert!(load_saved_bounds(&dir).is_none());
    }

    #[test]
    fn corrupt_window_json_returns_none_without_a_panic() {
        let dir = std::env::temp_dir().join(format!(
            "houston-window-state-test-corrupt-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        fs::write(dir.join("window.json"), b"{not json").expect("write corrupt file");
        assert!(load_saved_bounds(&dir).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_window_json_returns_none_without_a_panic() {
        let dir = std::env::temp_dir().join(format!(
            "houston-window-state-test-empty-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        fs::write(dir.join("window.json"), b"").expect("write empty file");
        assert!(load_saved_bounds(&dir).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "houston-window-state-test-roundtrip-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        let b = bounds(12, 34, 1400, 900, true);
        save_bounds(&dir, &b).expect("save must succeed");
        assert_eq!(load_saved_bounds(&dir), Some(b));
        fs::remove_dir_all(&dir).ok();
    }
}

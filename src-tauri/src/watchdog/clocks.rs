use std::time::Duration;

// Three clocks, not two: `mono` is frozen during suspend, `boot` advances
// through it, `wall` is steppable. No watchdog deadline is ever computed
// from `wall` -- only from `mono` -- so an NTP step can't fake a timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockSample {
    pub mono_ms: u64,
    pub boot_ms: u64,
    pub wall_ms: u64,
}

pub trait Clocks: Send + 'static {
    fn sample(&self) -> ClockSample;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClocks;

impl SystemClocks {
    #[cfg(target_os = "linux")]
    fn boot_ms() -> u64 {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid local `timespec`; the syscall only writes through it.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts) };
        if rc != 0 {
            return Self::mono_ms();
        }
        (ts.tv_sec as u64)
            .saturating_mul(1_000)
            .saturating_add(ts.tv_nsec as u64 / 1_000_000)
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    fn boot_ms() -> u64 {
        Self::mono_ms()
    }

    #[cfg(windows)]
    fn boot_ms() -> u64 {
        let mut now: u64 = 0;
        // SAFETY: `now` is a valid local `u64`; the call only writes through it.
        unsafe {
            windows_sys::Win32::System::WindowsProgramming::QueryInterruptTime(&mut now);
        }
        now / 10_000
    }

    #[cfg(target_os = "linux")]
    fn mono_ms() -> u64 {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `ts` is a valid local `timespec`; the syscall only writes through it.
        let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
        if rc != 0 {
            return 0;
        }
        (ts.tv_sec as u64)
            .saturating_mul(1_000)
            .saturating_add(ts.tv_nsec as u64 / 1_000_000)
    }

    #[cfg(not(target_os = "linux"))]
    fn mono_ms() -> u64 {
        use std::sync::OnceLock;
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ORIGIN
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as u64
    }

    fn wall_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

impl Clocks for SystemClocks {
    fn sample(&self) -> ClockSample {
        ClockSample {
            mono_ms: Self::mono_ms(),
            boot_ms: Self::boot_ms(),
            wall_ms: Self::wall_ms(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ClockVerdict {
    pub suspended_ms: Option<u64>,
    pub wall_step_ms: Option<i64>,
    pub starved_by_ms: Option<u64>,
    pub mono_delta_ms: u64,
}

impl ClockVerdict {
    pub fn is_quiet(&self) -> bool {
        self.suspended_ms.is_none() && self.wall_step_ms.is_none() && self.starved_by_ms.is_none()
    }
}

#[derive(Debug)]
pub struct ClockClassifier {
    prev: Option<ClockSample>,
    tick: Duration,
    suspend_threshold_ms: u64,
    wall_step_threshold_ms: u64,
}

impl ClockClassifier {
    pub fn new(tick: Duration, suspend_threshold_ms: u64, wall_step_threshold_ms: u64) -> Self {
        Self {
            prev: None,
            tick,
            suspend_threshold_ms,
            wall_step_threshold_ms,
        }
    }

    pub fn classify(&mut self, now: ClockSample) -> ClockVerdict {
        let expected = self.tick.as_millis() as u64;
        let Some(prev) = self.prev.replace(now) else {
            return ClockVerdict::default();
        };

        let dm = now.mono_ms.saturating_sub(prev.mono_ms);
        let db = now.boot_ms.saturating_sub(prev.boot_ms);
        let dw = (now.wall_ms as i64) - (prev.wall_ms as i64);

        let suspend_divergence = db.saturating_sub(dm);
        let suspended_ms =
            (suspend_divergence >= self.suspend_threshold_ms).then_some(suspend_divergence);

        let wall_vs_boot = dw - (db as i64);
        let wall_step_ms =
            (wall_vs_boot.unsigned_abs() >= self.wall_step_threshold_ms).then_some(wall_vs_boot);

        let overshoot = dm.saturating_sub(expected);
        let starved_by_ms = (overshoot >= expected && suspended_ms.is_none()).then_some(overshoot);

        ClockVerdict {
            suspended_ms,
            wall_step_ms,
            starved_by_ms,
            mono_delta_ms: dm,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK_MS: u64 = 1_000;
    const SUSPEND_MS: u64 = 2_000;

    fn classifier() -> ClockClassifier {
        ClockClassifier::new(Duration::from_millis(TICK_MS), SUSPEND_MS, SUSPEND_MS)
    }

    fn sample(mono: u64, boot: u64, wall: u64) -> ClockSample {
        ClockSample {
            mono_ms: mono,
            boot_ms: boot,
            wall_ms: wall,
        }
    }

    fn run(seq: &[ClockSample]) -> Vec<ClockVerdict> {
        let mut c = classifier();
        seq.iter().map(|s| c.classify(*s)).skip(1).collect()
    }

    #[test]
    fn first_sample_is_always_quiet() {
        let mut c = classifier();
        let v = c.classify(sample(9_999_999, 9_999_999, 1_700_000_000_000));
        assert!(
            v.is_quiet(),
            "startup must not classify as an anomaly: {v:?}"
        );
    }

    #[test]
    fn normal_tick_is_quiet() {
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 6_000, 1_700_000_001_000),
        ]);
        assert!(v[0].is_quiet(), "{v:?}");
        assert_eq!(v[0].mono_delta_ms, 1_000);
    }

    #[test]
    fn three_hour_suspend_is_classified_as_suspend_only() {
        let three_hours = 3 * 60 * 60 * 1_000;
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 5_000 + three_hours, 1_700_000_000_000 + three_hours),
        ])[0];
        assert_eq!(v.suspended_ms, Some(three_hours - 1_000));
        assert_eq!(v.wall_step_ms, None, "a suspend must not read as a step");
        assert_eq!(
            v.starved_by_ms, None,
            "a suspend must not read as starvation"
        );
    }

    #[test]
    fn ntp_step_forward_is_a_step_only() {
        let two_hours = 2 * 60 * 60 * 1_000;
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 6_000, 1_700_000_001_000 + two_hours),
        ])[0];
        assert_eq!(v.suspended_ms, None);
        assert_eq!(v.wall_step_ms, Some(two_hours as i64));
    }

    #[test]
    fn ntp_step_backward_is_a_signed_step() {
        let two_hours = 2 * 60 * 60 * 1_000i64;
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 6_000, (1_700_000_001_000i64 - two_hours) as u64),
        ])[0];
        assert_eq!(v.suspended_ms, None);
        assert_eq!(v.wall_step_ms, Some(-two_hours));
    }

    #[test]
    fn simultaneous_suspend_and_step_classify_independently() {
        let three_hours = 3 * 60 * 60 * 1_000;
        let two_hours = 2 * 60 * 60 * 1_000;
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(
                2_000,
                5_000 + three_hours,
                1_700_000_000_000 + three_hours + two_hours,
            ),
        ])[0];
        assert_eq!(v.suspended_ms, Some(three_hours - 1_000));
        assert_eq!(v.wall_step_ms, Some(two_hours as i64));
    }

    #[test]
    fn starved_tick_is_classified_as_starvation_not_suspend() {
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(5_000, 9_000, 1_700_000_004_000),
        ])[0];
        assert_eq!(v.suspended_ms, None);
        assert_eq!(v.wall_step_ms, None);
        assert_eq!(v.starved_by_ms, Some(3_000));
    }

    #[test]
    fn suspend_does_not_also_report_starvation() {
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(60_000, 3_600_000, 1_700_003_600_000),
        ])[0];
        assert!(v.suspended_ms.is_some());
        assert_eq!(
            v.starved_by_ms, None,
            "starvation is suppressed when a suspend explains the gap"
        );
    }

    #[test]
    fn exactly_at_the_suspend_threshold_classifies() {
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 6_000 + SUSPEND_MS, 1_700_000_001_000 + SUSPEND_MS),
        ])[0];
        assert_eq!(
            v.suspended_ms,
            Some(SUSPEND_MS),
            "the threshold is inclusive (>=), per spec §4"
        );
    }

    #[test]
    fn one_ms_below_the_suspend_threshold_stays_quiet() {
        let below = SUSPEND_MS - 1;
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_000, 6_000 + below, 1_700_000_001_000 + below),
        ])[0];
        assert_eq!(v.suspended_ms, None);
        assert!(v.is_quiet(), "{v:?}");
    }

    #[test]
    fn small_jitter_is_not_a_step() {
        let v = run(&[
            sample(1_000, 5_000, 1_700_000_000_000),
            sample(2_050, 6_050, 1_700_000_001_040),
        ])[0];
        assert!(v.is_quiet(), "{v:?}");
    }

    #[test]
    fn backwards_monotonic_clock_does_not_panic() {
        let v = run(&[
            sample(5_000, 9_000, 1_700_000_000_000),
            sample(1_000, 9_500, 1_700_000_000_500),
        ])[0];
        assert_eq!(v.mono_delta_ms, 0, "saturated rather than wrapped");
        assert_eq!(v.suspended_ms, None, "500 ms is below T_suspend");
        assert_eq!(v.wall_step_ms, None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_boot_clock_tracks_the_monotonic_one() {
        let a = SystemClocks.sample();
        std::thread::sleep(Duration::from_millis(50));
        let b = SystemClocks.sample();
        let d_mono = b.mono_ms - a.mono_ms;
        let d_boot = b.boot_ms - a.boot_ms;
        assert!(
            a.boot_ms >= a.mono_ms,
            "biased interrupt time must never trail unbiased: {a:?}"
        );
        assert!(
            d_mono <= d_boot + 5,
            "boot advanced less than mono across an awake interval: {d_mono} vs {d_boot}"
        );
        let div_before = a.boot_ms - a.mono_ms;
        let div_after = b.boot_ms - b.mono_ms;
        assert!(
            div_after.abs_diff(div_before) < 100,
            "divergence moved too much while awake: {div_before} -> {div_after}"
        );
    }
}

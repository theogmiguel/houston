//! When a run wraps up and stops, from Run now's duration or from the
//! routine's local clock window.
use anyhow::{bail, Result};
use houston_protocol::{
    NightClock, NightWindow, NIGHT_SHIFT_WINDOW_MAX_MINUTES, NIGHT_SHIFT_WRAP_UP_LEAD_MINUTES,
};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunWindow {
    pub wrap_up_at_ms: i64,
    pub hard_stop_at_ms: i64,
}

/// Run now: the hard stop is `until_ms`; wrap-up comes the lead before it, or
/// at three quarters of a run shorter than an hour.
pub fn run_now(now_ms: i64, until_ms: i64) -> Result<RunWindow> {
    let span = until_ms - now_ms;
    if span < MINUTE_MS {
        bail!(
            "a Night shift run needs at least one minute; the hard stop {until_ms} is {} s from \
             now",
            span / 1000
        );
    }
    let max = i64::from(NIGHT_SHIFT_WINDOW_MAX_MINUTES) * MINUTE_MS;
    if span > max {
        bail!(
            "a Night shift run of {} min is longer than the {} h limit",
            span / MINUTE_MS,
            NIGHT_SHIFT_WINDOW_MAX_MINUTES / 60
        );
    }
    let wrap_up_at_ms = if span < 60 * MINUTE_MS {
        now_ms + span * 3 / 4
    } else {
        until_ms - i64::from(NIGHT_SHIFT_WRAP_UP_LEAD_MINUTES) * MINUTE_MS
    };
    Ok(RunWindow {
        wrap_up_at_ms,
        hard_stop_at_ms: until_ms,
    })
}

/// A run's instants as the local clock window it covers, for checks that
/// reason in clock times.
pub fn clock_window(
    start_ms: i64,
    run: &RunWindow,
    offset: impl Fn(i64) -> i64,
) -> NightWindow {
    let clock = |ms: i64| {
        let minute = (ms + offset(ms)).rem_euclid(DAY_MS) / MINUTE_MS;
        NightClock {
            hour: (minute / 60) as u8,
            minute: (minute % 60) as u8,
        }
    };
    NightWindow {
        start: clock(start_ms),
        wrap_up: clock(run.wrap_up_at_ms),
        hard_stop: clock(run.hard_stop_at_ms),
        nights: Vec::new(),
    }
}

/// The first instant at or after `after_ms` whose local clock reads `c`.
fn next_local(after_ms: i64, c: NightClock, offset_ms: i64) -> i64 {
    let local = after_ms + offset_ms;
    let day = local.div_euclid(DAY_MS) * DAY_MS;
    let target = i64::from(c.hour) * 3_600_000 + i64::from(c.minute) * MINUTE_MS;
    let mut at = day + target;
    if at < local {
        at += DAY_MS;
    }
    at - offset_ms
}

/// A scheduled run that was due at `due_ms`: wrap-up and hard stop are the
/// next local clock times after it.
pub fn scheduled(due_ms: i64, w: &NightWindow) -> RunWindow {
    let offset = local_offset_ms(due_ms);
    RunWindow {
        wrap_up_at_ms: next_local(due_ms, w.wrap_up, offset),
        hard_stop_at_ms: next_local(due_ms, w.hard_stop, offset),
    }
}

/// The next scheduled start at or after `now_ms` on one of `nights`; `None`
/// when no night is selected.
pub fn next_start(now_ms: i64, w: &NightWindow) -> Option<i64> {
    if w.nights.is_empty() {
        return None;
    }
    let offset = local_offset_ms(now_ms);
    let mut at = next_local(now_ms, w.start, offset);
    for _ in 0..8 {
        let weekday = ((at + offset).div_euclid(DAY_MS) + 4).rem_euclid(7) as u8 + 1;
        if w.nights.contains(&weekday) {
            return Some(at);
        }
        at += DAY_MS;
    }
    None
}

/// Local time minus UTC at `at_ms`, daylight saving included.
#[cfg(unix)]
pub fn local_offset_ms(at_ms: i64) -> i64 {
    let secs = at_ms.div_euclid(1000) as libc::time_t;
    // SAFETY: `tm` is plain data and zero is a valid value; `localtime_r` only
    // reads its argument and the process time zone.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return 0;
    }
    tm.tm_gmtoff * 1000
}

#[cfg(windows)]
pub fn local_offset_ms(at_ms: i64) -> i64 {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{
        FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTime,
    };
    const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
    let ticks = at_ms * 10_000 + EPOCH_DIFF_100NS;
    let ft = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    // SAFETY: every pointer is to a local of the declared type; a null time
    // zone means the active one.
    unsafe {
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        let mut local: SYSTEMTIME = std::mem::zeroed();
        let mut local_ft: FILETIME = std::mem::zeroed();
        if FileTimeToSystemTime(&ft, &mut utc) == 0
            || SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0
            || SystemTimeToFileTime(&local, &mut local_ft) == 0
        {
            return 0;
        }
        let local_ticks =
            (i64::from(local_ft.dwHighDateTime) << 32) | i64::from(local_ft.dwLowDateTime);
        (local_ticks - ticks) / 10_000
    }
}

#[cfg(not(any(unix, windows)))]
pub fn local_offset_ms(_at_ms: i64) -> i64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn run_now_window() {
        let w = run_now(NOW, NOW + 8 * 3_600_000).unwrap();
        assert_eq!(w.hard_stop_at_ms, NOW + 8 * 3_600_000);
        assert_eq!(w.wrap_up_at_ms, NOW + 8 * 3_600_000 - 45 * MINUTE_MS);
        let w = run_now(NOW, NOW + 40 * MINUTE_MS).unwrap();
        assert_eq!(w.hard_stop_at_ms, NOW + 40 * MINUTE_MS);
        assert_eq!(w.wrap_up_at_ms, NOW + 30 * MINUTE_MS, "75 % of 40 min");
        let w = run_now(NOW, NOW + 60 * MINUTE_MS).unwrap();
        assert_eq!(
            w.wrap_up_at_ms,
            NOW + 15 * MINUTE_MS,
            "an hour takes the lead"
        );
        let err = format!("{:#}", run_now(NOW, NOW + 17 * 3_600_000).unwrap_err());
        assert!(err.contains("16 h") && err.contains("1020 min"), "{err}");
        assert!(run_now(NOW, NOW - 1).is_err());
    }

    fn at(hour: u8, minute: u8) -> NightClock {
        NightClock { hour, minute }
    }

    #[test]
    fn next_local_crosses_midnight() {
        let midnight = 1_790_035_200_000 - 1_790_035_200_000 % DAY_MS;
        let late = midnight + 23 * 3_600_000 + 30 * MINUTE_MS;
        assert_eq!(
            next_local(late, at(7, 30), 0),
            midnight + DAY_MS + 7 * 3_600_000 + 30 * MINUTE_MS
        );
        assert_eq!(next_local(late, at(23, 30), 0), late);
        assert_eq!(
            next_local(late, at(23, 30), 3_600_000),
            late + 23 * 3_600_000,
            "an hour east it is already 00:30 local, so the next 23:30 is a day on"
        );
    }

    #[test]
    fn next_start_honours_nights() {
        let w = NightWindow {
            start: at(23, 30),
            wrap_up: at(6, 45),
            hard_stop: at(7, 30),
            nights: Vec::new(),
        };
        assert_eq!(next_start(NOW, &w), None);
        let all = NightWindow {
            nights: (1..=7).collect(),
            ..w.clone()
        };
        let one = NightWindow {
            nights: vec![3],
            ..w
        };
        let a = next_start(NOW, &all).unwrap();
        let b = next_start(NOW, &one).unwrap();
        assert!(a >= NOW && a - NOW <= DAY_MS);
        assert!(b >= a && b - NOW <= 7 * DAY_MS);
    }
}

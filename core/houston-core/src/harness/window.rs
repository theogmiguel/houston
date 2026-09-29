//! Which days a digest reads: a fortnight the first time, then from the previous
//! run's end, never under a week (too few sessions to see recurrence) nor over a
//! month (a digest that no longer fits one reading).
use anyhow::{bail, Result};

pub const DAY_MS: i64 = 86_400_000;
pub const FIRST_RUN_DAYS: i64 = 14;
pub const MIN_DAYS: i64 = 7;
pub const MAX_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub since_ms: i64,
    pub until_ms: i64,
}

/// `YYYY-MM-DD` as midnight UTC.
pub fn parse_day(s: &str) -> Result<i64> {
    match crate::usage::time::parse_rfc3339_ms(&format!("{s}T00:00:00Z")) {
        Some(ms) if s.len() == 10 => Ok(ms),
        _ => bail!("{s:?} is not a date; expected YYYY-MM-DD, for example 2026-09-10"),
    }
}

/// `since` from its midnight to the end of `until`'s day, both inclusive.
pub fn explicit(since: &str, until: &str) -> Result<Window> {
    let since_ms = parse_day(since)?;
    let until_ms = parse_day(until)? + DAY_MS;
    if until_ms <= since_ms {
        bail!("--until {until} is before --since {since}; the window has to run forwards");
    }
    let days = (until_ms - since_ms) / DAY_MS;
    if days > MAX_DAYS {
        bail!(
            "--since {since} --until {until} spans {days} days; a digest reads at most \
             {MAX_DAYS} days, so narrow the window"
        );
    }
    Ok(Window { since_ms, until_ms })
}

/// `previous_until_ms` is the end of the most recent earlier run's window.
pub fn automatic(now_ms: i64, previous_until_ms: Option<i64>) -> Window {
    let since_ms = match previous_until_ms {
        None => now_ms - FIRST_RUN_DAYS * DAY_MS,
        Some(prev) => prev.clamp(now_ms - MAX_DAYS * DAY_MS, now_ms - MIN_DAYS * DAY_MS),
    };
    Window {
        since_ms,
        until_ms: now_ms,
    }
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// RFC 3339 UTC with seconds, the shape the transcripts themselves use.
pub fn format_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn explicit_window_bounds() {
        let w = explicit("2026-09-10", "2026-09-17").unwrap();
        assert_eq!(format_ms(w.since_ms), "2026-09-10T00:00:00Z");
        assert_eq!(format_ms(w.until_ms), "2026-09-18T00:00:00Z");

        let inverted = explicit("2026-09-17", "2026-09-10")
            .unwrap_err()
            .to_string();
        assert!(inverted.contains("2026-09-10") && inverted.contains("2026-09-17"));

        let long = explicit("2026-08-01", "2026-08-31")
            .unwrap_err()
            .to_string();
        assert!(long.contains("31 days"), "{long}");
        assert!(long.contains("30"), "{long}");

        assert!(
            explicit("2026-08-01", "2026-08-30").is_ok(),
            "30 days passes"
        );
        assert!(explicit("2026-9-1", "2026-09-10").is_err());
    }

    #[test]
    fn first_run_reads_fourteen_days() {
        let w = automatic(NOW, None);
        assert_eq!(w.until_ms, NOW);
        assert_eq!(w.since_ms, NOW - 14 * DAY_MS);
    }

    #[test]
    fn later_runs_clamp_between_seven_and_thirty_days() {
        assert_eq!(
            automatic(NOW, Some(NOW - 2 * DAY_MS)).since_ms,
            NOW - 7 * DAY_MS
        );
        assert_eq!(
            automatic(NOW, Some(NOW - 10 * DAY_MS)).since_ms,
            NOW - 10 * DAY_MS
        );
        assert_eq!(
            automatic(NOW, Some(NOW - 45 * DAY_MS)).since_ms,
            NOW - 30 * DAY_MS
        );
    }

    #[test]
    fn format_round_trips_through_the_transcript_parser() {
        let ms = crate::usage::time::parse_rfc3339_ms("2026-02-28T23:59:07Z").unwrap();
        assert_eq!(format_ms(ms), "2026-02-28T23:59:07Z");
        let leap = crate::usage::time::parse_rfc3339_ms("2024-02-29T00:00:00Z").unwrap();
        assert_eq!(format_ms(leap), "2024-02-29T00:00:00Z");
    }
}

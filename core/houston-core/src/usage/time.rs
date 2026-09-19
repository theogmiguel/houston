//! Both CLIs stamp transcript lines with RFC 3339 strings, and the daemon
//! buckets by UTC hour rather than calendar day, so nothing here needs a time
//! zone — the renderer folds hours into local days with `Intl`. No `chrono`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() {
        return None;
    }
    let mut acc: i64 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc * 10 + i64::from(b - b'0');
    }
    Some(acc)
}

/// Truncates fractional seconds to milliseconds and never rounds — the value is
/// only ever used for ordering and hour bucketing. Returns `None` rather than
/// guessing: a mis-parsed stamp files a turn under the wrong hour silently.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || (b[10] != b'T' && b[10] != b't' && b[10] != b' ') {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut rest = &b[19..];
    let mut millis: i64 = 0;
    if rest.first() == Some(&b'.') || rest.first() == Some(&b',') {
        let frac: &[u8] = rest[1..]
            .iter()
            .position(|c| !c.is_ascii_digit())
            .map_or(&rest[1..], |end| &rest[1..1 + end]);
        if frac.is_empty() {
            return None;
        }
        let mut scaled: i64 = 0;
        // Nanosecond stamps must not round up into the next millisecond: the
        // value is only ever used for ordering and hour bucketing.
        for i in 0..3 {
            scaled = scaled * 10 + frac.get(i).map_or(0, |&c| i64::from(c - b'0'));
        }
        millis = scaled;
        rest = &rest[1 + frac.len()..];
    }

    let offset_minutes: i64 = match rest.first() {
        None => 0,
        Some(&b'Z') | Some(&b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            if rest.len() < 6 || rest[3] != b':' {
                return None;
            }
            let oh = digits(&rest[1..3])?;
            let om = digits(&rest[4..6])?;
            if oh > 23 || om > 59 {
                return None;
            }
            let magnitude = oh * 60 + om;
            if sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        Some(_) => return None,
    };

    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second.min(59) - offset_minutes * 60;
    Some(secs * 1_000 + millis)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub const HOUR_MS: i64 = 3_600_000;

pub fn floor_hour_ms(ms: i64) -> i64 {
    ms.div_euclid(HOUR_MS) * HOUR_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_two_shapes_transcripts_actually_use() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.001Z"), Some(1));
        assert_eq!(
            parse_rfc3339_ms("2026-08-27T13:19:04.123Z"),
            Some(1_787_836_744_123)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-08-27T10:19:04.123-03:00"),
            parse_rfc3339_ms("2026-08-27T13:19:04.123Z")
        );
        assert_eq!(
            parse_rfc3339_ms("2026-08-27T14:19:04+01:00"),
            parse_rfc3339_ms("2026-08-27T13:19:04Z")
        );
    }

    #[test]
    fn truncates_sub_millisecond_precision_instead_of_rounding() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.999999Z"), Some(999));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.1Z"), Some(100));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00.05Z"), Some(50));
    }

    #[test]
    fn rejects_rather_than_guesses() {
        assert_eq!(parse_rfc3339_ms(""), None);
        assert_eq!(parse_rfc3339_ms("2026-08-27"), None);
        assert_eq!(parse_rfc3339_ms("2026-08-27T13:19:04.Z"), None);
        assert_eq!(parse_rfc3339_ms("2026-13-27T13:19:04Z"), None);
        assert_eq!(parse_rfc3339_ms("2026-08-27T24:19:04Z"), None);
        assert_eq!(parse_rfc3339_ms("2026-08-27T13:19:04+0100"), None);
        assert_eq!(parse_rfc3339_ms("not a timestamp at all"), None);
    }

    #[test]
    fn handles_leap_days_and_century_boundaries() {
        assert_eq!(
            parse_rfc3339_ms("2000-03-01T00:00:00Z").unwrap()
                - parse_rfc3339_ms("2000-02-28T00:00:00Z").unwrap(),
            2 * 86_400_000
        );
        assert_eq!(
            parse_rfc3339_ms("1900-03-01T00:00:00Z").unwrap()
                - parse_rfc3339_ms("1900-02-28T00:00:00Z").unwrap(),
            86_400_000
        );
    }

    #[test]
    fn floors_hours_on_both_sides_of_the_epoch() {
        assert_eq!(floor_hour_ms(0), 0);
        assert_eq!(floor_hour_ms(HOUR_MS - 1), 0);
        assert_eq!(floor_hour_ms(HOUR_MS), HOUR_MS);
        assert_eq!(floor_hour_ms(-1), -HOUR_MS);
    }
}

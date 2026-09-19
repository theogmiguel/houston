use anyhow::{bail, Result};
use houston_protocol::{Cadence, ChatPermissionMode};
use sha2::{Digest, Sha256};

pub use houston_protocol::{
    ROUTINES_TOTAL, ROUTINE_LAST_ERROR_MAX, ROUTINE_MIN_INTERVAL_SECS, ROUTINE_NAME_MAX,
    ROUTINE_PROMPT_MAX, ROUTINE_RUNS_CONCURRENT, ROUTINE_RUN_MAX_MS, ROUTINE_TICK_MS,
};

pub fn check_total_count(existing: u32) -> Result<(), (u32, u32)> {
    let requested = existing + 1;
    if requested > ROUTINES_TOTAL {
        Err((ROUTINES_TOTAL, requested))
    } else {
        Ok(())
    }
}

pub fn fold_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_space = false;
    for ch in name.trim().chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        for lower in ch.to_lowercase() {
            fold_char(lower, &mut out);
        }
    }
    out
}

fn fold_char(c: char, out: &mut String) {
    let folded: &str = match c {
        'à'..='å' => "a",
        'æ' => "ae",
        'ç' => "c",
        'è'..='ë' => "e",
        'ì'..='ï' => "i",
        'ð' => "d",
        'ñ' => "n",
        'ò'..='ö' | 'ø' => "o",
        'ù'..='ü' => "u",
        'ý' | 'ÿ' => "y",
        'ß' => "ss",
        'þ' => "th",
        '\u{0100}'..='\u{0105}' => "a",
        '\u{0106}'..='\u{010D}' => "c",
        '\u{010E}'..='\u{0111}' => "d",
        '\u{0112}'..='\u{011B}' => "e",
        '\u{011C}'..='\u{0123}' => "g",
        '\u{0124}'..='\u{0127}' => "h",
        '\u{0128}'..='\u{0131}' => "i",
        '\u{0132}'..='\u{0133}' => "ij",
        '\u{0134}'..='\u{0135}' => "j",
        '\u{0136}'..='\u{0138}' => "k",
        '\u{0139}'..='\u{0142}' => "l",
        '\u{0143}'..='\u{014B}' => "n",
        '\u{014C}'..='\u{0151}' => "o",
        '\u{0152}'..='\u{0153}' => "oe",
        '\u{0154}'..='\u{0159}' => "r",
        '\u{015A}'..='\u{0161}' => "s",
        '\u{0162}'..='\u{0167}' => "t",
        '\u{0168}'..='\u{0173}' => "u",
        '\u{0174}'..='\u{0175}' => "w",
        '\u{0176}'..='\u{0178}' => "y",
        '\u{0179}'..='\u{017E}' => "z",
        '\u{017F}' => "s",
        '\u{0300}'..='\u{036F}' => "",
        other => {
            out.push(other);
            return;
        }
    };
    out.push_str(folded);
}

pub fn validate_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        bail!("a routine needs a non-empty name");
    }
    let len = name.chars().count();
    if len > ROUTINE_NAME_MAX {
        bail!("routine name is {len} chars; the cap is {ROUTINE_NAME_MAX}");
    }
    Ok(name)
}

pub fn validate_prompt(prompt: &str) -> Result<()> {
    if prompt.trim().is_empty() {
        bail!("a routine needs a non-empty prompt");
    }
    let len = prompt.chars().count();
    if len > ROUTINE_PROMPT_MAX {
        bail!("routine prompt is {len} chars; the cap is {ROUTINE_PROMPT_MAX}");
    }
    Ok(())
}

pub fn validate_cadence(cadence: &Cadence) -> Result<()> {
    match cadence {
        Cadence::Interval { seconds } => {
            if *seconds < ROUTINE_MIN_INTERVAL_SECS {
                bail!(
                    "routine interval is {seconds} s; the floor is {ROUTINE_MIN_INTERVAL_SECS} s \
                     (every tick spawns a real agent session and spends real tokens)"
                );
            }
        }
        Cadence::Clock {
            hour,
            minute,
            weekdays,
        } => {
            if *hour > 23 {
                bail!("routine clock hour is {hour}; expected 0..=23");
            }
            if *minute > 59 {
                bail!("routine clock minute is {minute}; expected 0..=59");
            }
            if let Some(days) = weekdays {
                if days.is_empty() {
                    bail!(
                        "routine weekdays is an empty list, which could never run; omit it for \
                         daily or name at least one day (1 = Sunday … 7 = Saturday)"
                    );
                }
                if let Some(bad) = days.iter().find(|d| !(1..=7).contains(*d)) {
                    bail!(
                        "routine weekday {bad} is out of range; expected 1 = Sunday … 7 = Saturday"
                    );
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockNow {
    pub weekday: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

pub fn days_until_clock(now: ClockNow, hour: u8, minute: u8, weekdays: Option<&[u8]>) -> u32 {
    let allowed = |wd: u8| match weekdays {
        Some(days) if !days.is_empty() => days.contains(&wd),
        _ => true,
    };
    let now_secs = u32::from(now.hour) * 3600 + u32::from(now.minute) * 60 + u32::from(now.second);
    let target_secs = u32::from(hour) * 3600 + u32::from(minute) * 60;
    for days in 0..=7u32 {
        if days == 0 && target_secs < now_secs {
            continue;
        }
        let wd = ((u32::from(now.weekday) - 1 + days) % 7 + 1) as u8;
        if allowed(wd) {
            return days;
        }
    }
    7
}

pub fn next_run_at_ms(cadence: &Cadence, now_ms: i64) -> i64 {
    let next = match cadence {
        Cadence::Interval { seconds } => now_ms.saturating_add(i64::from(*seconds) * 1000),
        Cadence::Clock {
            hour,
            minute,
            weekdays,
        } => next_clock_ms(now_ms, *hour, *minute, weekdays.as_deref()),
    };
    next.max(now_ms)
}

#[cfg(unix)]
fn next_clock_ms(now_ms: i64, hour: u8, minute: u8, weekdays: Option<&[u8]>) -> i64 {
    let now_secs = now_ms.div_euclid(1000) as libc::time_t;
    // SAFETY: `tm` is a plain C struct whose only invariant is that it is
    // initialized; zeroing satisfies that. `localtime_r` and `mktime` are
    // thread-safe and read only their argument plus the process time zone.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&now_secs, &mut tm) }.is_null() {
        return next_clock_ms_utc(now_ms, hour, minute, weekdays);
    }
    let now = ClockNow {
        weekday: tm.tm_wday as u8 + 1,
        hour: tm.tm_hour as u8,
        minute: tm.tm_min as u8,
        second: tm.tm_sec as u8,
    };
    let days = days_until_clock(now, hour, minute, weekdays);
    tm.tm_mday += days as libc::c_int;
    tm.tm_hour = libc::c_int::from(hour);
    tm.tm_min = libc::c_int::from(minute);
    tm.tm_sec = 0;
    tm.tm_isdst = -1;
    let target = unsafe { libc::mktime(&mut tm) };
    if target == -1 {
        return next_clock_ms_utc(now_ms, hour, minute, weekdays);
    }
    (target as i64) * 1000
}

#[cfg(not(unix))]
fn next_clock_ms(now_ms: i64, hour: u8, minute: u8, weekdays: Option<&[u8]>) -> i64 {
    next_clock_ms_utc(now_ms, hour, minute, weekdays)
}

fn next_clock_ms_utc(now_ms: i64, hour: u8, minute: u8, weekdays: Option<&[u8]>) -> i64 {
    const DAY: i64 = 86_400;
    let now_secs = now_ms.div_euclid(1000);
    let day_index = now_secs.div_euclid(DAY);
    let secs_today = now_secs.rem_euclid(DAY);
    let now = ClockNow {
        weekday: ((day_index + 4).rem_euclid(7) + 1) as u8,
        hour: (secs_today / 3600) as u8,
        minute: (secs_today % 3600 / 60) as u8,
        second: (secs_today % 60) as u8,
    };
    let days = i64::from(days_until_clock(now, hour, minute, weekdays));
    let target_secs = (day_index + days) * DAY + i64::from(hour) * 3600 + i64::from(minute) * 60;
    target_secs * 1000
}

#[allow(clippy::too_many_arguments)]
pub fn revision(
    name: &str,
    prompt: &str,
    cadence: &Cadence,
    enabled: bool,
    workspace_id: Option<&str>,
    engine: houston_protocol::AgentKind,
    model: Option<&str>,
    effort: Option<houston_protocol::ChatEffort>,
    permission_mode: ChatPermissionMode,
    isolate: bool,
) -> String {
    let canonical = serde_json::to_vec(&(
        name,
        prompt,
        cadence,
        enabled,
        workspace_id,
        engine,
        model,
        effort,
        permission_mode,
        isolate,
    ))
    .expect("serializing routine fields to JSON cannot fail");
    let digest = Sha256::digest(&canonical);
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interval(seconds: u32) -> Cadence {
        Cadence::Interval { seconds }
    }

    fn clock(hour: u8, minute: u8, weekdays: Option<Vec<u8>>) -> Cadence {
        Cadence::Clock {
            hour,
            minute,
            weekdays,
        }
    }

    #[test]
    fn total_cap_names_limit_and_requested() {
        assert_eq!(check_total_count(0), Ok(()));
        assert_eq!(
            check_total_count(ROUTINES_TOTAL),
            Err((ROUTINES_TOTAL, ROUTINES_TOTAL + 1))
        );
    }

    #[test]
    fn fold_name_collapses_case_whitespace_and_diacritics() {
        assert_eq!(fold_name("  Café  Du \t Monde "), "cafe du monde");
        assert_eq!(fold_name("Straße"), "strasse");
        assert_eq!(fold_name("Łódź"), "lodz");
        assert_eq!(fold_name("Ação"), "acao");
        assert_eq!(fold_name("cafe\u{0301}"), fold_name("café"));
        assert_eq!(fold_name("Привет"), "привет");
    }

    #[test]
    fn validate_name_bounds_and_trims() {
        assert_eq!(validate_name("  Nightly  ").unwrap(), "Nightly");
        let err = validate_name("   ").unwrap_err();
        assert!(format!("{err:#}").contains("non-empty"), "{err:#}");
        assert!(validate_name(&"x".repeat(ROUTINE_NAME_MAX)).is_ok());
        let err = validate_name(&"x".repeat(ROUTINE_NAME_MAX + 1)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains(&(ROUTINE_NAME_MAX + 1).to_string())
                && msg.contains(&ROUTINE_NAME_MAX.to_string()),
            "must name the length and the cap: {msg}"
        );
    }

    #[test]
    fn validate_prompt_bounds() {
        assert!(validate_prompt("do the thing").is_ok());
        assert!(validate_prompt("   ").is_err());
        let err = validate_prompt(&"p".repeat(ROUTINE_PROMPT_MAX + 1)).unwrap_err();
        assert!(
            format!("{err:#}").contains(&ROUTINE_PROMPT_MAX.to_string()),
            "{err:#}"
        );
    }

    #[test]
    fn interval_under_the_floor_is_refused_naming_both_numbers() {
        assert!(validate_cadence(&interval(ROUTINE_MIN_INTERVAL_SECS)).is_ok());
        let err = validate_cadence(&interval(ROUTINE_MIN_INTERVAL_SECS - 1)).unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains(&(ROUTINE_MIN_INTERVAL_SECS - 1).to_string())
                && msg.contains(&ROUTINE_MIN_INTERVAL_SECS.to_string()),
            "{msg}"
        );
    }

    #[test]
    fn clock_range_and_weekday_range_are_refused_by_name() {
        assert!(validate_cadence(&clock(9, 0, None)).is_ok());
        assert!(validate_cadence(&clock(23, 59, Some(vec![1, 7]))).is_ok());
        let err = validate_cadence(&clock(24, 0, None)).unwrap_err();
        assert!(format!("{err:#}").contains("24"), "{err:#}");
        let err = validate_cadence(&clock(9, 60, None)).unwrap_err();
        assert!(format!("{err:#}").contains("60"), "{err:#}");
        let err = validate_cadence(&clock(9, 0, Some(vec![0]))).unwrap_err();
        assert!(format!("{err:#}").contains("weekday 0"), "{err:#}");
        let err = validate_cadence(&clock(9, 0, Some(vec![2, 8]))).unwrap_err();
        assert!(format!("{err:#}").contains("weekday 8"), "{err:#}");
        let err = validate_cadence(&clock(9, 0, Some(vec![]))).unwrap_err();
        assert!(format!("{err:#}").contains("empty"), "{err:#}");
    }

    const TUE: u8 = 3;
    const WED: u8 = 4;

    fn at(weekday: u8, hour: u8, minute: u8, second: u8) -> ClockNow {
        ClockNow {
            weekday,
            hour,
            minute,
            second,
        }
    }

    #[test]
    fn a_clock_still_ahead_today_is_today() {
        assert_eq!(days_until_clock(at(TUE, 8, 30, 0), 9, 0, None), 0);
        assert_eq!(days_until_clock(at(TUE, 9, 0, 0), 9, 0, None), 0);
    }

    #[test]
    fn a_clock_already_passed_today_rolls_to_tomorrow() {
        assert_eq!(days_until_clock(at(TUE, 10, 0, 0), 9, 0, None), 1);
        assert_eq!(days_until_clock(at(TUE, 9, 0, 1), 9, 0, None), 1);
    }

    #[test]
    fn weekdays_skip_to_the_next_allowed_day() {
        assert_eq!(days_until_clock(at(TUE, 8, 0, 0), 9, 0, Some(&[2, 4])), 1);
        assert_eq!(days_until_clock(at(WED, 10, 0, 0), 9, 0, Some(&[4])), 7);
        assert_eq!(days_until_clock(at(WED, 8, 0, 0), 9, 0, Some(&[4])), 0);
        assert_eq!(days_until_clock(at(TUE, 8, 0, 0), 9, 0, Some(&[7])), 4);
    }

    #[test]
    fn an_absent_or_empty_weekday_list_means_daily() {
        assert_eq!(days_until_clock(at(TUE, 10, 0, 0), 9, 0, None), 1);
        assert_eq!(days_until_clock(at(TUE, 10, 0, 0), 9, 0, Some(&[])), 1);
        assert_eq!(days_until_clock(at(TUE, 8, 0, 0), 9, 0, Some(&[])), 0);
    }

    #[test]
    fn interval_next_run_is_now_plus_seconds() {
        assert_eq!(next_run_at_ms(&interval(300), 1_000_000), 1_300_000);
    }

    #[test]
    fn next_run_never_predates_now() {
        let base = 1_756_166_400_000i64;
        for k in 0..48i64 {
            let now = base + k * 3_600_000 + 17_000;
            for cadence in [
                interval(ROUTINE_MIN_INTERVAL_SECS),
                clock(9, 0, None),
                clock(0, 0, None),
                clock(23, 59, Some(vec![1])),
                clock(9, 0, Some(vec![2, 3, 4, 5, 6])),
            ] {
                let next = next_run_at_ms(&cadence, now);
                assert!(
                    next >= now,
                    "{cadence:?} at now={now} produced next={next}, which predates creation"
                );
                if let Cadence::Clock { .. } = cadence {
                    assert!(
                        next - now <= 8 * 86_400_000,
                        "{cadence:?} at now={now}: next={next} is more than 8 days out"
                    );
                    assert_eq!(next % 60_000, 0, "a clock tick lands on a whole minute");
                }
            }
        }
    }

    #[test]
    fn utc_fallback_agrees_with_the_weekday_rule() {
        let now = 1_756_202_400_000i64;
        let next = next_clock_ms_utc(now, 9, 0, None);
        assert_eq!(next, now + 23 * 3_600_000);
        let next = next_clock_ms_utc(now, 9, 0, Some(&[1]));
        assert_eq!(next, now + (5 * 24 - 1) * 3_600_000);
    }

    #[test]
    fn revision_is_stable_for_equal_content_and_moves_on_any_edit() {
        use houston_protocol::{AgentKind, ChatEffort};
        let c = interval(300);
        let mode = ChatPermissionMode::AcceptEdits;
        #[allow(clippy::too_many_arguments)]
        let rev = |name: &str,
                   prompt: &str,
                   cadence: &Cadence,
                   enabled: bool,
                   ws: Option<&str>,
                   engine: AgentKind,
                   model: Option<&str>,
                   effort: Option<ChatEffort>,
                   mode: ChatPermissionMode,
                   isolate: bool| {
            revision(
                name, prompt, cadence, enabled, ws, engine, model, effort, mode, isolate,
            )
        };
        let base = || {
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Claude,
                None,
                None,
                mode,
                false,
            )
        };
        let a = base();
        assert_eq!(a, base());
        assert_eq!(a.len(), 16);
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                false,
                None,
                AgentKind::Claude,
                None,
                None,
                mode,
                false
            ),
            "pausing changes the revision"
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &interval(600),
                true,
                None,
                AgentKind::Claude,
                None,
                None,
                mode,
                false
            )
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                Some("/w"),
                AgentKind::Claude,
                None,
                None,
                mode,
                false
            )
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Codex,
                None,
                None,
                mode,
                false
            ),
            "the engine is execution content, so it is hashed"
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Claude,
                Some("opus"),
                None,
                mode,
                false
            ),
            "so is the model"
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Claude,
                None,
                Some(ChatEffort::High),
                mode,
                false
            ),
            "so is the effort"
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Claude,
                None,
                None,
                ChatPermissionMode::BypassPermissions,
                false
            ),
            "the unattended permission mode is editable content, so it is hashed"
        );
        assert_ne!(
            a,
            rev(
                "Nightly",
                "run it",
                &c,
                true,
                None,
                AgentKind::Claude,
                None,
                None,
                mode,
                true
            ),
            "so is isolation"
        );
    }
}

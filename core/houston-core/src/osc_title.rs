use std::sync::OnceLock;

use regex::Regex;

/// Longest title accepted, in bytes: a window title is a one-line summary, and
/// past this the sequence is something else wearing a title's clothes. The carry
/// holds one whole unterminated title plus its `ESC ] 0 ;` header, and no more.
pub const MAX_TITLE_BYTES: usize = 512;

const CARRY_CAP: usize = MAX_TITLE_BYTES + 8;

const PREFIXES: [&[u8]; 2] = [b"\x1b]0;", b"\x1b]2;"];

#[derive(Debug, Default)]
pub struct OscTitleScanner {
    carry: Vec<u8>,
}

fn find_terminator(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i < buf.len() {
        match buf[i] {
            0x07 => return Some((i, 1)),
            0x1b if i + 1 < buf.len() && buf[i + 1] == b'\\' => return Some((i, 2)),
            // An ESC that is not the start of an ST aborts the sequence: a new
            // escape sequence began, so the title never terminated.
            0x1b if i + 1 < buf.len() => return None,
            _ => i += 1,
        }
    }
    None
}

fn match_prefix(tail: &[u8]) -> (Option<usize>, bool) {
    let mut partial = false;
    for prefix in PREFIXES {
        if tail.len() >= prefix.len() {
            if tail.starts_with(prefix) {
                return (Some(prefix.len()), false);
            }
        } else if prefix.starts_with(tail) {
            partial = true;
        }
    }
    (None, partial)
}

impl OscTitleScanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Option<String> {
        if self.carry.is_empty()
            && memchr::memmem::find(chunk, b"\x1b]").is_none()
            && !ends_with_partial(chunk)
        {
            return None;
        }
        let owned: Vec<u8>;
        let work: &[u8] = if self.carry.is_empty() {
            chunk
        } else {
            let mut c = std::mem::take(&mut self.carry);
            c.extend_from_slice(chunk);
            owned = c;
            owned.as_slice()
        };

        let mut latest: Option<String> = None;
        let mut pos = 0usize;
        let mut new_carry: Option<usize> = None;
        while let Some(esc_rel) = memchr::memchr(0x1b, &work[pos..]) {
            let esc = pos + esc_rel;
            let tail = &work[esc..];
            let (body_at, partial) = match_prefix(tail);
            let Some(body_at) = body_at else {
                if partial {
                    new_carry = Some(esc);
                    break;
                }
                pos = esc + 1;
                continue;
            };
            match find_terminator(work, esc + body_at) {
                Some((term, term_len)) => {
                    let body = &work[esc + body_at..term];
                    if body.len() <= MAX_TITLE_BYTES {
                        latest = Some(String::from_utf8_lossy(body).into_owned());
                    }
                    pos = term + term_len;
                }
                None => {
                    new_carry = Some(esc);
                    break;
                }
            }
        }
        if let Some(at) = new_carry {
            if work.len() - at <= CARRY_CAP {
                self.carry = work[at..].to_vec();
            }
        }
        latest
    }
}

fn ends_with_partial(chunk: &[u8]) -> bool {
    chunk.last() == Some(&0x1b) || chunk.ends_with(b"\x1b]")
}

pub fn sanitize(raw: &str, app: Option<&str>, max_len: usize) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut text = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    if let Some(app) = app {
        if app.eq_ignore_ascii_case("grok") && grok_spinner_title(&text) {
            return None;
        }
    }

    text = text
        .trim_start_matches(|c: char| c.is_whitespace() || is_decoration_glyph(c))
        .to_string();

    if let Some(app) = app {
        if app.eq_ignore_ascii_case("opencode") {
            text = strip_opencode_prefix(&text);
        }
        text = strip_app_suffix(&text, app);
        if names_the_app(&text, app) {
            return None;
        }
    }

    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(crate::pane_name::truncate_at_word_boundary(text, max_len))
}

fn is_decoration_glyph(c: char) -> bool {
    matches!(c, '\u{2800}'..='\u{28FF}')
        || matches!(
            c,
            '·' | '✢'
                | '✳'
                | '✶'
                | '✻'
                | '✽'
                | '◐'
                | '◓'
                | '◑'
                | '◒'
                | '✦'
                | '⏲'
                | '◇'
                | '✋'
                | '▣'
                | '⚠'
                | '⏳'
                | '✓'
        )
        || matches!(c, '\u{FE0E}' | '\u{FE0F}')
}

fn strip_opencode_prefix(text: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(?:[^|]+\|\s*)?OC\s*\|\s*").expect("static OpenCode prefix regex")
    });
    re.replace(text, "").into_owned()
}

fn grok_spinner_title(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^[\u{2800}-\u{28ff}]+\s*-\s*.+?\s*-\s*grok\s*$")
            .expect("static Grok spinner title regex")
    });
    re.is_match(text)
}

/// True when the title is the CLI's own name, alone or followed by one more word
/// (`Claude Code`): a CLI announcing itself is not naming the session, so it must
/// fall through rather than rename every pane after the program.
fn names_the_app(text: &str, app: &str) -> bool {
    let mut words = text.split_whitespace();
    let Some(first) = words.next() else {
        return false;
    };
    first.eq_ignore_ascii_case(app) && words.count() <= 1
}

fn strip_app_suffix(text: &str, app: &str) -> String {
    for sep in [" — ", " – ", " - "] {
        if let Some(at) = text.rfind(sep) {
            let tail = &text[at + sep.len()..];
            if tail.trim().to_lowercase().starts_with(&app.to_lowercase()) {
                return text[..at].to_string();
            }
        }
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_one(bytes: &[u8]) -> Option<String> {
        OscTitleScanner::new().feed(bytes)
    }

    #[test]
    fn osc_0_and_osc_2_are_both_titles_with_either_terminator() {
        assert_eq!(feed_one(b"\x1b]0;hello\x07").as_deref(), Some("hello"));
        assert_eq!(feed_one(b"\x1b]2;hello\x07").as_deref(), Some("hello"));
        assert_eq!(feed_one(b"\x1b]0;hello\x1b\\").as_deref(), Some("hello"));
        assert_eq!(feed_one(b"\x1b]2;hello\x1b\\").as_deref(), Some("hello"));
    }

    #[test]
    fn ordinary_output_carries_no_title_and_takes_no_carry() {
        let mut s = OscTitleScanner::new();
        assert_eq!(s.feed(b"just some output\n"), None);
        assert!(s.carry.is_empty());
    }

    #[test]
    fn a_title_split_across_two_chunks_still_arrives() {
        let mut s = OscTitleScanner::new();
        assert_eq!(s.feed(b"noise\x1b]0;Fixing the au"), None);
        assert_eq!(
            s.feed(b"th bug\x07more").as_deref(),
            Some("Fixing the auth bug")
        );
        assert!(s.carry.is_empty());
    }

    #[test]
    fn a_prefix_split_mid_escape_still_arrives() {
        let mut s = OscTitleScanner::new();
        assert_eq!(s.feed(b"noise\x1b"), None);
        assert_eq!(s.feed(b"]2;Later\x07").as_deref(), Some("Later"));
    }

    #[test]
    fn only_the_last_title_in_a_chunk_is_reported() {
        assert_eq!(
            feed_one(b"\x1b]0;first\x07 mid \x1b]2;second\x07").as_deref(),
            Some("second")
        );
    }

    #[test]
    fn an_oversized_title_is_dropped_rather_than_carried_forever() {
        let big = "x".repeat(MAX_TITLE_BYTES + 1);
        let seq = format!("\x1b]0;{big}\x07");
        assert_eq!(feed_one(seq.as_bytes()), None);
    }

    #[test]
    fn an_unterminated_oversized_title_does_not_grow_the_carry() {
        let mut s = OscTitleScanner::new();
        let seq = format!("\x1b]0;{}", "x".repeat(CARRY_CAP + 10));
        s.feed(seq.as_bytes());
        assert!(s.carry.is_empty(), "carry: {} bytes", s.carry.len());
    }

    #[test]
    fn osc_1_is_an_icon_name_not_a_session_summary() {
        assert_eq!(feed_one(b"\x1b]1;icon\x07"), None);
    }

    #[test]
    fn a_spinner_prefix_and_the_panes_own_app_suffix_come_off() {
        assert_eq!(
            sanitize("✳ Fixing the auth bug — Claude", Some("Claude"), 40).as_deref(),
            Some("Fixing the auth bug")
        );
        assert_eq!(
            sanitize("✻ · Wiring the parser - Codex", Some("Codex"), 40).as_deref(),
            Some("Wiring the parser")
        );
    }

    #[test]
    fn the_recorded_spinner_title_names_the_cli_not_the_session() {
        for raw in [
            "\x1b]0;✳ Claude Code\x07",
            "\x1b]0;◐ Claude Code\x07",
            "\x1b]0;◑ Claude Code\x07",
        ] {
            let title = feed_one(raw.as_bytes()).unwrap();
            assert_eq!(sanitize(&title, Some("Claude"), 40), None, "{raw:?}");
        }
        assert_eq!(
            sanitize("Claude helps with the parser", Some("Claude"), 40).as_deref(),
            Some("Claude helps with the parser"),
            "a summary that mentions the CLI is still a summary"
        );
    }

    #[test]
    fn a_trailing_segment_that_is_not_the_app_name_stays() {
        assert_eq!(
            sanitize("Fix the flaky test - part 2", Some("Claude"), 40).as_deref(),
            Some("Fix the flaky test - part 2")
        );
    }

    #[test]
    fn control_characters_and_runs_of_space_collapse() {
        assert_eq!(
            sanitize("  Fix\tthe\r\n  bug  ", None, 40).as_deref(),
            Some("Fix the bug")
        );
    }

    #[test]
    fn a_title_of_only_decoration_names_nothing() {
        assert_eq!(sanitize("✳ · ◐ ", Some("Claude"), 40), None);
        assert_eq!(sanitize("", None, 40), None);
        assert_eq!(sanitize("   ", None, 40), None);
    }

    #[test]
    fn an_empty_title_reset_names_nothing() {
        assert_eq!(feed_one(b"\x1b]0;\x07").as_deref(), Some(""));
        assert_eq!(sanitize("", None, 40), None);
    }

    #[test]
    fn a_long_title_cuts_at_a_word_boundary_and_stays_char_safe() {
        let out = sanitize("ação ação ação ação ação ação ação ação", None, 10).unwrap();
        assert_eq!(out, "ação ação");
    }

    #[test]
    fn a_bracketed_or_hash_prefix_survives_sanitize() {
        assert_eq!(
            sanitize("[prod] Fix auth", None, 40).as_deref(),
            Some("[prod] Fix auth")
        );
        assert_eq!(
            sanitize("#42 rebase", None, 40).as_deref(),
            Some("#42 rebase")
        );
    }

    #[test]
    fn claude_code_spinner_run_comes_off_together() {
        assert_eq!(
            sanitize("✻ · Wiring the parser", Some("Claude"), 40).as_deref(),
            Some("Wiring the parser")
        );
    }

    #[test]
    fn opencode_session_title_strips_the_oc_bar_prefix() {
        assert_eq!(
            sanitize("OC | Fix parser", Some("Opencode"), 40).as_deref(),
            Some("Fix parser")
        );
        assert_eq!(sanitize("OpenCode", Some("Opencode"), 40), None);
    }

    #[test]
    fn opencode_title_with_a_wrapper_label_strips_both_segments() {
        assert_eq!(
            sanitize("work | OC | Fix parser", Some("Opencode"), 40).as_deref(),
            Some("Fix parser")
        );
    }

    #[test]
    fn oc_bar_marker_survives_for_a_non_opencode_pane() {
        assert_eq!(
            sanitize("OC | Fix parser", Some("Claude"), 40).as_deref(),
            Some("OC | Fix parser")
        );
    }

    #[test]
    fn grok_build_spinner_title_names_nothing() {
        assert_eq!(
            sanitize("⠋⠙⠹ - wiring the parser - grok", Some("Grok"), 40),
            None
        );
        assert_eq!(
            sanitize("⠋⠙⠹ - wiring the parser - Grok", Some("Grok"), 40),
            None,
            "case-insensitive on the trailing grok"
        );
    }

    #[test]
    fn grok_title_without_a_spinner_still_loses_its_app_suffix() {
        assert_eq!(
            sanitize("Fix the auth bug - grok", Some("Grok"), 40).as_deref(),
            Some("Fix the auth bug")
        );
    }
}

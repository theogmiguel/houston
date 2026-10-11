//! Whether a TUI's composer takes input, from the DEC private modes the CLI sets on its
//! own terminal: bracketed paste (2004) enabled, and after it the text cursor (25)
//! shown. ZCode's TUI enables bracketed paste when it takes the terminal and shows its
//! cursor only once its input box has focus; input written between the two is dropped.
//! A cursor shown before bracketed paste (ConPTY draws its own at startup) does not count.

// Longest `ESC [ ? params` prefix carried across a chunk boundary; past it the bytes
// are not a mode sequence this scanner tracks.
const MAX_PARAMS: usize = 32;

const BRACKETED_PASTE: &[u8] = b"2004";
const CURSOR_VISIBLE: &[u8] = b"25";

#[derive(Debug, Default)]
pub struct ComposerReady {
    carry: Vec<u8>,
    bracketed_paste: bool,
    ready: bool,
}

enum Parsed {
    Incomplete,
    Other,
    Mode { len: usize, set: bool },
}

fn parse(tail: &[u8]) -> Parsed {
    match tail.get(1..3) {
        None if tail.get(1).is_none_or(|&b| b == b'[') => return Parsed::Incomplete,
        None => return Parsed::Other,
        Some(b"[?") => {}
        Some(_) => return Parsed::Other,
    }
    for (i, &b) in tail.iter().enumerate().skip(3) {
        match b {
            b'0'..=b'9' | b';' if i - 3 < MAX_PARAMS => {}
            b'h' | b'l' if i > 3 => {
                return Parsed::Mode {
                    len: i + 1,
                    set: b == b'h',
                }
            }
            _ => return Parsed::Other,
        }
    }
    Parsed::Incomplete
}

impl ComposerReady {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ready(&self) -> bool {
        self.ready
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if self.carry.is_empty() && memchr::memchr(0x1b, chunk).is_none() {
            return;
        }
        let mut work = std::mem::take(&mut self.carry);
        work.extend_from_slice(chunk);
        let mut pos = 0;
        while let Some(rel) = memchr::memchr(0x1b, &work[pos..]) {
            let esc = pos + rel;
            match parse(&work[esc..]) {
                Parsed::Incomplete => {
                    self.carry = work[esc..].to_vec();
                    return;
                }
                Parsed::Other => pos = esc + 1,
                Parsed::Mode { len, set } => {
                    for mode in work[esc + 3..esc + len - 1].split(|&b| b == b';') {
                        self.apply(mode, set);
                    }
                    pos = esc + len;
                }
            }
        }
    }

    fn apply(&mut self, mode: &[u8], set: bool) {
        if mode == BRACKETED_PASTE {
            self.bracketed_paste = set;
            self.ready = false;
        } else if mode == CURSOR_VISIBLE {
            self.ready = set && self.bracketed_paste;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fed(chunks: &[&[u8]]) -> ComposerReady {
        let mut scanner = ComposerReady::new();
        for chunk in chunks {
            scanner.feed(chunk);
        }
        scanner
    }

    #[test]
    fn the_cursor_shown_after_bracketed_paste_marks_the_composer_ready() {
        assert!(fed(&[b"\x1b[?2004h\x1b[?25lboot\x1b[?25h"]).ready());
        assert!(fed(&[b"\x1b[?1049;2004h", b"x\x1b[?25h"]).ready());
    }

    #[test]
    fn a_cursor_shown_before_bracketed_paste_does_not_count() {
        // ConPTY's first frame shows the console cursor before the CLI has started.
        assert!(!fed(&[b"\x1b[?9001h\x1b[?1004h\x1b[?25h", b"\x1b[?2004h\x1b[?25l"]).ready());
        assert!(!fed(&[b"\x1b[?25h\x1b[?2004h"]).ready());
    }

    #[test]
    fn hiding_the_cursor_or_leaving_bracketed_paste_clears_it() {
        assert!(!fed(&[b"\x1b[?2004h\x1b[?25h\x1b[?25l"]).ready());
        assert!(!fed(&[b"\x1b[?2004h\x1b[?25h\x1b[?2004l"]).ready());
        assert!(fed(&[b"\x1b[?2004h\x1b[?25h\x1b[?25l\x1b[?25h"]).ready());
    }

    #[test]
    fn sequences_split_across_chunks_are_carried() {
        let bytes = b"text\x1b[?2004hmore\x1b[?25h";
        for split in 0..=bytes.len() {
            let (a, b) = bytes.split_at(split);
            assert!(fed(&[a, b]).ready(), "split at {split}");
        }
    }

    #[test]
    fn other_sequences_and_overlong_parameters_are_skipped() {
        assert!(!fed(&[b"\x1b[25h\x1b[?2004h\x1b[2004;25h"]).ready());
        let long = [b"\x1b[?".as_slice(), &[b'1'; MAX_PARAMS + 4], b"h"].concat();
        let mut scanner = fed(&[&long]);
        assert!(
            scanner.carry.is_empty(),
            "an overlong parameter is not carried"
        );
        scanner.feed(b"\x1b[?2004h\x1b[?25h");
        assert!(scanner.ready());
    }
}

use base64::Engine;

// Decoded clipboard payloads are capped here (spec: 1 MB); the raw carry bound
// allows base64 expansion (4/3) plus header slack, so an oversized sequence is
// still parsed far enough to be dropped rather than carried forever.
pub const MAX_DECODED: usize = 1024 * 1024;
const CARRY_CAP: usize = MAX_DECODED / 3 * 4 + 128;

const PREFIX: &[u8] = b"\x1b]52;";

#[derive(Debug, Default)]
pub struct Osc52Scanner {
    carry: Vec<u8>,
}

fn find_terminator(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i < buf.len() {
        match buf[i] {
            0x07 => return Some((i, 1)),
            0x1b if i + 1 < buf.len() && buf[i + 1] == b'\\' => return Some((i, 2)),
            _ => i += 1,
        }
    }
    None
}

// `<target>;<payload>` -> decoded text. `?` is a clipboard QUERY — answering it
// would leak the user's clipboard to the app; always ignored.
fn parse_body(body: &[u8]) -> Option<String> {
    let sep = memchr::memchr(b';', body)?;
    let payload = &body[sep + 1..];
    if payload == b"?" || payload.is_empty() {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    if decoded.len() > MAX_DECODED {
        return None;
    }
    Some(String::from_utf8_lossy(&decoded).into_owned())
}

impl Osc52Scanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        if self.carry.is_empty()
            && memchr::memmem::find(chunk, b"\x1b]").is_none()
            && !ends_with_partial(chunk)
        {
            return out;
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

        let mut pos = 0usize;
        let mut new_carry: Option<usize> = None;
        while let Some(esc_rel) = memchr::memchr(0x1b, &work[pos..]) {
            let esc = pos + esc_rel;
            let tail = &work[esc..];
            let n = tail.len().min(PREFIX.len());
            if tail[..n] != PREFIX[..n] {
                pos = esc + 1;
                continue;
            }
            if tail.len() < PREFIX.len() {
                new_carry = Some(esc);
                break;
            }
            match find_terminator(work, esc + PREFIX.len()) {
                Some((term, term_len)) => {
                    if let Some(text) = parse_body(&work[esc + PREFIX.len()..term]) {
                        out.push(text);
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
        out
    }
}

fn ends_with_partial(chunk: &[u8]) -> bool {
    chunk.last() == Some(&0x1b) || chunk.ends_with(b"\x1b]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn parses_a_clipboard_write() {
        let mut sc = Osc52Scanner::new();
        let seq = format!("before\x1b]52;c;{}\x07after", b64("hello clip"));
        assert_eq!(sc.feed(seq.as_bytes()), vec!["hello clip".to_string()]);
    }

    #[test]
    fn split_payload_across_reads_is_reassembled() {
        let full = format!("\x1b]52;c;{}\x1b\\", b64("split-me"));
        let bytes = full.as_bytes();
        for split in 1..bytes.len() - 1 {
            let mut sc = Osc52Scanner::new();
            let mut got = sc.feed(&bytes[..split]);
            got.extend(sc.feed(&bytes[split..]));
            assert_eq!(got, vec!["split-me".to_string()], "split at {split}");
        }
    }

    #[test]
    fn queries_and_garbage_are_ignored() {
        let mut sc = Osc52Scanner::new();
        assert!(sc.feed(b"\x1b]52;c;?\x07").is_empty(), "query = leak, drop");
        assert!(sc.feed(b"\x1b]52;c;!!!\x07").is_empty());
        assert!(sc.feed(b"\x1b]0;title\x07plain\n").is_empty());
    }

    #[test]
    fn oversized_payload_is_dropped() {
        let mut sc = Osc52Scanner::new();
        let big = "x".repeat(MAX_DECODED + 1);
        let seq = format!("\x1b]52;c;{}\x07", b64(&big));
        assert!(sc.feed(seq.as_bytes()).is_empty());
        let mut sc2 = Osc52Scanner::new();
        let mut flood = b"\x1b]52;c;".to_vec();
        flood.extend(vec![b'A'; CARRY_CAP + 100]);
        assert!(sc2.feed(&flood).is_empty());
        assert!(sc2.feed(b"\x07").is_empty(), "abandoned carry stays dead");
    }

    #[test]
    fn multi_char_selector_is_still_parsed() {
        let mut sc = Osc52Scanner::new();
        let seq = format!("\x1b]52;cp;{}\x07", b64("hello clip"));
        assert_eq!(sc.feed(seq.as_bytes()), vec!["hello clip".to_string()]);
    }

    #[test]
    fn empty_selector_uses_default_target() {
        let mut sc = Osc52Scanner::new();
        let seq = format!("\x1b]52;;{}\x07", b64("hello clip"));
        assert_eq!(sc.feed(seq.as_bytes()), vec!["hello clip".to_string()]);
    }

    #[test]
    fn empty_payload_yields_nothing() {
        let mut sc = Osc52Scanner::new();
        assert!(sc.feed(b"\x1b]52;c;\x07").is_empty());
    }

    #[test]
    fn embedded_whitespace_in_payload_is_rejected() {
        let mut sc = Osc52Scanner::new();
        let mut payload = b64("hello clip");
        payload.insert(payload.len() / 2, ' ');
        let seq = format!("\x1b]52;c;{}\x07", payload);
        assert!(sc.feed(seq.as_bytes()).is_empty());
    }

    #[test]
    fn embedded_newline_in_payload_is_rejected() {
        let mut sc = Osc52Scanner::new();
        let mut payload = b64("hello clip");
        payload.insert(payload.len() / 2, '\n');
        let seq = format!("\x1b]52;c;{}\x07", payload);
        assert!(sc.feed(seq.as_bytes()).is_empty());
    }

    #[test]
    fn url_safe_alphabet_is_rejected_by_standard_engine() {
        let bytes: [u8; 3] = [0xfb, 0xff, 0xbf];
        let standard = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(
            standard.contains('+') || standard.contains('/'),
            "fixture doesn't exercise the standard-only chars: {standard}"
        );
        let url_safe = standard.replace('+', "-").replace('/', "_");
        let mut sc = Osc52Scanner::new();
        let seq = format!("\x1b]52;c;{}\x07", url_safe);
        assert!(sc.feed(seq.as_bytes()).is_empty());
    }

    #[test]
    fn wrong_padding_is_rejected() {
        let mut sc = Osc52Scanner::new();
        let full = b64("hello clip");
        assert!(full.ends_with('='), "fixture doesn't exercise padding");
        let stripped: String = full.trim_end_matches('=').to_string();
        let seq = format!("\x1b]52;c;{}\x07", stripped);
        assert!(sc.feed(seq.as_bytes()).is_empty());
    }

    #[test]
    fn invalid_utf8_after_decode_is_lossily_replaced() {
        let mut sc = Osc52Scanner::new();
        let invalid_utf8: &[u8] = &[0xff, 0xfe, b'h', b'i'];
        let payload = base64::engine::general_purpose::STANDARD.encode(invalid_utf8);
        let seq = format!("\x1b]52;c;{}\x07", payload);
        let want = format!("{}{}hi", '\u{FFFD}', '\u{FFFD}');
        assert_eq!(sc.feed(seq.as_bytes()), vec![want]);
    }

    #[test]
    fn both_terminators_are_recognized() {
        let mut sc_bel = Osc52Scanner::new();
        let bel = format!("\x1b]52;c;{}\x07", b64("term-bel"));
        assert_eq!(sc_bel.feed(bel.as_bytes()), vec!["term-bel".to_string()]);

        let mut sc_st = Osc52Scanner::new();
        let st = format!("\x1b]52;c;{}\x1b\\", b64("term-st"));
        assert_eq!(sc_st.feed(st.as_bytes()), vec!["term-st".to_string()]);
    }
}

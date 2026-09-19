use base64::Engine;
use std::path::PathBuf;

/// Longest unterminated marker tail carried across feeds; a longer command
/// is dropped rather than buffered without bound.
const CARRY_CAP: usize = 16 * 1024;

/// Queryable context for command blocks and handoff — never a status
/// signal; status comes from hooks, not PTY content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    PromptStart,
    InputStart,
    CommandStart { cmd: String },
    CommandEnd { exit: Option<i32> },
    Cwd { path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub marker: Marker,
    pub offset: u64,
}

pub struct MarkerScanner {
    token: Vec<u8>,
    carry: Vec<u8>,
    carry_offset: u64,
}

impl std::fmt::Debug for MarkerScanner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarkerScanner")
            .field("token", &"[redacted]")
            .field("carry_len", &self.carry.len())
            .field("carry_offset", &self.carry_offset)
            .finish()
    }
}

const OSC_133: &[u8] = b"\x1b]133;";
const OSC_9_9: &[u8] = b"\x1b]9;9;";

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

fn token_payload<'a>(rest: &'a [u8], token: &[u8]) -> Option<&'a [u8]> {
    let separator = memchr::memchr(b';', rest)?;
    (rest[..separator] == *token).then_some(&rest[separator + 1..])
}

fn parse_body(body: &[u8], token: &[u8]) -> Option<Marker> {
    if let Some(rest) = body.strip_prefix(&OSC_133[1..]) {
        return match rest.first()? {
            b'A' if rest.strip_prefix(b"A;")? == token => Some(Marker::PromptStart),
            b'B' if rest.strip_prefix(b"B;")? == token => Some(Marker::InputStart),
            b'C' => {
                let payload = token_payload(rest.strip_prefix(b"C;")?, token)?;
                let cmd = base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .ok()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                Some(Marker::CommandStart { cmd })
            }
            b'D' => {
                let payload = token_payload(rest.strip_prefix(b"D;")?, token)?;
                let exit = std::str::from_utf8(payload)
                    .ok()
                    .and_then(|s| s.trim().parse::<i32>().ok());
                Some(Marker::CommandEnd { exit })
            }
            _ => None,
        };
    }
    if let Some(rest) = body.strip_prefix(&OSC_9_9[1..]) {
        let path = String::from_utf8_lossy(token_payload(rest, token)?).into_owned();
        if path.is_empty() {
            return None;
        }
        return Some(Marker::Cwd {
            path: PathBuf::from(path),
        });
    }
    None
}

impl MarkerScanner {
    pub fn new(token: String) -> Self {
        Self {
            token: token.into_bytes(),
            carry: Vec::new(),
            carry_offset: 0,
        }
    }

    pub fn feed(&mut self, chunk: &[u8], chunk_offset: u64) -> Vec<Hit> {
        let mut hits = Vec::new();
        if self.carry.is_empty()
            && memchr::memmem::find(chunk, b"\x1b]").is_none()
            && !ends_with_partial(chunk)
        {
            return hits;
        }
        let owned: Vec<u8>;
        let (work, work_base): (&[u8], u64) = if self.carry.is_empty() {
            (chunk, chunk_offset)
        } else {
            let mut c = std::mem::take(&mut self.carry);
            c.extend_from_slice(chunk);
            owned = c;
            (owned.as_slice(), self.carry_offset)
        };

        let mut pos = 0usize;
        let mut new_carry: Option<(usize, u64)> = None;
        while let Some(esc_rel) = memchr::memchr(0x1b, &work[pos..]) {
            let esc = pos + esc_rel;
            let tail = &work[esc..];
            let looks_like = |prefix: &[u8]| {
                let n = tail.len().min(prefix.len());
                tail[..n] == prefix[..n]
            };
            if !(looks_like(OSC_133) || looks_like(OSC_9_9)) {
                pos = esc + 1;
                continue;
            }
            if tail.len() < OSC_133.len() {
                new_carry = Some((esc, work_base + esc as u64));
                break;
            }
            match find_terminator(work, esc + 2) {
                Some((term, term_len)) => {
                    if let Some(marker) = parse_body(&work[esc + 1..term], &self.token) {
                        hits.push(Hit {
                            marker,
                            offset: work_base + esc as u64,
                        });
                    }
                    pos = term + term_len;
                }
                None => {
                    new_carry = Some((esc, work_base + esc as u64));
                    break;
                }
            }
        }

        if let Some((at, abs)) = new_carry {
            if work.len() - at <= CARRY_CAP {
                self.carry = work[at..].to_vec();
                self.carry_offset = abs;
            }
        }
        hits
    }
}

fn ends_with_partial(chunk: &[u8]) -> bool {
    chunk.last() == Some(&0x1b) || chunk.ends_with(b"\x1b]")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "right-token";

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn parses_the_full_ftcs_set() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        let seq = format!(
            "\x1b]133;D;{TOKEN};0\x07\x1b]9;9;{TOKEN};/home/x\x07\x1b]133;A;{TOKEN}\x07prompt$ \x1b]133;B;{TOKEN}\x07\x1b]133;C;{TOKEN};{}\x07output\n",
            b64("cargo test")
        );
        let hits = sc.feed(seq.as_bytes(), 100);
        let markers: Vec<&Marker> = hits.iter().map(|h| &h.marker).collect();
        assert_eq!(
            markers,
            vec![
                &Marker::CommandEnd { exit: Some(0) },
                &Marker::Cwd {
                    path: PathBuf::from("/home/x")
                },
                &Marker::PromptStart,
                &Marker::InputStart,
                &Marker::CommandStart {
                    cmd: "cargo test".into()
                },
            ]
        );
        assert_eq!(hits[0].offset, 100);
    }

    #[test]
    fn marker_split_across_two_feeds_is_not_lost() {
        let full = format!("\x1b]133;C;{TOKEN};{}\x07", b64("ls -la"));
        let bytes = full.as_bytes();
        for split in 1..bytes.len() - 1 {
            let mut sc2 = MarkerScanner::new(TOKEN.into());
            let mut hits = sc2.feed(&bytes[..split], 0);
            hits.extend(sc2.feed(&bytes[split..], split as u64));
            assert_eq!(hits.len(), 1, "split at {split}");
            assert_eq!(
                hits[0].marker,
                Marker::CommandStart {
                    cmd: "ls -la".into()
                }
            );
            assert_eq!(hits[0].offset, 0, "offset anchored at the ESC");
        }
    }

    #[test]
    fn st_terminator_works_too() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        let hits = sc.feed(b"\x1b]133;D;right-token;42\x1b\\", 0);
        assert_eq!(hits[0].marker, Marker::CommandEnd { exit: Some(42) });
    }

    #[test]
    fn unrelated_osc_and_plain_escapes_are_ignored() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        assert!(sc
            .feed(b"\x1b]0;window title\x07\x1b[31mred\x1b[0m\n", 0)
            .is_empty());
        assert!(sc.feed(b"plain output, no escapes\n", 0).is_empty());
    }

    #[test]
    fn debug_output_never_discloses_the_token_or_marker_carry() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        assert!(sc.feed(b"\x1b]133;A;right-", 0).is_empty());
        let debug = format!("{sc:?}");
        assert!(!debug.contains(TOKEN));
        assert!(!debug.contains("right-"));
    }

    #[test]
    fn marker_without_token_is_ignored() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        assert!(
            sc.feed(
                b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C;ZWNobw==\x07\x1b]133;D;0\x07\x1b]9;9;/forged\x07",
                0,
            )
            .is_empty(),
            "marker without token must be ignored"
        );
    }

    #[test]
    fn marker_with_wrong_token_is_ignored() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        assert!(
            sc.feed(
                b"\x1b]133;A;wrong-token\x07\x1b]133;B;wrong-token\x07\x1b]133;C;wrong-token;ZWNobw==\x07\x1b]133;D;wrong-token;0\x07\x1b]9;9;wrong-token;/forged\x07",
                0,
            )
            .is_empty(),
            "marker with wrong token must be ignored"
        );
    }

    #[test]
    fn oversized_unterminated_marker_is_dropped() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        let mut chunk = format!("\x1b]133;C;{TOKEN};").into_bytes();
        chunk.extend(vec![b'A'; CARRY_CAP + 10]);
        assert!(sc.feed(&chunk, 0).is_empty());
        assert!(sc.feed(b"\x07", 0).is_empty());
    }

    #[test]
    fn invalid_base64_command_yields_empty_cmd_not_a_crash() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        let hits = sc.feed(b"\x1b]133;C;right-token;!!!not-b64!!!\x07", 0);
        assert_eq!(hits[0].marker, Marker::CommandStart { cmd: String::new() });
    }

    #[test]
    fn offsets_are_absolute_stream_positions() {
        let mut sc = MarkerScanner::new(TOKEN.into());
        let hits = sc.feed(b"abc\x1b]133;A;right-token\x07", 1000);
        assert_eq!(hits[0].offset, 1003);
    }
}

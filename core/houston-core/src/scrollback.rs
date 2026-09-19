use anyhow::{bail, Context, Result};
use std::path::Path;

pub const SCROLLBACK_CAP: usize = 4 * 1024 * 1024;
// Trim with slack so the front-drain memmove amortizes across many pushes instead of
// running on every chunk under flood load.
const TRIM_SLACK: usize = 1024 * 1024;
// How far past the cap to search for a newline to cut at before falling back to a raw cut.
const SAFE_CUT_WINDOW: usize = 8 * 1024;

// Vec::drain returns no spare capacity and extend_from_slice doubles, so without this a
// trimmed ring settles near 2x cap (measured: 8 MiB resident for a 4 MiB cap). Shrinking
// back to here keeps it near SCROLLBACK_CAP + TRIM_SLACK instead.
const CAPACITY_CEILING: usize = SCROLLBACK_CAP + TRIM_SLACK + 64 * 1024;

// Prefixed to a replay that doesn't start at stream offset 0, so SGR state opened by
// trimmed bytes never bleeds into what the pane shows.
const SGR_RESET: &[u8] = b"\x1b[0m";

const PERSIST_MAGIC: &[u8; 4] = b"TRSB";
const PERSIST_VERSION: u8 = 1;

pub struct Replay {
    pub data: Vec<u8>,
    pub generation: u32,
    pub replayed_bytes: u64,
    pub bytes_seen: u64,
}

// What the terminal is actually showing for a line with bare CRs: keep only the text
// after the last CR that has something after it (an empty tail overwrote nothing).
fn carriage_tail(line: &str) -> &str {
    let mut head = line;
    while let Some(i) = head.rfind('\r') {
        let after = &head[i + 1..];
        if !after.is_empty() {
            return after;
        }
        head = &head[..i];
    }
    head
}

#[derive(Debug, Clone)]
pub struct Scrollback {
    buf: Vec<u8>,
    start: u64,
    // Bumped by a respawn; lets a client detect which run a replay/snapshot describes.
    generation: u32,
}

// Cut at-or-after `from` without splitting an escape sequence: just past the next
// newline (escapes never contain a raw \n), else just before the next ESC, else `from`.
fn safe_cut(buf: &[u8], from: usize) -> usize {
    let window_end = (from + SAFE_CUT_WINDOW).min(buf.len());
    if let Some(i) = memchr::memchr(b'\n', &buf[from..window_end]) {
        return from + i + 1;
    }
    if let Some(i) = memchr::memchr(0x1b, &buf[from..window_end]) {
        return from + i;
    }
    from
}

impl Default for Scrollback {
    fn default() -> Self {
        Self::new()
    }
}

impl Scrollback {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            start: 0,
            generation: 1,
        }
    }

    pub fn generation(&self) -> u32 {
        self.generation
    }

    pub fn bytes_seen(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    pub fn push(&mut self, data: &[u8]) -> u64 {
        let offset = self.bytes_seen();
        self.buf.extend_from_slice(data);
        if self.buf.len() > SCROLLBACK_CAP + TRIM_SLACK {
            let cut = safe_cut(&self.buf, self.buf.len() - SCROLLBACK_CAP);
            self.buf.drain(..cut);
            self.start += cut as u64;
            self.buf.shrink_to(CAPACITY_CEILING);
        }
        offset
    }

    pub fn replay(&self, cap: Option<u64>) -> Replay {
        let want = cap
            .map(|c| usize::try_from(c).unwrap_or(usize::MAX))
            .unwrap_or(usize::MAX)
            .min(self.buf.len());
        let mut from = self.buf.len() - want;
        if from > 0 {
            from = safe_cut(&self.buf, from);
        }
        let tail = &self.buf[from..];
        let partial = self.start > 0 || from > 0;
        let mut data = Vec::with_capacity(tail.len() + SGR_RESET.len());
        if partial && !tail.is_empty() {
            data.extend_from_slice(SGR_RESET);
        }
        data.extend_from_slice(tail);
        Replay {
            data,
            generation: self.generation,
            replayed_bytes: tail.len() as u64,
            bytes_seen: self.bytes_seen(),
        }
    }

    pub fn slice(&self, start: u64, end: u64) -> (Vec<u8>, bool) {
        let end = end.min(self.bytes_seen());
        if end <= start {
            return (Vec::new(), false);
        }
        if end <= self.start {
            return (Vec::new(), true);
        }
        let truncated = start < self.start;
        let from = start.max(self.start) - self.start;
        let to = end - self.start;
        (self.buf[from as usize..to as usize].to_vec(), truncated)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.buf
    }

    // A full-screen CLI redraws with cursor moves and never newlines, so this answers
    // "has it produced a line" honestly rather than reading the ring's shape as a proxy.
    pub fn wrote_a_line(&self) -> bool {
        memchr::memchr(b'\n', &self.buf).is_some()
    }

    pub fn tail_lines(&self, lines: usize) -> Vec<String> {
        let bytes: &[u8] = &self.buf;
        let mut end = bytes.len();
        if end > 0 && bytes[end - 1] == b'\n' {
            end -= 1;
        }
        let mut newlines_seen = 0usize;
        let mut start = 0usize;
        let mut i = end;
        while i > 0 {
            if bytes[i - 1] == b'\n' {
                newlines_seen += 1;
                if newlines_seen == lines {
                    start = i;
                    break;
                }
            }
            i -= 1;
        }
        String::from_utf8_lossy(&bytes[start..end])
            .lines()
            .map(|line| crate::agents::strip_ansi(carriage_tail(line)))
            .collect()
    }

    pub fn persist(&self, path: &Path) -> Result<()> {
        let mut out = Vec::with_capacity(17 + self.buf.len());
        out.extend_from_slice(PERSIST_MAGIC);
        out.push(PERSIST_VERSION);
        out.extend_from_slice(&self.generation.to_le_bytes());
        out.extend_from_slice(&self.start.to_le_bytes());
        out.extend_from_slice(&self.buf);
        let tmp = path.with_extension("bin.tmp");
        std::fs::write(&tmp, out)
            .with_context(|| format!("persisting scrollback to {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("moving {} into place", tmp.display()))
    }

    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read(path)
            .with_context(|| format!("reading persisted scrollback at {}", path.display()))?;
        if raw.len() < 17 || &raw[..4] != PERSIST_MAGIC {
            bail!(
                "corrupt scrollback file {}: expected TRSB header, got {} byte(s)",
                path.display(),
                raw.len()
            );
        }
        if raw[4] != PERSIST_VERSION {
            bail!(
                "scrollback file {} has version {}, expected {PERSIST_VERSION}",
                path.display(),
                raw[4]
            );
        }
        let generation = u32::from_le_bytes(raw[5..9].try_into().expect("4 bytes"));
        let start = u64::from_le_bytes(raw[9..17].try_into().expect("8 bytes"));
        Ok(Self {
            buf: raw[17..].to_vec(),
            start,
            generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trimmed_ring_does_not_hold_doubling_overshoot() {
        let mut sb = Scrollback::new();
        let chunk = vec![b'x'; 16 * 1024];
        for _ in 0..2000 {
            sb.push(&chunk);
        }
        assert!(
            sb.buf.capacity() <= CAPACITY_CEILING,
            "ring capacity {} exceeds the {CAPACITY_CEILING}-byte ceiling \
             (len {})",
            sb.buf.capacity(),
            sb.buf.len()
        );
    }

    #[test]
    fn a_settled_ring_stops_reallocating() {
        let mut sb = Scrollback::new();
        let chunk = vec![b'x'; 16 * 1024];
        for _ in 0..1000 {
            sb.push(&chunk);
        }
        let settled = sb.buf.capacity();
        let base = sb.buf.as_ptr();
        for _ in 0..1000 {
            sb.push(&chunk);
        }
        assert_eq!(
            sb.buf.capacity(),
            settled,
            "a settled ring must not change capacity again"
        );
        assert!(
            std::ptr::eq(sb.buf.as_ptr(), base),
            "a settled ring must not move its allocation again"
        );
    }

    #[test]
    fn push_returns_stream_offsets() {
        let mut sb = Scrollback::new();
        assert_eq!(sb.push(b"abc"), 0);
        assert_eq!(sb.push(b"defg"), 3);
        assert_eq!(sb.bytes_seen(), 7);
    }

    #[test]
    fn replay_of_untrimmed_ring_has_no_prefix() {
        let mut sb = Scrollback::new();
        sb.push(b"hello");
        let r = sb.replay(None);
        assert_eq!(r.data, b"hello");
        assert_eq!(r.replayed_bytes, 5);
        assert_eq!(r.bytes_seen, 5);
        assert_eq!(r.generation, 1);
    }

    #[test]
    fn trim_cuts_after_a_newline_and_never_splits_escapes() {
        let mut sb = Scrollback::new();
        let line = format!("\x1b[31m{}\x1b[0m\n", "x".repeat(1015));
        while sb.bytes_seen() < (SCROLLBACK_CAP + TRIM_SLACK + 4096) as u64 {
            sb.push(line.as_bytes());
        }
        let r = sb.replay(None);
        assert!(
            r.data.starts_with(b"\x1b[0m"),
            "trimmed replay gets a reset"
        );
        assert!(
            r.data[4..].starts_with(b"\x1b[31m"),
            "cut must land on a line boundary, got {:?}",
            &r.data[4..24]
        );
        assert_eq!(r.replayed_bytes + 4, r.data.len() as u64);
        assert_eq!(r.bytes_seen, sb.bytes_seen());
    }

    #[test]
    fn capped_replay_is_escape_safe() {
        let mut sb = Scrollback::new();
        for _ in 0..100 {
            sb.push(format!("\x1b[32m{}\x1b[0m\n", "y".repeat(80)).as_bytes());
        }
        let r = sb.replay(Some(500));
        assert!(r.replayed_bytes <= 500);
        assert!(r.data.starts_with(b"\x1b[0m"));
        assert!(
            r.data[4..].starts_with(b"\x1b[32m"),
            "cap cut on line start"
        );
    }

    #[test]
    fn zero_cap_replays_nothing_but_reports_the_stream() {
        let mut sb = Scrollback::new();
        sb.push(b"data\n");
        let r = sb.replay(Some(0));
        assert!(r.data.is_empty());
        assert_eq!(r.replayed_bytes, 0);
        assert_eq!(r.bytes_seen, 5);
    }

    #[test]
    fn slice_handles_spans_relative_to_the_trim_point() {
        let mut sb = Scrollback::new();
        let line = format!("{}\n", "s".repeat(1023));
        while sb.bytes_seen() < (SCROLLBACK_CAP + TRIM_SLACK + 4096) as u64 {
            sb.push(line.as_bytes());
        }
        let (bytes, truncated) = sb.slice(0, 100);
        assert!(bytes.is_empty());
        assert!(truncated);
        let front = sb.bytes_seen() - sb.buf.len() as u64;
        let (bytes, truncated) = sb.slice(front.saturating_sub(10), front + 50);
        assert_eq!(bytes.len(), 50);
        assert!(truncated);
        let (bytes, truncated) = sb.slice(front + 10, front + 20);
        assert_eq!(bytes.len(), 10);
        assert!(!truncated);
    }

    #[test]
    fn tail_lines_takes_the_last_n_lines() {
        let mut sb = Scrollback::new();
        sb.push(b"one\ntwo\nthree\n");
        assert_eq!(
            sb.tail_lines(2),
            vec!["two".to_string(), "three".to_string()]
        );
        assert_eq!(sb.tail_lines(3), vec!["one", "two", "three"]);
    }

    #[test]
    fn tail_lines_counts_honestly_never_pads() {
        let mut sb = Scrollback::new();
        sb.push(b"a\nb\n");
        assert_eq!(sb.tail_lines(50).len(), 2);
        let empty = Scrollback::new();
        assert!(empty.tail_lines(5).is_empty());
    }

    #[test]
    fn a_pane_that_only_redraws_itself_has_written_no_line() {
        let mut sb = Scrollback::new();
        sb.push(b"\x1b[?1049h\x1b[2J\x1b[H  Mustering... (5s)\r");
        assert!(!sb.wrote_a_line());
        sb.push(b"an answer\n");
        assert!(sb.wrote_a_line());
    }

    #[test]
    fn tail_lines_strips_ansi_and_keeps_partial_final_line() {
        let mut sb = Scrollback::new();
        sb.push(b"\x1b[31mred\x1b[0m\ntail without newline");
        assert_eq!(
            sb.tail_lines(2),
            vec!["red".to_string(), "tail without newline".to_string()]
        );
    }

    #[test]
    fn tail_lines_after_trim_reads_the_ring_front() {
        let mut sb = Scrollback::new();
        let line = format!("{}\n", "z".repeat(1023));
        while sb.bytes_seen() < (SCROLLBACK_CAP + TRIM_SLACK + 4096) as u64 {
            sb.push(line.as_bytes());
        }
        let out = sb.tail_lines(1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "z".repeat(1023));
    }

    #[test]
    fn tail_lines_handles_crlf_and_blank_lines() {
        let mut sb = Scrollback::new();
        sb.push(b"win line\r\n\r\nlast");
        assert_eq!(sb.tail_lines(4), vec!["win line", "", "last"]);
    }

    #[test]
    fn a_redrawn_line_reads_as_the_frame_the_terminal_is_showing() {
        let mut sb = Scrollback::new();
        sb.push(b"working.\rworking..\rworking...\rdone\nafter\n");
        assert_eq!(sb.tail_lines(2), vec!["done", "after"]);
    }

    #[test]
    fn a_line_whose_newest_byte_is_a_carriage_return_keeps_its_text() {
        let mut sb = Scrollback::new();
        sb.push(b"first\nBRAVO-TWO\r");
        assert_eq!(sb.tail_lines(2), vec!["first", "BRAVO-TWO"]);
        sb.push(b"\r\r");
        assert_eq!(sb.tail_lines(1), vec!["BRAVO-TWO"]);
    }

    #[test]
    fn a_whole_pane_redrawn_with_bare_cr_is_one_line_not_one_transcript() {
        let mut sb = Scrollback::new();
        for i in 0..2_000 {
            sb.push(format!("frame {i} of a spinner that never newlines\r").as_bytes());
        }
        sb.push(b"final frame");
        let out = sb.tail_lines(15);
        assert_eq!(out, vec!["final frame"]);
    }

    #[test]
    fn persist_load_roundtrip_preserves_stream_accounting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("7.bin");
        let mut sb = Scrollback::new();
        let line = format!("{}\n", "z".repeat(1023));
        while sb.bytes_seen() < (SCROLLBACK_CAP + TRIM_SLACK + 4096) as u64 {
            sb.push(line.as_bytes());
        }
        sb.persist(&path).unwrap();

        let loaded = Scrollback::load(&path).unwrap();
        assert_eq!(loaded.bytes_seen(), sb.bytes_seen());
        let (a, b) = (sb.replay(None), loaded.replay(None));
        assert_eq!(a.data, b.data);
        assert_eq!(a.replayed_bytes, b.replayed_bytes);
        assert_eq!(a.generation, b.generation);
    }

    #[test]
    fn load_rejects_garbage_naming_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.bin");
        std::fs::write(&path, b"nope").unwrap();
        let err = Scrollback::load(&path).unwrap_err().to_string();
        assert!(err.contains("bad.bin"), "error must name the file: {err}");
    }
}

use anyhow::{bail, Context, Result};
use std::collections::VecDeque;
use std::path::Path;

pub const SCROLLBACK_CAP: usize = 4 * 1024 * 1024;
// Preserve the replay retention window between trims.
const TRIM_SLACK: usize = 1024 * 1024;
// How far past the cap to search for a newline to cut at before falling back to a raw cut.
const SAFE_CUT_WINDOW: usize = 8 * 1024;

// Keep retained storage bounded even when loading a larger persisted buffer.
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

#[derive(Debug)]
pub struct Scrollback {
    buf: VecDeque<u8>,
    start: u64,
    // Bumped by a respawn; lets a client detect which run a replay/snapshot describes.
    generation: u32,
}

impl Clone for Scrollback {
    fn clone(&self) -> Self {
        let mut buf = VecDeque::with_capacity(self.buf.capacity());
        let (first, second) = self.as_slices();
        buf.extend(first);
        buf.extend(second);
        Self {
            buf,
            start: self.start,
            generation: self.generation,
        }
    }
}

// Cut at-or-after `from` without splitting an escape sequence: just past the next
// newline (escapes never contain a raw \n), else just before the next ESC, else `from`.
fn safe_cut(segments: &[&[u8]], from: usize) -> usize {
    let mut offset = 0;
    let mut escape = None;
    let end = from + SAFE_CUT_WINDOW;
    for segment in segments {
        let segment_end = offset + segment.len();
        if segment_end > from && offset < end {
            let lo = from.saturating_sub(offset);
            let hi = segment.len().min(end - offset);
            let window = &segment[lo..hi];
            if let Some(i) = memchr::memchr(b'\n', window) {
                return offset + lo + i + 1;
            }
            if escape.is_none() {
                escape = memchr::memchr(0x1b, window).map(|i| offset + lo + i);
            }
        }
        offset = segment_end;
    }
    escape.unwrap_or(from)
}

impl Default for Scrollback {
    fn default() -> Self {
        Self::new()
    }
}

impl Scrollback {
    pub fn new() -> Self {
        Self {
            buf: VecDeque::with_capacity(SCROLLBACK_CAP + TRIM_SLACK),
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
        let old_len = self.buf.len();
        let total = old_len + data.len();
        let trimmed = total > SCROLLBACK_CAP + TRIM_SLACK;
        let skip = if trimmed {
            let (first, second) = self.buf.as_slices();
            let cut = safe_cut(&[first, second, data], total - SCROLLBACK_CAP);
            self.buf.drain(..cut.min(old_len));
            self.start += cut as u64;
            cut.saturating_sub(old_len)
        } else {
            0
        };
        // Slice extension copies directly into the ring without moving retained bytes.
        self.buf.extend(&data[skip..]);
        if trimmed && self.buf.capacity() > CAPACITY_CEILING {
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
            let (first, second) = self.buf.as_slices();
            from = safe_cut(&[first, second], from);
        }
        let tail_len = self.buf.len() - from;
        let partial = self.start > 0 || from > 0;
        let mut data = Vec::with_capacity(tail_len + SGR_RESET.len());
        if partial && tail_len > 0 {
            data.extend_from_slice(SGR_RESET);
        }
        self.extend_range(&mut data, from, self.buf.len());
        Replay {
            data,
            generation: self.generation,
            replayed_bytes: tail_len as u64,
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
        let mut data = Vec::with_capacity((to - from) as usize);
        self.extend_range(&mut data, from as usize, to as usize);
        (data, truncated)
    }

    pub fn as_slices(&self) -> (&[u8], &[u8]) {
        self.buf.as_slices()
    }

    fn extend_range(&self, out: &mut Vec<u8>, from: usize, to: usize) {
        let (first, second) = self.buf.as_slices();
        if from < first.len() {
            out.extend_from_slice(&first[from..to.min(first.len())]);
        }
        if to > first.len() {
            out.extend_from_slice(&second[from.saturating_sub(first.len())..to - first.len()]);
        }
    }

    // A full-screen CLI redraws with cursor moves and never newlines, so this answers
    // "has it produced a line" honestly rather than reading the ring's shape as a proxy.
    pub fn wrote_a_line(&self) -> bool {
        let (first, second) = self.buf.as_slices();
        memchr::memchr(b'\n', first).is_some() || memchr::memchr(b'\n', second).is_some()
    }

    pub fn tail_lines(&self, lines: usize) -> Vec<String> {
        let (first, second) = self.buf.as_slices();
        let mut end = self.buf.len();
        if self.buf.back() == Some(&b'\n') {
            end -= 1;
        }
        let mut newlines_seen = 0usize;
        let mut start = 0usize;
        if lines > 0 {
            let segments = [
                (first.len(), &second[..end.saturating_sub(first.len())]),
                (0, &first[..end.min(first.len())]),
            ];
            'scan: for (offset, bytes) in segments {
                for i in memchr::memrchr_iter(b'\n', bytes) {
                    newlines_seen += 1;
                    if newlines_seen == lines {
                        start = offset + i + 1;
                        break 'scan;
                    }
                }
            }
        }
        let mut tail = Vec::with_capacity(end - start);
        self.extend_range(&mut tail, start, end);
        String::from_utf8_lossy(&tail)
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
        let (first, second) = self.buf.as_slices();
        out.extend_from_slice(first);
        out.extend_from_slice(second);
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
        let mut buf: VecDeque<u8> = raw[17..].to_vec().into();
        if buf.capacity() < SCROLLBACK_CAP + TRIM_SLACK {
            buf.reserve_exact(SCROLLBACK_CAP + TRIM_SLACK - buf.len());
        }
        Ok(Self {
            buf,
            start,
            generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    pub struct ReferenceScrollback {
        buf: Vec<u8>,
        start: u64,
        // Bumped by a respawn; lets a client detect which run a replay/snapshot describes.
        generation: u32,
    }

    // Cut at-or-after `from` without splitting an escape sequence: just past the next
    // newline (escapes never contain a raw \n), else just before the next ESC, else `from`.
    fn reference_safe_cut(buf: &[u8], from: usize) -> usize {
        let window_end = (from + SAFE_CUT_WINDOW).min(buf.len());
        if let Some(i) = memchr::memchr(b'\n', &buf[from..window_end]) {
            return from + i + 1;
        }
        if let Some(i) = memchr::memchr(0x1b, &buf[from..window_end]) {
            return from + i;
        }
        from
    }

    impl Default for ReferenceScrollback {
        fn default() -> Self {
            Self::new()
        }
    }

    impl ReferenceScrollback {
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
                let cut = reference_safe_cut(&self.buf, self.buf.len() - SCROLLBACK_CAP);
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
                from = reference_safe_cut(&self.buf, from);
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
            std::fs::rename(&tmp, path)
                .with_context(|| format!("moving {} into place", tmp.display()))
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

    #[test]
    fn segmented_safe_cuts_match_the_reference_at_every_split() {
        for text in [
            b"plain bytes".as_slice(),
            b"before\x1b[31mred",
            b"before\x1b[31mred\nafter",
            b"\n\x1b[0m\n",
        ] {
            for split in 0..=text.len() {
                for from in 0..=text.len() {
                    assert_eq!(
                        safe_cut(&[&text[..split], &[], &text[split..]], from),
                        reference_safe_cut(text, from)
                    );
                }
            }
        }
        let mut text = vec![b'x'; SAFE_CUT_WINDOW + 4];
        text[3] = 0x1b;
        text[SAFE_CUT_WINDOW] = b'\n';
        for from in [0, 1, 3, SAFE_CUT_WINDOW, text.len()] {
            assert_eq!(
                safe_cut(&[&text[..4], &text[4..]], from),
                reference_safe_cut(&text, from)
            );
        }
    }

    #[test]
    fn cloned_and_loaded_rings_append_without_growing() {
        let mut sb = Scrollback::new();
        sb.push(b"seed");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed.bin");
        sb.persist(&path).unwrap();
        for mut ring in [sb.clone(), Scrollback::load(&path).unwrap()] {
            let capacity = ring.buf.capacity();
            ring.push(&vec![b'x'; SCROLLBACK_CAP]);
            assert_eq!(ring.buf.capacity(), capacity);
            assert!(capacity <= CAPACITY_CEILING);
        }
    }

    fn assert_equivalent(actual: &Scrollback, reference: &ReferenceScrollback) {
        let (first, second) = actual.as_slices();
        assert_eq!([first, second].concat(), reference.bytes());
        assert_eq!(actual.bytes_seen(), reference.bytes_seen());
        assert_eq!(actual.generation(), reference.generation());
        assert_eq!(actual.wrote_a_line(), reference.wrote_a_line());
        for cap in [
            None,
            Some(0),
            Some(1),
            Some(8192),
            Some(SCROLLBACK_CAP as u64),
            Some(u64::MAX),
        ] {
            let a = actual.replay(cap);
            let b = reference.replay(cap);
            assert_eq!(a.data, b.data);
            assert_eq!(
                (a.generation, a.replayed_bytes, a.bytes_seen),
                (b.generation, b.replayed_bytes, b.bytes_seen)
            );
        }
        let seen = actual.bytes_seen();
        let base = reference.start;
        for (from, to) in [
            (0, seen),
            (0, base),
            (base.saturating_sub(1), base + 20),
            (base, base + 8192),
            (seen.saturating_sub(20), seen + 10),
            (seen + 1, seen),
            (seen, u64::MAX),
        ] {
            assert_eq!(actual.slice(from, to), reference.slice(from, to));
        }
        for lines in [0, 1, 3, 20] {
            assert_eq!(actual.tail_lines(lines), reference.tail_lines(lines));
        }
    }

    #[test]
    fn random_pushes_match_the_contiguous_reference() {
        let dir = tempfile::tempdir().unwrap();
        for seed in [1u64, 0xdead_beef, 0x1234_5678] {
            let mut random = seed;
            let mut actual = Scrollback::new();
            let mut reference = ReferenceScrollback::new();
            assert_equivalent(&actual, &reference);
            for step in 0..64 {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                let size = match step {
                    0 => 0,
                    1 => SCROLLBACK_CAP,
                    2 => TRIM_SLACK,
                    3 => 1,
                    4 => SCROLLBACK_CAP + TRIM_SLACK,
                    5 => SCROLLBACK_CAP + TRIM_SLACK + 1,
                    6 => 2 * SCROLLBACK_CAP + SAFE_CUT_WINDOW,
                    _ => random as usize % (128 * 1024),
                };
                let mut chunk = vec![b'x'; size];
                for (i, byte) in chunk.iter_mut().enumerate() {
                    *byte = match (i + random as usize % 131) % 131 {
                        0 => b'\n',
                        1 => b'\r',
                        2 => 0x1b,
                        3 => b'[',
                        4 => 0xff,
                        _ => b'a' + (i % 26) as u8,
                    };
                }
                assert_eq!(actual.push(&chunk), reference.push(&chunk));
                assert_equivalent(&actual, &reference);
                if step % 8 == 0 {
                    let a = dir.path().join("actual.bin");
                    let b = dir.path().join("reference.bin");
                    actual.persist(&a).unwrap();
                    reference.persist(&b).unwrap();
                    assert_eq!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());
                    actual = Scrollback::load(&a).unwrap();
                    reference = ReferenceScrollback::load(&b).unwrap();
                    assert_equivalent(&actual.clone(), &reference.clone());
                }
            }
        }
    }

    #[test]
    #[ignore = "debug-profile throughput measurement; run on an idle machine"]
    fn full_buffer_push_throughput() {
        use std::hint::black_box;
        use std::time::Instant;
        let chunk = vec![b'x'; 16 * 1024];
        let pushes = 16_384;
        let mut reference = ReferenceScrollback::new();
        let mut actual = Scrollback::new();
        let full = vec![b'x'; SCROLLBACK_CAP + TRIM_SLACK];
        reference.push(&full);
        actual.push(&full);
        let start = Instant::now();
        for _ in 0..pushes {
            black_box(reference.push(black_box(&chunk)));
        }
        let before = start.elapsed();
        let start = Instant::now();
        for _ in 0..pushes {
            black_box(actual.push(black_box(&chunk)));
        }
        let after = start.elapsed();
        let mib = (pushes * chunk.len()) as f64 / (1024.0 * 1024.0);
        println!("profile=debug chunk=16384 bytes total={mib} MiB reference={:.2} MiB/s ({before:?}) ring={:.2} MiB/s ({after:?})", mib / before.as_secs_f64(), mib / after.as_secs_f64());
        assert_eq!(actual.replay(None).data, reference.replay(None).data);
        assert_eq!(actual.bytes_seen(), reference.bytes_seen());
    }

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
        let (_, second) = sb.as_slices();
        assert!(!second.is_empty(), "fixture must wrap the ring");
        let allocation_start = second.as_ptr();
        for _ in 0..1000 {
            sb.push(&chunk);
            assert_eq!(sb.buf.capacity(), settled);
            let (_, second) = sb.as_slices();
            if !second.is_empty() {
                assert!(
                    std::ptr::eq(second.as_ptr(), allocation_start),
                    "a settled ring must not move its allocation again"
                );
            }
        }
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

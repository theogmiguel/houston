//! The daemon's terminal emulator (libghostty-vt), one per session. Live output still
//! streams as raw bytes -- this is for attach, terminal queries and `pane_read --source
//! screen`; it is never a status source (see docs/internals/invariants.md).

// Bound on how much history a reattach snapshot carries; VT_HISTORY_BYTES is the real
// cap on live retention (the library evicts by bytes, not rows).
pub const VT_HISTORY_ROWS: u32 = 1000;

// Per-session scrollback budget (bytes, not rows -- the library evicts by page).
// Sized so twelve live sessions stay under the daemon's RSS ceiling.
pub const VT_HISTORY_BYTES: usize = 6 * 512 * 1024;

// Longest in-flight escape-sequence prefix carried across a snapshot boundary -- 4x
// libghostty-vt's own OSC buffer. Past this the prefix is dropped as truncated rather
// than risk replaying a fragment of an OSC 52 clipboard payload as text.
pub const MAX_PENDING_SEQUENCE: usize = 8192;

#[cfg(houston_vt)]
mod imp {
    use std::ffi::c_void;

    pub const LIBRARY_REVISION: &str = env!("HOUSTON_GHOSTTY_VT_REVISION");

    #[repr(C)]
    struct TerminalOptions {
        cols: u16,
        rows: u16,
        max_scrollback: usize,
    }

    #[repr(C)]
    #[derive(Default)]
    struct FormatterScreenExtra {
        size: usize,
        cursor: bool,
        style: bool,
        hyperlink: bool,
        protection: bool,
        kitty_keyboard: bool,
        charsets: bool,
    }

    #[repr(C)]
    #[derive(Default)]
    struct FormatterTerminalExtra {
        size: usize,
        palette: bool,
        modes: bool,
        scrolling_region: bool,
        tabstops: bool,
        pwd: bool,
        keyboard: bool,
        screen: FormatterScreenExtra,
    }

    #[repr(C)]
    struct FormatterTerminalOptions {
        size: usize,
        emit: i32,
        unwrap: bool,
        trim: bool,
        extra: FormatterTerminalExtra,
        selection: *const c_void,
    }

    const RESULT_SUCCESS: i32 = 0;
    const FORMAT_PLAIN: i32 = 0;
    const OPT_USERDATA: i32 = 0;
    const OPT_WRITE_PTY: i32 = 1;

    type WritePtyFn = unsafe extern "C" fn(*mut c_void, *mut c_void, *const u8, usize);

    extern "C" {
        fn ghostty_terminal_new(
            allocator: *const c_void,
            out: *mut *mut c_void,
            options: TerminalOptions,
        ) -> i32;
        fn ghostty_terminal_free(terminal: *mut c_void);
        fn ghostty_terminal_resize(
            terminal: *mut c_void,
            cols: u16,
            rows: u16,
            cell_width_px: u32,
            cell_height_px: u32,
        ) -> i32;
        fn ghostty_terminal_set(terminal: *mut c_void, option: i32, value: *const c_void) -> i32;
        fn ghostty_terminal_vt_write(terminal: *mut c_void, data: *const u8, len: usize);
        fn ghostty_free(allocator: *const c_void, ptr: *mut u8, len: usize);

        fn ghostty_formatter_terminal_new(
            allocator: *const c_void,
            out: *mut *mut c_void,
            terminal: *mut c_void,
            options: FormatterTerminalOptions,
        ) -> i32;
        fn ghostty_formatter_format_alloc(
            formatter: *mut c_void,
            allocator: *const c_void,
            out_ptr: *mut *mut u8,
            out_len: *mut usize,
        ) -> i32;
        fn ghostty_formatter_free(formatter: *mut c_void);

        fn houston_vt_snapshot_format_version() -> u32;
        fn houston_vt_snapshot_parser_state(terminal: *mut c_void) -> u32;
        #[allow(clippy::too_many_arguments)]
        fn houston_vt_snapshot_encode(
            terminal: *mut c_void,
            allocator: *const c_void,
            history_rows: u32,
            pending: *const u8,
            pending_len: usize,
            pending_truncated: bool,
            out_ptr: *mut *mut u8,
            out_len: *mut usize,
        ) -> i32;
        fn houston_vt_snapshot_import(terminal: *mut c_void, ptr: *const u8, len: usize) -> i32;
    }

    const PARSER_GROUND: u32 = 1 << 0;
    const PARSER_UTF8_IDLE: u32 = 1 << 1;

    pub fn snapshot_format_version() -> u32 {
        // SAFETY: a pure accessor over a compile-time constant.
        unsafe { houston_vt_snapshot_format_version() }
    }

    struct Replies(Vec<u8>);

    // SAFETY (extern "C" callback): the library calls this with the userdata pointer
    // installed via OPT_USERDATA and a valid `data`/`len` describing what it wrote.
    unsafe extern "C" fn write_pty(
        _terminal: *mut c_void,
        userdata: *mut c_void,
        data: *const u8,
        len: usize,
    ) {
        if userdata.is_null() || data.is_null() || len == 0 {
            return;
        }
        // SAFETY: `userdata` is the live `&mut Replies` installed in `new`, valid for
        // this synchronous call; `data`/`len` describe a buffer the library just wrote.
        let replies = unsafe { &mut *(userdata as *mut Replies) };
        replies
            .0
            .extend_from_slice(unsafe { std::slice::from_raw_parts(data, len) });
    }

    pub struct Emulator {
        terminal: *mut c_void,
        replies: Box<Replies>,
        pending: Vec<u8>,
        pending_truncated: bool,
        cols: u16,
        rows: u16,
    }

    // SAFETY: the terminal is only ever touched through `&mut Emulator`, and every
    // session holds its emulator behind a Mutex; the library does no threading itself.
    unsafe impl Send for Emulator {}

    impl Emulator {
        pub fn new(cols: u16, rows: u16, history_bytes: usize) -> anyhow::Result<Self> {
            let cols = cols.max(1);
            let rows = rows.max(1);
            let mut terminal: *mut c_void = std::ptr::null_mut();
            // SAFETY: `terminal` is a valid out-pointer; the options struct is passed
            // by value and matches GhosttyTerminalOptions's layout.
            let result = unsafe {
                ghostty_terminal_new(
                    std::ptr::null(),
                    &mut terminal,
                    TerminalOptions {
                        cols,
                        rows,
                        max_scrollback: history_bytes,
                    },
                )
            };
            if result != RESULT_SUCCESS || terminal.is_null() {
                anyhow::bail!(
                    "libghostty-vt refused a {cols}x{rows} terminal with a {history_bytes}-byte \
                     scrollback budget (GhosttyResult {result}); expected 0 and a non-null handle"
                );
            }
            let mut me = Self {
                terminal,
                replies: Box::new(Replies(Vec::new())),
                pending: Vec::new(),
                pending_truncated: false,
                cols,
                rows,
            };
            let userdata = (&mut *me.replies) as *mut Replies as *mut c_void;
            // SAFETY: both options take a pointer value; `userdata` outlives every call
            // through it, since `me.replies` isn't dropped until the Emulator itself is.
            unsafe {
                ghostty_terminal_set(me.terminal, OPT_USERDATA, userdata);
                ghostty_terminal_set(
                    me.terminal,
                    OPT_WRITE_PTY,
                    write_pty as WritePtyFn as *const c_void,
                );
            }
            // Matches the renderer's own construction sequence (ghostty/core.ts), so a
            // snapshot taken here paints the same there. Safe only here: it runs before
            // any PTY byte, so it cannot land inside a sequence already in flight.
            me.feed(b"\x1b]133;A;redraw=1\x07");
            Ok(me)
        }

        pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
            if chunk.is_empty() {
                return Vec::new();
            }
            self.replies.0.clear();
            // SAFETY: `chunk` is valid for the duration of the call, and the library
            // documents this as accepting arbitrary bytes.
            unsafe { ghostty_terminal_vt_write(self.terminal, chunk.as_ptr(), chunk.len()) };
            self.track_pending(chunk);
            std::mem::take(&mut self.replies.0)
        }

        // Keeps `pending` equal to the in-flight escape sequence's bytes, so a snapshot
        // importer can replay it and land the parser back where the cutoff found it.
        fn track_pending(&mut self, chunk: &[u8]) {
            // SAFETY: a pure read of the stream's parser state.
            let state = unsafe { houston_vt_snapshot_parser_state(self.terminal) };
            if state & PARSER_GROUND != 0 && state & PARSER_UTF8_IDLE != 0 {
                self.pending.clear();
                self.pending_truncated = false;
                return;
            }
            let start = if state & PARSER_GROUND == 0 {
                chunk.iter().rposition(|b| is_introducer(*b))
            } else {
                // Not in an escape sequence but mid-codepoint: hold the trailing
                // continuation run plus its lead byte, so import resumes correctly.
                let mut i = chunk.len();
                while i > 0 && chunk[i - 1] & 0xC0 == 0x80 {
                    i -= 1;
                }
                i.checked_sub(1)
            };
            match start {
                Some(at) => {
                    self.pending.clear();
                    self.pending_truncated = false;
                    self.pending.extend_from_slice(&chunk[at..]);
                }
                None => self.pending.extend_from_slice(chunk),
            }
            if self.pending.len() > super::MAX_PENDING_SEQUENCE {
                self.pending.clear();
                self.pending_truncated = true;
            }
        }

        pub fn resize(&mut self, cols: u16, rows: u16) {
            let cols = cols.max(1);
            let rows = rows.max(1);
            if cols == self.cols && rows == self.rows {
                return;
            }
            // SAFETY: the handle is live; cell pixel sizes are cosmetic here (nothing in
            // the daemon reads pixel geometry), so they stay zero.
            let result = unsafe { ghostty_terminal_resize(self.terminal, cols, rows, 0, 0) };
            if result != RESULT_SUCCESS {
                tracing::warn!(
                    "libghostty-vt refused a resize to {cols}x{rows} (GhosttyResult {result}); \
                     the emulator stays at {}x{}",
                    self.cols,
                    self.rows
                );
                return;
            }
            self.cols = cols;
            self.rows = rows;
        }

        pub fn snapshot(&mut self, history_rows: u32) -> anyhow::Result<Vec<u8>> {
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len: usize = 0;
            // SAFETY: out-params are valid; the buffer is freed below with the same
            // (default) allocator it was made with.
            let result = unsafe {
                houston_vt_snapshot_encode(
                    self.terminal,
                    std::ptr::null(),
                    history_rows,
                    self.pending.as_ptr(),
                    self.pending.len(),
                    self.pending_truncated,
                    &mut ptr,
                    &mut len,
                )
            };
            if result != RESULT_SUCCESS || ptr.is_null() {
                anyhow::bail!(
                    "libghostty-vt refused to encode a snapshot at {history_rows} history rows \
                     (GhosttyResult {result}); expected 0 and a non-null buffer"
                );
            }
            // SAFETY: the library just handed us `len` initialised bytes at `ptr`;
            // copied out, then freed exactly once below.
            let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
            unsafe { ghostty_free(std::ptr::null(), ptr, len) };
            Ok(bytes)
        }

        pub fn import(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
            // SAFETY: `bytes` outlives the call; the importer validates the container
            // before touching the terminal.
            let result =
                unsafe { houston_vt_snapshot_import(self.terminal, bytes.as_ptr(), bytes.len()) };
            if result != RESULT_SUCCESS {
                anyhow::bail!(
                    "libghostty-vt refused a {}-byte snapshot (GhosttyResult {result}); this \
                     build reads format version {}",
                    bytes.len(),
                    snapshot_format_version()
                );
            }
            self.pending.clear();
            self.pending_truncated = false;
            Ok(())
        }

        pub fn screen_text(&mut self, lines: usize) -> Vec<String> {
            let mut formatter: *mut c_void = std::ptr::null_mut();
            let options = FormatterTerminalOptions {
                size: std::mem::size_of::<FormatterTerminalOptions>(),
                emit: FORMAT_PLAIN,
                unwrap: false,
                trim: true,
                extra: FormatterTerminalExtra {
                    size: std::mem::size_of::<FormatterTerminalExtra>(),
                    screen: FormatterScreenExtra {
                        size: std::mem::size_of::<FormatterScreenExtra>(),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                selection: std::ptr::null(),
            };
            // SAFETY: sized-struct options, out-pointer valid.
            let result = unsafe {
                ghostty_formatter_terminal_new(
                    std::ptr::null(),
                    &mut formatter,
                    self.terminal,
                    options,
                )
            };
            if result != RESULT_SUCCESS || formatter.is_null() {
                tracing::warn!(
                    "libghostty-vt refused a plain formatter (GhosttyResult {result}); \
                     pane_read --source screen returns nothing for this chunk"
                );
                return Vec::new();
            }
            let mut ptr: *mut u8 = std::ptr::null_mut();
            let mut len: usize = 0;
            // SAFETY: out-params valid; buffer freed below.
            let result = unsafe {
                ghostty_formatter_format_alloc(formatter, std::ptr::null(), &mut ptr, &mut len)
            };
            // SAFETY: `formatter` is non-null (checked above) and used nowhere after this.
            unsafe { ghostty_formatter_free(formatter) };
            if result != RESULT_SUCCESS || ptr.is_null() {
                tracing::warn!("libghostty-vt refused to format a screen (GhosttyResult {result})");
                return Vec::new();
            }
            // SAFETY: `len` initialised, valid-UTF8 bytes at `ptr` (the formatter writes
            // codepoints); copied out, then freed exactly once below.
            let text = String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
                .into_owned();
            unsafe { ghostty_free(std::ptr::null(), ptr, len) };

            let lines = lines.max(1);
            let all: Vec<String> = text.lines().map(str::to_string).collect();
            let start = all.len().saturating_sub(lines);
            all[start..].to_vec()
        }
    }

    impl Drop for Emulator {
        fn drop(&mut self) {
            // SAFETY: freed exactly once; the Box holding the callback's userdata is
            // dropped after this, on the same scope exit.
            unsafe { ghostty_terminal_free(self.terminal) };
        }
    }

    // ESC, plus the 8-bit C1 forms of DCS, CSI, OSC, PM and APC -- a control sequence
    // starts at one of these and nowhere else.
    fn is_introducer(b: u8) -> bool {
        matches!(b, 0x1b | 0x90 | 0x9b | 0x9d | 0x9e | 0x9f)
    }
}

#[cfg(not(houston_vt))]
mod imp {
    pub const LIBRARY_REVISION: &str = "unbuilt";

    pub fn snapshot_format_version() -> u32 {
        0
    }

    pub struct Emulator;

    impl Emulator {
        pub fn new(cols: u16, rows: u16, _history_bytes: usize) -> anyhow::Result<Self> {
            anyhow::bail!(
                "this build has no terminal emulator: libghostty-vt is not built for this target, \
                 so a {cols}x{rows} session cannot be snapshotted and reattach falls back to a \
                 byte replay"
            )
        }

        pub fn feed(&mut self, _chunk: &[u8]) -> Vec<u8> {
            Vec::new()
        }

        pub fn resize(&mut self, _cols: u16, _rows: u16) {}

        pub fn snapshot(&mut self, _history_rows: u32) -> anyhow::Result<Vec<u8>> {
            anyhow::bail!("no terminal emulator in this build; snapshot attach is unavailable")
        }

        pub fn import(&mut self, _bytes: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("no terminal emulator in this build; snapshot import is unavailable")
        }

        pub fn screen_text(&mut self, _lines: usize) -> Vec<String> {
            Vec::new()
        }
    }
}

pub use imp::{snapshot_format_version, Emulator, LIBRARY_REVISION};

pub const fn available() -> bool {
    cfg!(houston_vt)
}

#[cfg(all(test, houston_vt))]
mod tests {
    use super::*;

    fn emulator(cols: u16, rows: u16) -> Emulator {
        Emulator::new(cols, rows, VT_HISTORY_BYTES).expect("the pinned library builds a terminal")
    }

    fn live_history_retained_rows(cols: u16) -> usize {
        const ROWS: u16 = 24;
        const LINES: u32 = 400_000;
        let mut vt = emulator(cols, ROWS);
        let mut chunk = String::new();
        for n in 0..LINES {
            chunk.push_str(&format!("line {n}\r\n"));
            if chunk.len() >= 64 * 1024 {
                vt.feed(chunk.as_bytes());
                chunk.clear();
            }
        }
        vt.feed(chunk.as_bytes());

        let all = vt.screen_text(usize::MAX);
        let retained = all.len();
        println!(
            "live history: {retained} rows retained at {:.1} MiB after {LINES} lines at {cols} cols",
            VT_HISTORY_BYTES as f64 / (1024.0 * 1024.0)
        );
        assert!(
            (retained as u32) < LINES,
            "all {LINES} rows survived; VT_HISTORY_BYTES ({VT_HISTORY_BYTES}) bounded nothing"
        );
        assert!(
            !all.iter().any(|l| l == "line 0"),
            "the oldest row survived; history dropped the wrong end"
        );
        assert!(
            all.iter().any(|l| l == &format!("line {}", LINES - 1)),
            "the newest row is missing; history dropped the wrong end"
        );
        retained
    }

    #[test]
    fn live_history_is_bounded_by_bytes_and_drops_the_oldest_rows() {
        live_history_retained_rows(120);
    }

    #[test]
    fn live_history_retained_rows_at_200_cols() {
        live_history_retained_rows(200);
    }

    #[test]
    fn a_partial_overwrite_reads_as_the_screen_shows_it() {
        let mut vt = emulator(80, 24);
        vt.feed(b"abcdef\rXY");
        assert_eq!(vt.screen_text(1), vec!["XYcdef".to_string()]);
    }

    #[test]
    fn cursor_addressed_paint_reads_as_a_grid_not_a_byte_stream() {
        let mut vt = emulator(40, 5);
        vt.feed(b"\x1b[2J\x1b[1;1Hthe capital of Japan\x1b[2;1His Tokyo");
        assert_eq!(
            vt.screen_text(2),
            vec!["the capital of Japan".to_string(), "is Tokyo".to_string()]
        );
    }

    #[test]
    fn screen_text_returns_the_bottom_n_rows() {
        let mut vt = emulator(20, 24);
        for i in 0..10 {
            vt.feed(format!("line {i}\r\n").as_bytes());
        }
        assert_eq!(
            vt.screen_text(3),
            vec![
                "line 7".to_string(),
                "line 8".to_string(),
                "line 9".to_string()
            ]
        );
    }

    #[test]
    fn a_wide_character_keeps_the_columns_after_it_in_place() {
        let mut vt = emulator(20, 3);
        vt.feed("\u{6f22}\u{5b57}ok".as_bytes());
        assert_eq!(vt.screen_text(1), vec!["\u{6f22}\u{5b57}ok".to_string()]);
    }

    #[test]
    fn a_snapshot_carries_the_magic_and_this_builds_format_version() {
        let mut vt = emulator(80, 24);
        vt.feed(b"hello\r\n");
        let bytes = vt.snapshot(VT_HISTORY_ROWS).expect("encode");
        assert_eq!(&bytes[0..4], b"HVTS", "snapshot magic");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            snapshot_format_version()
        );
    }

    #[test]
    fn a_snapshot_round_trips_through_a_fresh_emulator() {
        let mut source = emulator(80, 24);
        source.feed(b"\x1b[1;31mred\x1b[0m\r\nplain\r\n");
        let bytes = source.snapshot(VT_HISTORY_ROWS).expect("encode");

        let mut restored = emulator(80, 24);
        restored.import(&bytes).expect("import");
        assert_eq!(restored.screen_text(2), source.screen_text(2));
    }

    #[test]
    fn an_escape_sequence_split_at_the_cutoff_continues_after_import() {
        let mut continuous = emulator(80, 24);
        continuous.feed(b"start\x1b[1");
        continuous.feed(b";32mgreen");

        let mut source = emulator(80, 24);
        source.feed(b"start\x1b[1");
        let bytes = source.snapshot(VT_HISTORY_ROWS).expect("encode");

        let mut restored = emulator(80, 24);
        restored.import(&bytes).expect("import");
        restored.feed(b";32mgreen");

        assert_eq!(restored.screen_text(1), continuous.screen_text(1));
        assert_eq!(
            restored.screen_text(1),
            vec!["startgreen".to_string()],
            "the split CSI must be consumed as a colour change, not printed"
        );
    }

    #[test]
    fn a_snapshot_on_a_boundary_replays_nothing() {
        let mut vt = emulator(80, 24);
        vt.feed(b"\x1b[1;31mred\x1b[0m");
        let bytes = vt.snapshot(VT_HISTORY_ROWS).expect("encode");
        assert!(
            !bytes.windows(4).any(|w| w == b"PEND"),
            "a boundary snapshot must carry no PEND section"
        );
    }

    #[test]
    fn a_split_utf8_codepoint_survives_the_cutoff() {
        let mut source = emulator(80, 24);
        source.feed("caf\u{e9}".as_bytes().split_at(4).0);
        let bytes = source.snapshot(VT_HISTORY_ROWS).expect("encode");

        let mut restored = emulator(80, 24);
        restored.import(&bytes).expect("import");
        restored.feed(&"caf\u{e9}".as_bytes()[4..]);
        assert_eq!(restored.screen_text(1), vec!["caf\u{e9}".to_string()]);
    }

    #[test]
    fn a_device_attributes_query_is_answered_from_the_emulator() {
        let mut vt = emulator(80, 24);
        assert_eq!(vt.feed(b"\x1b[c"), b"\x1b[?62;22c".to_vec());
    }

    #[test]
    fn a_cursor_position_report_reflects_where_the_cursor_actually_is() {
        let mut vt = emulator(80, 24);
        vt.feed(b"\x1b[3;7H");
        assert_eq!(vt.feed(b"\x1b[6n"), b"\x1b[3;7R".to_vec());
    }

    #[test]
    fn plain_output_produces_no_reply() {
        let mut vt = emulator(80, 24);
        assert!(vt.feed(b"just text\r\n").is_empty());
    }

    #[test]
    fn the_history_budget_bounds_a_snapshot() {
        let mut vt = emulator(80, 24);
        for i in 0..4000 {
            vt.feed(format!("row {i}\r\n").as_bytes());
        }
        let bounded = vt.snapshot(50).expect("encode");
        let full = vt.snapshot(VT_HISTORY_ROWS).expect("encode");
        assert!(
            bounded.len() < full.len(),
            "a 50-row history bound ({} B) must be smaller than a {VT_HISTORY_ROWS}-row one ({} B)",
            bounded.len(),
            full.len()
        );
    }

    #[test]
    fn resize_moves_the_grid_the_screen_is_read_from() {
        let mut vt = emulator(80, 24);
        vt.feed(b"\x1b[2J\x1b[1;1H");
        vt.resize(20, 5);
        vt.feed(b"0123456789012345678901234");
        assert_eq!(
            vt.screen_text(2),
            vec!["01234567890123456789".to_string(), "01234".to_string()],
            "the twenty-first column must wrap, which only happens if the resize took"
        );
    }
}

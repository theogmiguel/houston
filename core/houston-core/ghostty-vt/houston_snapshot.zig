//! Snapshot export/import for a libghostty-vt terminal, so a pane can be
//! reattached from state instead of a byte replay.
//!
//! This file is Houston's, not upstream's. The build copies it into the
//! pinned libghostty-vt source tree and a three-hunk patch routes and
//! exports it; keeping the body out of the patch is what lets an upstream
//! bump fail on three lines of context instead of nine hundred.
//!
//! The whole point of living inside the library rather than beside it is
//! that the daemon's native build and the renderer's wasm32 build compile
//! THIS FILE from the same source. Encode and import cannot drift, and the
//! format needs no second implementation in Rust or TypeScript.
//!
//! Nothing here serializes library memory. Page storage is a pooled linked
//! list of native pointers, four bytes wide on wasm32 and eight on x86_64,
//! so a byte copy of it could never cross the boundary it exists to cross.
//! Instead the bulk of a screen leaves as the library's own VT
//! re-encoding -- `formatter.zig` already knows how to write a screen back
//! out as SGR runs, OSC 8 hyperlinks and codepoints -- and comes back in
//! through the same stream that parses a real program's output. What VT
//! cannot say (a pending-wrap flag, a saved cursor, the kitty flag stack,
//! the mode bitfields) travels as explicit little-endian fields.

const std = @import("std");
const testing = std.testing;
const lib = @import("../lib.zig");
const CAllocator = lib.alloc.Allocator;
const terminal_c = @import("terminal.zig");
const Terminal = terminal_c.Terminal;
const ZigTerminal = @import("../Terminal.zig");
const Screen = @import("../Screen.zig");
const ScreenSet = @import("../ScreenSet.zig");
const Selection = @import("../Selection.zig");
const charsets = @import("../charsets.zig");
const formatterpkg = @import("../formatter.zig");
const modespkg = @import("../modes.zig");
const stylepkg = @import("../style.zig");
const Result = @import("result.zig").Result;

/// Bumped whenever an encoder change would make an older importer read a
/// snapshot wrongly rather than merely miss something. The importer refuses
/// any value it does not equal: a wrong screen is worse than a byte replay.
pub const FORMAT_VERSION: u32 = 1;

const MAGIC = "HVTS";

/// Mode bitfields travel as a fixed 128-bit little-endian integer rather
/// than `@sizeOf(ModePacked)` bytes, so adding a mode upstream changes the
/// bit COUNT (checked on import) without changing the field width.
const MODE_BYTES = 16;
const ModeInt = u128;

const Tag = struct {
    const head = "HEAD";
    const term = "TERM";
    const region = "SCRG";
    const mode = "MODE";
    const flags = "TFLG";
    const primary = "SCRP";
    const alternate = "SCRA";
    const pending = "PEND";
};

// -- encode ---------------------------------------------------------------

/// Bit flags returned by `snapshot_parser_state`.
pub const PARSER_GROUND: u32 = 1 << 0;
pub const PARSER_UTF8_IDLE: u32 = 1 << 1;

/// Where the VT stream stands between writes. The daemon needs this to know
/// whether the chunk it just fed ended on a sequence boundary; when it did
/// not, the trailing bytes of that chunk are the in-flight sequence and get
/// handed back to `snapshot_encode` as `pending`.
pub fn snapshot_parser_state(terminal_: Terminal) callconv(lib.calling_conv) u32 {
    const wrapper = terminal_ orelse return 0;
    var out: u32 = 0;
    if (wrapper.stream.parser.state == .ground) out |= PARSER_GROUND;
    if (wrapper.stream.utf8decoder.state == 0) out |= PARSER_UTF8_IDLE;
    return out;
}

pub fn snapshot_format_version() callconv(lib.calling_conv) u32 {
    return FORMAT_VERSION;
}

/// Serialize `terminal` into a freshly allocated buffer. Free it with
/// `ghostty_free` and the same allocator.
///
/// `history_rows` caps how many scrollback rows the primary screen carries;
/// the alternate screen has no scrollback by construction. `pending` is the
/// in-flight escape-sequence prefix the caller has been tracking (see
/// `snapshot_parser_state`), replayed verbatim as the last thing the
/// importer does. `pending_truncated` says the caller lost the head of that
/// sequence, in which case the importer drops it rather than replaying a
/// fragment whose meaning changed.
pub fn snapshot_encode(
    terminal_: Terminal,
    alloc_: ?*const CAllocator,
    history_rows: u32,
    pending_ptr: ?[*]const u8,
    pending_len: usize,
    pending_truncated: bool,
    out_ptr: *?[*]u8,
    out_len: *usize,
) callconv(lib.calling_conv) Result {
    const wrapper = terminal_ orelse return .invalid_value;
    const alloc = lib.alloc.default(alloc_);
    const pending: []const u8 = if (pending_ptr) |p| p[0..pending_len] else &.{};

    const buf = encode(
        alloc,
        wrapper.terminal,
        history_rows,
        pending,
        pending_truncated,
    ) catch return .out_of_memory;

    out_ptr.* = buf.ptr;
    out_len.* = buf.len;
    return .success;
}

fn encode(
    alloc: std.mem.Allocator,
    t: *ZigTerminal,
    history_rows: u32,
    pending: []const u8,
    pending_truncated: bool,
) ![]u8 {
    var aw: std.Io.Writer.Allocating = .init(alloc);
    errdefer aw.deinit();
    const w = &aw.writer;

    try w.writeAll(MAGIC);
    try writeInt(w, u32, FORMAT_VERSION);

    const alt_present = t.screens.all.get(.alternate) != null;

    {
        var body: std.Io.Writer.Allocating = .init(alloc);
        defer body.deinit();
        try writeInt(&body.writer, u16, t.cols);
        try writeInt(&body.writer, u16, t.rows);
        try writeInt(&body.writer, u8, @as(u8, if (t.screens.active_key == .alternate) 1 else 0));
        try writeInt(&body.writer, u8, @as(u8, if (alt_present) 1 else 0));
        try writeInt(&body.writer, u8, @as(u8, if (pending_truncated) 1 else 0));
        try writeInt(&body.writer, u8, 0);
        try writeInt(&body.writer, u16, @as(u16, @bitSizeOf(modespkg.ModePacked)));
        try writeSection(w, Tag.head, body.writer.buffered());
    }

    // Terminal-level state that is cheapest to say in VT: the palette,
    // tabstops, the pwd and the keyboard-protocol modes. Deliberately NOT
    // `modes` -- the mode extra emits the alternate-screen DEC modes too,
    // and replaying those would switch screens underneath an importer that
    // is placing both screens itself.
    try writeTerminalVt(alloc, w, t, Tag.term, .{
        .palette = true,
        .modes = false,
        .scrolling_region = false,
        .tabstops = true,
        .pwd = true,
        .keyboard = true,
        .screen = .none,
    });

    // The scrolling region rides in its own section because the importer
    // has to apply it AFTER painting the screens: a region in force changes
    // where a newline scrolls, and the paint is a lot of newlines.
    try writeTerminalVt(alloc, w, t, Tag.region, .{
        .palette = false,
        .modes = false,
        .scrolling_region = true,
        .tabstops = false,
        .pwd = false,
        .keyboard = false,
        .screen = .none,
    });

    {
        var body: std.Io.Writer.Allocating = .init(alloc);
        defer body.deinit();
        try writeModes(&body.writer, t.modes.values);
        try writeModes(&body.writer, t.modes.saved);
        try writeModes(&body.writer, t.modes.default);
        try writeSection(w, Tag.mode, body.writer.buffered());
    }

    // The mouse event/format pair is the reason this section exists: the
    // mode bits alone cannot say which of several overlapping mouse modes
    // was set LAST, and that ordering is what the terminal actually reports
    // with.
    {
        var body: std.Io.Writer.Allocating = .init(alloc);
        defer body.deinit();
        try writeInt(&body.writer, u8, enumU8(t.flags.mouse_event));
        try writeInt(&body.writer, u8, enumU8(t.flags.mouse_format));
        try writeInt(&body.writer, u8, @as(u8, if (t.flags.modify_other_keys_2) 1 else 0));
        try writeInt(&body.writer, u8, enumU8(t.flags.mouse_shift_capture));
        try writeInt(&body.writer, u8, enumU8(t.status_display));
        try writeInt(&body.writer, u8, @as(u8, if (t.previous_char != null) 1 else 0));
        try writeInt(&body.writer, u32, @as(u32, t.previous_char orelse 0));
        // Set by OSC 133's `redraw=` and by nothing else. An importer that
        // did not carry it would have to re-send that OSC to get it back,
        // and a byte written after the import lands inside the in-flight
        // sequence `PEND` just replayed.
        try writeInt(&body.writer, u8, enumU8(t.flags.shell_redraws_prompt));
        try writeSection(w, Tag.flags, body.writer.buffered());
    }

    {
        var body: std.Io.Writer.Allocating = .init(alloc);
        defer body.deinit();
        try encodeScreen(alloc, t, .primary, history_rows, &body.writer);
        try writeSection(w, Tag.primary, body.writer.buffered());
    }

    if (alt_present) {
        var body: std.Io.Writer.Allocating = .init(alloc);
        defer body.deinit();
        // The alternate screen never keeps scrollback (`switchScreen` gives
        // it `max_scrollback = 0`), so a history budget is meaningless here.
        try encodeScreen(alloc, t, .alternate, 0, &body.writer);
        try writeSection(w, Tag.alternate, body.writer.buffered());
    }

    if (pending.len > 0 and !pending_truncated) {
        try writeSection(w, Tag.pending, pending);
    }

    return try aw.toOwnedSlice();
}

fn writeTerminalVt(
    alloc: std.mem.Allocator,
    w: *std.Io.Writer,
    t: *ZigTerminal,
    tag: *const [4]u8,
    extra: formatterpkg.TerminalFormatter.Extra,
) !void {
    var f: formatterpkg.TerminalFormatter = .init(t, .{ .emit = .vt, .trim = false });
    f.content = .none;
    f.extra = extra;
    var body: std.Io.Writer.Allocating = .init(alloc);
    defer body.deinit();
    try f.format(&body.writer);
    try writeSection(w, tag, body.writer.buffered());
}

fn encodeScreen(
    alloc: std.mem.Allocator,
    t: *ZigTerminal,
    key: ScreenSet.Key,
    history_rows: u32,
    w: *std.Io.Writer,
) !void {
    const screen: *Screen = t.screens.all.get(key) orelse return error.NoScreen;

    var content: std.Io.Writer.Allocating = .init(alloc);
    defer content.deinit();
    {
        var f: formatterpkg.ScreenFormatter = .init(screen, .{
            .emit = .vt,
            // Trailing whitespace can carry a background colour, and a
            // trimmed trailing blank row would shift every row above it up
            // by one on import. Exact reattach cannot afford either.
            .unwrap = false,
            .trim = false,
        });
        f.extra = .{
            .cursor = true,
            .style = true,
            .hyperlink = true,
            .protection = true,
            // The stack, not just its top, is restored structurally below.
            .kitty_keyboard = false,
            .charsets = true,
        };
        f.content = .{ .selection = boundedSelection(screen, t.rows, history_rows) };
        try f.format(&content.writer);
    }
    const vt = content.writer.buffered();
    try writeInt(w, u32, @intCast(vt.len));
    try w.writeAll(vt);

    // How many rows the painted stream is supposed to end up holding. The
    // formatter always trims trailing BLANK rows, so a screen whose bottom
    // rows are empty paints short and every row above it lands one row too
    // low in the scrollback; the importer scrolls the difference back in.
    try writeInt(w, u32, @intCast(@min(
        screen.pages.total_rows,
        @as(usize, t.rows) + history_rows,
    )));

    try writeInt(w, u16, screen.cursor.x);
    try writeInt(w, u16, screen.cursor.y);
    try writeInt(w, u8, @as(u8, if (screen.cursor.pending_wrap) 1 else 0));
    try writeInt(w, u8, enumU8(screen.cursor.cursor_style));
    try writeInt(w, u8, @as(u8, if (screen.cursor.protected) 1 else 0));
    try writeInt(w, u8, enumU8(screen.protected_mode));

    for (screen.kitty_keyboard.flags) |flags| {
        try writeInt(w, u8, @as(u8, flags.int()));
    }
    try writeInt(w, u8, @as(u8, screen.kitty_keyboard.idx));

    if (screen.saved_cursor) |saved| {
        try writeInt(w, u8, 1);
        try writeInt(w, u16, saved.x);
        try writeInt(w, u16, saved.y);
        try writeInt(w, u8, @as(u8, if (saved.protected) 1 else 0));
        try writeInt(w, u8, @as(u8, if (saved.pending_wrap) 1 else 0));
        try writeInt(w, u8, @as(u8, if (saved.origin) 1 else 0));
        try writeStyle(w, saved.style);
        try writeCharset(w, saved.charset);
    } else {
        try writeInt(w, u8, 0);
    }
}

/// The rows this screen contributes to the snapshot: the active area plus at
/// most `history_rows` of scrollback above it. `null` (everything) when the
/// screen holds no more than that already.
fn boundedSelection(screen: *const Screen, rows: u16, history_rows: u32) ?Selection {
    const total = screen.pages.total_rows;
    if (total <= rows) return null;
    const scrollback = total - rows;
    if (scrollback <= history_rows) return null;
    const drop: u32 = @intCast(scrollback - history_rows);
    const start = screen.pages.pin(.{ .screen = .{ .x = 0, .y = drop } }) orelse return null;
    const end = screen.pages.getBottomRight(.screen) orelse return null;
    return .init(start, end, false);
}

// -- import ---------------------------------------------------------------

/// Replace `terminal`'s entire state with a snapshot. On any refusal the
/// terminal is left reset rather than half-imported: a blank pane that then
/// repaints is recoverable, a spliced one is not.
pub fn snapshot_import(
    terminal_: Terminal,
    ptr: [*]const u8,
    len: usize,
) callconv(lib.calling_conv) Result {
    const wrapper = terminal_ orelse return .invalid_value;
    return importBytes(wrapper, ptr[0..len]) catch |err| switch (err) {
        error.OutOfMemory => .out_of_memory,
        else => .invalid_value,
    };
}

fn importBytes(wrapper: anytype, buf: []const u8) !Result {
    if (buf.len < 8) return .invalid_value;
    if (!std.mem.eql(u8, buf[0..4], MAGIC)) return .invalid_value;
    if (readInt(u32, buf[4..8]) != FORMAT_VERSION) return .invalid_value;

    const t: *ZigTerminal = wrapper.terminal;
    t.fullReset();
    // A reset leaves the parser mid-nothing, but the caller may have been
    // writing into this terminal before deciding to import.
    wrapper.stream.parser = .init();
    wrapper.stream.utf8decoder = .{};

    var sections: Sections = .{};
    var i: usize = 8;
    while (i + 8 <= buf.len) {
        const tag = buf[i..][0..4];
        const body_len = readInt(u32, buf[i + 4 ..][0..4]);
        i += 8;
        if (i + body_len > buf.len) return .invalid_value;
        const body = buf[i..][0..body_len];
        i += body_len;
        if (std.mem.eql(u8, tag, Tag.head)) sections.head = body;
        if (std.mem.eql(u8, tag, Tag.term)) sections.term = body;
        if (std.mem.eql(u8, tag, Tag.region)) sections.region = body;
        if (std.mem.eql(u8, tag, Tag.mode)) sections.mode = body;
        if (std.mem.eql(u8, tag, Tag.flags)) sections.flags = body;
        if (std.mem.eql(u8, tag, Tag.primary)) sections.primary = body;
        if (std.mem.eql(u8, tag, Tag.alternate)) sections.alternate = body;
        if (std.mem.eql(u8, tag, Tag.pending)) sections.pending = body;
    }

    const head = sections.head orelse return .invalid_value;
    if (head.len < 10) return .invalid_value;
    const cols = readInt(u16, head[0..2]);
    const rows = readInt(u16, head[2..4]);
    const active_alternate = head[4] != 0;
    const alt_present = head[5] != 0;
    if (readInt(u16, head[8..10]) != @as(u16, @bitSizeOf(modespkg.ModePacked))) {
        return .invalid_value;
    }
    if (cols == 0 or rows == 0) return .invalid_value;
    try t.resize(t.gpa(), cols, rows);

    // Tabstops, the palette and the pwd first: emitting a tabstop is HTS at
    // a cursor position, so this walks the cursor across the row and must
    // not do that over painted content.
    if (sections.term) |body| wrapper.stream.nextSlice(body);

    // Then content, with the scrolling region and origin mode still at
    // their defaults -- both change where a newline scrolls, and painting a
    // screen is mostly newlines.
    var active_cursor: Cursor = .{};
    if (sections.primary) |body| {
        const c = try importScreen(wrapper, .primary, body);
        if (!active_alternate) active_cursor = c;
    }
    if (alt_present) {
        if (sections.alternate) |body| {
            _ = try t.switchScreen(.alternate);
            const c = try importScreen(wrapper, .alternate, body);
            if (active_alternate) active_cursor = c;
        }
    }
    _ = try t.switchScreen(if (active_alternate) .alternate else .primary);

    if (sections.region) |body| wrapper.stream.nextSlice(body);

    if (sections.mode) |body| {
        if (body.len < MODE_BYTES * 3) return .invalid_value;
        t.modes.values = readModes(body[0..MODE_BYTES]);
        t.modes.saved = readModes(body[MODE_BYTES..][0..MODE_BYTES]);
        t.modes.default = readModes(body[MODE_BYTES * 2 ..][0..MODE_BYTES]);
    }

    if (sections.flags) |body| {
        if (body.len < 11) return .invalid_value;
        t.flags.mouse_event = @enumFromInt(body[0]);
        t.flags.mouse_format = @enumFromInt(body[1]);
        t.flags.modify_other_keys_2 = body[2] != 0;
        t.flags.mouse_shift_capture = @enumFromInt(body[3]);
        t.status_display = @enumFromInt(body[4]);
        t.previous_char = if (body[5] != 0) @intCast(readInt(u32, body[6..10])) else null;
        t.flags.shell_redraws_prompt = @enumFromInt(body[10]);
    }

    // The active screen's cursor is placed last: DECSTBM homes it, and
    // origin mode (just restored above) would reinterpret the coordinates,
    // so it is turned off for the one call that needs absolute rows.
    {
        const origin = t.modes.get(.origin);
        t.modes.set(.origin, false);
        t.setCursorPos(active_cursor.y + 1, active_cursor.x + 1);
        t.modes.set(.origin, origin);
        t.screens.active.cursor.pending_wrap = active_cursor.pending_wrap;
    }

    // The in-flight escape sequence, replayed last so the parser lands in
    // exactly the state the cutoff caught it in.
    if (sections.pending) |body| wrapper.stream.nextSlice(body);

    return .success;
}

const Sections = struct {
    head: ?[]const u8 = null,
    term: ?[]const u8 = null,
    region: ?[]const u8 = null,
    mode: ?[]const u8 = null,
    flags: ?[]const u8 = null,
    primary: ?[]const u8 = null,
    alternate: ?[]const u8 = null,
    pending: ?[]const u8 = null,
};

const Cursor = struct { x: u16 = 0, y: u16 = 0, pending_wrap: bool = false };

fn importScreen(wrapper: anytype, key: ScreenSet.Key, body: []const u8) !Cursor {
    if (body.len < 4) return error.Malformed;
    const vt_len = readInt(u32, body[0..4]);
    if (4 + vt_len > body.len) return error.Malformed;
    // The content stream paints from wherever the cursor stands, and the
    // tabstop section just walked it across the top row with CHA.
    wrapper.stream.nextSlice("\x1b[H\x1b[0m");
    wrapper.stream.nextSlice(body[4..][0..vt_len]);

    var i: usize = 4 + vt_len;
    const t: *ZigTerminal = wrapper.terminal;
    const screen: *Screen = t.screens.all.get(key) orelse return error.NoScreen;

    if (i + 4 > body.len) return error.Malformed;
    const target_rows = readInt(u32, body[i..][0..4]);
    i += 4;
    var guard: u32 = 0;
    while (screen.pages.total_rows < target_rows and guard < target_rows) : (guard += 1) {
        // Park on the bottom row and scroll one blank row in.
        wrapper.stream.nextSlice("\x1b[9999;1H\r\n");
    }

    if (i + 8 > body.len) return error.Malformed;
    const cursor_x = readInt(u16, body[i..][0..2]);
    const cursor_y = readInt(u16, body[i + 2 ..][0..2]);
    const pending_wrap = body[i + 4] != 0;
    const cursor_style = body[i + 5];
    const cursor_protected = body[i + 6] != 0;
    const protected_mode = body[i + 7];
    i += 8;

    // CUP has already been emitted by the encoder's `cursor` extra, but it
    // cannot express the last-column flag, and it clears it.
    t.setCursorPos(cursor_y + 1, cursor_x + 1);
    screen.cursor.pending_wrap = pending_wrap;
    screen.cursor.cursor_style = @enumFromInt(cursor_style);
    screen.cursor.protected = cursor_protected;
    screen.protected_mode = @enumFromInt(protected_mode);

    if (i + 9 > body.len) return error.Malformed;
    for (0..8) |slot| {
        screen.kitty_keyboard.flags[slot] = @bitCast(@as(u5, @truncate(body[i + slot])));
    }
    screen.kitty_keyboard.idx = @truncate(body[i + 8]);
    i += 9;

    if (i >= body.len) return error.Malformed;
    const saved_present = body[i] != 0;
    i += 1;
    const cursor: Cursor = .{ .x = cursor_x, .y = cursor_y, .pending_wrap = pending_wrap };
    if (!saved_present) {
        screen.saved_cursor = null;
        return cursor;
    }
    if (i + 7 > body.len) return error.Malformed;
    var saved: Screen.SavedCursor = .{
        .x = readInt(u16, body[i..][0..2]),
        .y = readInt(u16, body[i + 2 ..][0..2]),
        .protected = body[i + 4] != 0,
        .pending_wrap = body[i + 5] != 0,
        .origin = body[i + 6] != 0,
        .style = .{},
        .charset = .{},
    };
    i += 7;
    i = try readStyle(body, i, &saved.style);
    i = try readCharset(body, i, &saved.charset);
    screen.saved_cursor = saved;
    return cursor;
}

// -- little-endian primitives --------------------------------------------

/// Enum tags in this library are C-ABI ints; every one that reaches the
/// snapshot has far fewer than 256 values, and the import side range-checks
/// them on the way back.
fn enumU8(value: anytype) u8 {
    return @intCast(@intFromEnum(value));
}

fn writeInt(w: *std.Io.Writer, comptime T: type, value: T) !void {
    var buf: [@divExact(@bitSizeOf(T), 8)]u8 = undefined;
    std.mem.writeInt(T, &buf, value, .little);
    try w.writeAll(&buf);
}

fn readInt(comptime T: type, buf: *const [@divExact(@bitSizeOf(T), 8)]u8) T {
    return std.mem.readInt(T, buf, .little);
}

fn writeSection(w: *std.Io.Writer, tag: *const [4]u8, body: []const u8) !void {
    try w.writeAll(tag);
    try writeInt(w, u32, @intCast(body.len));
    try w.writeAll(body);
}

fn writeModes(w: *std.Io.Writer, m: modespkg.ModePacked) !void {
    const Backing = @typeInfo(modespkg.ModePacked).@"struct".backing_integer.?;
    try writeInt(w, ModeInt, @as(ModeInt, @as(Backing, @bitCast(m))));
}

fn readModes(buf: *const [MODE_BYTES]u8) modespkg.ModePacked {
    const Backing = @typeInfo(modespkg.ModePacked).@"struct".backing_integer.?;
    return @bitCast(@as(Backing, @truncate(readInt(ModeInt, buf))));
}

fn writeStyle(w: *std.Io.Writer, s: stylepkg.Style) !void {
    try writeColor(w, s.fg_color);
    try writeColor(w, s.bg_color);
    try writeColor(w, s.underline_color);
    const Flags = @TypeOf(s.flags);
    try writeInt(w, u16, @as(u16, @bitCast(@as(@typeInfo(Flags).@"struct".backing_integer.?, @bitCast(s.flags)))));
}

fn writeColor(w: *std.Io.Writer, c: stylepkg.Style.Color) !void {
    switch (c) {
        .none => {
            try writeInt(w, u8, 0);
            try w.writeAll(&[_]u8{ 0, 0, 0 });
        },
        .palette => |p| {
            try writeInt(w, u8, 1);
            try w.writeAll(&[_]u8{ p, 0, 0 });
        },
        .rgb => |rgb| {
            try writeInt(w, u8, 2);
            try w.writeAll(&[_]u8{ rgb.r, rgb.g, rgb.b });
        },
    }
}

fn readStyle(buf: []const u8, start: usize, out: *stylepkg.Style) !usize {
    var i = start;
    if (i + 14 > buf.len) return error.Malformed;
    i = readColor(buf, i, &out.fg_color);
    i = readColor(buf, i, &out.bg_color);
    i = readColor(buf, i, &out.underline_color);
    out.flags = @bitCast(readInt(u16, buf[i..][0..2]));
    return i + 2;
}

fn readColor(buf: []const u8, i: usize, out: *stylepkg.Style.Color) usize {
    out.* = switch (buf[i]) {
        1 => .{ .palette = buf[i + 1] },
        2 => .{ .rgb = .{ .r = buf[i + 1], .g = buf[i + 2], .b = buf[i + 3] } },
        else => .none,
    };
    return i + 4;
}

fn writeCharset(w: *std.Io.Writer, cs: Screen.CharsetState) !void {
    try writeInt(w, u8, enumU8(cs.charsets.g0));
    try writeInt(w, u8, enumU8(cs.charsets.g1));
    try writeInt(w, u8, enumU8(cs.charsets.g2));
    try writeInt(w, u8, enumU8(cs.charsets.g3));
    try writeInt(w, u8, enumU8(cs.gl));
    try writeInt(w, u8, enumU8(cs.gr));
    // 0xFF, not a slot value, is how "no single shift pending" travels.
    try writeInt(w, u8, if (cs.single_shift) |s| enumU8(s) else 0xFF);
}

fn readCharset(buf: []const u8, start: usize, out: *Screen.CharsetState) !usize {
    if (start + 7 > buf.len) return error.Malformed;
    out.charsets.g0 = @enumFromInt(buf[start]);
    out.charsets.g1 = @enumFromInt(buf[start + 1]);
    out.charsets.g2 = @enumFromInt(buf[start + 2]);
    out.charsets.g3 = @enumFromInt(buf[start + 3]);
    out.gl = @enumFromInt(buf[start + 4]);
    out.gr = @enumFromInt(buf[start + 5]);
    out.single_shift = if (buf[start + 6] == 0xFF) null else @enumFromInt(buf[start + 6]);
    return start + 7;
}

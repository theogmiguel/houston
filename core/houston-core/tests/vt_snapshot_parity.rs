#![cfg(unix)]

use houston_core::vt::{Emulator, VT_HISTORY_BYTES, VT_HISTORY_ROWS};

const COLS: u16 = 80;
const ROWS: u16 = 24;

struct Scenario {
    name: &'static str,
    a: Vec<u8>,
    b: Vec<u8>,
}

fn scenarios() -> Vec<Scenario> {
    let mut history = Vec::new();
    for i in 0..300 {
        history.extend_from_slice(
            format!(
                "\x1b[3{}mrow {i}\x1b[0m \x1b]8;;https://h/{i}\x1b\\L{i}\x1b]8;;\x1b\\\r\n",
                i % 8
            )
            .as_bytes(),
        );
    }
    let cases: Vec<(&'static str, &[u8], &[u8])> = vec![
        (
            "plain text",
            b"hello world\r\nsecond line\r\n",
            b"third line\r\n",
        ),
        (
            "sgr colors",
            b"\x1b[1;31mred bold\x1b[0m\r\n\x1b[38;2;10;20;30mtruecolor\x1b[0m\r\n",
            b"after\r\n",
        ),
        (
            "alternate screen active",
            b"primary content\r\n\x1b[?1049h\x1b[2J\x1b[Halt screen here",
            b"\r\nmore alt",
        ),
        (
            "alt then back to primary",
            b"primary\r\n\x1b[?1049halt\x1b[?1049l",
            b"back on primary\r\n",
        ),
        (
            "split CSI at cutoff",
            b"start\x1b[1",
            b";32mgreen\x1b[0m\r\n",
        ),
        (
            "split OSC 8 hyperlink",
            b"pre \x1b]8;;https://exam",
            b"ple.com\x1b\\link\x1b]8;;\x1b\\ post\r\n",
        ),
        (
            "split OSC 52",
            b"\x1b]52;c;SGVsbG8g",
            b"V29ybGQ=\x1b\\done\r\n",
        ),
        ("kitty flags pushed twice", b"\x1b[>1u\x1b[>5u", b"body\r\n"),
        (
            "mouse tracking sgr",
            b"\x1b[?1000h\x1b[?1006h",
            b"tracking\r\n",
        ),
        (
            "wide and grapheme cells",
            "\u{6f22}\u{5b57} e\u{301} \u{1f468}\u{200d}\u{1f469}\r\n".as_bytes(),
            b"after wide\r\n",
        ),
        (
            "hyperlink cells",
            b"\x1b]8;;https://houston.local\x1b\\clickme\x1b]8;;\x1b\\\r\n",
            b"tail\r\n",
        ),
        ("bracketed paste + origin", b"\x1b[?2004h\x1b[?6h", b"x\r\n"),
        (
            "saved cursor",
            b"abc\x1b[5;10H\x1b[1;31m\x1b7\x1b[0m\x1b[1;1H",
            b"zz\r\n",
        ),
        (
            "scrolling region",
            b"\x1b[5;20r\x1b[10;1Hin region\r\n",
            b"more\r\n",
        ),
        ("split UTF-8 codepoint", b"caf\xc3", b"\xa9 done\r\n"),
    ];
    let mut out: Vec<Scenario> = cases
        .into_iter()
        .map(|(name, a, b)| Scenario {
            name,
            a: a.to_vec(),
            b: b.to_vec(),
        })
        .collect();
    out.push(Scenario {
        name: "300 rows of history",
        a: history,
        b: b"tail row\r\n".to_vec(),
    });
    out
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("vt_snapshots.json")
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn build_fixture() -> String {
    let mut entries = Vec::new();
    for s in scenarios() {
        let mut vt = Emulator::new(COLS, ROWS, VT_HISTORY_BYTES).expect("emulator");
        vt.feed(&s.a);
        let state = vt.snapshot(VT_HISTORY_ROWS).expect("snapshot");
        entries.push(serde_json::json!({
            "name": s.name,
            "a": b64(&s.a),
            "b": b64(&s.b),
            "snapshot": b64(&state),
        }));
    }
    let doc = serde_json::json!({
        "cols": COLS,
        "rows": ROWS,
        "formatVersion": houston_core::vt::snapshot_format_version(),
        "historyRows": VT_HISTORY_ROWS,
        "scenarios": entries,
    });
    serde_json::to_string_pretty(&doc).expect("serialize") + "\n"
}

#[test]
fn the_committed_snapshot_fixture_matches_what_this_build_emits() {
    let built = build_fixture();
    let path = fixture_path();
    if std::env::var("HOUSTON_REGEN_VT_FIXTURE").is_ok() {
        std::fs::create_dir_all(path.parent().expect("fixtures dir")).expect("mkdir");
        std::fs::write(&path, &built).expect("write fixture");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{} is missing ({e}); regenerate it with HOUSTON_REGEN_VT_FIXTURE=1 cargo test \
             --test vt_snapshot_parity",
            path.display()
        )
    });
    assert_eq!(
        committed,
        built,
        "the committed snapshot fixture ({} bytes) is not what this build emits ({} bytes). \
         The renderer's import test reads it, so a stale fixture would prove nothing. \
         Regenerate: HOUSTON_REGEN_VT_FIXTURE=1 cargo test --test vt_snapshot_parity",
        committed.len(),
        built.len()
    );
}

#[test]
fn every_scenario_continues_identically_after_a_native_round_trip() {
    for s in scenarios() {
        let mut continuous = Emulator::new(COLS, ROWS, VT_HISTORY_BYTES).expect("emulator");
        continuous.feed(&s.a);
        continuous.feed(&s.b);

        let mut source = Emulator::new(COLS, ROWS, VT_HISTORY_BYTES).expect("emulator");
        source.feed(&s.a);
        let state = source.snapshot(VT_HISTORY_ROWS).expect("snapshot");

        let mut restored = Emulator::new(COLS, ROWS, VT_HISTORY_BYTES).expect("emulator");
        restored.import(&state).expect("import");
        restored.feed(&s.b);

        assert_eq!(
            restored.snapshot(VT_HISTORY_ROWS).expect("snapshot"),
            continuous.snapshot(VT_HISTORY_ROWS).expect("snapshot"),
            "scenario {:?}: a snapshot taken at the cutoff and continued does not match an \
             uninterrupted run",
            s.name
        );
    }
}

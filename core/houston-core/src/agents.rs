// Identity only: this labels a pane by whichever CLI last announced itself.
// It is not the working/needs-you status machine — that is hooks-driven.
use houston_protocol as proto;
use regex::Regex;
use std::sync::OnceLock;

// One Aho-Corasick pass instead of nine memmem searches: this runs on every
// PTY chunk of every session, and ordinary output (the common case) needs
// to read the bytes once, not nine times, before concluding "no banner".
fn banner_prescan() -> &'static aho_corasick::AhoCorasick {
    static SCAN: OnceLock<aho_corasick::AhoCorasick> = OnceLock::new();
    SCAN.get_or_init(|| {
        aho_corasick::AhoCorasick::new([
            &b"laude"[..],
            b"odex",
            b"ntigravity",
            b"agy",
            b"emini",
            b"pencode",
            b"ursor",
            b"roid",
            b"opilot",
            b"ider ",
            b"rok",
        ])
        .expect("banner prescan patterns are valid")
    })
}

fn might_contain_banner(chunk: &[u8]) -> bool {
    banner_prescan().is_match(chunk)
}

// Banners live at the head of an output burst; scanning a whole flood chunk
// through the regexes is wasted work. Capped per chunk, not per session, so
// a CLI started later in a shell is still recognized.
const SCAN_CAP: usize = 4096;

fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?x)
            \x1b\[[0-9;?]*[A-Za-z]                 # CSI
          | \x1b\][^\x07\x1b]*(?:\x07|\x1b\\)      # OSC
          | \x1b[PX^_][^\x1b]*\x1b\\               # DCS/SOS/PM/APC
          | \x1b[()][A-Z0-9]                       # charset select
          | \x1b[=>NOMDEHc78]                      # short escapes
          | [\x00-\x08\x0b\x0c\x0e-\x1f]           # stray control bytes
        ",
        )
        .unwrap()
    })
}

// Two shapes: the classic "Welcome to Claude Code!" and, since 2.1, a bare
// version header ("Claude Code v2.1.247") not at line start. The version
// form requires three numbers right after, so mid-line prose doesn't match.
fn claude_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?im)welcome to claude code|claude code(?:\x1b\[[0-9;]*m|\s)+v\d+\.\d+\.\d+(?:\x1b|\s*$)",
        )
        .unwrap()
    })
}

fn codex_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^[^\n]{0,8}OpenAI Codex").unwrap())
}

fn antigravity_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?im)^[^\n]{0,8}Antigravity\b|^[^\n]{0,8}Google Antigravity\b|\bagy +v?\d+|^[^\n]{0,8}Gemini[^\n]{0,40}\bCLI\b").unwrap()
    })
}

fn opencode_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?im)^[^\n]{0,8}opencode +v?\d").unwrap())
}

fn cursor_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^[^\n]{0,12}Cursor Agent\b|(?m)^[^\n]{0,8}cursor-agent +v?\d").unwrap()
    })
}

fn droid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^[^\n]{0,12}Factory Droid\b|(?m)^[^\n]{0,4}Droid v\d").unwrap()
    })
}

fn copilot_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^[^\n]{0,12}GitHub Copilot (?:CLI|Chat)\b").unwrap())
}

fn aider_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^[^\n]{0,4}[Aa]ider v\d").unwrap())
}

fn grok_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?m)^[^\n]{0,12}Grok Build\b|(?m)^[^\n]{0,8}grok-build\b|(?m)^[^\n]{0,8}grok v\d+",
        )
        .unwrap()
    })
}

pub fn strip_ansi(text: &str) -> String {
    ansi_re().replace_all(text, "").into_owned()
}

pub fn scan(chunk: &[u8]) -> Option<proto::AgentKind> {
    if !might_contain_banner(chunk) {
        return None;
    }
    let head = &chunk[..chunk.len().min(SCAN_CAP)];
    let raw = String::from_utf8_lossy(head);
    let text = ansi_re().replace_all(&raw, "");
    if claude_re().is_match(&text) {
        Some(proto::AgentKind::Claude)
    } else if codex_re().is_match(&text) {
        Some(proto::AgentKind::Codex)
    } else if antigravity_re().is_match(&text) {
        Some(proto::AgentKind::Antigravity)
    } else if opencode_re().is_match(&text) {
        Some(proto::AgentKind::Opencode)
    } else if cursor_re().is_match(&text) {
        Some(proto::AgentKind::Cursor)
    } else if droid_re().is_match(&text) {
        Some(proto::AgentKind::Droid)
    } else if copilot_re().is_match(&text) {
        Some(proto::AgentKind::Copilot)
    } else if aider_re().is_match(&text) {
        Some(proto::AgentKind::Aider)
    } else if grok_re().is_match(&text) {
        Some(proto::AgentKind::Grok)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_claude_code_banner_with_colors() {
        let banner = "\x1b[38;5;208m\u{273b} Welcome to \x1b[1mClaude Code\x1b[0m!\n".as_bytes();
        assert_eq!(scan(banner), Some(proto::AgentKind::Claude));
    }

    #[test]
    fn detects_the_claude_code_2_1_version_header() {
        let banner = "\x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.247\x1b[0m\nOpus 5 with xhigh effort\n"
            .as_bytes();
        assert_eq!(scan(banner), Some(proto::AgentKind::Claude));
        assert_eq!(
            scan(b"we shipped claude code v2.1 support yesterday\n"),
            None,
            "a mention mid-line is prose, not a banner"
        );
    }

    #[test]
    fn detects_codex_banner_with_box_prefix() {
        let banner = "\u{256d}\u{2500} >_ OpenAI Codex (v0.48.0)\n".as_bytes();
        assert_eq!(scan(banner), Some(proto::AgentKind::Codex));
    }

    #[test]
    fn detects_antigravity_banner() {
        assert_eq!(
            scan(b"Google Antigravity v1.0.0\n"),
            Some(proto::AgentKind::Antigravity)
        );
        assert_eq!(scan(b"agy v1.1.22\n"), Some(proto::AgentKind::Antigravity));
        assert_eq!(
            scan("\x1b[36m* Antigravity ready\x1b[0m\n".as_bytes()),
            Some(proto::AgentKind::Antigravity)
        );
    }

    #[test]
    fn codex_requires_line_start_context() {
        assert_eq!(
            scan(b"see the announcement about OpenAI Codex pricing today\n"),
            None
        );
    }

    #[test]
    fn plain_output_is_ignored_cheaply() {
        assert_eq!(scan(b"compiling houston-core v0.1.0 (42 warnings)\n"), None);
        assert_eq!(scan(b"$ ls -la\ntotal 48\n"), None);
    }

    #[test]
    fn mentions_without_banner_shape_are_ignored() {
        assert_eq!(scan(b"I asked claude about gemini vs codex\n"), None);
        assert_eq!(scan(b"read about android droid stuff online\n"), None);
        assert_eq!(scan(b"the spider web\n"), None);
        assert_eq!(scan(b"we considered opencode as an option\n"), None);
        assert_eq!(scan(b"the cursor agent pattern\n"), None);
        assert_eq!(scan(b"grok cli docs say otherwise\n"), None);
        assert_eq!(scan(b"we discussed grok build tool today\n"), None);
        assert_eq!(scan(b"error: aider v2 required\n"), None);
        assert_eq!(scan(b"install droid v9 pkg\n"), None);
        assert_eq!(scan(b"install the github copilot cli today\n"), None);
        assert_eq!(scan(b"opencode is at v3 now\n"), None);
    }

    #[test]
    fn detects_the_v13_banner_table() {
        assert_eq!(
            scan(b"\x1b[35mopencode v0.6.1\x1b[0m\n"),
            Some(proto::AgentKind::Opencode)
        );
        assert_eq!(
            scan(b"Welcome to Cursor Agent!\n"),
            Some(proto::AgentKind::Cursor)
        );
        assert_eq!(
            scan(b"Factory Droid ready\n"),
            Some(proto::AgentKind::Droid)
        );
        assert_eq!(
            scan(b"GitHub Copilot CLI 1.2.0\n"),
            Some(proto::AgentKind::Copilot)
        );
        assert_eq!(scan(b"Aider v0.86.1\n"), Some(proto::AgentKind::Aider));
        assert_eq!(scan(b"Grok Build v0.3\n"), Some(proto::AgentKind::Grok));
    }

    #[test]
    fn detects_grok_build_not_the_nonexistent_grok_cli_banner() {
        assert_eq!(scan(b"Grok Build v1.2.3\n"), Some(proto::AgentKind::Grok));
        assert_eq!(scan(b"grok-build\n"), Some(proto::AgentKind::Grok));
        assert_eq!(scan(b"grok v4\n"), Some(proto::AgentKind::Grok));
        assert_eq!(scan(b"Grok CLI 0.3\n"), None);
        assert_eq!(scan(b"grok-cli v0.3\n"), None);
    }

    #[test]
    fn scan_cap_only_reads_the_chunk_head() {
        let mut chunk = vec![b'x'; 5000];
        chunk.extend_from_slice(b"\nAider v0.86.1\n");
        assert_eq!(scan(&chunk), None);
    }
}

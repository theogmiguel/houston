//! `wsl.exe -l -v` output. The state column is localized, so it is display text only.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Distro {
    pub name: String,
    pub state: String,
    pub version: u8,
    pub default: bool,
}

/// Distros that container engines create to host the engine itself; nobody works in them.
pub const UTILITY: [&str; 4] = [
    "docker-desktop",
    "docker-desktop-data",
    "rancher-desktop",
    "rancher-desktop-data",
];

pub fn is_utility(name: &str) -> bool {
    UTILITY.contains(&name)
}

/// `wsl.exe` writes UTF-16LE unless `WSL_UTF8=1` reached it; a NUL byte tells them apart.
pub fn decode(bytes: &[u8]) -> String {
    let text = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.strip_prefix('\u{feff}')
        .unwrap_or(&text)
        .replace('\r', "")
}

/// Rows split on runs of two or more spaces: name first, state and version last.
/// A row whose last column is not a number (the header) is not a distro.
pub fn parse_list(text: &str) -> Vec<Distro> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let default = line.starts_with('*');
            let fields: Vec<&str> = line
                .trim_start_matches('*')
                .split("  ")
                .map(str::trim)
                .filter(|field| !field.is_empty())
                .collect();
            let [name, .., state, version] = fields.as_slice() else {
                return None;
            };
            Some(Distro {
                name: name.to_string(),
                state: state.to_string(),
                version: version.parse().ok()?,
                default,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORDED_UTF16: &[u8] = include_bytes!("fixtures/wsl-l-v-utf16.bin");
    const RECORDED_UTF8: &[u8] = include_bytes!("fixtures/wsl-l-v-utf8.bin");

    fn utf16le(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn parses_recorded_list_verbose() {
        let expected = vec![
            Distro {
                name: "Ubuntu".into(),
                state: "Running".into(),
                version: 2,
                default: true,
            },
            Distro {
                name: "docker-desktop".into(),
                state: "Stopped".into(),
                version: 2,
                default: false,
            },
        ];
        assert_eq!(parse_list(&decode(RECORDED_UTF16)), expected);
        assert_eq!(parse_list(&decode(RECORDED_UTF8)), expected);
    }

    #[test]
    fn decodes_by_nul_presence() {
        let text = "  NAME      STATE   VERSION\r\n* Ubuntu    Running 2\r\n";
        let clean = "  NAME      STATE   VERSION\n* Ubuntu    Running 2\n";

        let mut with_bom = vec![0xFF, 0xFE];
        with_bom.extend(utf16le(text));
        assert_eq!(decode(&with_bom), clean);
        assert_eq!(decode(&utf16le(text)), clean);

        let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
        utf8_bom.extend(text.as_bytes());
        assert_eq!(decode(&utf8_bom), clean);
        assert_eq!(decode(text.as_bytes()), clean);

        assert!(RECORDED_UTF16.contains(&0) && !RECORDED_UTF8.contains(&0));
        let decoded = decode(RECORDED_UTF16);
        assert!(
            !decoded.contains('\r') && !decoded.contains('\0'),
            "{decoded:?}"
        );
        assert_eq!(decoded, decode(RECORDED_UTF8));
    }

    #[test]
    fn a_header_or_blank_line_is_not_a_distro() {
        assert!(parse_list("  NAME   STATE   VERSION\n\n").is_empty());
    }
}

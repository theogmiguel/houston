//! Windows virtual-key translation and the modifier-pair edge detector. The values
//! are plain numbers so the shortcut rules run as unit tests on every host, while the
//! FFI that polls them lives in `windows_input.rs`.

use super::platform::KeyChord;

pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;

/// Both physical keys of a modifier, matching upstream `WINDOWS_MODIFIER_PAIR_VIRTUAL_KEYS`.
pub fn modifier_pair_keys(modifier: &str) -> Option<(i32, i32)> {
    match modifier {
        "shift" => Some((0xA0, 0xA1)),
        "control" => Some((0xA2, 0xA3)),
        "alt" => Some((0xA4, 0xA5)),
        "meta" => Some((0x5B, 0x5C)),
        _ => None,
    }
}

/// The upstream `snapShotModifierPairLabel` for the non-Apple labels.
pub fn pair_label(modifier: &str) -> Option<&'static str> {
    match modifier {
        "shift" => Some("Shift + Shift"),
        "meta" => Some("Super + Super"),
        "control" => Some("Ctrl + Ctrl"),
        "alt" => Some("Alt + Alt"),
        _ => None,
    }
}

/// An observed pair cannot be reserved exclusively, so the status explains that
/// instead of claiming an exclusive registration. Windows-specific caveats follow
/// upstream `observedPairMessage`.
pub fn observed_pair_message(modifier: &str) -> String {
    let label = pair_label(modifier).unwrap_or(modifier);
    let base = format!("{label} is observed and cannot be reserved exclusively.");
    match modifier {
        "meta" => format!("{base} This key can also open the system's own menu."),
        "alt" => format!("{base} This key can also activate app menu bars."),
        _ => base,
    }
}

pub fn pair_failure_message(modifier: &str) -> String {
    let label = pair_label(modifier).unwrap_or(modifier);
    format!("{label} is not available on this system.")
}

pub fn chord_failure_message() -> String {
    "This shortcut is already used by the system or another app.".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChordSpec {
    pub modifiers: u32,
    pub virtual_key: u32,
}

/// Translates the settings chord into the `RegisterHotKey` arguments. Command and
/// Control both mean Control on Windows; Super is the Windows key.
pub fn chord_spec(chord: &KeyChord) -> Result<ChordSpec, String> {
    let mut modifiers = 0;
    if chord.alt_key {
        modifiers |= MOD_ALT;
    }
    if chord.ctrl_key || chord.mod_key {
        modifiers |= MOD_CONTROL;
    }
    if chord.shift_key {
        modifiers |= MOD_SHIFT;
    }
    if chord.meta_key {
        modifiers |= MOD_WIN;
    }
    let virtual_key = virtual_key(&chord.key).ok_or_else(|| {
        format!(
            "Windows cannot map the shortcut key {:?}; use a letter, digit or function key.",
            chord.key
        )
    })?;
    Ok(ChordSpec {
        modifiers,
        virtual_key,
    })
}

fn virtual_key(key: &str) -> Option<u32> {
    if key == " " {
        return Some(0x20);
    }
    let trimmed = key.trim();
    let uppercase = trimmed.to_uppercase();
    let mut characters = uppercase.chars();
    if let (Some(character), None) = (characters.next(), characters.next()) {
        if character.is_ascii_uppercase() || character.is_ascii_digit() {
            return Some(character as u32);
        }
    }
    Some(match uppercase.as_str() {
        " " | "SPACE" => 0x20,
        "TAB" => 0x09,
        "ENTER" | "RETURN" => 0x0D,
        "ESC" | "ESCAPE" => 0x1B,
        "BACKSPACE" => 0x08,
        "DELETE" | "DEL" => 0x2E,
        "INSERT" => 0x2D,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "ARROWLEFT" | "LEFT" => 0x25,
        "ARROWUP" | "UP" => 0x26,
        "ARROWRIGHT" | "RIGHT" => 0x27,
        "ARROWDOWN" | "DOWN" => 0x28,
        "`" | "BACKQUOTE" => 0xC0,
        "-" | "MINUS" => 0xBD,
        "=" | "EQUAL" => 0xBB,
        "[" | "BRACKETLEFT" => 0xDB,
        "]" | "BRACKETRIGHT" => 0xDD,
        "\\" | "BACKSLASH" => 0xDC,
        ";" | "SEMICOLON" => 0xBA,
        "'" | "QUOTE" => 0xDE,
        "," | "COMMA" => 0xBC,
        "." | "PERIOD" => 0xBE,
        "/" | "SLASH" => 0xBF,
        function if function.len() >= 2 && function.len() <= 3 && function.starts_with('F') => {
            let number: u32 = function[1..].parse().ok()?;
            if !(1..=24).contains(&number) {
                return None;
            }
            0x70 + number - 1
        }
        _ => return None,
    })
}

/// Rising-edge detector for the two-key poll. Holding the pair must trigger once,
/// like upstream's `pressed && !active` check.
#[derive(Debug, Default)]
pub struct ModifierPairPoll {
    pressed: bool,
}

impl ModifierPairPoll {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn step(&mut self, pressed: bool) -> bool {
        let triggered = pressed && !self.pressed;
        self.pressed = pressed;
        triggered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(key: &str) -> KeyChord {
        KeyChord {
            key: key.to_string(),
            ..KeyChord::default()
        }
    }

    #[test]
    fn modifier_pairs_match_the_polled_virtual_keys() {
        assert_eq!(modifier_pair_keys("shift"), Some((0xA0, 0xA1)));
        assert_eq!(modifier_pair_keys("control"), Some((0xA2, 0xA3)));
        assert_eq!(modifier_pair_keys("alt"), Some((0xA4, 0xA5)));
        assert_eq!(modifier_pair_keys("meta"), Some((0x5B, 0x5C)));
        assert_eq!(modifier_pair_keys("hyper"), None);
    }

    #[test]
    fn observed_pair_messages_carry_the_windows_caveats() {
        assert_eq!(
            observed_pair_message("shift"),
            "Shift + Shift is observed and cannot be reserved exclusively."
        );
        assert_eq!(
            observed_pair_message("meta"),
            "Super + Super is observed and cannot be reserved exclusively. This key can also open the system's own menu."
        );
        assert_eq!(
            observed_pair_message("alt"),
            "Alt + Alt is observed and cannot be reserved exclusively. This key can also activate app menu bars."
        );
        assert_eq!(
            pair_failure_message("control"),
            "Ctrl + Ctrl is not available on this system."
        );
        assert_eq!(pair_label("unknown"), None);
    }

    #[test]
    fn chord_failure_matches_upstream() {
        assert_eq!(
            chord_failure_message(),
            "This shortcut is already used by the system or another app."
        );
    }

    #[test]
    fn letters_digits_and_named_keys_map_to_virtual_keys() {
        assert_eq!(virtual_key("s"), Some(0x53));
        assert_eq!(virtual_key("S"), Some(0x53));
        assert_eq!(virtual_key("7"), Some(0x37));
        assert_eq!(virtual_key(" "), Some(0x20));
        assert_eq!(virtual_key("Escape"), Some(0x1B));
        assert_eq!(virtual_key("ArrowUp"), Some(0x26));
        assert_eq!(virtual_key("F12"), Some(0x7B));
        assert_eq!(virtual_key("F24"), Some(0x87));
        assert_eq!(virtual_key("F25"), None);
        assert_eq!(virtual_key("MediaPlayPause"), None);
    }

    #[test]
    fn chords_combine_modifiers_the_way_windows_expects() {
        let mut shortcut = chord("s");
        shortcut.ctrl_key = true;
        shortcut.shift_key = true;
        assert_eq!(
            chord_spec(&shortcut),
            Ok(ChordSpec {
                modifiers: MOD_CONTROL | MOD_SHIFT,
                virtual_key: 0x53,
            })
        );

        let mut command = chord("k");
        command.mod_key = true;
        assert_eq!(
            chord_spec(&command).expect("command").modifiers,
            MOD_CONTROL,
            "CommandOrControl is Control on Windows"
        );

        let mut super_key = chord("k");
        super_key.meta_key = true;
        super_key.alt_key = true;
        assert_eq!(
            chord_spec(&super_key).expect("super").modifiers,
            MOD_WIN | MOD_ALT
        );

        assert!(chord_spec(&chord("Unidentified")).is_err());
    }

    #[test]
    fn the_pair_poll_triggers_once_per_press() {
        let mut poll = ModifierPairPoll::new();
        assert!(!poll.step(false));
        assert!(poll.step(true));
        assert!(!poll.step(true));
        assert!(!poll.step(false));
        assert!(poll.step(true));
    }
}

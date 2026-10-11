//! What a dictation inserts into a prompt. The desktop and a paired device
//! share this rule, so the agent sees the same text whichever microphone spoke.
use houston_protocol as proto;

// Prepended to the dictated text rather than installed as a system-prompt note:
// nothing is written into the agent CLI's own config, and turning the setting
// off removes it with no cleanup step.
pub const AGENT_PREAMBLE: &str = "The following was dictated in Brazilian Portuguese and \
     machine-translated to English; treat wording quirks as transcription artefacts, and write \
     your final answer back in Brazilian Portuguese.";

/// Whether this settings combination prefixes the preamble on a pane's first dictation.
pub fn wants_preamble(output_mode: proto::VoiceOutputMode, agent_preamble: bool) -> bool {
    agent_preamble && output_mode == proto::VoiceOutputMode::English
}

/// The trimmed transcript plus one trailing space, never a newline, so a
/// dictation cannot submit; empty when the engine returned only whitespace.
pub fn insert_text(text: &str, with_preamble: bool) -> String {
    let body = text.trim();
    if body.is_empty() {
        return String::new();
    }
    if with_preamble {
        format!("{AGENT_PREAMBLE} {body} ")
    } else {
        format!("{body} ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proto::VoiceOutputMode::{English, Original};

    #[test]
    fn ends_with_a_space_and_never_a_newline_so_dictation_cannot_submit() {
        let out = insert_text("run the tests", false);
        assert_eq!(out, "run the tests ");
        assert!(!out.contains('\n') && !out.contains('\r'));
    }

    #[test]
    fn trims_what_the_engine_returned() {
        assert_eq!(insert_text("  hello  ", false), "hello ");
    }

    #[test]
    fn inserts_nothing_for_an_empty_transcript() {
        assert_eq!(insert_text("   ", true), "");
    }

    #[test]
    fn only_english_output_with_the_toggle_on_wants_the_preamble() {
        assert!(wants_preamble(English, true));
        assert!(!wants_preamble(English, false));
        assert!(!wants_preamble(Original, true));
    }

    #[test]
    fn the_preamble_leads_the_text() {
        let out = insert_text("run the tests", true);
        assert!(out.starts_with(AGENT_PREAMBLE));
        assert!(out.ends_with(" run the tests "));
    }
}

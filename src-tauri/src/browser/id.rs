// 64 gives headroom for a synthetic/composite id without letting an unbounded
// string into a Tauri webview label or a GTK widget name.
pub const MAX_ID_LEN: usize = 64;

const LABEL_PREFIX: &str = "tr-browser-";

pub fn validate_surface_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!(
            "browser: surface id must be non-empty, got {id:?}; expected 1-{MAX_ID_LEN} ASCII \
             letters/digits/-/_"
        ));
    }
    if id.len() > MAX_ID_LEN {
        return Err(format!(
            "browser: surface id {id:?} is {} bytes; expected at most {MAX_ID_LEN} ASCII \
             letters/digits/-/_",
            id.len()
        ));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!(
            "browser: surface id {id:?} must contain only ASCII letters, digits, '-' or '_'"
        ));
    }
    Ok(())
}

pub fn derive_label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

// The invoke guard reads this: a page loaded in a browser pane is content-only
// and holds no app authority, so its mount-time transport sever is backed by a
// host-side refusal even where the transport survives.
pub fn is_content_only_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_conservative_tokens() {
        for id in ["a", "grid-leaf-3", "rightPanel", "A1_b-2", "0"] {
            assert!(validate_surface_id(id).is_ok(), "{id:?} should be accepted");
        }
    }

    #[test]
    fn rejects_empty_id_and_names_it() {
        let err = validate_surface_id("").unwrap_err();
        assert!(err.contains("\"\""), "{err}");
    }

    #[test]
    fn rejects_id_over_the_length_cap_and_names_the_length() {
        let too_long = "a".repeat(MAX_ID_LEN + 1);
        let err = validate_surface_id(&too_long).unwrap_err();
        assert!(err.contains(&format!("{}", MAX_ID_LEN + 1)), "{err}");
        assert!(err.contains(&MAX_ID_LEN.to_string()), "{err}");
    }

    #[test]
    fn accepts_id_at_exactly_the_length_cap() {
        let exact = "a".repeat(MAX_ID_LEN);
        assert!(validate_surface_id(&exact).is_ok());
    }

    #[test]
    fn rejects_path_like_and_whitespace_ids_and_names_the_value() {
        for id in ["../escape", "grid leaf", "grid/leaf", "grid\nleaf", "id\0x"] {
            let err = validate_surface_id(id).unwrap_err();
            assert!(err.contains(&format!("{id:?}")), "{err} should name {id:?}");
        }
    }

    #[test]
    fn rejects_non_ascii_ids() {
        let err = validate_surface_id("grid-léaf").unwrap_err();
        assert!(err.contains("grid-léaf"), "{err}");
    }

    #[test]
    fn derived_label_carries_the_id_under_the_shared_prefix() {
        assert_eq!(derive_label("grid-leaf-3"), "tr-browser-grid-leaf-3");
    }

    #[test]
    fn content_only_labels_are_exactly_the_ones_this_module_mints() {
        for id in ["a", "grid-leaf-3", "rightPanel", "A1_b-2"] {
            assert!(
                is_content_only_label(&derive_label(id)),
                "{id:?}'s derived label must read as content-only"
            );
        }
        assert!(is_content_only_label("tr-browser-window-grid-leaf-3"));
        for label in ["main", "spike-webview", "tr-browser", "trbrowser-x", ""] {
            assert!(
                !is_content_only_label(label),
                "{label:?} is not a browser surface and must keep its IPC"
            );
        }
    }
}

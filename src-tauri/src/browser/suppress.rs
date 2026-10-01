use std::collections::BTreeSet;

// Renderer counts collapse to one asserted state per reason on the wire. Replays
// during surface registration must therefore be idempotent.
#[derive(Debug, Clone, Default)]
pub struct SuppressionSet(BTreeSet<String>);

impl SuppressionSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn assert(&mut self, reason: &str) -> Result<(), String> {
        self.0.insert(normalize_reason(reason)?);
        Ok(())
    }

    pub fn release(&mut self, reason: &str) -> Result<(), String> {
        let reason = normalize_reason(reason)?;
        self.0.remove(&reason);
        Ok(())
    }

    pub fn is_hidden(&self) -> bool {
        !self.0.is_empty()
    }

    pub fn reasons(&self) -> Vec<String> {
        self.0.iter().cloned().collect()
    }
}

pub fn apply_visibility(
    hidden: bool,
    set_visible: impl FnOnce(bool) -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    set_visible(!hidden)?;
    if !hidden {
        restore()?;
    }
    Ok(())
}

fn normalize_reason(reason: &str) -> Result<String, String> {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "browser: suppression reason must be a non-empty string, got {reason:?}"
        ));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_visible() {
        let set = SuppressionSet::new();
        assert!(!set.is_hidden());
    }

    #[test]
    fn asserting_a_reason_hides() {
        let mut set = SuppressionSet::new();
        set.assert("modal").unwrap();
        assert!(set.is_hidden());
    }

    #[test]
    fn releasing_the_only_reason_shows_again() {
        let mut set = SuppressionSet::new();
        set.assert("modal").unwrap();
        set.release("modal").unwrap();
        assert!(!set.is_hidden());
    }

    #[test]
    fn overlapping_reasons_stay_hidden_until_every_reason_is_released() {
        let mut set = SuppressionSet::new();
        set.assert("modal").unwrap();
        set.assert("tabs-popover").unwrap();
        set.release("modal").unwrap();
        assert!(set.is_hidden(), "still hidden while tabs-popover holds");
        set.release("tabs-popover").unwrap();
        assert!(!set.is_hidden());
    }

    #[test]
    fn releasing_an_unasserted_reason_is_a_noop() {
        let mut set = SuppressionSet::new();
        set.assert("modal").unwrap();
        set.release("never-asserted").unwrap();
        assert!(set.is_hidden(), "unrelated release must not affect modal");
    }

    #[test]
    fn replaying_renderer_state_does_not_leak_a_reason() {
        let mut set = SuppressionSet::new();
        set.assert("popover").unwrap();
        set.assert("popover").unwrap();
        set.release("popover").unwrap();
        assert!(!set.is_hidden());
    }

    #[test]
    fn showing_restores_geometry_and_device_zoom_after_reveal() {
        let calls = std::cell::RefCell::new(Vec::new());
        apply_visibility(
            false,
            |visible| {
                calls
                    .borrow_mut()
                    .push(if visible { "show" } else { "hide" });
                Ok(())
            },
            || {
                calls.borrow_mut().extend(["geometry", "device-zoom"]);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), ["show", "geometry", "device-zoom"]);
        calls.borrow_mut().clear();
        apply_visibility(
            true,
            |_| {
                calls.borrow_mut().push("hide");
                Ok(())
            },
            || {
                panic!("hidden surfaces must not restore geometry or zoom");
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), ["hide"]);
    }

    #[test]
    fn empty_reason_is_rejected_and_named() {
        let mut set = SuppressionSet::new();
        let err = set.assert("   ").unwrap_err();
        assert!(err.contains("\"   \""), "{err}");
    }
}

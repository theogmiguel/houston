use std::collections::BTreeMap;

// Counted per reason, not a boolean or a plain set: two asserters of the same reason
// must be told apart, so the first release cannot un-hide a child the second still
// needs hidden.
#[derive(Debug, Clone, Default)]
pub struct SuppressionSet(BTreeMap<String, usize>);

impl SuppressionSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn assert(&mut self, reason: &str) -> Result<(), String> {
        *self.0.entry(normalize_reason(reason)?).or_insert(0) += 1;
        Ok(())
    }

    pub fn release(&mut self, reason: &str) -> Result<(), String> {
        let reason = normalize_reason(reason)?;
        if let Some(count) = self.0.get_mut(&reason) {
            *count -= 1;
            if *count == 0 {
                self.0.remove(&reason);
            }
        }
        Ok(())
    }

    pub fn is_hidden(&self) -> bool {
        !self.0.is_empty()
    }

    pub fn reasons(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
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
    fn two_asserters_of_the_same_reason_both_need_releasing() {
        let mut set = SuppressionSet::new();
        set.assert("modal").unwrap();
        set.assert("modal").unwrap();
        set.release("modal").unwrap();
        assert!(
            set.is_hidden(),
            "must still be hidden after releasing only one of two same-reason asserts"
        );
        set.release("modal").unwrap();
        assert!(!set.is_hidden());
    }

    #[test]
    fn empty_reason_is_rejected_and_named() {
        let mut set = SuppressionSet::new();
        let err = set.assert("   ").unwrap_err();
        assert!(err.contains("\"   \""), "{err}");
    }
}

//! Refs cannot live in the page: WebKitGTK hands every `evaluate_javascript` call a
//! fresh ephemeral world, so page globals do not survive between calls. Each surface's
//! store maps `e<n>` to a structural locator re-resolved against the live document.
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locator {
    pub path: Vec<u32>,
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct RefStore {
    seq: u64,
    map: HashMap<String, Locator>,
}

impl RefStore {
    pub fn start_seq(&self) -> u64 {
        self.seq
    }

    pub fn replace(&mut self, entries: HashMap<String, Locator>, minted: u64) {
        self.map = entries;
        self.seq += minted;
    }

    pub fn get(&self, r: &str) -> Option<&Locator> {
        self.map.get(r)
    }

    pub fn clear_for_navigation(&mut self) {
        self.map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locator(path: &[u32], tags: &[&str]) -> Locator {
        Locator {
            path: path.to_vec(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[test]
    fn a_snapshot_replaces_the_previous_snapshots_refs() {
        let mut store = RefStore::default();
        store.replace(HashMap::from([("e1".into(), locator(&[0], &["body"]))]), 1);
        store.replace(HashMap::from([("e2".into(), locator(&[1], &["body"]))]), 1);
        assert!(store.get("e1").is_none(), "an old snapshot's ref must die");
        assert_eq!(store.get("e2"), Some(&locator(&[1], &["body"])));
    }

    #[test]
    fn the_sequence_is_monotonic_across_snapshots_and_navigations() {
        let mut store = RefStore::default();
        assert_eq!(store.start_seq(), 0);
        store.replace(HashMap::new(), 7);
        assert_eq!(store.start_seq(), 7);
        store.clear_for_navigation();
        assert_eq!(
            store.start_seq(),
            7,
            "navigation must not reset numbering — a recycled ref could alias"
        );
        store.replace(HashMap::new(), 3);
        assert_eq!(store.start_seq(), 10);
    }

    #[test]
    fn navigation_invalidates_every_ref() {
        let mut store = RefStore::default();
        store.replace(HashMap::from([("e1".into(), locator(&[0], &["body"]))]), 1);
        store.clear_for_navigation();
        assert!(store.get("e1").is_none());
    }
}

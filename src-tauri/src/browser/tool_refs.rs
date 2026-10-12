//! WebKitGTK evaluations have ephemeral globals. Native refs retain locators whose
//! node-owned listeners prove document and element identity across script worlds.
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locator {
    pub path: Vec<u32>,
    pub tags: Vec<String>,
    pub document_identity: String,
    pub element_identity: String,
}

#[derive(Debug, Clone)]
pub struct RefStore {
    seq: u64,
    cleanup_identity: String,
    map: HashMap<String, Locator>,
}

impl Default for RefStore {
    fn default() -> Self {
        Self {
            seq: 0,
            map: HashMap::new(),
            cleanup_identity: format!("houston-cleanup-{}", uuid::Uuid::new_v4()),
        }
    }
}

impl RefStore {
    pub fn start_seq(&self) -> u64 {
        self.seq
    }

    pub fn cleanup_identity(&self) -> &str {
        &self.cleanup_identity
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
            document_identity: "document".into(),
            element_identity: "element".into(),
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

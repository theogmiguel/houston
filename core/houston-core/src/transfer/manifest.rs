//! `manifest.json`, the first entry of a transfer file. `format` changes whenever an
//! older Houston could not restore a newer file correctly.

use houston_protocol as proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const FORMAT_VERSION: u32 = 1;
pub const FILE_EXTENSION: &str = "houston-transfer";
pub const MANIFEST_ENTRY: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub transfer_id: String,
    pub created_at_ms: u64,
    /// `std::env::consts::OS` of the exporting computer.
    pub source_os: String,
    pub houston_version: String,
    pub workspace: WorkspaceEntry,
    pub cli_versions: Vec<proto::TransferCliVersion>,
    pub checkouts: Vec<CheckoutEntry>,
    pub panes: Vec<PaneEntry>,
    pub skipped: Vec<proto::TransferSkipped>,
    /// Untracked entries not carried: symbolic links and other non-regular paths.
    pub skipped_links: Vec<String>,
    /// The renderer's grid entries for the workspace, never interpreted by the daemon.
    pub grids: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutEntry {
    /// `main`, or `worktree:<slug>`.
    pub key: String,
    /// The slug of a Houston worktree under `.houston/worktrees/`.
    pub worktree: Option<String>,
    /// The checkout's path on the exporting computer.
    pub path: String,
    /// `None` for a detached HEAD.
    pub branch: Option<String>,
    pub head: String,
    /// `checkouts/<n>/head.bundle` holds commits no remote ref has.
    pub bundle: bool,
    /// `checkouts/<n>/tracked.diff` holds a binary diff against `head`.
    pub diff: bool,
    /// Untracked, non-ignored files under `checkouts/<n>/untracked/`, `/`-separated.
    pub untracked: Vec<String>,
    /// Where `checkouts/<n>/` sits in the archive.
    pub archive_dir: String,
    /// The transfer this checkout arrived in on the exporting computer, if any.
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneEntry {
    pub source_session: u32,
    pub provider: proto::AgentKind,
    pub title: String,
    pub checkout: String,
    /// The pane's folder relative to its checkout, `/`-separated; empty for the root.
    pub rel_cwd: String,
    /// The pane's folder on the exporting computer.
    pub cwd: String,
    pub conversation: String,
    /// Where `transcripts/<n>/` sits in the archive.
    pub archive_dir: String,
    /// The transcript relative to the provider location: `<id>.jsonl` for Claude, the
    /// `sessions/…` path for Codex.
    pub transcript: String,
    /// The other files under `archive_dir`, relative to the same location.
    pub extra_files: Vec<String>,
    pub transcript_sha256: String,
    pub launch_selections: Option<crate::launch::SessionLaunchSelections>,
    pub profile_label: Option<String>,
    /// The transfer and pane this conversation arrived as on the exporting computer.
    pub origin: Option<PaneOrigin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaneOrigin {
    pub transfer_id: String,
    pub session: u32,
}

/// A checkout's state as paths: HEAD plus a content hash for every path whose working
/// file differs from HEAD or is untracked. Equal states mean the tree did not change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeState {
    pub head: String,
    pub paths: BTreeMap<String, String>,
}

impl TreeState {
    /// What differs between two states, as user-facing lines.
    pub fn changes_since(&self, recorded: &TreeState) -> Vec<String> {
        let mut out = Vec::new();
        if self.head != recorded.head {
            out.push(format!(
                "HEAD moved from {} to {}",
                short(&recorded.head),
                short(&self.head)
            ));
        }
        for (path, hash) in &self.paths {
            match recorded.paths.get(path) {
                None => out.push(format!("{path} (changed after the export)")),
                Some(old) if old != hash => out.push(format!("{path} (edited after the export)")),
                Some(_) => {}
            }
        }
        for path in recorded.paths.keys() {
            if !self.paths.contains_key(path) {
                out.push(format!("{path} (reverted after the export)"));
            }
        }
        out
    }
}

pub fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

/// The leading numeric parts of a CLI version, for an older/newer comparison:
/// `2.1.307 (Claude Code)` and `codex-cli 0.142.3` both parse.
pub fn version_key(version: &str) -> Option<Vec<u64>> {
    let start = version.find(|c: char| c.is_ascii_digit())?;
    let parts: Vec<u64> = version[start..]
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .next()?
        .split('.')
        .map_while(|part| part.parse().ok())
        .collect();
    (!parts.is_empty()).then_some(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_their_numeric_parts() {
        assert_eq!(version_key("2.1.307 (Claude Code)"), Some(vec![2, 1, 307]));
        assert_eq!(version_key("codex-cli 0.142.3"), Some(vec![0, 142, 3]));
        assert!(version_key("2.1.307") > version_key("2.1.99"));
        assert_eq!(version_key("unknown"), None);
    }

    #[test]
    fn tree_changes_name_each_path_and_a_moved_head() {
        let recorded = TreeState {
            head: "a".repeat(40),
            paths: [("kept".into(), "1".into()), ("gone".into(), "2".into())].into(),
        };
        let now = TreeState {
            head: "b".repeat(40),
            paths: [("kept".into(), "9".into()), ("new".into(), "3".into())].into(),
        };
        assert_eq!(
            now.changes_since(&recorded),
            vec![
                format!("HEAD moved from {} to {}", "a".repeat(12), "b".repeat(12)),
                "kept (edited after the export)".to_string(),
                "new (changed after the export)".to_string(),
                "gone (reverted after the export)".to_string(),
            ]
        );
        assert!(recorded.changes_since(&recorded).is_empty());
    }
}

//! Local credential helpers and provider constants for task tracker connectors.

use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::collections::BTreeMap;

pub mod github;
pub mod notion;

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrackerPollCursor {
    pub etag: Option<String>,
    pub last_edited_time: Option<String>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTaskSnapshot {
    pub external_id: String,
    pub url: String,
    pub remote_rev: Option<String>,
    pub fields: BTreeMap<String, String>,
    pub project: Option<houston_protocol::TaskTrackerProjectSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerPollPage {
    pub records: Vec<RemoteTaskSnapshot>,
    pub cursor: TrackerPollCursor,
    pub not_modified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerWriteReceipt {
    pub external_id: Option<String>,
    pub url: Option<String>,
    pub remote_rev: Option<String>,
}

pub const NOTION_API_VERSION: &str = "2026-03-11";
pub const SNAPSHOT_MAX_BYTES: usize = 65_536;

pub fn project_external_key(provider: houston_protocol::TaskTrackerProvider, external_id: &str) -> String {
    let provider = match provider {
        houston_protocol::TaskTrackerProvider::GithubIssues => "github_issues",
        houston_protocol::TaskTrackerProvider::Notion => "notion",
        houston_protocol::TaskTrackerProvider::Slack => "slack",
    };
    format!("{provider}:{external_id}")
}

pub fn github_milestone_project_key(repository: &str, milestone_number: u64) -> String {
    project_external_key(
        houston_protocol::TaskTrackerProvider::GithubIssues,
        &format!("{repository}:milestone:{milestone_number}"),
    )
}

fn service(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider) -> String {
    let mut hash = Sha256::new();
    hash.update(state_dir.display().to_string().as_bytes());
    hash.update([0]);
    hash.update(workspace.as_bytes());
    format!("houston-tracker-{}-{}", match provider {
        houston_protocol::TaskTrackerProvider::GithubIssues => "github",
        houston_protocol::TaskTrackerProvider::Notion => "notion",
        houston_protocol::TaskTrackerProvider::Slack => "slack",
    }, &format!("{:x}", hash.finalize())[..16])
}

fn entry(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider) -> Result<keyring::Entry> {
    keyring::Entry::new(&service(state_dir, workspace, provider), "integration-token")
        .map_err(|e| anyhow!("opening the task tracker credential in the OS keychain failed: {e}"))
}

pub fn store(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider, token: &str) -> Result<()> {
    if provider != houston_protocol::TaskTrackerProvider::Notion {
        bail!("only Notion uses a Houston-stored task tracker credential; GitHub uses installed gh authentication");
    }
    let token = token.trim();
    if token.is_empty() || token.len() > 4096 {
        bail!("Notion integration token must be between 1 and 4096 bytes");
    }
    entry(state_dir, workspace, provider)?.set_password(token)
        .map_err(|e| anyhow!("storing the Notion integration token in the OS keychain failed: {e}"))
}

pub fn load(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider) -> Result<Option<crate::ssh_credentials::Secret>> {
    match entry(state_dir, workspace, provider)?.get_password() {
        Ok(token) => Ok(Some(crate::ssh_credentials::Secret::new(token))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("reading the task tracker credential from the OS keychain failed: {e}")),
    }
}

pub fn has(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider) -> Result<bool> {
    Ok(load(state_dir, workspace, provider)?.is_some())
}

pub fn clear(state_dir: &Path, workspace: &str, provider: houston_protocol::TaskTrackerProvider) -> Result<()> {
    match entry(state_dir, workspace, provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("deleting the task tracker credential from the OS keychain failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_services_are_separated_by_state_dir_workspace_and_provider() {
        let provider = houston_protocol::TaskTrackerProvider::Notion;
        let one = service(Path::new("/tmp/dev"), "/work/a", provider);
        assert_eq!(one, service(Path::new("/tmp/dev"), "/work/a", provider));
        assert_ne!(one, service(Path::new("/tmp/release"), "/work/a", provider));
        assert_ne!(one, service(Path::new("/tmp/dev"), "/work/b", provider));
        assert_ne!(one, service(Path::new("/tmp/dev"), "/work/a", houston_protocol::TaskTrackerProvider::GithubIssues));
    }

    #[test]
    fn notion_version_is_current_data_source_api_version() {
        assert_eq!(NOTION_API_VERSION, "2026-03-11");
    }

    #[test]
    fn project_external_keys_are_provider_and_repository_qualified() {
        let github = github_milestone_project_key("org/repo", 7);
        assert_eq!(github, "github_issues:org/repo:milestone:7");
        assert_ne!(github, project_external_key(houston_protocol::TaskTrackerProvider::Notion, "org/repo:milestone:7"));
    }
}

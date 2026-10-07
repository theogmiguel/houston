use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum TaskTrackerProvider {
    GithubIssues,
    Notion,
    Slack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum TaskExternalLinkSource {
    Source,
    PullRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskTrackerFieldConflict {
    pub field: String,
    pub base: String,
    pub local: String,
    pub remote: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskTrackerSnapshot {
    pub base: BTreeMap<String, String>,
    pub local: BTreeMap<String, String>,
    pub remote: BTreeMap<String, String>,
    pub conflicts: Vec<TaskTrackerFieldConflict>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub revision: i64,
    #[serde(default)]
    pub project_external_id: Option<String>,
    #[serde(default)]
    pub project: Option<TaskTrackerProjectSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskTrackerProjectSnapshot {
    pub external_id: String,
    pub url: String,
    pub title: String,
    pub description: String,
    pub unverified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskTrackerStatusMapping {
    pub todo: Option<String>,
    pub in_progress: Option<String>,
    pub in_review: Option<String>,
    pub done: Option<String>,
    pub canceled: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TaskTrackerSyncState {
    Current,
    Diverged,
    Pending,
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskExternalLink {
    #[cfg_attr(feature = "ts-gen", ts(type = "number"))]
    pub task_id: i64,
    pub provider: TaskTrackerProvider,
    pub external_id: String,
    pub url: String,
    #[cfg_attr(feature = "ts-gen", ts(type = "number | null"))]
    pub fetched_at_ms: Option<i64>,
    pub body_hash: Option<String>,
    pub remote_rev: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(type = "number | null"))]
    pub synced_at_ms: Option<i64>,
    pub source: TaskExternalLinkSource,
    pub snapshot: TaskTrackerSnapshot,
    pub sync_state: TaskTrackerSyncState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
pub struct TaskTrackerWorkspaceSettings {
    pub workspace: String,
    pub provider: TaskTrackerProvider,
    pub enabled: bool,
    pub github_repository: Option<String>,
    pub github_label: Option<String>,
    pub github_assigned_user: Option<String>,
    pub notion_data_source_id: Option<String>,
    pub notion_title_property_id: Option<String>,
    pub notion_description_property_id: Option<String>,
    pub notion_status_property_id: Option<String>,
    pub notion_assignee_property_id: Option<String>,
    pub notion_project_relation_property_id: Option<String>,
    pub notion_assignee_user_id: Option<String>,
    pub notion_active_status_values: Vec<String>,
    pub notion_projects_data_source_id: Option<String>,
    pub notion_project_title_property_id: Option<String>,
    pub notion_project_description_property_id: Option<String>,
    pub notion_pr_url_property_id: Option<String>,
    pub notion_status_mapping: TaskTrackerStatusMapping,
    pub has_credential: bool,
    #[cfg_attr(feature = "ts-gen", ts(type = "number | null"))]
    pub last_sync_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskTrackerConflictResolution {
    Local,
    Remote,
    Custom { value: String },
}

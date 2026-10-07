use super::Daemon;
use anyhow::{bail, Context, Result};
use houston_protocol as proto;

impl Daemon {
    pub fn task_tracker_settings(&self, workspace: &str) -> Result<proto::ServerMsg> {
        let mut settings = self.db().task_tracker_settings(workspace)?;
        for entry in &mut settings {
            entry.has_credential = match entry.provider {
                proto::TaskTrackerProvider::GithubIssues => false,
                _ => crate::task_trackers::has(&self.state_dir, workspace, entry.provider)?,
            };
        }
        Ok(proto::ServerMsg::TaskTrackerSettings { settings, refusal: None })
    }

    pub fn task_tracker_settings_set(&self, mut settings: proto::TaskTrackerWorkspaceSettings) -> Result<proto::ServerMsg> {
        self.require_tracker_workspace(&settings.workspace)?;
        validate_settings(&settings)?;
        settings.has_credential = match settings.provider {
            proto::TaskTrackerProvider::GithubIssues => false,
            _ => crate::task_trackers::has(&self.state_dir, &settings.workspace, settings.provider)?,
        };
        self.db().set_task_tracker_settings(&settings)?;
        let response = proto::ServerMsg::TaskTrackerSettings { settings: vec![settings], refusal: None };
        self.broadcast_control(&response);
        Ok(response)
    }

    pub fn task_tracker_credential_set(&self, workspace: &str, provider: proto::TaskTrackerProvider, token: &str) -> Result<proto::ServerMsg> {
        self.require_tracker_workspace(workspace)?;
        crate::task_trackers::store(&self.state_dir, workspace, provider, token)?;
        self.task_tracker_settings(workspace)
    }

    pub fn task_tracker_credential_clear(&self, workspace: &str, provider: proto::TaskTrackerProvider) -> Result<proto::ServerMsg> {
        self.require_tracker_workspace(workspace)?;
        crate::task_trackers::clear(&self.state_dir, workspace, provider)?;
        self.task_tracker_settings(workspace)
    }

    pub fn task_tracker_links(&self, task_id: i64) -> Result<proto::ServerMsg> {
        Ok(proto::ServerMsg::TaskTrackerLinks { task_id, links: self.db().task_external_links(task_id)? })
    }

    pub fn task_tracker_conflict_resolve(
        &self, task_id: i64, provider: proto::TaskTrackerProvider, external_id: &str,
        field: &str, expected_revision: i64, resolution: proto::TaskTrackerConflictResolution,
    ) -> Result<proto::ServerMsg> {
        let link = self.db().task_tracker_conflict_resolve(task_id, provider, external_id, field, expected_revision, &resolution)?
            .context("task tracker conflict disappeared while resolving it")?;
        let response = proto::ServerMsg::TaskTrackerConflictResolved { task_id, link };
        self.broadcast_control(&response);
        Ok(response)
    }

    fn require_tracker_workspace(&self, workspace: &str) -> Result<()> {
        if !self.workspace_list()?.iter().any(|w| w.path == workspace) {
            bail!("task tracker workspace {workspace:?} is not registered");
        }
        Ok(())
    }
}

fn validate_settings(s: &proto::TaskTrackerWorkspaceSettings) -> Result<()> {
    match s.provider {
        proto::TaskTrackerProvider::GithubIssues => {
            let repository = s.github_repository.as_deref().unwrap_or("");
            if repository.split('/').count() != 2 || repository.split('/').any(|part| part.is_empty() || part.chars().any(|c| matches!(c, ' ' | '?' | '#'))) {
                bail!("GitHub repository must use owner/repository format, received {repository:?}");
            }
            if s.github_label.as_deref().is_none_or(str::is_empty) && s.github_assigned_user.as_deref().is_none_or(str::is_empty) {
                bail!("GitHub Issues requires a configured label or assigned user filter");
            }
        }
        proto::TaskTrackerProvider::Notion => {
            for (name, value) in [
                ("data source ID", s.notion_data_source_id.as_deref()),
                ("title property ID", s.notion_title_property_id.as_deref()),
                ("description property ID", s.notion_description_property_id.as_deref()),
                ("status property ID", s.notion_status_property_id.as_deref()),
                ("assignee property ID", s.notion_assignee_property_id.as_deref()),
                ("project relation property ID", s.notion_project_relation_property_id.as_deref()),
                ("projects data source ID", s.notion_projects_data_source_id.as_deref()),
                ("project title property ID", s.notion_project_title_property_id.as_deref()),
                ("project description property ID", s.notion_project_description_property_id.as_deref()),
                ("PR URL property ID", s.notion_pr_url_property_id.as_deref()),
            ] {
                if s.enabled && value.is_none_or(|v| !valid_notion_id(v)) {
                    bail!("Notion {name} must be a 32-hex or UUID property/data-source ID, not a name");
                }
            }
            if s.enabled && s.notion_active_status_values.is_empty() {
                bail!("Notion requires at least one configured active status value");
            }
            if s.enabled && s.notion_assignee_user_id.as_deref().is_none_or(|id| !valid_notion_id(id)) {
                bail!("Notion requires the assignee's user ID; it cannot be inferred from the integration token");
            }
            if s.notion_projects_data_source_id.is_some()
                && (s.notion_project_title_property_id.is_none() || s.notion_project_description_property_id.is_none())
            {
                bail!("Notion project title and description property IDs are required when a projects data source is configured");
            }
            if [
                &s.notion_status_mapping.todo, &s.notion_status_mapping.in_progress,
                &s.notion_status_mapping.in_review, &s.notion_status_mapping.done,
                &s.notion_status_mapping.canceled,
            ].iter().flatten().any(|value| value.trim().is_empty() || value.len() > 100) {
                bail!("Notion coarse status option mappings must be non-empty values of at most 100 bytes");
            }
            if s.notion_active_status_values.len() > 32 || s.notion_active_status_values.iter().any(|v| v.trim().is_empty() || v.len() > 100) {
                bail!("Notion active status values must contain at most 32 non-empty values of at most 100 bytes each");
            }
        }
        proto::TaskTrackerProvider::Slack => bail!("Slack links are recorded by Slack intake; Slack tracker settings are not configurable here"),
    }
    Ok(())
}

fn valid_notion_id(value: &str) -> bool {
    let normalized = value.replace('-', "");
    normalized.len() == 32 && normalized.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(provider: proto::TaskTrackerProvider) -> proto::TaskTrackerWorkspaceSettings {
        proto::TaskTrackerWorkspaceSettings {
            workspace: "/tmp/project".into(), provider, enabled: true,
            github_repository: Some("owner/repo".into()), github_label: None, github_assigned_user: Some("me".into()),
            notion_data_source_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_title_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_description_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_status_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_assignee_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_project_relation_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_assignee_user_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_active_status_values: vec!["Active".into()], has_credential: false, last_sync_at_ms: None, last_error: None,
            notion_projects_data_source_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_project_title_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_project_description_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_pr_url_property_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: Some("To do".into()), in_progress: Some("Doing".into()), in_review: Some("Review".into()),
                done: Some("Done".into()), canceled: Some("Canceled".into()),
            },
        }
    }

    #[test]
    fn github_requires_label_or_assignee_and_owner_repo() {
        let mut s = settings(proto::TaskTrackerProvider::GithubIssues);
        assert!(validate_settings(&s).is_ok());
        s.github_assigned_user = None;
        assert!(validate_settings(&s).is_err());
        s.github_repository = Some("repo".into());
        s.github_label = Some("ready".into());
        assert!(validate_settings(&s).is_err());
    }

    #[test]
    fn notion_requires_ids_not_display_names_and_active_statuses() {
        let mut s = settings(proto::TaskTrackerProvider::Notion);
        assert!(validate_settings(&s).is_ok());
        s.notion_status_property_id = Some("Status".into());
        assert!(validate_settings(&s).is_err());
        s.notion_status_property_id = Some("0123456789abcdef0123456789abcdef".into());
        s.notion_active_status_values.clear();
        assert!(validate_settings(&s).is_err());
    }
}

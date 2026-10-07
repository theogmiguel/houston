use super::Daemon;
use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use std::sync::Arc;
use std::time::Duration;

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

    pub async fn task_tracker_settings_set(&self, mut settings: proto::TaskTrackerWorkspaceSettings) -> Result<proto::ServerMsg> {
        self.require_tracker_workspace(&settings.workspace)?;
        validate_settings(&settings)?;
        if settings.enabled && settings.provider == proto::TaskTrackerProvider::Notion {
            let token = crate::task_trackers::load(&self.state_dir, &settings.workspace, settings.provider)?
                .context("connect the Notion integration before enabling its task tracker")?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .context("building the bounded Notion schema client")?;
            let task_schema = notion_data_source_schema(&client, token.expose(), settings.notion_data_source_id.as_deref().expect("enabled Notion settings require a data source ID")).await?;
            let project_schema = if let Some(id) = settings.notion_projects_data_source_id.as_deref() {
                Some(notion_data_source_schema(&client, token.expose(), id).await?)
            } else {
                None
            };
            validate_notion_schema(&settings, &task_schema, project_schema.as_ref())?;
        }
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

    pub async fn task_tracker_sync_now(&self, workspace: &str) -> Result<proto::ServerMsg> {
        self.require_tracker_workspace(workspace)?;
        self.task_tracker_poll_enabled_for(Some(workspace)).await?;
        let settings = self.db().task_tracker_settings(workspace)?;
        let provider = settings.iter().find(|settings| settings.enabled).map(|settings| settings.provider)
            .context("no task tracker is enabled for this workspace")?;
        let latest = settings.iter().filter_map(|settings| settings.last_sync_at_ms).max();
        Ok(proto::ServerMsg::TaskTrackerSyncState {
            workspace: workspace.to_string(),
            provider,
            last_sync_at_ms: latest,
            error: settings.iter().find_map(|settings| settings.last_error.clone()),
        })
    }

    pub fn task_tracker_conflict_resolve(
        &self, task_id: i64, expected_task_revision: i64, expected_project_revision: Option<i64>,
        provider: proto::TaskTrackerProvider, external_id: &str,
        field: &str, expected_revision: i64, resolution: proto::TaskTrackerConflictResolution,
    ) -> Result<proto::ServerMsg> {
        let link = self.db().task_tracker_conflict_resolve(task_id, expected_task_revision, expected_project_revision, provider, external_id, field, expected_revision, &resolution)?
            .context("task tracker conflict disappeared while resolving it")?;
        if let Some(task) = self.db().task(task_id)? {
            self.broadcast_control(&proto::ServerMsg::TaskChanged {
                workspace: task.workspace,
                id: task_id,
                revision: task.revision,
            });
        }
        if field == "project.description" || field == "project.title" {
            if let Some(project_id) = self.db().task_domain(task_id)?.and_then(|domain| domain.project_id) {
                if let Some(project) = self.db().task_project(project_id)? {
                    self.broadcast_control(&proto::ServerMsg::TaskProjectChanged {
                        workspace: project.workspace,
                        id: project.id,
                        revision: project.revision,
                    });
                }
            }
        }
        let response = proto::ServerMsg::TaskTrackerConflictResolved { task_id, link };
        self.broadcast_control(&response);
        Ok(response)
    }

    pub async fn task_tracker_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(20));
        loop {
            interval.tick().await;
            if let Err(error) = self.task_tracker_poll_enabled_for(None).await {
                tracing::warn!(error = %error, "task tracker poll cycle failed");
            }
            if let Err(error) = self.task_tracker_drain_outbox().await {
                tracing::warn!(error = %error, "task tracker outbox cycle failed");
            }
        }
    }

    async fn task_tracker_poll_enabled_for(&self, workspace: Option<&str>) -> Result<()> {
        let settings = self.db().task_tracker_enabled_settings()?;
        for settings in settings {
            if workspace.is_some_and(|workspace| settings.workspace != workspace) {
                continue;
            }
            let provider = settings.provider;
            let cursor = self.db().task_tracker_poll_cursor(&settings.workspace, provider)?;
            let token = if provider == proto::TaskTrackerProvider::Notion {
                match crate::task_trackers::load(&self.state_dir, &settings.workspace, provider)? {
                    Some(token) => Some(token),
                    None => {
                        self.set_tracker_error(&settings, &cursor, "Notion integration token is missing")?;
                        continue;
                    }
                }
            } else {
                None
            };
            let result = match provider {
                proto::TaskTrackerProvider::GithubIssues => crate::task_trackers::github::poll(&settings, None, &cursor).await,
                proto::TaskTrackerProvider::Notion => crate::task_trackers::notion::poll(&settings, token.as_ref().map(|secret| secret.expose()), &cursor).await,
                proto::TaskTrackerProvider::Slack => Err(anyhow!("Slack intake does not expose task tracker polling")),
            };
            match result {
                Ok(page) => {
                    if !page.not_modified {
                        for record in &page.records {
                            let prior_task_id = self.db().task_tracker_external_task(&settings.workspace, provider, &record.external_id)?;
                            let prior_revision = match prior_task_id {
                                Some(task_id) => self.db().task(task_id)?.map(|task| task.revision),
                                None => None,
                            };
                            let project_key = record.project.as_ref().map(|project| crate::task_trackers::project_external_key(provider, &project.external_id));
                            let prior_project_revision = if let Some(key) = project_key.as_deref() {
                                self.db().task_project_by_external_id(&settings.workspace, key)?.map(|project| project.revision)
                            } else { None };
                            let task_id = self.db().task_tracker_import_remote(&settings.workspace, provider, record, now_ms())?;
                            if let Some(task) = self.db().task(task_id)? {
                                if prior_revision != Some(task.revision) {
                                    self.broadcast_control(&proto::ServerMsg::TaskChanged {
                                        workspace: task.workspace,
                                        id: task.id,
                                        revision: task.revision,
                                    });
                                }
                            }
                            self.broadcast_control(&proto::ServerMsg::TaskTrackerLinks {
                                task_id,
                                links: self.db().task_external_links(task_id)?,
                            });
                            if let Some(key) = project_key.as_deref() {
                                self.broadcast_tracker_project_change(&settings.workspace, key, prior_project_revision)?;
                            }
                        }
                    }
                    if provider == proto::TaskTrackerProvider::Notion
                        && page.cursor.next_cursor.is_none()
                        && !page.not_modified
                    {
                        self.refresh_linked_notion_pages(&settings, token.as_ref().map(|secret| secret.expose()), &page.records).await?;
                    }
                    self.db().task_tracker_poll_state_set(&settings.workspace, provider, &page.cursor, now_ms(), None)?;
                    self.broadcast_control(&proto::ServerMsg::TaskTrackerSyncState {
                        workspace: settings.workspace,
                        provider,
                        last_sync_at_ms: Some(now_ms()),
                        error: None,
                    });
                }
                Err(error) => {
                    self.set_tracker_error(&settings, &cursor, &format!("{error:#}"))?;
                }
            }
        }
        Ok(())
    }

    async fn refresh_linked_notion_pages(
        &self,
        settings: &proto::TaskTrackerWorkspaceSettings,
        token: Option<&str>,
        just_imported: &[crate::task_trackers::RemoteTaskSnapshot],
    ) -> Result<()> {
        let token = token.context("Notion token is required to refresh linked pages")?;
        let seen: std::collections::HashSet<&str> = just_imported.iter().map(|record| record.external_id.as_str()).collect();
        let after = self.db().task_tracker_refresh_cursor(&settings.workspace, settings.provider)?;
        let ids = self.db().task_tracker_linked_external_ids(&settings.workspace, settings.provider, after.as_deref(), 3)?;
        if ids.is_empty() {
            self.db().task_tracker_refresh_cursor_set(&settings.workspace, settings.provider, None)?;
            return Ok(());
        }
        for external_id in &ids {
            if !seen.contains(external_id.as_str()) {
                let record = crate::task_trackers::notion::retrieve_page(settings, Some(token), external_id).await?;
                let prior_task_id = self.db().task_tracker_external_task(&settings.workspace, settings.provider, &record.external_id)?;
                let prior_revision = match prior_task_id {
                    Some(task_id) => self.db().task(task_id)?.map(|task| task.revision),
                    None => None,
                };
                let project_key = record.project.as_ref().map(|project| crate::task_trackers::project_external_key(settings.provider, &project.external_id));
                let prior_project_revision = if let Some(key) = project_key.as_deref() {
                    self.db().task_project_by_external_id(&settings.workspace, key)?.map(|project| project.revision)
                } else { None };
                let task_id = self.db().task_tracker_import_remote(&settings.workspace, settings.provider, &record, now_ms())?;
                if let Some(task) = self.db().task(task_id)? {
                    if prior_revision != Some(task.revision) {
                        self.broadcast_control(&proto::ServerMsg::TaskChanged {
                            workspace: task.workspace,
                            id: task.id,
                            revision: task.revision,
                        });
                    }
                }
                self.broadcast_control(&proto::ServerMsg::TaskTrackerLinks {
                    task_id,
                    links: self.db().task_external_links(task_id)?,
                });
                if let Some(key) = project_key.as_deref() {
                    self.broadcast_tracker_project_change(&settings.workspace, key, prior_project_revision)?;
                }
            }
        }
        let next = if ids.len() < 3 { None } else { ids.last().cloned() };
        self.db().task_tracker_refresh_cursor_set(&settings.workspace, settings.provider, next.as_deref())?;
        Ok(())
    }

    fn broadcast_tracker_project_change(&self, workspace: &str, external_id: &str, before_revision: Option<i64>) -> Result<()> {
        if let Some(project) = self.db().task_project_by_external_id(workspace, external_id)? {
            if before_revision != Some(project.revision) {
                self.broadcast_control(&proto::ServerMsg::TaskProjectChanged {
                    workspace: project.workspace,
                    id: project.id,
                    revision: project.revision,
                });
            }
        }
        Ok(())
    }

    fn set_tracker_error(
        &self,
        settings: &proto::TaskTrackerWorkspaceSettings,
        cursor: &crate::task_trackers::TrackerPollCursor,
        message: &str,
    ) -> Result<()> {
        let message: String = message.chars().take(1024).collect();
        let now = now_ms();
        self.db().task_tracker_poll_state_set(&settings.workspace, settings.provider, cursor, now, Some(&message))?;
        self.broadcast_control(&proto::ServerMsg::TaskTrackerSyncState {
            workspace: settings.workspace.clone(),
            provider: settings.provider,
            last_sync_at_ms: Some(now),
            error: Some(message),
        });
        Ok(())
    }

    async fn task_tracker_drain_outbox(&self) -> Result<()> {
        let rows = self.db().task_tracker_outbox_pending(now_ms(), 25)?;
        for row in rows {
            let Some(settings) = self.db().task_tracker_setting(&row.workspace, row.provider)? else {
                self.db().task_tracker_outbox_failed(row.id, "tracker configuration was removed", now_ms())?;
                continue;
            };
            if !settings.enabled {
                self.db().task_tracker_outbox_failed(row.id, "tracker is disabled", now_ms())?;
                continue;
            }
            let token = if row.provider == proto::TaskTrackerProvider::Notion {
                match crate::task_trackers::load(&self.state_dir, &row.workspace, row.provider)? {
                    Some(token) => Some(token),
                    None => {
                        self.db().task_tracker_outbox_failed(row.id, "Notion integration token is missing", now_ms())?;
                        continue;
                    }
                }
            } else {
                None
            };
            let payload: serde_json::Value = match self.db().task_tracker_outbox_current_payload(&row) {
                Ok(Some(value)) => value,
                Ok(None) => {
                    self.db().task_tracker_outbox_sent(row.id, r#"{"superseded":true}"#, now_ms())?;
                    continue;
                }
                Err(error) => {
                    self.db().task_tracker_outbox_failed(row.id, &format!("cannot refresh outbox payload from live state: {error:#}"), now_ms())?;
                    continue;
                }
            };
            let link_task_id = payload.get("delivery_task_id").and_then(serde_json::Value::as_i64).unwrap_or(row.task_id);
            let mut provider_payload = payload.clone();
            if let Some(object) = provider_payload.as_object_mut() { object.remove("delivery_task_id"); }
            let result = match row.provider {
                proto::TaskTrackerProvider::GithubIssues => crate::task_trackers::github::write(&settings, None, &row.action, &provider_payload).await,
                proto::TaskTrackerProvider::Notion => crate::task_trackers::notion::write(&settings, token.as_ref().map(|secret| secret.expose()), &row.action, &provider_payload).await,
                proto::TaskTrackerProvider::Slack => Err(anyhow!("Slack intake does not support tracker writeback")),
            };
            match result {
                Ok(receipt) => {
                    if let Err(error) = self.db().task_tracker_write_receipt(
                        link_task_id, row.provider, &row.action, receipt.external_id.as_deref(),
                        receipt.url.as_deref(), receipt.remote_rev.as_deref(), now_ms(),
                    ) {
                        self.db().task_tracker_outbox_failed(row.id, &format!("cannot persist tracker write receipt: {error:#}"), now_ms())?;
                        continue;
                    }
                    let receipt = serde_json::to_string(&receipt)?;
                    self.db().task_tracker_outbox_sent(row.id, &receipt, now_ms())?;
                }
                Err(error) => {
                    self.db().task_tracker_outbox_failed(row.id, &format!("{error:#}"), now_ms())?;
                }
            }
        }
        Ok(())
    }

    fn require_tracker_workspace(&self, workspace: &str) -> Result<()> {
        if !self.workspace_list()?.iter().any(|w| w.path == workspace) {
            bail!("task tracker workspace {workspace:?} is not registered");
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}

async fn notion_data_source_schema(client: &reqwest::Client, token: &str, data_source_id: &str) -> Result<serde_json::Value> {
    let response = client
        .get(format!("https://api.notion.com/v1/data_sources/{data_source_id}"))
        .bearer_auth(token)
        .header("Notion-Version", crate::task_trackers::NOTION_API_VERSION)
        .send()
        .await
        .context("requesting Notion data-source schema")?;
    let status = response.status();
    if !status.is_success() {
        bail!("Notion data-source schema request returned HTTP {status}");
    }
    response.json().await.context("decoding Notion data-source schema")
}

fn validate_settings(s: &proto::TaskTrackerWorkspaceSettings) -> Result<()> {
    match s.provider {
        proto::TaskTrackerProvider::GithubIssues => {
            if s.enabled {
                let repository = s.github_repository.as_deref().unwrap_or("");
                if repository.split('/').count() != 2 || repository.split('/').any(|part| part.is_empty() || part.chars().any(|c| matches!(c, ' ' | '?' | '#'))) {
                    bail!("GitHub repository must use owner/repository format, received {repository:?}");
                }
                if s.github_label.as_deref().is_none_or(str::is_empty) && s.github_assigned_user.as_deref().is_none_or(str::is_empty) {
                    bail!("GitHub Issues requires a configured label or assigned user filter");
                }
            }
        }
        proto::TaskTrackerProvider::Notion => {
            if s.enabled {
                if s.notion_data_source_id.as_deref().is_none_or(|id| !valid_notion_id(id)) {
                    bail!("Notion data source ID must be a 32-hex or UUID ID");
                }
                if s.notion_assignee_user_id.as_deref().is_none_or(|id| !valid_notion_id(id)) {
                    bail!("Notion requires the assignee's user ID; it cannot be inferred from the integration token");
                }
                for (name, value) in [
                    ("title property ID", s.notion_title_property_id.as_deref()),
                    ("description property ID", s.notion_description_property_id.as_deref()),
                    ("status property ID", s.notion_status_property_id.as_deref()),
                    ("assignee property ID", s.notion_assignee_property_id.as_deref()),
                ] {
                    validate_property_id(name, value, true)?;
                }
                if s.notion_active_status_values.is_empty() {
                    bail!("Notion requires at least one configured active status value");
                }
                if let Some(projects_data_source_id) = s.notion_projects_data_source_id.as_deref() {
                    if !valid_notion_id(projects_data_source_id) {
                        bail!("Notion projects data source ID must be a 32-hex or UUID ID");
                    }
                    validate_property_id("project relation property ID", s.notion_project_relation_property_id.as_deref(), true)?;
                    validate_property_id("project title property ID", s.notion_project_title_property_id.as_deref(), true)?;
                    validate_property_id("project description property ID", s.notion_project_description_property_id.as_deref(), true)?;
                } else if s.notion_project_relation_property_id.is_some()
                    || s.notion_project_title_property_id.is_some()
                    || s.notion_project_description_property_id.is_some()
                {
                    bail!("Notion project relation/title/description mappings require a projects data source ID");
                }
                validate_property_id("PR URL property ID", s.notion_pr_url_property_id.as_deref(), false)?;
            }
            if [
                s.notion_status_mapping.todo.as_ref(), s.notion_status_mapping.in_progress.as_ref(),
                s.notion_status_mapping.in_review.as_ref(), s.notion_status_mapping.done.as_ref(),
                s.notion_status_mapping.canceled.as_ref(),
            ].into_iter().flatten().any(|value| value.trim().is_empty() || value.len() > 100) {
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
    let bytes = value.as_bytes();
    if bytes.len() == 32 {
        return bytes.iter().all(u8::is_ascii_hexdigit);
    }
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()
        })
}

fn validate_property_id(name: &str, value: Option<&str>, required: bool) -> Result<()> {
    let Some(value) = value else {
        if required {
            bail!("Notion {name} is required for this configuration");
        }
        return Ok(());
    };
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        bail!("Notion {name} must be a non-empty property ID of at most 200 bytes without control characters");
    }
    Ok(())
}

fn validate_notion_schema(
    settings: &proto::TaskTrackerWorkspaceSettings,
    task_schema: &serde_json::Value,
    project_schema: Option<&serde_json::Value>,
) -> Result<()> {
    let properties = task_schema.get("properties").unwrap_or(task_schema);
    for (name, id, expected) in [
        ("title", settings.notion_title_property_id.as_deref(), &["title"][..]),
        ("description", settings.notion_description_property_id.as_deref(), &["rich_text"][..]),
        ("status", settings.notion_status_property_id.as_deref(), &["status", "select"][..]),
        ("assignee", settings.notion_assignee_property_id.as_deref(), &["people"][..]),
        ("project relation", settings.notion_project_relation_property_id.as_deref(), &["relation"][..]),
        ("PR URL", settings.notion_pr_url_property_id.as_deref(), &["url"][..]),
    ] {
        if let Some(id) = id {
            let property = find_notion_property(properties, id)
                .with_context(|| format!("Notion {name} property ID {id:?} is not present in the configured data source schema"))?;
            let kind = property.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
            if !expected.contains(&kind) {
                bail!("Notion {name} property ID {id:?} has type {kind:?}; expected {}", expected.join(" or "));
            }
            if name == "status" {
                validate_status_options(settings, property, kind)?;
            }
        }
    }
    if let Some(project_schema) = project_schema {
        let properties = project_schema.get("properties").unwrap_or(project_schema);
        for (name, id, expected) in [
            ("project title", settings.notion_project_title_property_id.as_deref(), "title"),
            ("project description", settings.notion_project_description_property_id.as_deref(), "rich_text"),
        ] {
            let id = id.with_context(|| format!("Notion {name} property ID is required with a projects data source"))?;
            let property = find_notion_property(properties, id)
                .with_context(|| format!("Notion {name} property ID {id:?} is not present in the projects data source schema"))?;
            let kind = property.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
            if kind != expected {
                bail!("Notion {name} property ID {id:?} has type {kind:?}; expected {expected}");
            }
        }
    }
    Ok(())
}

fn find_notion_property<'a>(properties: &'a serde_json::Value, id: &str) -> Option<&'a serde_json::Value> {
    properties.as_object()?.values().find(|property| property.get("id").and_then(serde_json::Value::as_str) == Some(id))
}

fn validate_status_options(settings: &proto::TaskTrackerWorkspaceSettings, property: &serde_json::Value, kind: &str) -> Result<()> {
    let options = property.get(kind).and_then(|value| value.get("options")).and_then(serde_json::Value::as_array);
    let Some(options) = options else {
        bail!("Notion status property schema has no options array to validate configured status values");
    };
    let names: Vec<&str> = options.iter().filter_map(|value| value.get("name").and_then(serde_json::Value::as_str)).collect();
    for value in settings.notion_active_status_values.iter()
        .chain([
            settings.notion_status_mapping.todo.as_ref(),
            settings.notion_status_mapping.in_progress.as_ref(),
            settings.notion_status_mapping.in_review.as_ref(),
            settings.notion_status_mapping.done.as_ref(),
            settings.notion_status_mapping.canceled.as_ref(),
        ].into_iter().flatten())
    {
        if !names.contains(&value.as_str()) {
            bail!("Notion status option {value:?} is not present in the configured status property schema");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(provider: proto::TaskTrackerProvider) -> proto::TaskTrackerWorkspaceSettings {
        proto::TaskTrackerWorkspaceSettings {
            workspace: "/tmp/project".into(), provider, enabled: true,
            github_repository: Some("owner/repo".into()), github_label: None, github_assigned_user: Some("me".into()),
            notion_data_source_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_title_property_id: Some("title".into()),
            notion_description_property_id: Some("f%5C%5C%3Ap".into()),
            notion_status_property_id: Some("statusId".into()),
            notion_assignee_property_id: Some("ownR".into()),
            notion_project_relation_property_id: None,
            notion_assignee_user_id: Some("0123456789abcdef0123456789abcdef".into()),
            notion_active_status_values: vec!["Active".into()], has_credential: false, last_sync_at_ms: None, last_error: None,
            notion_projects_data_source_id: None,
            notion_project_title_property_id: None,
            notion_project_description_property_id: None,
            notion_pr_url_property_id: Some("prUrl".into()),
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: None, in_progress: None, in_review: None,
                done: Some("Done".into()), canceled: None,
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
    fn notion_property_ids_accept_short_names_and_are_used_as_returned() {
        let mut s = settings(proto::TaskTrackerProvider::Notion);
        assert!(validate_settings(&s).is_ok());
        let schema = serde_json::json!({"properties":{
            "Name":{"id":"title","type":"title"},
            "Notes":{"id":"f%5C%5C%3Ap","type":"rich_text"},
            "State":{"id":"statusId","type":"status","status":{"options":[{"name":"Active"},{"name":"Done"}]}},
            "Owner":{"id":"ownR","type":"people"},
            "PR":{"id":"prUrl","type":"url"}
        }});
        validate_notion_schema(&s, &schema, None).unwrap();
        assert_eq!(s.notion_description_property_id.as_deref(), Some("f%5C%5C%3Ap"));

        let mut missing_property = s.clone();
        missing_property.notion_title_property_id = Some("renamed-title".into());
        assert!(validate_notion_schema(&missing_property, &schema, None).is_err());
        let mut schema_with_wrong_type = schema.clone();
        schema_with_wrong_type["properties"]["Name"]["type"] = serde_json::json!("rich_text");
        assert!(validate_notion_schema(&s, &schema_with_wrong_type, None).is_err());

        let mut invalid_property_id = s.clone();
        invalid_property_id.notion_pr_url_property_id = Some("".into());
        assert!(validate_settings(&invalid_property_id).is_err());
        s.notion_active_status_values.clear();
        assert!(validate_settings(&s).is_err());
    }

    #[test]
    fn notion_optional_project_mappings_are_only_required_when_project_source_is_enabled() {
        let mut s = settings(proto::TaskTrackerProvider::Notion);
        assert!(validate_settings(&s).is_ok());
        s.notion_projects_data_source_id = Some("fedcba9876543210fedcba9876543210".into());
        assert!(validate_settings(&s).is_err());
        s.notion_project_relation_property_id = Some("projectRelation".into());
        s.notion_project_title_property_id = Some("title".into());
        s.notion_project_description_property_id = Some("projectDescription".into());
        assert!(validate_settings(&s).is_ok());

        let task_schema = serde_json::json!({"properties":{
            "Name":{"id":"title","type":"title"},
            "Notes":{"id":"f%5C%5C%3Ap","type":"rich_text"},
            "State":{"id":"statusId","type":"status","status":{"options":[{"name":"Active"},{"name":"Done"}]}},
            "Owner":{"id":"ownR","type":"people"},
            "Project":{"id":"projectRelation","type":"relation"}
        }});
        let project_schema = serde_json::json!({"properties":{
            "Project name":{"id":"title","type":"title"},
            "Description":{"id":"projectDescription","type":"rich_text"}
        }});
        validate_notion_schema(&s, &task_schema, Some(&project_schema)).unwrap();
        let wrong_project_type = serde_json::json!({"properties":{
            "Project name":{"id":"title","type":"rich_text"},
            "Description":{"id":"projectDescription","type":"rich_text"}
        }});
        assert!(validate_notion_schema(&s, &task_schema, Some(&wrong_project_type)).is_err());
    }
}

//! Notion data-source adapter. Credentials are borrowed and only sent to the
//! fixed Notion API origin; this module has no database or keychain access.

use anyhow::{anyhow, bail, ensure, Context, Result};
use reqwest::{header, Method, StatusCode, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};

use crate::{
    ssh_credentials::Secret,
    task_trackers::{
        RemoteTaskSnapshot, TrackerPollCursor, TrackerPollPage, TrackerWriteReceipt,
        NOTION_API_VERSION,
    },
};
use houston_protocol::{TaskTrackerProjectSnapshot, TaskTrackerWorkspaceSettings};

const API_ORIGIN: &str = "https://api.notion.com/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_AFTER_MAX: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1_048_576;
const PAGE_SIZE: usize = 100;
const MAX_PAGES_PER_POLL: usize = 5;
const MAX_POLL_RECORDS: usize = PAGE_SIZE * MAX_PAGES_PER_POLL;
const MAX_COMMENT_CHARS: usize = 11_500;
const MAX_COMMENT_CHUNKS: usize = 6;
const MAX_PROPERTY_ID_BYTES: usize = 256;

#[derive(Clone)]
struct Api {
    client: reqwest::Client,
    base: Url,
}

impl Api {
    fn new() -> Result<Self> {
        Self::with_base(Url::parse(API_ORIGIN).expect("static Notion API URL"))
    }

    fn with_base(base: Url) -> Result<Self> {
        let is_official = base.scheme() == "https" && base.host_str() == Some("api.notion.com");
        #[cfg(test)]
        let is_test_loopback = matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]" | "::1"));
        #[cfg(not(test))]
        let is_test_loopback = false;
        ensure!(is_official || is_test_loopback, "Notion API origin must be https://api.notion.com");
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building the Notion HTTP client")?;
        Ok(Self { client, base })
    }

    fn url(&self, path: &str) -> Url {
        self.base.join(path).expect("fixed Notion API path")
    }

    async fn request(&self, method: Method, path: &str, token: &Secret, body: Option<Value>) -> Result<Value> {
        for attempt in 0..=1 {
            let mut request = self.client.request(method.clone(), self.url(path))
                .bearer_auth(token.expose())
                .header("Notion-Version", NOTION_API_VERSION);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|error| {
                anyhow!("Notion request failed: {}", error.without_url())
            })?;
            if response.status() == StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
                let retry_after = response.headers().get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs).unwrap_or(Duration::from_secs(1));
                if retry_after > RETRY_AFTER_MAX {
                    bail!("Notion rate limit asks for {}s; adapter wait limit is {}s", retry_after.as_secs(), RETRY_AFTER_MAX.as_secs());
                }
                tokio::time::sleep(retry_after).await;
                continue;
            }
            let status = response.status();
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                anyhow!("Notion returned an unreadable HTTP {status} response: {}", error.without_url())
            })? {
                ensure!(bytes.len().saturating_add(chunk.len()) <= MAX_RESPONSE_BYTES, "Notion HTTP {status} response exceeded the {} byte limit", MAX_RESPONSE_BYTES);
                bytes.extend_from_slice(&chunk);
            }
            if !status.is_success() {
                bail!("Notion request failed with HTTP {status}");
            }
            return serde_json::from_slice(&bytes).context("Notion returned an invalid JSON response");
        }
        bail!("Notion request remained rate limited after one bounded retry")
    }

    async fn get(&self, path: &str, token: &Secret) -> Result<Value> {
        self.request(Method::GET, path, token, None).await
    }

    async fn post(&self, path: &str, token: &Secret, body: Value) -> Result<Value> {
        self.request(Method::POST, path, token, Some(body)).await
    }

    async fn patch(&self, path: &str, token: &Secret, body: Value) -> Result<Value> {
        self.request(Method::PATCH, path, token, Some(body)).await
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PollContinuation {
    marker: String,
    since: String,
    started_at: String,
    query_cursor: Option<String>,
}

fn resource_id(raw: &str, label: &str) -> Result<&str> {
    let bytes = raw.as_bytes();
    let valid_hyphenated = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit()
        });
    let valid_compact = bytes.len() == 32 && bytes.iter().all(u8::is_ascii_hexdigit);
    ensure!(valid_hyphenated || valid_compact, "Notion {label} must be a UUID resource ID");
    Ok(raw)
}

fn property_id(raw: &str, label: &str) -> Result<&str> {
    ensure!(!raw.is_empty() && raw.trim() == raw && raw.len() <= MAX_PROPERTY_ID_BYTES, "Notion {label} property ID must be a non-empty opaque value of at most {MAX_PROPERTY_ID_BYTES} bytes");
    Ok(raw)
}

fn configured<'a>(value: &'a Option<String>, label: &str) -> Result<&'a str> {
    let value = value.as_deref().ok_or_else(|| anyhow!("Notion {label} is not configured"))?;
    property_id(value, label)
}

async fn data_source(api: &Api, token: &Secret, id: &str, label: &str) -> Result<Value> {
    resource_id(id, label)?;
    let response = api.get(&format!("v1/data_sources/{id}"), token).await?;
    ensure!(response.get("object").and_then(Value::as_str) == Some("data_source"), "Notion {label} lookup did not return a data source");
    ensure!(response.get("id").and_then(Value::as_str) == Some(id), "Notion {label} response ID did not match the configured data source");
    ensure!(response.get("properties").and_then(Value::as_object).is_some(), "Notion {label} has no readable property schema");
    Ok(response)
}

fn schema_property<'a>(schema: &'a Value, id: &str, label: &str) -> Result<&'a Value> {
    property_id(id, label)?;
    let properties = schema.get("properties").and_then(Value::as_object)
        .ok_or_else(|| anyhow!("Notion {label} data source has no properties"))?;
    let found = properties.iter().find(|(key, prop)| key.as_str() == id || prop.get("id").and_then(Value::as_str) == Some(id));
    found.map(|(_, property)| property).ok_or_else(|| anyhow!("Notion configured {label} property ID {id:?} does not exist in its data source"))
}

fn validate_type(property: &Value, expected: &str, label: &str) -> Result<()> {
    ensure!(property.get("type").and_then(Value::as_str) == Some(expected), "Notion configured {label} property must have type {expected}");
    Ok(())
}

fn option_names(property: &Value, kind: &str) -> Vec<&str> {
    property.get(kind).and_then(|v| v.get("options")).and_then(Value::as_array)
        .map(|options| options.iter().filter_map(|option| option.get("name").and_then(Value::as_str)).collect())
        .unwrap_or_default()
}

struct TaskSchema {
    source: Value,
    title: String,
    description: Option<String>,
    status: String,
    status_type: String,
    assignee: String,
    relation: Option<String>,
    projects_source: Option<Value>,
    project_title: Option<String>,
    project_description: Option<String>,
    pr_url: Option<String>,
    settings_mapping: houston_protocol::TaskTrackerStatusMapping,
}

async fn validate_settings(api: &Api, token: &Secret, settings: &TaskTrackerWorkspaceSettings) -> Result<TaskSchema> {
    let source_id = settings.notion_data_source_id.as_deref().ok_or_else(|| anyhow!("Notion task data source ID is not configured"))?;
    let source = data_source(api, token, source_id, "task").await?;
    let title = configured(&settings.notion_title_property_id, "title")?.to_owned();
    validate_type(schema_property(&source, &title, "title")?, "title", "title")?;
    let description = settings.notion_description_property_id.as_deref().map(|id| {
        property_id(id, "description").map(str::to_owned)
    }).transpose()?;
    if let Some(id) = &description { validate_type(schema_property(&source, id, "description")?, "rich_text", "description")?; }
    let status = configured(&settings.notion_status_property_id, "status")?.to_owned();
    let status_property = schema_property(&source, &status, "status")?;
    let status_type = status_property.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
    ensure!(status_type == "status" || status_type == "select", "Notion configured status property must have type status or select");
    let options = option_names(status_property, &status_type);
    ensure!(!options.is_empty(), "Notion status property {status:?} has no selectable options");
    for value in settings.notion_active_status_values.iter().chain([
        settings.notion_status_mapping.todo.as_ref(), settings.notion_status_mapping.in_progress.as_ref(),
        settings.notion_status_mapping.in_review.as_ref(), settings.notion_status_mapping.done.as_ref(),
        settings.notion_status_mapping.canceled.as_ref(),
    ].into_iter().flatten()) {
        ensure!(options.contains(&value.as_str()), "Notion status option {value:?} is not present in the configured status property");
    }
    ensure!(!settings.notion_active_status_values.is_empty(), "Notion active status values must contain at least one existing status option");
    let assignee = configured(&settings.notion_assignee_property_id, "assignee")?.to_owned();
    validate_type(schema_property(&source, &assignee, "assignee")?, "people", "assignee")?;
    let user_id = settings.notion_assignee_user_id.as_deref().ok_or_else(|| anyhow!("Notion assigned human user ID is not configured"))?;
    resource_id(user_id, "assigned human user")?;
    let relation = settings.notion_project_relation_property_id.as_deref().map(|id| property_id(id, "project relation").map(str::to_owned)).transpose()?;
    let projects_source_id = settings.notion_projects_data_source_id.as_deref();
    let (projects_source, project_title, project_description) = match (relation.as_deref(), projects_source_id) {
        (Some(relation_id), Some(project_source_id)) => {
            let property = schema_property(&source, relation_id, "project relation")?;
            validate_type(property, "relation", "project relation")?;
            resource_id(project_source_id, "project data source")?;
            let related_id = property.pointer("/relation/data_source_id").and_then(Value::as_str)
                .ok_or_else(|| anyhow!("Notion project relation does not identify its related data source"))?;
            ensure!(related_id == project_source_id, "Notion project relation points to a different data source than configured");
            let project_source = data_source(api, token, project_source_id, "project").await?;
            let project_title = configured(&settings.notion_project_title_property_id, "project title")?.to_owned();
            validate_type(schema_property(&project_source, &project_title, "project title")?, "title", "project title")?;
            let project_description = settings.notion_project_description_property_id.as_deref().map(|id| property_id(id, "project description").map(str::to_owned)).transpose()?;
            if let Some(id) = &project_description { validate_type(schema_property(&project_source, id, "project description")?, "rich_text", "project description")?; }
            (Some(project_source), Some(project_title), project_description)
        }
        (None, None) => (None, None, None),
        (Some(_), None) => bail!("Notion project relation is configured without a project data source ID"),
        (None, Some(_)) => bail!("Notion project data source is configured without a project relation property"),
    };
    let pr_url = settings.notion_pr_url_property_id.as_deref().map(|id| property_id(id, "pull request URL").map(str::to_owned)).transpose()?;
    if let Some(id) = &pr_url { validate_type(schema_property(&source, id, "pull request URL")?, "url", "pull request URL")?; }
    Ok(TaskSchema { source, title, description, status, status_type, assignee, relation, projects_source, project_title, project_description, pr_url, settings_mapping: settings.notion_status_mapping.clone() })
}

fn property_value<'a>(properties: &'a Value, id: &str) -> Option<&'a Value> {
    let properties = properties.as_object()?;
    properties.iter().find(|(key, value)| key.as_str() == id || value.get("id").and_then(Value::as_str) == Some(id)).map(|(_, value)| value)
}

fn rich_text(value: &Value) -> String {
    value.as_array().into_iter().flatten().filter_map(|part| part.pointer("/plain_text").and_then(Value::as_str))
        .collect::<String>()
}

fn property_text(properties: &Value, id: &str, kind: &str) -> Option<String> {
    let property = property_value(properties, id)?;
    match kind {
        "title" | "rich_text" => Some(rich_text(property.get(kind)?)),
        "status" | "select" => property.get(kind)?.get("name")?.as_str().map(str::to_owned),
        "url" => property.get("url")?.as_str().map(str::to_owned),
        _ => None,
    }
}

fn bounded(mut value: String, max: usize) -> String {
    if value.len() <= max { return value; }
    let mut end = max;
    while !value.is_char_boundary(end) { end -= 1; }
    value.truncate(end);
    value
}

fn page_snapshot(page: &Value, schema: &TaskSchema) -> Result<RemoteTaskSnapshot> {
    ensure!(page.get("object").and_then(Value::as_str) == Some("page"), "Notion data source returned a non-page result");
    let id = page.get("id").and_then(Value::as_str).ok_or_else(|| anyhow!("Notion page has no ID"))?;
    resource_id(id, "page")?;
    let url = page.get("url").and_then(Value::as_str).ok_or_else(|| anyhow!("Notion page has no URL"))?.to_owned();
    let props = page.get("properties").ok_or_else(|| anyhow!("Notion page has no properties"))?;
    let title = property_text(props, &schema.title, "title").ok_or_else(|| anyhow!("Notion page has no mapped title property"))?;
    let mut fields = BTreeMap::new();
    fields.insert("title".to_owned(), bounded(title, 16_384));
    if let Some(id) = &schema.description {
        if let Some(description) = property_text(props, id, "rich_text") { fields.insert("description".to_owned(), bounded(description, 16_384)); }
    }
    if let Some(status) = property_text(props, &schema.status, &schema.status_type) {
        let mapping = &schema.settings_mapping;
        let normalized = [
            (mapping.todo.as_deref(), "todo"),
            (mapping.in_progress.as_deref(), "in_progress"),
            (mapping.in_review.as_deref(), "in_review"),
            (mapping.done.as_deref(), "done"),
            (mapping.canceled.as_deref(), "canceled"),
        ].into_iter().find_map(|(configured, normalized)| (configured == Some(status.as_str())).then_some(normalized)).unwrap_or("backlog");
        fields.insert("status".to_owned(), normalized.to_owned());
    }
    if let Some(assignee) = property_value(props, &schema.assignee).and_then(|p| p.get("people")).and_then(Value::as_array)
        .and_then(|people| people.iter().find_map(|p| p.get("id").and_then(Value::as_str))) {
        fields.insert("assignee_id".to_owned(), assignee.to_owned());
    }
    if let Some(id) = &schema.pr_url {
        if let Some(url) = property_text(props, id, "url") { fields.insert("pr_url".to_owned(), bounded(url, 2_048)); }
    }
    let remote_rev = page.get("last_edited_time").and_then(Value::as_str).map(str::to_owned);
    Ok(RemoteTaskSnapshot { external_id: id.to_owned(), url, remote_rev, fields, project: None })
}

fn page_project_ids(page: &Value, relation_id: &str) -> Vec<String> {
    property_value(page.get("properties").unwrap_or(&Value::Null), relation_id)
        .and_then(|value| value.get("relation")).and_then(Value::as_array).into_iter().flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned)).collect()
}

async fn project_snapshot(api: &Api, token: &Secret, id: &str, schema: &TaskSchema) -> Result<Option<TaskTrackerProjectSnapshot>> {
    let Some(project_source) = &schema.projects_source else { return Ok(None); };
    let page = api.get(&format!("v1/pages/{id}"), token).await?;
    ensure!(page.get("object").and_then(Value::as_str) == Some("page"), "Notion related project lookup did not return a page");
    ensure!(page.get("id").and_then(Value::as_str) == Some(id), "Notion related project page ID did not match the relation");
    let source_id = project_source.get("id").and_then(Value::as_str).expect("validated project source ID");
    ensure!(page.pointer("/parent/data_source_id").and_then(Value::as_str) == Some(source_id), "Notion related project page belongs to a different data source");
    let props = page.get("properties").ok_or_else(|| anyhow!("Notion project page has no properties"))?;
    let title_id = schema.project_title.as_deref().expect("project source has title mapping");
    let title = property_text(props, title_id, "title").ok_or_else(|| anyhow!("Notion project page has no mapped title"))?;
    let description = match schema.project_description.as_deref() {
        Some(id) => property_text(props, id, "rich_text").unwrap_or_default(),
        None => String::new(),
    };
    Ok(Some(TaskTrackerProjectSnapshot {
        external_id: format!("notion:{}:{id}", project_source.get("id").and_then(Value::as_str).expect("validated project source ID")),
        url: page.get("url").and_then(Value::as_str).unwrap_or_default().to_owned(),
        title: bounded(title, 8_192),
        description: bounded(description, 16_384),
        unverified: true,
    }))
}

async fn hydrate_project(api: &Api, token: &Secret, page: &Value, schema: &TaskSchema, snapshot: &mut RemoteTaskSnapshot) -> Result<()> {
    if let Some(relation_id) = &schema.relation {
        if let Some(project_id) = page_project_ids(page, relation_id).into_iter().next() {
            resource_id(&project_id, "related project page")?;
            snapshot.project = project_snapshot(api, token, &project_id, schema).await?;
            if let Some(project) = &snapshot.project {
                snapshot.fields.insert("project_external_id".to_owned(), project.external_id.clone());
            }
        }
    }
    Ok(())
}

fn continuation(raw: Option<&str>, checkpoint: Option<&str>) -> Result<PollContinuation> {
    if let Some(raw) = raw {
        let value: PollContinuation = serde_json::from_str(raw).context("Notion poll continuation is malformed")?;
        ensure!(value.marker == "houston-notion-poll-v1", "Notion poll continuation belongs to another adapter");
        Ok(value)
    } else {
        let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(PollContinuation {
            marker: "houston-notion-poll-v1".into(),
            since: checkpoint.unwrap_or("1970-01-01T00:00:00Z").to_owned(),
            started_at,
            query_cursor: None,
        })
    }
}

fn status_filter_property(status_type: &str, id: &str, value: &str) -> Value {
    json!({"property": id, (status_type): {"equals": value}})
}

/// Query configured task data source pages. The returned cursor is caller-persisted;
/// `last_edited_time` advances only after all pages in this bounded batch succeed.
pub async fn poll(settings: &TaskTrackerWorkspaceSettings, token: Option<&str>, cursor: &TrackerPollCursor) -> Result<TrackerPollPage> {
    let token = token.ok_or_else(|| anyhow!("Notion integration token is not available from the OS keychain"))?;
    let secret = Secret::new(token.to_owned());
    ensure!(!secret.is_empty(), "Notion integration token is empty");
    let api = Api::new()?;
    let schema = validate_settings(&api, &secret, settings).await?;
    let mut continuation = continuation(cursor.next_cursor.as_deref(), cursor.last_edited_time.as_deref())?;
    let source_id = settings.notion_data_source_id.as_deref().expect("validated task source");
    let mut records = Vec::new();
    let mut exhausted = false;
    for _ in 0..MAX_PAGES_PER_POLL {
        let active: Vec<Value> = settings.notion_active_status_values.iter()
            .map(|status| status_filter_property(&schema.status_type, &schema.status, status)).collect();
        let mut filters = vec![json!({"timestamp":"last_edited_time","last_edited_time":{"on_or_after":continuation.since}})];
        filters.push(json!({"property":schema.assignee,"people":{"contains":settings.notion_assignee_user_id.as_deref().expect("validated user")}}));
        filters.push(if active.len() == 1 { active[0].clone() } else { json!({"or":active}) });
        let mut body = json!({"filter":{"and":filters},"page_size":PAGE_SIZE,"sorts":[{"timestamp":"last_edited_time","direction":"ascending"}]});
        if let Some(query_cursor) = &continuation.query_cursor { body["start_cursor"] = json!(query_cursor); }
        let result = api.post(&format!("v1/data_sources/{source_id}/query"), &secret, body).await?;
        ensure!(result.get("object").and_then(Value::as_str) == Some("list"), "Notion data source query did not return a result list");
        for page in result.get("results").and_then(Value::as_array).into_iter().flatten() {
            let mut snapshot = page_snapshot(page, &schema)?;
            hydrate_project(&api, &secret, page, &schema, &mut snapshot).await?;
            records.push(snapshot);
            ensure!(records.len() <= MAX_POLL_RECORDS, "Notion poll exceeded the {} record batch limit", MAX_POLL_RECORDS);
        }
        let has_more = result.get("has_more").and_then(Value::as_bool).unwrap_or(false);
        if !has_more {
            exhausted = true;
            continuation.query_cursor = None;
            break;
        }
        continuation.query_cursor = Some(result.get("next_cursor").and_then(Value::as_str).ok_or_else(|| anyhow!("Notion indicated another page without a next cursor"))?.to_owned());
    }
    let next_cursor = if exhausted { None } else { Some(serde_json::to_string(&continuation).context("encoding Notion poll continuation")?) };
    Ok(TrackerPollPage {
        records,
        cursor: TrackerPollCursor {
            etag: None,
            last_edited_time: if exhausted { Some(continuation.started_at) } else { cursor.last_edited_time.clone() },
            next_cursor,
        },
        not_modified: false,
    })
}

/// Fetch one already-linked Notion page regardless of active-status poll filters.
pub async fn retrieve_page(settings: &TaskTrackerWorkspaceSettings, token: Option<&str>, page_id: &str) -> Result<RemoteTaskSnapshot> {
    resource_id(page_id, "page")?;
    let token = token.ok_or_else(|| anyhow!("Notion integration token is not available from the OS keychain"))?;
    let secret = Secret::new(token.to_owned());
    let api = Api::new()?;
    let schema = validate_settings(&api, &secret, settings).await?;
    let page = api.get(&format!("v1/pages/{page_id}"), &secret).await?;
    let source_id = settings.notion_data_source_id.as_deref().expect("validated task source");
    ensure!(page.get("object").and_then(Value::as_str) == Some("page"), "Notion refresh target is not a page");
    ensure!(page.get("id").and_then(Value::as_str) == Some(page_id), "Notion refresh page ID did not match the requested page");
    ensure!(page.pointer("/parent/data_source_id").and_then(Value::as_str) == Some(source_id), "Notion refresh page belongs to a different task data source");
    let mut snapshot = page_snapshot(&page, &schema)?;
    hydrate_project(&api, &secret, &page, &schema, &mut snapshot).await?;
    Ok(snapshot)
}

fn text_chunks(value: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        current.push(character);
        if current.chars().count() == max_chars {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() { chunks.push(current); }
    chunks
}

fn rich_text_payload(value: &str) -> Vec<Value> {
    text_chunks(value, 2_000).into_iter().map(|chunk| json!({"type":"text","text":{"content":chunk}})).collect()
}

fn payload_string<'a>(payload: &'a Value, key: &str) -> Result<&'a str> {
    payload.get(key).and_then(Value::as_str).ok_or_else(|| anyhow!("Notion write payload must contain string field {key:?}"))
}

async fn write_comment(api: &Api, token: &Secret, page_id: &str, summary: &str) -> Result<()> {
    let summary = bounded(summary.to_owned(), MAX_COMMENT_CHARS);
    let mut hash = Sha256::new();
    hash.update(page_id.as_bytes()); hash.update([0]); hash.update(summary.as_bytes());
    let marker = format!("houston-handback:{}", &format!("{:x}", hash.finalize())[..24]);
    let mut cursor: Option<String> = None;
    let mut found = false;
    let mut complete = false;
    for _ in 0..5 {
        let mut url = api.url("v1/comments");
        url.query_pairs_mut().append_pair("block_id", page_id).append_pair("page_size", "100");
        if let Some(value) = &cursor { url.query_pairs_mut().append_pair("start_cursor", value); }
        let query = url.query().map(|value| format!("?{value}")).unwrap_or_default();
        let response = api.get(&format!("v1/comments{query}"), token).await?;
        for comment in response.get("results").and_then(Value::as_array).into_iter().flatten() {
            if rich_text(comment.get("rich_text").unwrap_or(&Value::Null)).contains(&marker) { found = true; }
        }
        if found { break; }
        if !response.get("has_more").and_then(Value::as_bool).unwrap_or(false) { complete = true; break; }
        cursor = response.get("next_cursor").and_then(Value::as_str).map(str::to_owned);
        ensure!(cursor.is_some(), "Notion comments pagination omitted next_cursor");
    }
    if found { return Ok(()); }
    ensure!(complete, "Notion comment history exceeded the bounded idempotency lookup; refusing a possibly duplicate comment");
    let body = format!("{summary}\n\n{marker}");
    ensure!(text_chunks(&body, 2_000).len() <= MAX_COMMENT_CHUNKS, "Notion handback summary exceeded the rich-text chunk limit");
    api.post("v1/comments", token, json!({"parent":{"page_id":page_id},"rich_text":rich_text_payload(&body)})).await?;
    Ok(())
}

/// Apply a caller-decided write to an existing Notion page; this never creates tasks.
pub async fn write(settings: &TaskTrackerWorkspaceSettings, token: Option<&str>, action: &str, payload: &Value) -> Result<TrackerWriteReceipt> {
    let token = token.ok_or_else(|| anyhow!("Notion integration token is not available from the OS keychain"))?;
    let secret = Secret::new(token.to_owned());
    ensure!(!secret.is_empty(), "Notion integration token is empty");
    let page_id = payload_string(payload, "external_id")?;
    resource_id(page_id, "page")?;
    let api = Api::new()?;
    let schema = validate_settings(&api, &secret, settings).await?;
    let existing_page = api.get(&format!("v1/pages/{page_id}"), &secret).await?;
    ensure!(existing_page.get("object").and_then(Value::as_str) == Some("page"), "Notion write target is not an existing page");
    ensure!(existing_page.get("id").and_then(Value::as_str) == Some(page_id), "Notion write page ID did not match the requested page");
    let source_id = settings.notion_data_source_id.as_deref().expect("validated task source");
    ensure!(existing_page.pointer("/parent/data_source_id").and_then(Value::as_str) == Some(source_id), "Notion write target belongs to a different task data source");
    match action {
        "status" => {
            let coarse = payload_string(payload, "status")?;
            let value = match coarse {
                "todo" => settings.notion_status_mapping.todo.as_deref(),
                "in_progress" => settings.notion_status_mapping.in_progress.as_deref(),
                "in_review" => settings.notion_status_mapping.in_review.as_deref(),
                "done" => settings.notion_status_mapping.done.as_deref(),
                "canceled" => settings.notion_status_mapping.canceled.as_deref(),
                _ => bail!("Notion status write value {coarse:?} is not a supported coarse status"),
            }.ok_or_else(|| anyhow!("Notion coarse status {coarse:?} has no configured status mapping"))?;
            let property = schema_property(&schema.source, &schema.status, "status")?;
            ensure!(option_names(property, &schema.status_type).contains(&value), "Notion mapped status option {value:?} no longer exists");
            api.patch(&format!("v1/pages/{page_id}"), &secret, json!({"properties":{(schema.status):{(schema.status_type):{"name":value}}}})).await?;
        }
        "pull_request_url" => {
            let property_id = schema.pr_url.as_deref().ok_or_else(|| anyhow!("Notion pull request URL property is not configured"))?;
            let url = payload_string(payload, "url")?;
            ensure!(url.len() <= 2_048 && Url::parse(url).is_ok_and(|u| u.scheme() == "https"), "Notion pull request URL must be a valid HTTPS URL no longer than 2048 bytes");
            api.patch(&format!("v1/pages/{page_id}"), &secret, json!({"properties":{(property_id):{"url":url}}})).await?;
        }
        "handback_summary" => {
            write_comment(&api, &secret, page_id, payload_string(payload, "summary")?).await?;
        }
        other => bail!("unsupported Notion write action {other:?}"),
    }
    let refreshed = api.get(&format!("v1/pages/{page_id}"), &secret).await?;
    let snapshot = page_snapshot(&refreshed, &schema)?;
    Ok(TrackerWriteReceipt { external_id: Some(snapshot.external_id), url: Some(snapshot.url), remote_rev: snapshot.remote_rev })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn property_ids_are_opaque_and_never_uuid_only() {
        assert_eq!(property_id("title", "title").unwrap(), "title");
        assert_eq!(property_id("a%2Fb", "title").unwrap(), "a%2Fb");
        assert!(property_id("", "title").is_err());
        assert!(resource_id("title", "page").is_err());
        assert!(resource_id("550e8400-e29b-41d4-a716-446655440000", "page").is_ok());
    }

    #[test]
    fn rich_text_chunking_obeys_notion_character_limit() {
        let chunks = rich_text_payload(&"é".repeat(4_001));
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk["text"]["content"].as_str().unwrap().chars().count() <= 2_000));
    }

    #[test]
    fn incremental_continuation_keeps_start_watermark_until_complete() {
        let initial = continuation(None, Some("2026-10-01T00:00:00Z")).unwrap();
        let serialized = serde_json::to_string(&PollContinuation { query_cursor: Some("next".into()), ..initial.clone() }).unwrap();
        let resumed = continuation(Some(&serialized), Some("2026-10-01T00:00:00Z")).unwrap();
        assert_eq!(resumed.since, "2026-10-01T00:00:00Z");
        assert_eq!(resumed.started_at, initial.started_at);
        assert_eq!(resumed.query_cursor.as_deref(), Some("next"));
    }

    #[test]
    fn query_filter_uses_property_id_verbatim() {
        let filter = status_filter_property("status", "a%2Fb", "In progress");
        assert_eq!(filter["property"], "a%2Fb");
        assert_eq!(filter["status"]["equals"], "In progress");
    }

    #[tokio::test]
    async fn fake_http_api_receives_only_the_borrowed_test_token_and_version() {
        use std::{io::{BufRead, BufReader, Write}, net::TcpListener, thread};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() { break; }
                request.push_str(&line);
            }
            let body = r#"{"ok":true}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            request
        });
        let api = Api::with_base(Url::parse(&format!("http://{address}/")).unwrap()).unwrap();
        let token = Secret::new("fake-notion-test-token".into());
        let response = api.get("v1/data_sources/550e8400-e29b-41d4-a716-446655440000", &token).await.unwrap();
        assert_eq!(response["ok"], true);
        let request = server.join().unwrap();
        assert!(request.to_ascii_lowercase().contains("authorization: bearer fake-notion-test-token"));
        assert!(request.to_ascii_lowercase().contains("notion-version: 2026-03-11"));
    }

    #[test]
    fn only_the_official_origin_or_test_loopback_is_accepted() {
        assert!(Api::with_base(Url::parse("https://api.notion.com/").unwrap()).is_ok());
        assert!(Api::with_base(Url::parse("http://127.0.0.1:9000/").unwrap()).is_ok());
        assert!(Api::with_base(Url::parse("https://example.com/").unwrap()).is_err());
    }
}

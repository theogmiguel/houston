//! Bounded GitHub Issues adapter. Domain reconciliation and cursor persistence
//! belong to the caller; this module only reads and writes the configured repo.

use crate::task_trackers::{
    RemoteTaskSnapshot, TrackerPollCursor, TrackerPollPage, TrackerWriteReceipt,
};
use houston_protocol as proto;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

const MAX_PAGES: u32 = 20;
const PAGE_SIZE: u32 = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ERROR_BODY: usize = 4_000;
const MAX_TITLE: usize = 500;
const MAX_DESCRIPTION: usize = 8_000;
const MAX_MILESTONE_DESCRIPTION: usize = 4_000;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct PageEtags {
    repository: Option<String>,
    label: Option<String>,
    assigned_user: Option<String>,
    pages: BTreeMap<u32, PageState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PageState {
    etag: Option<String>,
    count: usize,
}

#[derive(Debug)]
struct ApiResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

/// Polls all matching issues with authenticated `gh api` requests. The cursor's
/// `etag` is an opaque serialization of the per-page ETag map, owned by caller.
pub async fn poll(
    settings: &proto::TaskTrackerWorkspaceSettings,
    _token: Option<&str>,
    cursor: &TrackerPollCursor,
) -> anyhow::Result<TrackerPollPage> {
    let repo = repository(settings)?;
    let previous = decode_etags(cursor.etag.as_deref())?;
    let compatible = previous.repository.as_deref() == Some(repo.as_str())
        && previous.label == settings.github_label
        && previous.assigned_user == settings.github_assigned_user;
    let (first_records, first_pages, changed, saw_304) =
        poll_pages(&repo, &previous.pages, compatible).await?;
    if !changed {
        return Ok(TrackerPollPage {
            records: Vec::new(),
            cursor: TrackerPollCursor {
                etag: Some(serde_json::to_string(&PageEtags {
                    repository: Some(repo),
                    label: settings.github_label.clone(),
                    assigned_user: settings.github_assigned_user.clone(),
                    pages: first_pages,
                })?),
                last_edited_time: cursor.last_edited_time.clone(),
                next_cursor: None,
            },
            not_modified: true,
        });
    }

    // A changed page alone is not a complete collection when other pages were 304.
    let (raw, pages) = if saw_304 {
        let (raw, pages, _, _) = poll_pages(&repo, &BTreeMap::new(), false).await?;
        (raw, pages)
    } else {
        (first_records, first_pages)
    };
    let records = raw
        .iter()
        .filter(|issue| matches_filter(issue, settings))
        .filter_map(|issue| snapshot(issue, &repo))
        .collect();

    Ok(TrackerPollPage {
        records,
        cursor: TrackerPollCursor {
            etag: Some(serde_json::to_string(&PageEtags {
                repository: Some(repo),
                label: settings.github_label.clone(),
                assigned_user: settings.github_assigned_user.clone(),
                pages,
            })?),
            last_edited_time: cursor.last_edited_time.clone(),
            next_cursor: None,
        },
        not_modified: false,
    })
}

/// Executes a task-domain write through fixed GitHub API paths. Create payloads
/// must include a durable `delivery_marker` and `task_identity`; the caller must
/// persist those before invoking this function so a retry can find the issue.
pub async fn write(
    settings: &proto::TaskTrackerWorkspaceSettings,
    _token: Option<&str>,
    action: &str,
    payload: &Value,
) -> anyhow::Result<TrackerWriteReceipt> {
    let repo = repository(settings)?;
    let action = action.to_ascii_lowercase();
    let repo_for_call = repo.clone();
    let payload = payload.clone();
    tokio::task::spawn_blocking(move || write_blocking(&repo_for_call, &action, &payload)).await?
}

async fn poll_pages(
    repo: &str,
    previous: &BTreeMap<u32, PageState>,
    conditional: bool,
) -> anyhow::Result<(Vec<Value>, BTreeMap<u32, PageState>, bool, bool)> {
    let mut records = Vec::new();
    let mut etags = BTreeMap::new();
    let mut changed = false;
    let mut saw_304 = false;
    for page in 1..=MAX_PAGES {
        let route = format!("repos/{repo}/issues?state=all&per_page={PAGE_SIZE}&page={page}");
        let previous_page = conditional.then(|| previous.get(&page)).flatten();
        let response = api_get(
            &route,
            previous_page.and_then(|state| state.etag.as_ref()),
            ISSUE_JQ,
        )
        .await?;
        if response.status == 304 {
            saw_304 = true;
            let prior = previous_page.ok_or_else(|| {
                anyhow::anyhow!("GitHub returned 304 without a cached page cursor")
            })?;
            etags.insert(
                page,
                PageState {
                    etag: response
                        .headers
                        .get("etag")
                        .cloned()
                        .or_else(|| prior.etag.clone()),
                    count: prior.count,
                },
            );
            if prior.count < PAGE_SIZE as usize {
                return Ok((records, etags, changed, saw_304));
            }
            continue;
        }
        if response.status != 200 {
            anyhow::bail!(format_api_error("GitHub issue poll", &response));
        }
        changed = true;
        let page_records: Vec<Value> = serde_json::from_str(&response.body).map_err(|error| {
            anyhow::anyhow!("GitHub issue page {page} returned invalid bounded JSON: {error}")
        })?;
        let count = page_records.len();
        etags.insert(
            page,
            PageState {
                etag: response.headers.get("etag").cloned(),
                count,
            },
        );
        records.extend(page_records);
        if count < PAGE_SIZE as usize {
            return Ok((records, etags, changed, saw_304));
        }
    }
    anyhow::bail!("GitHub issue pagination exceeded the {MAX_PAGES}-page bound; increase the bounded import limit or narrow the repository")
}

async fn api_get(
    route: &str,
    etag: Option<&String>,
    jq: &'static str,
) -> anyhow::Result<ApiResponse> {
    let route = route.to_owned();
    let etag = etag.cloned();
    tokio::task::spawn_blocking(move || api_get_blocking(&route, etag.as_deref(), jq)).await?
}

fn api_get_blocking(route: &str, etag: Option<&str>, jq: &str) -> anyhow::Result<ApiResponse> {
    let mut cmd = api_command();
    cmd.args(["--include", "--method", "GET", route]);
    cmd.args(["--jq", jq]);
    if let Some(etag) = etag {
        cmd.arg("--header").arg(format!("If-None-Match: {etag}"));
    }
    let output = crate::spawn::output_within(cmd, REQUEST_TIMEOUT)?.ok_or_else(|| {
        anyhow::anyhow!(
            "GitHub API request exceeded {} second timeout",
            REQUEST_TIMEOUT.as_secs()
        )
    })?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let response = parse_response(&raw)?;
    if response.status == 304 {
        return Ok(response);
    }
    if !output.status.success() && response.status == 0 {
        let stderr = bounded(&String::from_utf8_lossy(&output.stderr), MAX_ERROR_BODY);
        anyhow::bail!("gh api failed before returning an HTTP response: {stderr}");
    }
    Ok(response)
}

const ISSUE_JQ: &str = r#"if type == "array" then map({number,title:((.title // "")[0:500]),body:((.body // "")[0:8000]),html_url,updated_at,state,labels:((.labels // [])[:100] | map(.name)),assignee:(.assignee.login // null),assignees:((.assignees // [])[:100] | map(.login)),milestone:(if .milestone == null then null else {number:.milestone.number,title:((.milestone.title // "")[0:500]),description:((.milestone.description // "")[0:4000]),html_url} end),pull_request}) else {message:((.message // tostring)[0:4000])} end"#;
const COMMENTS_JQ: &str = r#"if type == "array" then map({body:((.body // "")[0:4000])}) else {message:((.message // tostring)[0:4000])} end"#;
const WRITE_JQ: &str = r#"if has("number") then {number,html_url,updated_at} else {message:((.message // tostring)[0:4000])} end"#;

fn api_command() -> std::process::Command {
    #[cfg(test)]
    let executable = TEST_GH_SHIM
        .get()
        .and_then(|path| path.lock().ok()?.clone());
    #[cfg(test)]
    let mut command = crate::spawn::command(executable.unwrap_or_else(|| "gh".into()));
    #[cfg(not(test))]
    let mut command = crate::spawn::command("gh");
    command.env("GH_HOST", "github.com");
    command.env("GH_PROMPT_DISABLED", "1");
    command.args(["api"]);
    command
}

fn parse_response(raw: &str) -> anyhow::Result<ApiResponse> {
    let mut status = 0;
    let mut headers = BTreeMap::new();
    let mut body_offset = 0;
    for (index, line) in raw.split_inclusive('\n').enumerate() {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.starts_with("HTTP/") {
            status = trimmed
                .split_whitespace()
                .nth(1)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            headers.clear();
        } else if trimmed.is_empty() && status != 0 {
            body_offset = raw
                .split_inclusive('\n')
                .take(index + 1)
                .map(str::len)
                .sum();
            break;
        } else if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    // gh can emit the JSON body without --include on versions that reject a 304.
    if status == 0 {
        let body = raw.trim();
        if !body.is_empty() {
            return Ok(ApiResponse {
                status: 200,
                headers,
                body: body.to_owned(),
            });
        }
    }
    let body = raw.get(body_offset..).unwrap_or_default().trim().to_owned();
    Ok(ApiResponse {
        status,
        headers,
        body,
    })
}

fn format_api_error(operation: &str, response: &ApiResponse) -> String {
    let mut details = bounded(&response.body, MAX_ERROR_BODY);
    if details.is_empty() {
        details = "no response body".into();
    }
    let retry_after = response
        .headers
        .get("retry-after")
        .map(String::as_str)
        .unwrap_or("unknown");
    let remaining = response
        .headers
        .get("x-ratelimit-remaining")
        .map(String::as_str)
        .unwrap_or("unknown");
    let reset = response
        .headers
        .get("x-ratelimit-reset")
        .map(String::as_str)
        .unwrap_or("unknown");
    format!("{operation} failed with HTTP {}: {details}; rate-limit retry-after={retry_after}, remaining={remaining}, reset={reset}", response.status)
}

fn repository(settings: &proto::TaskTrackerWorkspaceSettings) -> anyhow::Result<String> {
    if settings.provider != proto::TaskTrackerProvider::GithubIssues {
        anyhow::bail!("GitHub Issues adapter requires provider=github_issues");
    }
    let raw = settings.github_repository.as_deref().unwrap_or_default();
    let mut parts = raw.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    let safe = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    };
    if parts.next().is_some() || !safe(owner) || !safe(name) {
        anyhow::bail!(
            "GitHub repository must be a validated owner/repository pair; got {:?}",
            bounded(raw, 120)
        );
    }
    Ok(format!("{owner}/{name}"))
}

fn matches_filter(issue: &Value, settings: &proto::TaskTrackerWorkspaceSettings) -> bool {
    let label_match = settings
        .github_label
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|wanted| {
            issue
                .get("labels")
                .and_then(Value::as_array)
                .is_some_and(|labels| {
                    labels.iter().any(|label| {
                        label
                            .as_str()
                            .or_else(|| label.get("name").and_then(Value::as_str))
                            == Some(wanted)
                    })
                })
        });
    let assignee_match = settings
        .github_assigned_user
        .as_deref()
        .filter(|s| !s.is_empty())
        .is_some_and(|wanted| {
            let matches = |assignee: &Value| {
                assignee
                    .as_str()
                    .or_else(|| assignee.get("login").and_then(Value::as_str))
                    .is_some_and(|actual| actual.eq_ignore_ascii_case(wanted))
            };
            issue
                .get("assignees")
                .and_then(Value::as_array)
                .is_some_and(|assignees| assignees.iter().any(matches))
                || issue.get("assignee").is_some_and(matches)
        });
    let configured = settings
        .github_label
        .as_deref()
        .is_some_and(|s| !s.is_empty())
        || settings
            .github_assigned_user
            .as_deref()
            .is_some_and(|s| !s.is_empty());
    !configured || label_match || assignee_match
}

fn snapshot(issue: &Value, repo: &str) -> Option<RemoteTaskSnapshot> {
    if issue.get("pull_request").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let number = issue.get("number")?.as_u64()?;
    let url = issue.get("html_url")?.as_str()?.to_owned();
    let title = bounded(
        issue
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        MAX_TITLE,
    );
    let description = bounded(
        issue
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        MAX_DESCRIPTION,
    );
    let state = match issue.get("state").and_then(Value::as_str).unwrap_or("open") {
        "closed" => "done",
        _ => "todo",
    };
    let mut fields = BTreeMap::new();
    fields.insert("title".into(), title);
    fields.insert("description".into(), description);
    fields.insert("status".into(), state.to_owned());
    let project = issue
        .get("milestone")
        .filter(|value| !value.is_null())
        .and_then(|milestone| {
            let milestone_number = milestone.get("number")?.as_u64()?;
            Some(proto::TaskTrackerProjectSnapshot {
                external_id: format!("github_issues:{repo}:milestone:{milestone_number}"),
                url: milestone
                    .get("html_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                title: bounded(
                    milestone
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    MAX_TITLE,
                ),
                description: bounded(
                    milestone
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    MAX_MILESTONE_DESCRIPTION,
                ),
                unverified: true,
            })
        });
    Some(RemoteTaskSnapshot {
        external_id: format!("{repo}#{number}"),
        url,
        remote_rev: issue
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
        fields,
        project,
    })
}

fn decode_etags(raw: Option<&str>) -> anyhow::Result<PageEtags> {
    Ok(raw
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default())
}

fn write_blocking(
    repo: &str,
    action: &str,
    payload: &Value,
) -> anyhow::Result<TrackerWriteReceipt> {
    match action {
        "create" | "delivery_open" | "open_delivery" => create_issue(repo, payload),
        "status" | "status_comment" | "summary_comment" | "pr_reference" => {
            comment_issue(repo, action, payload)
        }
        "delivery_close" | "close_delivery" => close_issue(repo, payload),
        other => anyhow::bail!("unsupported GitHub Issues write action {other:?}"),
    }
}

fn create_issue(repo: &str, payload: &Value) -> anyhow::Result<TrackerWriteReceipt> {
    let marker = required_string(payload, "delivery_marker")?;
    let task_identity = required_string(payload, "task_identity")?;
    let title = bounded(required_string(payload, "title")?, MAX_TITLE);
    let description = without_close_keywords(&bounded(
        payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        7_600,
    ));
    let marker = required_bounded(marker, "delivery_marker", 160)?;
    let task_identity = required_bounded(task_identity, "task_identity", 160)?;
    let full_marker = format!("<!-- houston-delivery:{task_identity}:{marker} -->");
    if let Some(existing) = find_delivery_issue(repo, &full_marker)? {
        return issue_receipt(&existing, repo);
    }
    let body = format!("{description}\n\n{full_marker}");
    let response = api_post_json(
        &format!("repos/{repo}/issues"),
        &json!({"title": title, "body": body}),
    )?;
    if response.status != 201 {
        anyhow::bail!(format_api_error("GitHub delivery issue create", &response));
    }
    issue_receipt(&serde_json::from_str(&response.body)?, repo)
}

fn find_delivery_issue(repo: &str, marker: &str) -> anyhow::Result<Option<Value>> {
    for page in 1..=MAX_PAGES {
        let route = format!("repos/{repo}/issues?state=all&per_page={PAGE_SIZE}&page={page}");
        let response = api_get_blocking(&route, None, ISSUE_JQ)?;
        if response.status != 200 {
            anyhow::bail!(format_api_error(
                "GitHub delivery issue idempotency lookup",
                &response
            ));
        }
        let issues: Vec<Value> = serde_json::from_str(&response.body)?;
        if let Some(issue) = issues.iter().find(|issue| {
            issue.get("pull_request").is_none_or(Value::is_null)
                && issue
                    .get("body")
                    .and_then(Value::as_str)
                    .is_some_and(|body| body.contains(marker))
        }) {
            return Ok(Some(issue.clone()));
        }
        if issues.len() < PAGE_SIZE as usize {
            return Ok(None);
        }
    }
    anyhow::bail!("GitHub delivery marker lookup exceeded the {MAX_PAGES}-page bound")
}

fn comment_issue(repo: &str, action: &str, payload: &Value) -> anyhow::Result<TrackerWriteReceipt> {
    let number = issue_number(payload)?;
    let task_identity = required_bounded(
        required_string(payload, "task_identity")?,
        "task_identity",
        160,
    )?;
    let revision = payload.get("revision").and_then(Value::as_i64).unwrap_or(0);
    let marker = format!("<!-- houston-task:{task_identity}:{revision}:{action} -->");
    let comment = match action {
        "pr_reference" => {
            let url = required_github_pr_url(
                payload
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                repo,
            )?;
            format!("Pull request: {url}\n{marker}")
        }
        "status" | "status_comment" => {
            let status = required_string(payload, "status")?;
            if !matches!(
                status,
                "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled"
            ) {
                anyhow::bail!("GitHub status comments require one normalized Houston status value");
            }
            let summary = bounded(
                payload
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                2_000,
            );
            format!(
                "Task status: {status}\n{}\n{marker}",
                without_close_keywords(&summary)
            )
        }
        _ => {
            let summary =
                without_close_keywords(&bounded(required_string(payload, "summary")?, 3_500));
            format!("{summary}\n{marker}")
        }
    };
    if has_comment_marker(repo, number, &marker)? {
        return Ok(TrackerWriteReceipt {
            external_id: Some(format!("{repo}#{number}")),
            url: Some(issue_url(repo, number)),
            remote_rev: None,
        });
    }
    let response = api_post_json(
        &format!("repos/{repo}/issues/{number}/comments"),
        &json!({"body": comment}),
    )?;
    if response.status != 201 {
        anyhow::bail!(format_api_error("GitHub issue comment write", &response));
    }
    Ok(TrackerWriteReceipt {
        external_id: Some(format!("{repo}#{number}")),
        url: Some(issue_url(repo, number)),
        remote_rev: response.headers.get("etag").cloned(),
    })
}

fn has_comment_marker(repo: &str, number: u64, marker: &str) -> anyhow::Result<bool> {
    for page in 1..=MAX_PAGES {
        let route =
            format!("repos/{repo}/issues/{number}/comments?per_page={PAGE_SIZE}&page={page}");
        let response = api_get_blocking(&route, None, COMMENTS_JQ)?;
        if response.status != 200 {
            anyhow::bail!(format_api_error(
                "GitHub issue comment idempotency lookup",
                &response
            ));
        }
        let comments: Vec<Value> = serde_json::from_str(&response.body)?;
        if comments.iter().any(|comment| {
            comment
                .get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| body.contains(marker))
        }) {
            return Ok(true);
        }
        if comments.len() < PAGE_SIZE as usize {
            return Ok(false);
        }
    }
    anyhow::bail!("GitHub issue comment lookup exceeded the {MAX_PAGES}-page bound")
}

fn close_issue(repo: &str, payload: &Value) -> anyhow::Result<TrackerWriteReceipt> {
    if payload.get("authorized_by_daemon").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("delivery close requires authorized_by_daemon=true from the daemon");
    }
    if payload.get("all_children_done").and_then(Value::as_bool) != Some(true)
        && payload.get("user_override").and_then(Value::as_bool) != Some(true)
    {
        anyhow::bail!("delivery close requires all_children_done=true or user_override=true");
    }
    let number = issue_number(payload)?;
    let response = api_patch_json(
        &format!("repos/{repo}/issues/{number}"),
        &json!({"state": "closed"}),
    )?;
    if response.status != 200 {
        anyhow::bail!(format_api_error("GitHub delivery issue close", &response));
    }
    issue_receipt(&serde_json::from_str(&response.body)?, repo)
}

fn api_post_json(route: &str, body: &Value) -> anyhow::Result<ApiResponse> {
    api_write_json(route, "POST", body)
}

fn api_patch_json(route: &str, body: &Value) -> anyhow::Result<ApiResponse> {
    api_write_json(route, "PATCH", body)
}

fn api_write_json(route: &str, method: &str, body: &Value) -> anyhow::Result<ApiResponse> {
    let mut command = api_command();
    command.args(["--include", "--method", method, route, "--jq", WRITE_JQ]);
    let object = body
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("GitHub API write body must be an object"))?;
    for (key, value) in object {
        let value = value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("GitHub API write field {key:?} must be text"))?;
        command.arg("--field").arg(format!("{key}={value}"));
    }
    let output = crate::spawn::output_within(command, REQUEST_TIMEOUT)?.ok_or_else(|| {
        anyhow::anyhow!(
            "GitHub API write exceeded {} second timeout",
            REQUEST_TIMEOUT.as_secs()
        )
    })?;
    let response = parse_response(&String::from_utf8_lossy(&output.stdout))?;
    if !output.status.success() && response.status == 0 {
        anyhow::bail!(
            "gh api write failed before returning HTTP response: {}",
            bounded(&String::from_utf8_lossy(&output.stderr), MAX_ERROR_BODY)
        );
    }
    Ok(response)
}

fn required_string<'a>(payload: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("GitHub write payload requires non-empty string field {key:?}")
        })
}

fn issue_number(payload: &Value) -> anyhow::Result<u64> {
    payload
        .get("issue_number")
        .or_else(|| payload.get("number"))
        .and_then(Value::as_u64)
        .filter(|number| *number > 0)
        .ok_or_else(|| anyhow::anyhow!("GitHub write payload requires a positive issue_number"))
}

fn issue_receipt(issue: &Value, repo: &str) -> anyhow::Result<TrackerWriteReceipt> {
    let number = issue
        .get("number")
        .and_then(Value::as_u64)
        .filter(|number| *number > 0)
        .ok_or_else(|| anyhow::anyhow!("GitHub issue write response omitted a valid number"))?;
    let url = issue
        .get("html_url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("GitHub issue write response omitted html_url"))?;
    Ok(TrackerWriteReceipt {
        external_id: Some(format!("{repo}#{number}")),
        url: Some(url.to_owned()),
        remote_rev: issue
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn required_bounded(value: &str, field: &str, max_chars: usize) -> anyhow::Result<String> {
    if value.chars().count() > max_chars {
        anyhow::bail!(
            "GitHub write field {field:?} exceeds the {max_chars}-character idempotency bound"
        );
    }
    Ok(value.to_owned())
}

fn issue_url(repo: &str, number: u64) -> String {
    format!("https://github.com/{repo}/issues/{number}")
}

fn required_github_pr_url(url: &str, repo: &str) -> anyhow::Result<String> {
    let prefix = format!("https://github.com/{repo}/pull/");
    let number = url.strip_prefix(&prefix).unwrap_or_default();
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) || number == "0" {
        anyhow::bail!(
            "pull request reference must be an https://github.com/{repo}/pull/<number> URL"
        );
    }
    Ok(format!("{prefix}{number}"))
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn without_close_keywords(value: &str) -> String {
    static WORDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    WORDS
        .get_or_init(|| {
            regex::Regex::new(
                r"(?i)\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b",
            )
            .expect("constant close-keyword pattern")
        })
        .replace_all(value, "")
        .into_owned()
}

#[cfg(test)]
static TEST_GH_SHIM: std::sync::OnceLock<std::sync::Mutex<Option<std::path::PathBuf>>> =
    std::sync::OnceLock::new();
#[cfg(test)]
static TEST_GH_SHIM_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> proto::TaskTrackerWorkspaceSettings {
        proto::TaskTrackerWorkspaceSettings {
            workspace: "/tmp/project".into(),
            provider: proto::TaskTrackerProvider::GithubIssues,
            enabled: true,
            github_repository: Some("octo-org/project".into()),
            github_label: Some("import".into()),
            github_assigned_user: Some("theo".into()),
            notion_data_source_id: None,
            notion_title_property_id: None,
            notion_description_property_id: None,
            notion_status_property_id: None,
            notion_assignee_property_id: None,
            notion_project_relation_property_id: None,
            notion_assignee_user_id: None,
            notion_active_status_values: Vec::new(),
            notion_projects_data_source_id: None,
            notion_project_title_property_id: None,
            notion_project_description_property_id: None,
            notion_pr_url_property_id: None,
            notion_status_mapping: proto::TaskTrackerStatusMapping {
                todo: None,
                in_progress: None,
                in_review: None,
                done: None,
                canceled: None,
            },
            has_credential: false,
            last_sync_at_ms: None,
            last_error: None,
        }
    }

    fn issue(
        number: u64,
        labels: &[&str],
        assignee: Option<&str>,
        pull: bool,
        milestone: bool,
    ) -> Value {
        json!({
            "number": number, "title": "Issue", "body": "details", "html_url": format!("https://github.com/octo-org/project/issues/{number}"),
            "updated_at": "2026-10-06T12:00:00Z", "state": "open", "labels": labels,
            "assignee": assignee, "pull_request": if pull { json!({"url":"x"}) } else { Value::Null },
            "milestone": if milestone { json!({"number":7,"title":"M7","description":"batch","html_url":"https://github.com/octo-org/project/milestone/7"}) } else { Value::Null }
        })
    }

    #[test]
    fn import_filter_is_label_or_assignee_and_excludes_pull_requests() {
        let settings = settings();
        assert!(matches_filter(
            &issue(1, &["import"], None, false, false),
            &settings
        ));
        assert!(matches_filter(
            &issue(2, &[], Some("THEO"), false, false),
            &settings
        ));
        let mut shared = issue(5, &[], Some("other"), false, false);
        shared["assignees"] = json!([{"login": "other"}, {"login": "THEO"}]);
        assert!(matches_filter(&shared, &settings));
        assert!(!matches_filter(
            &issue(3, &[], Some("other"), false, false),
            &settings
        ));
        assert!(snapshot(
            &issue(4, &["import"], None, true, false),
            "octo-org/project"
        )
        .is_none());
    }

    #[test]
    fn milestone_import_has_repository_scoped_canonical_identity() {
        let record = snapshot(&issue(42, &[], None, false, true), "octo-org/project").unwrap();
        assert_eq!(record.external_id, "octo-org/project#42");
        let project = record.project.unwrap();
        assert_eq!(
            project.external_id,
            "github_issues:octo-org/project:milestone:7"
        );
        assert!(project.unverified);
        assert_eq!(record.remote_rev.as_deref(), Some("2026-10-06T12:00:00Z"));
        assert_eq!(
            record.fields.get("status").map(String::as_str),
            Some("todo")
        );
    }

    #[test]
    fn repository_and_pr_url_validation_prevent_arbitrary_credential_egress() {
        let mut settings = settings();
        settings.github_repository = Some("evil.example/path?token=x".into());
        assert!(repository(&settings).is_err());
        assert!(
            required_github_pr_url("https://attacker.test/pull/1", "octo-org/project").is_err()
        );
        assert_eq!(
            required_github_pr_url(
                "https://github.com/octo-org/project/pull/8",
                "octo-org/project"
            )
            .unwrap(),
            "https://github.com/octo-org/project/pull/8"
        );
    }

    #[test]
    fn response_parser_retains_page_etag_and_rate_limit_headers() {
        let response = parse_response("HTTP/2 403\r\nETag: \"page-1\"\r\nRetry-After: 30\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 1900000000\r\n\r\n{\"message\":\"limited\"}").unwrap();
        assert_eq!(response.status, 403);
        assert_eq!(
            response.headers.get("etag").map(String::as_str),
            Some("\"page-1\"")
        );
        let message = format_api_error("poll", &response);
        assert!(message.contains("retry-after=30"));
        assert!(message.contains("remaining=0"));
        assert!(message.contains("reset=1900000000"));
    }

    #[test]
    fn write_refuses_implicit_close_and_close_keywords_are_never_emitted_for_references() {
        assert!(close_issue(
            "octo-org/project",
            &json!({"issue_number":4,"authorized_by_daemon":true})
        )
        .is_err());
        let marker = "<!-- houston-task:T-4:2:pr_reference -->";
        assert!(
            !format!("Pull request: https://github.com/octo-org/project/pull/4\n{marker}")
                .contains("#4")
        );
        assert!(!without_close_keywords("This closes #7 and fixes #8")
            .to_ascii_lowercase()
            .contains("closes #7"));
    }

    #[test]
    fn etag_cursor_round_trips_each_page_independently() {
        let state = PageEtags {
            repository: Some("octo-org/project".into()),
            label: Some("import".into()),
            assigned_user: Some("theo".into()),
            pages: BTreeMap::from([
                (
                    1,
                    PageState {
                        etag: Some("first".into()),
                        count: 100,
                    },
                ),
                (
                    2,
                    PageState {
                        etag: Some("second".into()),
                        count: 12,
                    },
                ),
            ]),
        };
        let encoded = serde_json::to_string(&state).unwrap();
        let decoded = decode_etags(Some(&encoded)).unwrap();
        assert_eq!(decoded.pages.len(), 2);
        assert_eq!(decoded.label.as_deref(), Some("import"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_shim_poll_preserves_cached_membership_on_304() {
        use std::os::unix::fs::PermissionsExt as _;
        let _guard = TEST_GH_SHIM_LOCK.lock().await;

        let root = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/github_issues_page.json");
        let not_modified = root.path().join("not-modified");
        let shim = root.path().join("gh");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nif [ -f '{}' ]; then printf 'HTTP/2 304\\r\\nETag: \"page-1\"\\r\\n\\r\\n'; else printf 'HTTP/2 200\\r\\nETag: \"page-1\"\\r\\n\\r\\n'; cat '{}'; fi\n",
                not_modified.display(), fixture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)).unwrap();
        let lock = TEST_GH_SHIM.get_or_init(|| std::sync::Mutex::new(None));
        *lock.lock().unwrap() = Some(shim);

        let first = poll(&settings(), None, &TrackerPollCursor::default())
            .await
            .unwrap();
        assert!(!first.not_modified);
        assert_eq!(first.records.len(), 2);
        assert!(first
            .records
            .iter()
            .any(|record| record.external_id == "octo-org/project#11"));
        assert!(first
            .records
            .iter()
            .any(|record| record.external_id == "octo-org/project#12"));
        let cursor = first.cursor;

        std::fs::write(not_modified, "304").unwrap();
        let second = poll(&settings(), None, &cursor).await.unwrap();
        assert!(second.not_modified);
        assert!(
            second.records.is_empty(),
            "304 means retain caller's existing membership"
        );
        *lock.lock().unwrap() = None;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_shim_refetches_complete_membership_when_a_later_page_changes() {
        use std::os::unix::fs::PermissionsExt as _;
        let _guard = TEST_GH_SHIM_LOCK.lock().await;

        let root = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/github_issues_page.json");
        let calls = root.path().join("calls");
        let shim = root.path().join("gh");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\ncase \"$*\" in *'&page=1 '*If-None-Match*) printf 'HTTP/2 304\\r\\nETag: \"page-1\"\\r\\n\\r\\n' ;; *'&page=2 '*If-None-Match*) printf 'HTTP/2 200\\r\\nETag: \"page-2\"\\r\\n\\r\\n'; printf '%s' '[{{\"number\":14,\"title\":\"Changed page two\",\"body\":\"\",\"html_url\":\"https://github.com/octo-org/project/issues/14\",\"updated_at\":\"2026-10-06T12:30:00Z\",\"state\":\"open\",\"labels\":[{{\"name\":\"import\"}}],\"assignee\":null,\"assignees\":[],\"milestone\":null}}]' ;; *) printf 'HTTP/2 200\\r\\nETag: \"page-1\"\\r\\n\\r\\n'; cat '{}' ;; esac\n",
                calls.display(), fixture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)).unwrap();
        let lock = TEST_GH_SHIM.get_or_init(|| std::sync::Mutex::new(None));
        *lock.lock().unwrap() = Some(shim);

        let cursor = TrackerPollCursor {
            etag: Some(
                serde_json::to_string(&PageEtags {
                    repository: Some("octo-org/project".into()),
                    label: Some("import".into()),
                    assigned_user: Some("theo".into()),
                    pages: BTreeMap::from([
                        (
                            1,
                            PageState {
                                etag: Some("page-1".into()),
                                count: 100,
                            },
                        ),
                        (
                            2,
                            PageState {
                                etag: Some("page-2".into()),
                                count: 1,
                            },
                        ),
                    ]),
                })
                .unwrap(),
            ),
            last_edited_time: None,
            next_cursor: None,
        };
        let result = poll(&settings(), None, &cursor).await.unwrap();
        assert!(!result.not_modified);
        assert_eq!(result.records.len(), 2);
        assert!(result
            .records
            .iter()
            .any(|record| record.external_id == "octo-org/project#11"));
        assert!(result
            .records
            .iter()
            .any(|record| record.external_id == "octo-org/project#12"));
        assert!(!result
            .records
            .iter()
            .any(|record| record.external_id == "octo-org/project#14"));
        let calls = std::fs::read_to_string(calls).unwrap();
        let calls = calls.lines().collect::<Vec<_>>();
        assert_eq!(
            calls.len(),
            3,
            "page 1 304 and page 2 changed must trigger a full refetch"
        );
        assert!(calls[0].contains("&page=1 "));
        assert!(calls[0].contains("If-None-Match: page-1"));
        assert!(calls[1].contains("&page=2 "));
        assert!(calls[1].contains("If-None-Match: page-2"));
        assert!(calls[2].contains("&page=1 "));
        assert!(!calls[2].contains("If-None-Match"));
        *lock.lock().unwrap() = None;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn gh_shim_delivery_retry_finds_marker_without_creating_a_duplicate() {
        use std::os::unix::fs::PermissionsExt as _;
        let _guard = TEST_GH_SHIM_LOCK.lock().await;

        let root = tempfile::tempdir().unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/github_delivery_issue_marker.json");
        let calls = root.path().join("calls");
        let shim = root.path().join("gh");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nprintf 'HTTP/2 200\\r\\n\\r\\n'\ncat '{}'\n",
                calls.display(), fixture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)).unwrap();
        let lock = TEST_GH_SHIM.get_or_init(|| std::sync::Mutex::new(None));
        *lock.lock().unwrap() = Some(shim);

        let receipt = write(
            &settings(),
            None,
            "delivery_open",
            &json!({"delivery_marker":"outbox-88","task_identity":"T-88","title":"Delivery"}),
        )
        .await
        .unwrap();
        assert_eq!(receipt.external_id.as_deref(), Some("octo-org/project#77"));
        assert_eq!(
            receipt.url.as_deref(),
            Some("https://github.com/octo-org/project/issues/77")
        );
        let calls = std::fs::read_to_string(calls).unwrap();
        assert_eq!(
            calls.lines().count(),
            1,
            "the shim must receive only the lookup request"
        );
        assert!(calls.contains("repos/octo-org/project/issues?state=all"));
        *lock.lock().unwrap() = None;
    }
}

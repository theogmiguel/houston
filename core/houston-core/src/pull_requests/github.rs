use houston_protocol as proto;
use houston_protocol::{
    PrCheck, PrCheckState, PrComment, PrDetail, PrMergeState, PrMergeable, PrReview,
    PullRequestLink, PullRequestLinkSource, PullRequestState,
};
use serde_json::Value;
use std::path::Path;

use anyhow::{bail, Result};

pub struct LinkContext<'a> {
    pub host: &'a str,
    pub source: PullRequestLinkSource,
    pub linked_at: u64,
    pub synced_at: u64,
}

pub fn link_from_json(v: &serde_json::Value, ctx: &LinkContext<'_>) -> Option<PullRequestLink> {
    let number = u32::try_from(v.get("number")?.as_u64()?).ok()?;
    let url = v.get("url")?.as_str()?.to_string();
    let raw_state = v.get("state").and_then(|s| s.as_str()).unwrap_or("OPEN");
    let merged_at = timestamp(v.get("mergedAt"));
    let closed_at = timestamp(v.get("closedAt"));
    let state = if merged_at.is_some() || raw_state.eq_ignore_ascii_case("merged") {
        PullRequestState::Merged
    } else if raw_state.eq_ignore_ascii_case("closed") {
        PullRequestState::Closed
    } else {
        PullRequestState::Open
    };
    let checks = crate::gh::checks_from_rollup(v.get("statusCheckRollup"));
    Some(PullRequestLink {
        host: ctx.host.to_string(),
        repository: repository_from_url(&url).unwrap_or_default(),
        number,
        url,
        state,
        source: ctx.source,
        title: text(v.get("title")),
        is_draft: v.get("isDraft").and_then(|b| b.as_bool()).unwrap_or(false),
        additions: count(v.get("additions")),
        deletions: count(v.get("deletions")),
        changed_files: count(v.get("changedFiles")),
        checks: (checks != proto::PrChecks::None).then_some(checks),
        review_decision: text(v.get("reviewDecision")),
        linked_at: ctx.linked_at,
        merged_at,
        closed_at,
        synced_at: Some(ctx.synced_at),
    })
}

/// One `gh pr view --json` payload into the identity it carries plus the reading
/// behind it. The caller fills in the merge gate (policy lives in the parent)
/// and the GraphQL reads (permissions, threads) it merges in afterwards.
pub fn detail_from_json(
    v: &serde_json::Value,
    ctx: &LinkContext<'_>,
) -> Option<(PullRequestLink, PrDetail)> {
    let link = link_from_json(v, ctx)?;
    let auto_merge = v.get("autoMergeRequest");
    let detail = PrDetail {
        body: text(v.get("body")).filter(|b| !b.trim().is_empty()),
        author: v
            .get("author")
            .and_then(|a| a.get("login"))
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        base_ref: text(v.get("baseRefName")),
        head_ref: text(v.get("headRefName")),
        head_sha: text(v.get("headRefOid")).unwrap_or_default(),
        commit_count: v
            .get("commits")
            .and_then(|c| c.as_array())
            .map(|a| u32::try_from(a.len()).unwrap_or(u32::MAX))
            .unwrap_or(0),
        created_at: timestamp(v.get("createdAt")).unwrap_or(0),
        updated_at: timestamp(v.get("updatedAt")).unwrap_or(0),
        mergeable: mergeable_from(v.get("mergeable")),
        merge_state: merge_state_from(v.get("mergeStateStatus")),
        checks: check_list(v.get("statusCheckRollup")),
        comments: comments(v.get("comments")),
        reviews: reviews(v.get("reviews")),
        comments_total: v
            .get("comments")
            .and_then(|c| c.as_array())
            .map(|a| u32::try_from(a.len()).unwrap_or(u32::MAX))
            .unwrap_or(0),
        reviews_total: v
            .get("reviews")
            .and_then(|c| c.as_array())
            .map(|a| u32::try_from(a.len()).unwrap_or(u32::MAX))
            .unwrap_or(0),
        merge_disabled_reason: None,
        viewer: None,
        viewer_message: None,
        behind_by: None,
        labels: labels_from(v.get("labels")),
        reviewers: requested_reviewers_from(v.get("reviewRequests")),
        reactions: Vec::new(),
        threads: Vec::new(),
        threads_truncated: false,
        threads_message: None,
        auto_merge_enabled: auto_merge.map(|a| !a.is_null()),
        auto_merge_method: auto_merge
            .and_then(|a| a.get("mergeMethod"))
            .and_then(|m| m.as_str())
            .and_then(merge_method_from),
        cross_repository: v
            .get("isCrossRepository")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
    };
    Some((link, detail))
}

fn merge_method_from(raw: &str) -> Option<proto::PrMergeMethod> {
    match raw {
        "MERGE" => Some(proto::PrMergeMethod::Merge),
        "SQUASH" => Some(proto::PrMergeMethod::Squash),
        "REBASE" => Some(proto::PrMergeMethod::Rebase),
        _ => None,
    }
}

fn labels_from(v: Option<&serde_json::Value>) -> Vec<proto::PrLabel> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|l| {
            let name = text(l.get("name"))?;
            Some(proto::PrLabel {
                name,
                color: text(l.get("color")),
            })
        })
        .collect()
}

/// The flattened `reviewRequests` gh reports — `{login}` for a person,
/// `{slug}` for a team. Used as the fallback when the GraphQL reviewer read
/// fails, so a request still shows on a degraded page.
fn requested_reviewers_from(v: Option<&serde_json::Value>) -> Vec<proto::PrReviewer> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in arr {
        if let Some(login) = text(r.get("login")) {
            push_reviewer(
                &mut out,
                proto::PrReviewer {
                    id: login,
                    kind: proto::PrReviewerKind::User,
                },
            );
        } else if let Some(slug) = text(r.get("slug")) {
            push_reviewer(
                &mut out,
                proto::PrReviewer {
                    id: slug,
                    kind: proto::PrReviewerKind::Team,
                },
            );
        }
    }
    out
}

fn push_reviewer(out: &mut Vec<proto::PrReviewer>, reviewer: proto::PrReviewer) {
    if !out
        .iter()
        .any(|r| r.id == reviewer.id && r.kind == reviewer.kind)
    {
        out.push(reviewer);
    }
}

fn text(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn count(v: Option<&serde_json::Value>) -> u32 {
    v.and_then(|n| n.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn timestamp(v: Option<&serde_json::Value>) -> Option<u64> {
    let ms = timestamp_ms(v)?;
    u64::try_from(ms / 1000).ok()
}

fn timestamp_ms(v: Option<&serde_json::Value>) -> Option<i64> {
    crate::usage::time::parse_rfc3339_ms(v?.as_str()?)
}

fn repository_from_url(url: &str) -> Option<String> {
    let parts: Vec<&str> = url.split('/').collect();
    let pull = parts.iter().position(|p| *p == "pull" || *p == "pulls")?;
    if pull < 2 {
        return None;
    }
    Some(format!("{}/{}", parts[pull - 2], parts[pull - 1]))
}

fn mergeable_from(v: Option<&serde_json::Value>) -> PrMergeable {
    match v.and_then(|s| s.as_str()).unwrap_or("") {
        "MERGEABLE" => PrMergeable::Mergeable,
        "CONFLICTING" => PrMergeable::Conflicting,
        _ => PrMergeable::Unknown,
    }
}

fn merge_state_from(v: Option<&serde_json::Value>) -> PrMergeState {
    match v.and_then(|s| s.as_str()).unwrap_or("") {
        "CLEAN" => PrMergeState::Clean,
        "BEHIND" => PrMergeState::Behind,
        "BLOCKED" => PrMergeState::Blocked,
        "DIRTY" => PrMergeState::Dirty,
        "DRAFT" => PrMergeState::Draft,
        "HAS_HOOKS" => PrMergeState::HasHooks,
        "UNSTABLE" => PrMergeState::Unstable,
        _ => PrMergeState::Unknown,
    }
}

/// `statusCheckRollup` carries check runs (`name`/`status`/`conclusion`) and
/// commit status contexts (`context`/`state`). Every entry becomes a check; one
/// in neither shape is `Unknown`, so a malformed rollup never reads all-green.
fn check_list(v: Option<&serde_json::Value>) -> Vec<PrCheck> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    arr.iter().map(check_from_entry).collect()
}

fn check_from_entry(c: &serde_json::Value) -> PrCheck {
    let typename = c.get("__typename").and_then(|s| s.as_str()).unwrap_or("");
    if c.get("context").is_some() || typename == "StatusContext" {
        let Some(name) = text(c.get("context")) else {
            return unnamed_check();
        };
        let state = match c.get("state").and_then(|s| s.as_str()).unwrap_or("") {
            "SUCCESS" => PrCheckState::Passing,
            "PENDING" | "EXPECTED" => PrCheckState::Running,
            "FAILURE" | "ERROR" => PrCheckState::Failing,
            _ => PrCheckState::Unknown,
        };
        return PrCheck {
            name,
            state,
            url: text(c.get("targetUrl")),
            duration_ms: None,
        };
    }
    let Some(name) = text(c.get("name")).or_else(|| text(c.get("workflowName"))) else {
        return unnamed_check();
    };
    let state = match c.get("status").and_then(|s| s.as_str()).unwrap_or("") {
        "QUEUED" | "PENDING" | "REQUESTED" | "WAITING" => PrCheckState::Queued,
        "IN_PROGRESS" => PrCheckState::Running,
        "COMPLETED" => match c.get("conclusion").and_then(|s| s.as_str()).unwrap_or("") {
            "SUCCESS" => PrCheckState::Passing,
            "SKIPPED" | "NEUTRAL" => PrCheckState::Skipped,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
            | "STALE" => PrCheckState::Failing,
            _ => PrCheckState::Unknown,
        },
        _ => PrCheckState::Unknown,
    };
    let started = timestamp_ms(c.get("startedAt"));
    let completed = timestamp_ms(c.get("completedAt"));
    let duration_ms = match (started, completed) {
        (Some(start), Some(end)) if end >= start => Some(u64::try_from(end - start).unwrap_or(0)),
        _ => None,
    };
    PrCheck {
        name,
        state,
        url: text(c.get("detailsUrl")),
        duration_ms,
    }
}

/// An entry whose name cannot be read is unverifiable, so it blocks the gate
/// rather than vanishing into an all-green rollup.
fn unnamed_check() -> PrCheck {
    PrCheck {
        name: "unnamed check".to_string(),
        state: PrCheckState::Unknown,
        url: None,
        duration_ms: None,
    }
}

/// The newest comments, in their original order. `comments_total` tells the UI
/// what the cap left out.
fn comments(v: Option<&serde_json::Value>) -> Vec<PrComment> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let start = arr.len().saturating_sub(super::DETAIL_MAX_COMMENTS);
    arr[start..]
        .iter()
        .map(|c| PrComment {
            id: text(c.get("id")),
            author: c
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string(),
            body: clip(text(c.get("body")).unwrap_or_default()),
            created_at: timestamp(c.get("createdAt")).unwrap_or(0),
            url: text(c.get("url")),
            reactions: Vec::new(),
        })
        .collect()
}

fn reviews(v: Option<&serde_json::Value>) -> Vec<PrReview> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let start = arr.len().saturating_sub(super::DETAIL_MAX_REVIEWS);
    arr[start..]
        .iter()
        .map(|r| PrReview {
            id: text(r.get("id")),
            author: r
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string(),
            state: text(r.get("state")).unwrap_or_else(|| "COMMENTED".to_string()),
            body: clip(text(r.get("body")).unwrap_or_default()),
            submitted_at: timestamp(r.get("submittedAt")).unwrap_or(0),
            reactions: Vec::new(),
        })
        .collect()
}

fn clip(body: String) -> String {
    let max = super::DETAIL_BODY_MAX;
    if body.len() <= max {
        return body;
    }
    let original = body.len();
    let mut end = max;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}… [truncated: showing first {max} of {original} bytes]",
        &body[..end]
    )
}

// The GraphQL reads `gh pr view --json` cannot make: permissions, inline
// review threads, reactions by remark, reviewer and label candidates.

/// Reaction groups as every reactable node reports them. Only the count is
/// asked for; who reacted is a hover on GitHub, not a line here.
const REACTION_GROUPS: &str =
    "reactionGroups { content viewerHasReacted reactors(first: 1) { totalCount } }";

/// What the viewer may do, and how far the head is behind its base. The
/// comparison needs the head ref qualified `owner:branch`, so it is written in
/// rather than passed as a nullable variable GraphQL refuses.
const ACCESS_QUERY: &str = "query PrAccess($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { \
    viewerPermission \
    pullRequest(number: $number) { viewerCanUpdate viewerDidAuthor viewerCanUpdateBranch } } }";

const ACCESS_COMPARE_QUERY: &str =
    "query PrAccess($owner: String!, $name: String!, $number: Int!, $headRef: String!) { \
    repository(owner: $owner, name: $name) { \
    viewerPermission \
    pullRequest(number: $number) { \
    viewerCanUpdate viewerDidAuthor viewerCanUpdateBranch \
    baseRef { compare(headRef: $headRef) { behindBy } } } } }";

pub struct PrAccessData {
    pub permissions: proto::PrPermissions,
    pub behind_by: Option<u32>,
}

pub fn access(
    dir: &Path,
    repository: &str,
    number: u32,
    head_ref: Option<&str>,
) -> Result<PrAccessData> {
    let (owner, name) = repository_parts(repository, number)?;
    let (query, variables) = match head_ref {
        Some(head_ref) => (
            ACCESS_COMPARE_QUERY,
            serde_json::json!({ "owner": owner, "name": name, "number": number, "headRef": head_ref }),
        ),
        None => (
            ACCESS_QUERY,
            serde_json::json!({ "owner": owner, "name": name, "number": number }),
        ),
    };
    let value = crate::gh::graphql(dir, query, variables)?;
    let repository_node = value
        .pointer("/data/repository")
        .filter(|r| !r.is_null())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "GitHub answered no repository for {repository:?}; expected an `owner/name` GitHub repository this account can read"
            )
        })?;
    let pull_request = repository_node
        .get("pullRequest")
        .filter(|p| !p.is_null())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "GitHub did not show PR #{number} in {repository} to this account; check the number and the token's access"
            )
        })?;
    let permission = repository_node
        .get("viewerPermission")
        .and_then(Value::as_str)
        .unwrap_or("");
    let behind_by = pull_request
        .pointer("/baseRef/compare/behindBy")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    Ok(PrAccessData {
        permissions: proto::PrPermissions {
            can_write: matches!(permission, "ADMIN" | "MAINTAIN" | "WRITE"),
            can_triage: matches!(permission, "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE"),
            can_update: pull_request
                .get("viewerCanUpdate")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            did_author: pull_request
                .get("viewerDidAuthor")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            can_update_branch: pull_request
                .get("viewerCanUpdateBranch")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        behind_by,
    })
}

/// Inline discussions, every remark's reactions, and the reviewers on the
/// review: one bounded page with `truncated` telling the UI what it is not
/// showing; a longer thread is pages of its own on GitHub.
const THREADS_QUERY_TEMPLATE: &str = "query PrThreads($owner: String!, $name: String!, $number: Int!) { \
    repository(owner: $owner, name: $name) { \
    pullRequest(number: $number) { \
    id \
    __REACTION_GROUPS__ \
    comments(first: 100) { nodes { id __REACTION_GROUPS__ } } \
    reviews(first: 100) { nodes { id __REACTION_GROUPS__ } } \
    reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } } \
    latestReviews(first: 50) { nodes { author { login } } } \
    reviewThreads(first: 100) { \
    totalCount \
    pageInfo { hasNextPage } \
    nodes { \
    id isResolved isOutdated path line \
    comments(first: 50) { \
    totalCount \
    pageInfo { hasNextPage } \
    nodes { id author { login } body createdAt url __REACTION_GROUPS__ } } } } } } }";

fn threads_query() -> String {
    THREADS_QUERY_TEMPLATE.replace("__REACTION_GROUPS__", REACTION_GROUPS)
}

pub struct PrThreadsData {
    pub threads: Vec<proto::PrThread>,
    pub truncated: bool,
    /// The pull request's own reactions, which sit on its description.
    pub reactions: Vec<proto::PrReactionCount>,
    /// Reactions by node id, for the conversation comments and reviews the `gh`
    /// JSON read reports none on.
    pub reactions_by_id: Vec<(String, Vec<proto::PrReactionCount>)>,
    pub reviewers: Vec<proto::PrReviewer>,
}

pub fn threads(dir: &Path, repository: &str, number: u32) -> Result<PrThreadsData> {
    let (owner, name) = repository_parts(repository, number)?;
    let value = crate::gh::graphql(
        dir,
        &threads_query(),
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )?;
    let pull_request = value
        .pointer("/data/repository/pullRequest")
        .filter(|p| !p.is_null())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "GitHub did not show PR #{number} in {repository} while reading its discussions"
            )
        })?;

    let (threads, mut truncated) = threads_from(pull_request.get("reviewThreads"));

    let mut reactions_by_id: Vec<(String, Vec<proto::PrReactionCount>)> = Vec::new();
    for group in ["comments", "reviews"] {
        if let Some(nodes) = pull_request
            .pointer(&format!("/{group}/nodes"))
            .and_then(Value::as_array)
        {
            for node in nodes {
                let Some(id) = text(node.get("id")) else {
                    continue;
                };
                let counts = reaction_counts(node.get(REACTION_GROUPS_FIELD_NAME));
                if !counts.is_empty() {
                    reactions_by_id.push((id, counts));
                }
            }
        }
    }

    let mut reviewers: Vec<proto::PrReviewer> = Vec::new();
    if let Some(nodes) = pull_request
        .pointer("/reviewRequests/nodes")
        .and_then(Value::as_array)
    {
        for node in nodes {
            let Some(requested) = node.get("requestedReviewer").filter(|r| !r.is_null()) else {
                continue;
            };
            if let Some(login) = text(requested.get("login")) {
                push_reviewer(
                    &mut reviewers,
                    proto::PrReviewer {
                        id: login,
                        kind: proto::PrReviewerKind::User,
                    },
                );
            } else if let Some(slug) = text(requested.get("slug")) {
                push_reviewer(
                    &mut reviewers,
                    proto::PrReviewer {
                        id: slug,
                        kind: proto::PrReviewerKind::Team,
                    },
                );
            }
        }
    }
    if let Some(nodes) = pull_request
        .pointer("/latestReviews/nodes")
        .and_then(Value::as_array)
    {
        for node in nodes {
            if let Some(login) = node.pointer("/author/login").and_then(Value::as_str) {
                push_reviewer(
                    &mut reviewers,
                    proto::PrReviewer {
                        id: login.to_string(),
                        kind: proto::PrReviewerKind::User,
                    },
                );
            }
        }
    }

    // A thread with a malformed row is skipped rather than failing the page; the
    // flag below still says the read was bounded.
    if threads.len()
        != pull_request
            .pointer("/reviewThreads/nodes")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    {
        truncated = true;
    }
    Ok(PrThreadsData {
        threads,
        truncated,
        reactions: reaction_counts(pull_request.get(REACTION_GROUPS_FIELD_NAME)),
        reactions_by_id,
        reviewers,
    })
}

/// The GraphQL alias under which reaction groups come back; the same name in the
/// query and in the response, kept once so the two cannot drift.
const REACTION_GROUPS_FIELD_NAME: &str = "reactionGroups";

fn threads_from(v: Option<&Value>) -> (Vec<proto::PrThread>, bool) {
    let Some(connection) = v.filter(|c| !c.is_null()) else {
        return (Vec::new(), false);
    };
    let truncated = connection
        .pointer("/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || connection
            .get("totalCount")
            .and_then(Value::as_u64)
            .is_some_and(|total| {
                total
                    > connection
                        .get("nodes")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0) as u64
            });
    let mut threads = Vec::new();
    let mut any_comments_truncated = false;
    for node in connection
        .get("nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let Some(id) = text(node.get("id")) else {
            continue;
        };
        let mut comments = Vec::new();
        if let Some(comment_nodes) = node.pointer("/comments/nodes").and_then(Value::as_array) {
            for c in comment_nodes {
                let Some(cid) = text(c.get("id")) else {
                    continue;
                };
                comments.push(proto::PrThreadComment {
                    id: cid,
                    author: c
                        .pointer("/author/login")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("unknown")
                        .to_string(),
                    body: clip(text(c.get("body")).unwrap_or_default()),
                    created_at: timestamp(c.get("createdAt")).unwrap_or(0),
                    url: text(c.get("url")),
                    reactions: reaction_counts(c.get(REACTION_GROUPS_FIELD_NAME)),
                });
            }
        }
        if node
            .pointer("/comments/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || node
                .pointer("/comments/totalCount")
                .and_then(Value::as_u64)
                .is_some_and(|total| total > comments.len() as u64)
        {
            any_comments_truncated = true;
        }
        threads.push(proto::PrThread {
            id,
            path: text(node.get("path")),
            line: node
                .get("line")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok()),
            resolved: node
                .get("isResolved")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outdated: node
                .get("isOutdated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            comments,
        });
    }
    (threads, truncated || any_comments_truncated)
}

fn reaction_from_github(raw: &str) -> Option<proto::PrReaction> {
    match raw {
        "THUMBS_UP" => Some(proto::PrReaction::ThumbsUp),
        "THUMBS_DOWN" => Some(proto::PrReaction::ThumbsDown),
        "LAUGH" => Some(proto::PrReaction::Laugh),
        "HOORAY" => Some(proto::PrReaction::Hooray),
        "CONFUSED" => Some(proto::PrReaction::Confused),
        "HEART" => Some(proto::PrReaction::Heart),
        "ROCKET" => Some(proto::PrReaction::Rocket),
        "EYES" => Some(proto::PrReaction::Eyes),
        _ => None,
    }
}

/// GitHub answers every one of its eight groups, most of them empty; only the
/// ones with a count are carried, which keeps an empty page empty.
fn reaction_counts(v: Option<&Value>) -> Vec<proto::PrReactionCount> {
    let Some(arr) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|group| {
            let content = reaction_from_github(group.get("content")?.as_str()?)?;
            let count = group
                .pointer("/reactors/totalCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if count == 0 {
                return None;
            }
            Some(proto::PrReactionCount {
                content,
                count: u32::try_from(count).unwrap_or(u32::MAX),
                reacted: group
                    .get("viewerHasReacted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// The pull request's node id, which a reaction on its description and a revert
/// both address.
pub fn pull_request_node_id(dir: &Path, repository: &str, number: u32) -> Result<String> {
    const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }";
    let (owner, name) = repository_parts(repository, number)?;
    let value = crate::gh::graphql(
        dir,
        QUERY,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )?;
    value
        .pointer("/data/repository/pullRequest/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "GitHub returned no node id for PR #{number} in {repository}; expected `repository.pullRequest.id`"
            )
        })
}

/// True when `subject_id` is the pull request itself or a remark hanging off it.
/// Read before a reaction is written, so a client that names another pull
/// request's comment cannot react through this one.
pub fn subject_belongs(
    dir: &Path,
    repository: &str,
    number: u32,
    subject_id: &str,
) -> Result<bool> {
    const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) { \
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } \
        node(id: $subjectId) { id \
        ... on IssueComment { pullRequest { id } } \
        ... on PullRequestReviewComment { pullRequest { id } } \
        ... on PullRequestReview { pullRequest { id } } } }";
    let (owner, name) = repository_parts(repository, number)?;
    let value = crate::gh::graphql(
        dir,
        QUERY,
        serde_json::json!({ "owner": owner, "name": name, "number": number, "subjectId": subject_id }),
    )?;
    let expected = value
        .pointer("/data/repository/pullRequest/id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let node = value
        .get("data")
        .and_then(|d| d.get("node"))
        .filter(|n| !n.is_null());
    let actual = node.and_then(|n| {
        n.pointer("/pullRequest/id")
            .and_then(Value::as_str)
            .or_else(|| n.get("id").and_then(Value::as_str))
    });
    Ok(matches!((expected, actual), (Some(a), Some(b)) if a == b))
}

/// The people this viewer may ask for a review, with whoever has already been
/// asked marked and the author left out: GitHub refuses a review request from
/// the person who opened the pull request.
pub fn reviewer_candidates(
    dir: &Path,
    repository: &str,
    number: u32,
) -> Result<(Vec<proto::PrReviewerCandidate>, bool)> {
    const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
        repository(owner: $owner, name: $name) { \
        assignableUsers(first: 100) { pageInfo { hasNextPage } nodes { login name } } \
        pullRequest(number: $number) { \
        author { login } \
        reviewRequests(first: 100) { nodes { requestedReviewer { \
        ... on User { login name } \
        ... on Team { slug name } \
        ... on Bot { login } } } } } } }";
    let (owner, name) = repository_parts(repository, number)?;
    let value = crate::gh::graphql(
        dir,
        QUERY,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )?;
    let repo_node = value.pointer("/data/repository").filter(|r| !r.is_null());
    let author = repo_node
        .and_then(|r| r.pointer("/pullRequest/author/login"))
        .and_then(Value::as_str);
    let mut candidates: Vec<proto::PrReviewerCandidate> = Vec::new();
    let mut seen: Vec<(proto::PrReviewerKind, String)> = Vec::new();
    if let Some(nodes) = repo_node
        .and_then(|r| r.pointer("/pullRequest/reviewRequests/nodes"))
        .and_then(Value::as_array)
    {
        for node in nodes {
            let Some(requested) = node.get("requestedReviewer").filter(|r| !r.is_null()) else {
                continue;
            };
            let (id, kind) = match (text(requested.get("login")), text(requested.get("slug"))) {
                (Some(login), _) => (login, proto::PrReviewerKind::User),
                (None, Some(slug)) => (slug, proto::PrReviewerKind::Team),
                _ => continue,
            };
            seen.push((kind, id.clone()));
            candidates.push(proto::PrReviewerCandidate {
                id: id.clone(),
                kind,
                login: id,
                name: text(requested.get("name")),
                is_requested: true,
            });
        }
    }
    let mut truncated = false;
    if let Some(users) = repo_node.and_then(|r| r.pointer("/assignableUsers")) {
        truncated = users
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        for node in users
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(login) = text(node.get("login")) else {
                continue;
            };
            if Some(login.as_str()) == author {
                continue;
            }
            if seen
                .iter()
                .any(|(k, id)| *k == proto::PrReviewerKind::User && *id == login)
            {
                continue;
            }
            seen.push((proto::PrReviewerKind::User, login.clone()));
            candidates.push(proto::PrReviewerCandidate {
                id: login.clone(),
                kind: proto::PrReviewerKind::User,
                login,
                name: text(node.get("name")),
                is_requested: false,
            });
        }
    }
    Ok((candidates, truncated))
}

/// The repository's labels with the ones on this pull request marked. A label
/// the pull request wears that the repository no longer defines leads the list,
/// because a label that cannot be seen cannot be taken off.
pub fn label_candidates(
    dir: &Path,
    repository: &str,
    number: u32,
) -> Result<(Vec<proto::PrLabelCandidate>, bool)> {
    const QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) { \
        repository(owner: $owner, name: $name) { \
        labels(first: 100, orderBy: { field: NAME, direction: ASC }) { \
        pageInfo { hasNextPage } nodes { name color description } } \
        pullRequest(number: $number) { labels(first: 100) { nodes { name } } } } }";
    let (owner, name) = repository_parts(repository, number)?;
    let value = crate::gh::graphql(
        dir,
        QUERY,
        serde_json::json!({ "owner": owner, "name": name, "number": number }),
    )?;
    let repo_node = value.pointer("/data/repository").filter(|r| !r.is_null());
    let applied: Vec<String> = repo_node
        .and_then(|r| r.pointer("/pullRequest/labels/nodes"))
        .and_then(Value::as_array)
        .map(|nodes| nodes.iter().filter_map(|n| text(n.get("name"))).collect())
        .unwrap_or_default();
    let mut candidates: Vec<proto::PrLabelCandidate> = Vec::new();
    let mut truncated = false;
    if let Some(labels) = repo_node
        .and_then(|r| r.get("labels"))
        .filter(|l| !l.is_null())
    {
        truncated = labels
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        for node in labels
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = text(node.get("name")) else {
                continue;
            };
            let is_applied = applied.contains(&name);
            candidates.push(proto::PrLabelCandidate {
                name,
                color: text(node.get("color")),
                description: text(node.get("description")),
                is_applied,
            });
        }
    }
    let mut leading: Vec<proto::PrLabelCandidate> = applied
        .iter()
        .filter(|name| !candidates.iter().any(|c| c.name == **name))
        .map(|name| proto::PrLabelCandidate {
            name: name.clone(),
            color: None,
            description: None,
            is_applied: true,
        })
        .collect();
    leading.extend(candidates);
    Ok((leading, truncated))
}

/// One `gh pr list` row each, folded from the fields the list read asked for.
pub fn list_items(v: &Value) -> Vec<proto::PrListItem> {
    let Some(rows) = v.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let number = u32::try_from(row.get("number")?.as_u64()?).ok()?;
            let url = row.get("url")?.as_str()?.to_string();
            let raw_state = row.get("state").and_then(Value::as_str).unwrap_or("OPEN");
            let merged = !row.get("mergedAt").map(Value::is_null).unwrap_or(true);
            let state = if merged || raw_state.eq_ignore_ascii_case("merged") {
                PullRequestState::Merged
            } else if raw_state.eq_ignore_ascii_case("closed") {
                PullRequestState::Closed
            } else {
                PullRequestState::Open
            };
            let checks = crate::gh::checks_from_rollup(row.get("statusCheckRollup"));
            Some(proto::PrListItem {
                number,
                title: text(row.get("title")).unwrap_or_default(),
                url,
                state,
                is_draft: row.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
                author: row
                    .pointer("/author/login")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                head_ref: text(row.get("headRefName")).unwrap_or_default(),
                base_ref: text(row.get("baseRefName")).unwrap_or_default(),
                updated_at: timestamp(row.get("updatedAt")).unwrap_or(0),
                additions: count(row.get("additions")),
                deletions: count(row.get("deletions")),
                review_decision: text(row.get("reviewDecision")),
                checks: (checks != proto::PrChecks::None).then_some(checks),
                labels: labels_from(row.get("labels")),
            })
        })
        .collect()
}

/// `gh run list --json databaseId,workflowName,url` rows as approval targets.
pub fn workflow_runs(v: &Value) -> Vec<crate::gh::WorkflowRun> {
    let Some(rows) = v.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let id = row.get("databaseId")?.as_u64()?;
            Some(crate::gh::WorkflowRun {
                id,
                name: text(row.get("workflowName")).unwrap_or_else(|| format!("run {id}")),
            })
        })
        .collect()
}

/// The head facts an approve-workflows pass has to re-verify: a fork's runs,
/// pinned to the revision the user saw.
pub struct CrossRepoHead {
    pub sha: String,
    pub branch: String,
    pub owner: String,
}

/// `Some` only for an open cross-repository pull request whose head is fully
/// known; anything less cannot be approved safely.
pub fn cross_repo_head(v: &Value) -> Option<CrossRepoHead> {
    if !v
        .get("isCrossRepository")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if !v
        .get("state")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("open"))
    {
        return None;
    }
    Some(CrossRepoHead {
        sha: text(v.get("headRefOid"))?,
        branch: text(v.get("headRefName"))?,
        owner: text(v.pointer("/headRepositoryOwner/login"))?,
    })
}

fn repository_parts(repository: &str, number: u32) -> Result<(String, String)> {
    match crate::gh::split_repository(repository) {
        Some(parts) => Ok(parts),
        None => bail!(
            "cannot address PR #{number} on GitHub: repository {repository:?} is not `owner/name`"
        ),
    }
}

// ---------------------------------------------------------------------------
// Stacked pull requests, GitHub's own preview object.
// ---------------------------------------------------------------------------

pub struct StackLayer {
    pub number: u32,
    pub title: Option<String>,
    pub head_sha: Option<String>,
    pub head_ref: String,
    pub is_draft: bool,
    pub state: PullRequestState,
}

pub struct Stack {
    pub id: String,
    pub number: u32,
    pub url: String,
    pub base: String,
    pub layers: Vec<StackLayer>,
}

/// The first stack of a `?pull_request=` listing, or `None` for an empty one: a
/// pull request is in at most one stack, so the array is GitHub's way of saying
/// "none" rather than a page.
pub fn stack_from_json(v: &Value) -> Result<Option<Stack>> {
    let Some(first) = v.as_array().and_then(|a| a.first()) else {
        return Ok(None);
    };
    let Some(number) = first.get("number").and_then(Value::as_u64) else {
        bail!("a stack without a number is not a stack; expected a list of `{{\"number\", \"pull_requests\"}}` objects");
    };
    let id = text(first.get("node_id"))
        .or_else(|| {
            first
                .get("id")
                .and_then(|i| i.as_u64())
                .map(|n| n.to_string())
        })
        .unwrap_or_else(|| number.to_string());
    let url = text(first.get("html_url"))
        .or_else(|| text(first.get("url")))
        .unwrap_or_default();
    let base = text(first.get("base"))
        .or_else(|| text(first.pointer("/base/ref")))
        .unwrap_or_default();
    let layers = first
        .get("pull_requests")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let number = u32::try_from(row.get("number")?.as_u64()?).ok()?;
                    let head_ref = text(row.pointer("/head/ref"))?;
                    let merged = !row.get("merged_at").map(Value::is_null).unwrap_or(true);
                    let raw_state = row.get("state").and_then(Value::as_str).unwrap_or("");
                    let state = if merged || raw_state.eq_ignore_ascii_case("merged") {
                        PullRequestState::Merged
                    } else if raw_state.eq_ignore_ascii_case("closed") {
                        PullRequestState::Closed
                    } else {
                        PullRequestState::Open
                    };
                    Some(StackLayer {
                        number,
                        title: text(row.get("title")),
                        head_sha: text(row.pointer("/head/sha")),
                        head_ref,
                        is_draft: row.get("draft").and_then(Value::as_bool).unwrap_or(false),
                        state,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(Stack {
        id,
        number: u32::try_from(number).unwrap_or(u32::MAX),
        url,
        base,
        layers,
    }))
}

pub fn stack_to_proto(stack: &Stack) -> proto::PrStack {
    proto::PrStack {
        id: stack.id.clone(),
        number: stack.number,
        url: stack.url.clone(),
        base: stack.base.clone(),
        layers: stack
            .layers
            .iter()
            .map(|l| proto::PrStackLayer {
                number: l.number,
                head_ref: l.head_ref.clone(),
                state: l.state,
                is_draft: l.is_draft,
                title: l.title.clone(),
                head_sha: l.head_sha.clone(),
            })
            .collect(),
    }
}

/// gh's async merge job: `{status, details{uuid, message}}`.
pub struct StackMergeStatus {
    pub state: String,
    pub uuid: Option<String>,
    pub detail: Option<String>,
}

pub fn stack_merge_status_of(raw: &str) -> Option<StackMergeStatus> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let state = text(value.get("status"))?;
    Some(StackMergeStatus {
        state,
        uuid: text(value.pointer("/details/uuid")),
        detail: text(value.pointer("/details/message")),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use serde_json::json;

    fn link(v: serde_json::Value) -> PullRequestLink {
        link_from_json(&v, &ctx_fixture()).expect("the recorded gh payload must produce a link")
    }

    fn detail(v: serde_json::Value) -> (PullRequestLink, PrDetail) {
        detail_from_json(&v, &ctx_fixture()).expect("the recorded gh payload must produce a detail")
    }

    #[test]
    fn an_open_pull_request_maps_every_field() {
        let l = link(json!({
            "number": 212u64,
            "url": "https://github.com/owner/repo/pull/212",
            "state": "OPEN",
            "title": "a change",
            "isDraft": false,
            "additions": 12u64,
            "deletions": 3u64,
            "changedFiles": 2u64,
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}],
        }));
        assert_eq!(l.host, "GitHub");
        assert_eq!(l.repository, "owner/repo");
        assert_eq!(l.number, 212);
        assert_eq!(l.state, PullRequestState::Open);
        assert_eq!(l.source, PullRequestLinkSource::Manual);
        assert_eq!(l.title.as_deref(), Some("a change"));
        assert_eq!(l.additions, 12);
        assert_eq!(l.deletions, 3);
        assert_eq!(l.changed_files, 2);
        assert_eq!(l.checks, Some(proto::PrChecks::Passing));
        assert_eq!(l.linked_at, 5);
        assert_eq!(l.synced_at, Some(9));
        assert_eq!(l.merged_at, None);
    }

    #[test]
    fn merged_and_closed_states_come_from_their_own_fields() {
        let merged = link(json!({
            "number": 1u64, "url": "https://github.com/o/r/pull/1", "state": "OPEN",
            "mergedAt": "2026-09-01T12:00:00Z",
        }));
        assert_eq!(merged.state, PullRequestState::Merged);
        assert!(merged.merged_at.is_some());

        let closed = link(json!({
            "number": 2u64, "url": "https://github.com/o/r/pull/2", "state": "CLOSED",
            "closedAt": "2026-09-02T12:00:00Z",
        }));
        assert_eq!(closed.state, PullRequestState::Closed);
        assert!(closed.merged_at.is_none());
    }

    #[test]
    fn a_draft_and_a_review_decision_are_kept() {
        let l = link(json!({
            "number": 3u64, "url": "https://github.com/o/r/pull/3", "state": "OPEN",
            "isDraft": true, "reviewDecision": "APPROVED",
        }));
        assert!(l.is_draft);
        assert_eq!(l.review_decision.as_deref(), Some("APPROVED"));
    }

    #[test]
    fn a_payload_without_a_number_or_url_is_not_a_link() {
        assert!(link_from_json(&json!({"url": "u"}), &ctx_fixture()).is_none());
        assert!(link_from_json(&json!({"number": 4u64}), &ctx_fixture()).is_none());
    }

    #[test]
    fn a_detail_carries_branches_body_and_commit_count() {
        let (_, d) = detail(json!({
            "number": 212u64,
            "url": "https://github.com/owner/repo/pull/212",
            "state": "OPEN",
            "title": "a change",
            "body": "what it does",
            "author": {"login": "theo"},
            "baseRefName": "main",
            "headRefName": "feat/x",
            "headRefOid": "abc123",
            "createdAt": "2026-09-01T12:00:00Z",
            "updatedAt": "2026-09-02T12:00:00Z",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "commits": [{"oid": "a"}, {"oid": "b"}],
        }));
        assert_eq!(d.body.as_deref(), Some("what it does"));
        assert_eq!(d.author.as_deref(), Some("theo"));
        assert_eq!(d.base_ref.as_deref(), Some("main"));
        assert_eq!(d.head_ref.as_deref(), Some("feat/x"));
        assert_eq!(d.head_sha, "abc123");
        assert_eq!(d.commit_count, 2);
        assert_eq!(d.created_at, 1788264000);
        assert_eq!(d.mergeable, PrMergeable::Mergeable);
        assert_eq!(d.merge_state, PrMergeState::Clean);
    }

    #[test]
    fn checks_carry_both_gh_shapes_and_a_real_duration_only() {
        let (_, d) = detail(json!({
            "number": 1u64, "url": "https://github.com/o/r/pull/1", "state": "OPEN",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "build", "status": "COMPLETED",
                 "conclusion": "SUCCESS", "detailsUrl": "https://x/build",
                 "startedAt": "2026-09-01T12:00:00Z", "completedAt": "2026-09-01T12:01:12Z"},
                {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS"},
                {"__typename": "StatusContext", "context": "ci/legacy", "state": "FAILURE",
                 "targetUrl": "https://x/legacy"},
                {"name": "weird", "status": "COMPLETED", "conclusion": "SOMETHING_NEW"},
                {"status": "COMPLETED", "conclusion": "SUCCESS"}
            ],
        }));
        assert_eq!(d.checks.len(), 5);
        assert_eq!(d.checks[0].state, PrCheckState::Passing);
        assert_eq!(d.checks[0].duration_ms, Some(72_000));
        assert_eq!(d.checks[0].url.as_deref(), Some("https://x/build"));
        assert_eq!(d.checks[1].state, PrCheckState::Running);
        assert_eq!(d.checks[1].duration_ms, None);
        assert_eq!(d.checks[2].name, "ci/legacy");
        assert_eq!(d.checks[2].state, PrCheckState::Failing);
        assert_eq!(d.checks[2].duration_ms, None);
        assert_eq!(d.checks[3].state, PrCheckState::Unknown);
        assert_eq!(d.checks[4].name, "unnamed check");
        assert_eq!(
            d.checks[4].state,
            PrCheckState::Unknown,
            "a nameless entry must block, not vanish"
        );
    }

    #[test]
    fn comments_and_reviews_keep_totals_when_capped() {
        let comments: Vec<serde_json::Value> = (0..25)
            .map(|i| json!({"author": {"login": format!("user{i}")}, "body": format!("body {i}")}))
            .collect();
        let reviews: Vec<serde_json::Value> = (0..22)
            .map(|i| json!({"author": {"login": format!("rev{i}")}, "state": "APPROVED", "body": "lgtm"}))
            .collect();
        let (_, d) = detail(json!({
            "number": 5u64, "url": "https://github.com/o/r/pull/5", "state": "OPEN",
            "comments": comments, "reviews": reviews,
        }));
        assert_eq!(d.comments_total, 25);
        assert_eq!(d.reviews_total, 22);
        assert_eq!(d.comments.len(), crate::pull_requests::DETAIL_MAX_COMMENTS);
        assert_eq!(d.reviews.len(), crate::pull_requests::DETAIL_MAX_REVIEWS);
        assert_eq!(d.comments.last().unwrap().author, "user24");
        assert_eq!(d.reviews.last().unwrap().author, "rev21");
    }

    #[test]
    fn an_overlong_comment_body_is_clipped_with_a_marker() {
        let original = crate::pull_requests::DETAIL_BODY_MAX + 10;
        let long = "x".repeat(original);
        let (_, d) = detail(json!({
            "number": 6u64, "url": "https://github.com/o/r/pull/6", "state": "OPEN",
            "comments": [{"author": {"login": "u"}, "body": long}],
        }));
        let body = &d.comments[0].body;
        assert!(body.contains("showing first 4000 of 4010 bytes"), "{body}");
        assert!(body.len() < crate::pull_requests::DETAIL_BODY_MAX + 60);
    }

    fn ctx_fixture() -> LinkContext<'static> {
        LinkContext {
            host: "GitHub",
            source: PullRequestLinkSource::Manual,
            linked_at: 5,
            synced_at: 9,
        }
    }

    #[test]
    fn a_detail_carries_labels_reviewers_auto_merge_and_the_head_owner() {
        let raw = json!({
            "number": 7u64,
            "url": "https://github.com/owner/repo/pull/7",
            "state": "OPEN",
            "headRefName": "feat/x",
            "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "no-color"}],
            "reviewRequests": [{"login": "octo", "slug": null}, {"slug": "core"},
                               {"login": "octo"}],
            "autoMergeRequest": {"mergeMethod": "REBASE"},
            "headRepositoryOwner": {"login": "theo"},
        });
        let (_, d) = detail(raw.clone());
        assert_eq!(d.labels.len(), 2);
        assert_eq!(d.labels[0].name, "bug");
        assert_eq!(d.labels[0].color.as_deref(), Some("d73a4a"));
        assert_eq!(d.labels[1].color, None);
        let ids: Vec<(proto::PrReviewerKind, &str)> = d
            .reviewers
            .iter()
            .map(|r| (r.kind, r.id.as_str()))
            .collect();
        assert_eq!(
            ids,
            vec![
                (proto::PrReviewerKind::User, "octo"),
                (proto::PrReviewerKind::Team, "core"),
            ],
            "a repeated request keeps one row"
        );
        assert_eq!(d.auto_merge_enabled, Some(true));
        assert_eq!(d.auto_merge_method, Some(proto::PrMergeMethod::Rebase));
        assert_eq!(
            cross_repo_head(&raw).map(|h| h.owner),
            None,
            "a same-repository pull request has no fork head"
        );
    }

    #[test]
    fn an_absent_auto_merge_request_is_not_an_answer() {
        let (_, d) = detail(json!({
            "number": 7u64, "url": "https://github.com/owner/repo/pull/7", "state": "OPEN",
        }));
        assert_eq!(
            d.auto_merge_enabled, None,
            "gh without the field says nothing"
        );
        let (_, d) = detail(json!({
            "number": 7u64, "url": "https://github.com/owner/repo/pull/7", "state": "OPEN",
            "autoMergeRequest": null,
        }));
        assert_eq!(
            d.auto_merge_enabled,
            Some(false),
            "a null says none is armed"
        );
        assert_eq!(d.auto_merge_method, None);
    }

    #[test]
    fn a_cross_repo_head_is_only_read_when_it_is_whole() {
        let head = cross_repo_head(&json!({
            "state": "OPEN",
            "isCrossRepository": true,
            "headRefOid": "abc123",
            "headRefName": "feat/x",
            "headRepositoryOwner": {"login": "fork"},
        }))
        .expect("a whole fork head");
        assert_eq!(head.sha, "abc123");
        assert_eq!(head.branch, "feat/x");
        assert_eq!(head.owner, "fork");

        assert!(cross_repo_head(&json!({
            "state": "OPEN", "isCrossRepository": true,
            "headRefOid": "abc123", "headRefName": "feat/x",
        }))
        .is_none());
        assert!(cross_repo_head(&json!({
            "state": "CLOSED", "isCrossRepository": true,
            "headRefOid": "abc123", "headRefName": "feat/x",
            "headRepositoryOwner": {"login": "fork"},
        }))
        .is_none());
        assert!(cross_repo_head(&json!({
            "state": "OPEN", "isCrossRepository": false,
        }))
        .is_none());
    }

    #[test]
    fn reaction_groups_collapse_to_the_nonzero_counts() {
        let groups = json!([
            {"content": "THUMBS_UP", "viewerHasReacted": true, "reactors": {"totalCount": 3}},
            {"content": "HEART", "viewerHasReacted": false, "reactors": {"totalCount": 0}},
            {"content": "SOMETHING_NEW", "viewerHasReacted": true, "reactors": {"totalCount": 4}},
        ]);
        assert_eq!(
            reaction_counts(Some(&groups)),
            vec![proto::PrReactionCount {
                content: proto::PrReaction::ThumbsUp,
                count: 3,
                reacted: true,
            }],
            "an empty group and an unknown content are both dropped"
        );
        assert!(reaction_counts(None).is_empty());
    }

    #[test]
    fn threads_parse_their_anchor_resolution_and_truncation() {
        let (threads, truncated) = threads_from(Some(&json!({
            "totalCount": 1,
            "pageInfo": {"hasNextPage": false},
            "nodes": [{
                "id": "PRT_1", "isResolved": true, "isOutdated": false,
                "path": "src/a.rs", "line": 12,
                "comments": {"totalCount": 2, "pageInfo": {"hasNextPage": false},
                    "nodes": [{"id": "C1", "author": {"login": "rev"}, "body": "one",
                               "createdAt": "2026-09-02T10:00:00Z", "url": null}]},
            }],
        })));
        assert_eq!(threads.len(), 1);
        assert!(threads[0].resolved);
        assert_eq!(threads[0].line, Some(12));
        assert_eq!(threads[0].comments.len(), 1);
        assert!(
            truncated,
            "a thread showing fewer comments than totalCount is truncated"
        );

        let (malformed, _) = threads_from(Some(&json!({
            "totalCount": 1,
            "nodes": [{"no_id": true}],
        })));
        assert!(
            malformed.is_empty(),
            "a nameless thread is skipped, not fatal"
        );
    }

    #[test]
    fn a_list_row_folds_state_checks_and_labels() {
        let items = list_items(&json!([
            {"number": 62, "title": "newer", "url": "https://github.com/o/r/pull/62",
             "author": {"login": "theo"}, "headRefName": "feat/y", "baseRefName": "main",
             "state": "OPEN", "isDraft": true, "reviewDecision": "APPROVED",
             "additions": 1, "deletions": 2, "updatedAt": "2026-09-02T00:00:00Z",
             "labels": [{"name": "bug", "color": "d73a4a"}],
             "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE"}]},
            {"number": 61, "title": "merged", "url": "https://github.com/o/r/pull/61",
             "author": {"login": "rev"}, "headRefName": "feat/x", "baseRefName": "main",
             "state": "CLOSED", "isDraft": false, "mergedAt": "2026-09-01T00:00:00Z",
             "updatedAt": "2026-09-01T00:00:00Z"},
        ]));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].state, PullRequestState::Open);
        assert!(items[0].is_draft);
        assert_eq!(items[0].checks, Some(proto::PrChecks::Failing));
        assert_eq!(items[0].labels[0].name, "bug");
        assert_eq!(items[0].author.as_deref(), Some("theo"));
        assert_eq!(items[1].state, PullRequestState::Merged);
        assert_eq!(
            items[1].checks, None,
            "a row with no rollup carries no verdict"
        );
        assert!(list_items(&json!({"not": "an array"})).is_empty());
    }

    #[test]
    fn a_stack_parses_its_layers_bottom_to_top() {
        let stack = stack_from_json(&json!([{
            "number": 5,
            "node_id": "ST_1",
            "html_url": "https://github.com/o/r/stacks/5",
            "base": {"ref": "main"},
            "pull_requests": [
                {"number": 61, "title": "first", "draft": false,
                 "head": {"sha": "aaa", "ref": "feat/x"}, "state": "open"},
                {"number": 62, "title": "second", "draft": true,
                 "head": {"sha": "bbb", "ref": "feat/y"}, "state": "open"},
                {"number": 60, "head": {"sha": "ccc", "ref": "feat/w"}, "state": "closed",
                 "merged_at": "2026-09-01T00:00:00Z"},
            ],
        }]))
        .unwrap()
        .expect("a stack");
        assert_eq!(stack.id, "ST_1");
        assert_eq!(stack.number, 5);
        assert_eq!(stack.url, "https://github.com/o/r/stacks/5");
        assert_eq!(stack.base, "main");
        assert_eq!(stack.layers.len(), 3);
        assert_eq!(stack.layers[0].number, 61);
        assert_eq!(stack.layers[0].head_sha.as_deref(), Some("aaa"));
        assert!(!stack.layers[0].is_draft);
        assert!(stack.layers[1].is_draft);
        assert_eq!(stack.layers[2].state, PullRequestState::Merged);
        assert!(stack_from_json(&json!([])).unwrap().is_none());
        assert!(stack_from_json(&json!([{"no": "number"}])).is_err());
    }

    #[test]
    fn an_async_merge_status_reads_its_job() {
        let pending = stack_merge_status_of(r#"{"status":"pending","details":{"uuid":"job-1"}}"#)
            .expect("pending");
        assert_eq!(pending.state, "pending");
        assert_eq!(pending.uuid.as_deref(), Some("job-1"));
        let failed = stack_merge_status_of(
            r#"{"status":"failed","details":{"message":"branch protection"}}"#,
        )
        .expect("failed");
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.detail.as_deref(), Some("branch protection"));
        assert!(stack_merge_status_of("not json").is_none());
    }

    #[test]
    fn workflow_runs_map_their_id_and_name() {
        let runs = workflow_runs(&json!([
            {"databaseId": 7u64, "workflowName": "ci", "url": "https://x/run/7"},
            {"workflowName": "nameless"},
        ]));
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, 7);
        assert_eq!(runs[0].name, "ci");
    }
}

//! Bitbucket Cloud pull requests over REST 2.0, read-only: one pull request with
//! its build statuses, approvals, comments and diffstat, mapped onto the same
//! protocol types the GitHub reader fills.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use houston_protocol as proto;
use serde_json::Value;
use zeroize::Zeroizing;

use super::{
    PrCheck, PrCheckState, PrComment, PrDetail, PrMergeState, PrMergeable, PrReview,
    PullRequestLink, PullRequestLinkSource, PullRequestState,
};

pub const API_BASE: &str = "https://api.bitbucket.org/2.0";

/// The host name a link records, which `link_pr`/`unlink_pr` compare on.
pub const HOST: &str = "Bitbucket";

/// Why no write is offered: the adapter only reads.
pub const READ_ONLY_REASON: &str =
    "Houston reads Bitbucket Cloud pull requests but does not change them; comment, review and merge on Bitbucket";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The API's own page maximum, so a capped read costs the fewest requests.
const PAGE_LEN: usize = 100;

/// Up to 300 remarks: past that, the page links to Bitbucket rather than
/// spending the user's hourly request budget on one refresh.
pub const COMMENT_PAGES_MAX: usize = 3;
/// `commit_count` saturates at 500 commits; the header then reads "500 commits".
pub const COMMIT_PAGES_MAX: usize = 5;
/// +/− and the file count cover the first 400 changed files and saturate there,
/// like the commit count.
pub const DIFFSTAT_PAGES_MAX: usize = 4;
/// One page of build statuses: a pull request with more than 100 builds on its
/// head is not one this tab can usefully list anyway.
pub const STATUS_PAGES_MAX: usize = 1;

/// An Atlassian account e-mail and an API token, as Basic credentials.
pub struct Credentials {
    pub email: String,
    pub token: Zeroizing<String>,
}

pub struct BitbucketClient {
    http: reqwest::blocking::Client,
    base: String,
    /// The only origin the Authorization header is sent to.
    base_url: reqwest::Url,
    authorization: Zeroizing<String>,
}

impl BitbucketClient {
    pub fn with_base_url(credentials: &Credentials, base: &str) -> Result<Self> {
        use base64::Engine as _;
        let base_url = reqwest::Url::parse(base)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .ok_or_else(|| {
                anyhow!("building the Bitbucket HTTP client failed: the API base {base:?} is not an absolute http(s) URL")
            })?;
        let http = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("houston/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| anyhow!("building the Bitbucket HTTP client failed: {e}"))?;
        let pair = Zeroizing::new(format!("{}:{}", credentials.email, *credentials.token));
        let encoded = base64::engine::general_purpose::STANDARD.encode(pair.as_bytes());
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            base_url,
            authorization: Zeroizing::new(format!("Basic {encoded}")),
        })
    }

    fn repo_path(workspace: &str, repo: &str) -> Result<String> {
        for (what, slug) in [("workspace", workspace), ("repository", repo)] {
            if !crate::forge::is_slug(slug) {
                bail!("refusing the Bitbucket {what} slug {slug:?}: expected letters, digits, '.', '_' or '-', and not '.' or '..'");
            }
        }
        Ok(format!("/repositories/{workspace}/{repo}"))
    }

    /// One GET; `path` is what errors name, so it never carries the query.
    fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        self.get_url(path, &format!("{}{path}", self.base), query)
    }

    fn get_url(&self, path: &str, url: &str, query: &[(&str, &str)]) -> Result<Value> {
        let mut url = reqwest::Url::parse(url).map_err(|e| {
            anyhow!("the Bitbucket URL for GET {path} does not parse ({e}); expected an absolute http(s) URL")
        })?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let response = self
            .http
            .get(url)
            .header(reqwest::header::AUTHORIZATION, self.authorization.as_str())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|e| {
                anyhow!(
                    "GET {path} on Bitbucket failed before an answer: {}",
                    e.without_url()
                )
            })?;
        let status = response.status();
        if !status.is_success() {
            bail!("{}", status_refusal(status.as_u16(), path));
        }
        response.json::<Value>().map_err(|e| {
            anyhow!(
                "Bitbucket answered GET {path} with a body that is not JSON ({}); expected a REST 2.0 object",
                e.without_url()
            )
        })
    }

    /// Follows `next` up to `max_pages`; the flag says a page was left unread.
    fn get_pages(&self, path: &str, max_pages: usize) -> Result<(Vec<Value>, bool)> {
        let mut values = Vec::new();
        let mut page = self.get(path, &[("pagelen", PAGE_LEN.to_string().as_str())])?;
        for read in 1..=max_pages {
            if let Some(items) = page.get("values").and_then(Value::as_array) {
                values.extend(items.iter().cloned());
            } else {
                bail!("Bitbucket answered GET {path} without a `values` array; expected a paginated list");
            }
            let Some(next) = page.get("next").and_then(Value::as_str).map(str::to_string) else {
                return Ok((values, false));
            };
            if read == max_pages {
                return Ok((values, true));
            }
            let same_origin =
                reqwest::Url::parse(&next).is_ok_and(|u| u.origin() == self.base_url.origin());
            if !same_origin {
                bail!("Bitbucket answered GET {path} with a next page outside {}; refusing to send the token there", self.base_url.origin().ascii_serialization());
            }
            page = self.get_url(path, &next, &[])?;
        }
        Ok((values, true))
    }

    /// The pull request whose source is `branch`: the newest open one, else the
    /// newest in any state. `None` is Bitbucket saying there is none.
    pub fn branch_pull_request(
        &self,
        workspace: &str,
        repo: &str,
        branch: &str,
    ) -> Result<Option<u32>> {
        let path = format!("{}/pullrequests", Self::repo_path(workspace, repo)?);
        let q = format!("source.branch.name=\"{}\"", query_string_literal(branch));
        let page = self.get(
            &path,
            &[
                ("q", q.as_str()),
                ("state", "OPEN"),
                ("state", "MERGED"),
                ("state", "DECLINED"),
                ("state", "SUPERSEDED"),
                ("sort", "-updated_on"),
                ("fields", "values.id,values.state,values.updated_on"),
            ],
        )?;
        let Some(values) = page.get("values").and_then(Value::as_array) else {
            bail!("Bitbucket answered GET {path} without a `values` array; expected a paginated list of pull requests");
        };
        let open = values
            .iter()
            .find(|v| v.get("state").and_then(Value::as_str) == Some("OPEN"));
        Ok(open
            .or_else(|| values.first())
            .and_then(|v| v.get("id"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()))
    }

    /// One pull request whole. The core read must succeed; each follow-up read
    /// that fails becomes a note on the page instead of blanking it.
    pub fn read(
        &self,
        workspace: &str,
        repo: &str,
        number: u32,
        source: PullRequestLinkSource,
        linked_at: u64,
    ) -> Result<(PullRequestLink, PrDetail)> {
        let base = format!(
            "{}/pullrequests/{number}",
            Self::repo_path(workspace, repo)?
        );
        let pr = self.get(&base, &[])?;
        let statuses_path = format!("{base}/statuses");
        let comments_path = format!("{base}/comments");
        let diffstat_path = format!("{base}/diffstat");
        let commits_path = format!("{base}/commits");
        let (statuses, comments, diffstat, commits) = std::thread::scope(|scope| {
            let statuses = scope.spawn(|| self.get_pages(&statuses_path, STATUS_PAGES_MAX));
            let comments = scope.spawn(|| self.get_pages(&comments_path, COMMENT_PAGES_MAX));
            let diffstat = scope.spawn(|| self.get_pages(&diffstat_path, DIFFSTAT_PAGES_MAX));
            let commits = scope.spawn(|| self.get_pages(&commits_path, COMMIT_PAGES_MAX));
            (
                joined(statuses.join(), "build status"),
                joined(comments.join(), "comment"),
                joined(diffstat.join(), "diffstat"),
                joined(commits.join(), "commit"),
            )
        });
        let mut notes = Vec::new();
        let mut note = |what: &str, r: Result<(Vec<Value>, bool)>| match r {
            Ok(pages) => Some(pages),
            Err(e) => {
                notes.push(format!("could not read the {what} of PR #{number}: {e}"));
                None
            }
        };
        let follow_ups = FollowUps {
            statuses: note("builds", statuses).map(|(v, _)| v),
            comments: note("comments", comments),
            diffstat: note("changed files", diffstat).map(|(v, _)| v),
            commits: note("commits", commits).map(|(v, _)| v),
        };
        let ctx = MapContext {
            repository: format!("{workspace}/{repo}"),
            number,
            source,
            linked_at,
            synced_at: super::now_unix(),
        };
        if follow_ups.comments.as_ref().is_some_and(|(_, more)| *more) {
            notes.push(format!(
                "PR #{number} has more than {} comments; Houston read the first {} — open it on Bitbucket for the rest",
                COMMENT_PAGES_MAX * PAGE_LEN,
                COMMENT_PAGES_MAX * PAGE_LEN
            ));
        }
        let (link, mut detail) = map_pull_request(&pr, &follow_ups, &ctx)?;
        if !notes.is_empty() {
            detail.threads_message = Some(notes.join("; "));
        }
        Ok((link, detail))
    }
}

fn joined(
    outcome: std::thread::Result<Result<(Vec<Value>, bool)>>,
    what: &str,
) -> Result<(Vec<Value>, bool)> {
    outcome.unwrap_or_else(|_| Err(anyhow!("the {what} read panicked; refresh")))
}

/// Bitbucket's query language quotes strings with `"` and escapes with `\`.
fn query_string_literal(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The refusal for an HTTP status, naming what the user can do about it.
fn status_refusal(status: u16, path: &str) -> String {
    match status {
        401 | 403 => format!(
            "Bitbucket refused GET {path} with HTTP {status}: the API token needs the read:pullrequest:bitbucket and read:repository:bitbucket scopes, and tokens expire at most one year after creation — create a new one in Atlassian account settings if it lapsed"
        ),
        404 => format!(
            "Bitbucket answered HTTP 404 for GET {path}: check the pull request number, and that the token's account can see the repository"
        ),
        429 => format!(
            "Bitbucket answered HTTP 429 for GET {path}: the limit of 1,000 API requests per hour per user was reached; Houston does not retry, refresh later"
        ),
        other => format!("Bitbucket answered HTTP {other} for GET {path}"),
    }
}

/// The follow-up reads, each `None` when it failed.
struct FollowUps {
    statuses: Option<Vec<Value>>,
    comments: Option<(Vec<Value>, bool)>,
    diffstat: Option<Vec<Value>>,
    commits: Option<Vec<Value>>,
}

struct MapContext {
    repository: String,
    number: u32,
    source: PullRequestLinkSource,
    linked_at: u64,
    synced_at: u64,
}

fn map_pull_request(
    pr: &Value,
    follow: &FollowUps,
    ctx: &MapContext,
) -> Result<(PullRequestLink, PrDetail)> {
    let url = str_at(pr, "/links/html/href").ok_or_else(|| {
        anyhow!(
            "Bitbucket returned PR #{} without links.html.href; expected a pullrequest object",
            ctx.number
        )
    })?;
    let state = match str_at(pr, "/state").as_deref() {
        Some("MERGED") => PullRequestState::Merged,
        Some("DECLINED") | Some("SUPERSEDED") => PullRequestState::Closed,
        _ => PullRequestState::Open,
    };
    let updated_at = time_at(pr, "/updated_on");
    let checks = follow
        .statuses
        .as_deref()
        .map(checks_from)
        .unwrap_or_default();
    let reviews = reviews_from(pr);
    let review_decision = review_decision(&reviews);
    let (additions, deletions, changed_files) = follow
        .diffstat
        .as_deref()
        .map(diffstat_totals)
        .unwrap_or((0, 0, 0));
    let link = PullRequestLink {
        host: HOST.to_string(),
        repository: ctx.repository.clone(),
        number: ctx.number,
        url,
        state,
        source: ctx.source,
        title: str_at(pr, "/title"),
        is_draft: pr.get("draft").and_then(Value::as_bool).unwrap_or(false),
        additions,
        deletions,
        changed_files,
        checks: rollup(&checks),
        review_decision,
        linked_at: ctx.linked_at,
        // REST 2.0 has no merged/closed time; the last update is the nearest fact.
        merged_at: (state == PullRequestState::Merged)
            .then_some(updated_at)
            .flatten(),
        closed_at: (state == PullRequestState::Closed)
            .then_some(updated_at)
            .flatten(),
        synced_at: Some(ctx.synced_at),
    };
    let (comments, comments_total, threads) = match &follow.comments {
        Some((values, truncated)) => {
            let split = discussion(values);
            (split.0, split.1, (split.2, *truncated))
        }
        None => (Vec::new(), 0, (Vec::new(), false)),
    };
    let reviews_total = u32::try_from(reviews.len()).unwrap_or(u32::MAX);
    let detail = PrDetail {
        body: str_at(pr, "/description")
            .or_else(|| str_at(pr, "/summary/raw"))
            .filter(|b| !b.trim().is_empty())
            .map(super::github::clip),
        author: display_name(pr.get("author")),
        base_ref: str_at(pr, "/destination/branch/name"),
        head_ref: str_at(pr, "/source/branch/name"),
        head_sha: str_at(pr, "/source/commit/hash").unwrap_or_default(),
        commit_count: follow
            .commits
            .as_ref()
            .map(|c| u32::try_from(c.len()).unwrap_or(u32::MAX))
            .unwrap_or(0),
        created_at: time_at(pr, "/created_on").unwrap_or(0),
        updated_at: updated_at.unwrap_or(0),
        mergeable: PrMergeable::Unknown,
        merge_state: PrMergeState::Unknown,
        checks,
        comments,
        reviews: reviews
            .into_iter()
            .take(super::DETAIL_MAX_REVIEWS)
            .collect(),
        comments_total,
        reviews_total,
        merge_disabled_reason: Some(READ_ONLY_REASON.to_string()),
        viewer: None,
        viewer_message: None,
        behind_by: None,
        labels: Vec::new(),
        reviewers: Vec::new(),
        reactions: Vec::new(),
        threads: threads.0,
        threads_truncated: threads.1,
        threads_message: None,
        auto_merge_enabled: None,
        auto_merge_method: None,
        cross_repository: false,
    };
    Ok((link, detail))
}

fn str_at(v: &Value, pointer: &str) -> Option<String> {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn time_at(v: &Value, pointer: &str) -> Option<u64> {
    let ms = crate::usage::time::parse_rfc3339_ms(v.pointer(pointer)?.as_str()?)?;
    u64::try_from(ms / 1000).ok()
}

fn display_name(user: Option<&Value>) -> Option<String> {
    let user = user?;
    str_at(user, "/display_name").or_else(|| str_at(user, "/nickname"))
}

fn checks_from(statuses: &[Value]) -> Vec<PrCheck> {
    statuses
        .iter()
        .map(|s| {
            let started = time_at(s, "/created_on");
            let finished = time_at(s, "/updated_on");
            let state = match str_at(s, "/state").as_deref() {
                Some("SUCCESSFUL") => PrCheckState::Passing,
                Some("FAILED") | Some("STOPPED") => PrCheckState::Failing,
                Some("INPROGRESS") => PrCheckState::Running,
                _ => PrCheckState::Unknown,
            };
            let done = matches!(state, PrCheckState::Passing | PrCheckState::Failing);
            PrCheck {
                name: str_at(s, "/name")
                    .or_else(|| str_at(s, "/key"))
                    .unwrap_or_else(|| "unnamed build".to_string()),
                state,
                url: str_at(s, "/url"),
                duration_ms: started
                    .zip(finished)
                    .filter(|_| done)
                    .and_then(|(a, b)| b.checked_sub(a))
                    .map(|secs| secs * 1000),
            }
        })
        .collect()
}

fn rollup(checks: &[PrCheck]) -> Option<proto::PrChecks> {
    if checks.is_empty() {
        return None;
    }
    if checks.iter().any(|c| c.state == PrCheckState::Failing) {
        return Some(proto::PrChecks::Failing);
    }
    if checks.iter().all(|c| c.state == PrCheckState::Passing) {
        return Some(proto::PrChecks::Passing);
    }
    Some(proto::PrChecks::Running)
}

/// Approvals and change requests are participant states, not review objects.
fn reviews_from(pr: &Value) -> Vec<PrReview> {
    let Some(participants) = pr.get("participants").and_then(Value::as_array) else {
        return Vec::new();
    };
    participants
        .iter()
        .filter_map(|p| {
            let state = match str_at(p, "/state").as_deref() {
                Some("changes_requested") => "CHANGES_REQUESTED",
                Some("approved") => "APPROVED",
                _ if p.get("approved").and_then(Value::as_bool) == Some(true) => "APPROVED",
                _ => return None,
            };
            Some(PrReview {
                id: None,
                author: display_name(p.get("user")).unwrap_or_else(|| "unknown".to_string()),
                state: state.to_string(),
                body: String::new(),
                submitted_at: time_at(p, "/participated_on").unwrap_or(0),
                reactions: Vec::new(),
            })
        })
        .collect()
}

fn review_decision(reviews: &[PrReview]) -> Option<String> {
    if reviews.iter().any(|r| r.state == "CHANGES_REQUESTED") {
        Some("CHANGES_REQUESTED".to_string())
    } else if reviews.iter().any(|r| r.state == "APPROVED") {
        Some("APPROVED".to_string())
    } else {
        None
    }
}

fn diffstat_totals(entries: &[Value]) -> (u32, u32, u32) {
    let sum = |key: &str| {
        entries
            .iter()
            .filter_map(|e| e.get(key).and_then(Value::as_u64))
            .fold(0u32, |acc, n| {
                acc.saturating_add(u32::try_from(n).unwrap_or(u32::MAX))
            })
    };
    (
        sum("lines_added"),
        sum("lines_removed"),
        u32::try_from(entries.len()).unwrap_or(u32::MAX),
    )
}

/// General remarks (and replies to them) become comments; a remark anchored to
/// a file, with its replies, becomes one thread. Pending drafts and deleted
/// remarks are not shown.
fn discussion(values: &[Value]) -> (Vec<PrComment>, u32, Vec<proto::PrThread>) {
    let visible: Vec<&Value> = values
        .iter()
        .filter(|c| c.get("pending").and_then(Value::as_bool) != Some(true))
        .collect();
    let by_id: HashMap<u64, &Value> = visible
        .iter()
        .filter_map(|c| Some((c.get("id")?.as_u64()?, *c)))
        .collect();
    let root_of = |c: &Value| -> u64 {
        let mut current = c;
        // A parent chain is a tree; the bound only guards a malformed payload.
        for _ in 0..64 {
            let parent = current.pointer("/parent/id").and_then(Value::as_u64);
            match parent.and_then(|p| by_id.get(&p)) {
                Some(next) => current = next,
                None => break,
            }
        }
        current.get("id").and_then(Value::as_u64).unwrap_or(0)
    };
    let mut general = Vec::new();
    let mut threads: Vec<proto::PrThread> = Vec::new();
    for c in visible.iter().copied() {
        let deleted = c.get("deleted").and_then(Value::as_bool) == Some(true);
        let root_id = root_of(c);
        let root = by_id.get(&root_id).copied().unwrap_or(c);
        let Some(inline) = root.get("inline").filter(|i| !i.is_null()) else {
            if !deleted {
                general.push(comment_of(c));
            }
            continue;
        };
        let index = match threads.iter().position(|t| t.id == root_id.to_string()) {
            Some(i) => i,
            None => {
                threads.push(proto::PrThread {
                    id: root_id.to_string(),
                    path: str_at(inline, "/path"),
                    line: inline
                        .get("to")
                        .and_then(Value::as_u64)
                        .or_else(|| inline.get("from").and_then(Value::as_u64))
                        .and_then(|n| u32::try_from(n).ok()),
                    resolved: root.get("resolution").is_some_and(|r| !r.is_null()),
                    outdated: false,
                    comments: Vec::new(),
                });
                threads.len() - 1
            }
        };
        if !deleted {
            let remark = comment_of(c);
            threads[index].comments.push(proto::PrThreadComment {
                id: c
                    .get("id")
                    .and_then(Value::as_u64)
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
                author: remark.author,
                body: remark.body,
                created_at: remark.created_at,
                url: remark.url,
                reactions: Vec::new(),
            });
        }
    }
    threads.retain(|t| !t.comments.is_empty());
    let total = u32::try_from(general.len()).unwrap_or(u32::MAX);
    let start = general.len().saturating_sub(super::DETAIL_MAX_COMMENTS);
    (general.split_off(start), total, threads)
}

fn comment_of(c: &Value) -> PrComment {
    PrComment {
        id: c.get("id").and_then(Value::as_u64).map(|n| n.to_string()),
        author: display_name(c.get("user")).unwrap_or_else(|| "unknown".to_string()),
        body: super::github::clip(str_at(c, "/content/raw").unwrap_or_default()),
        created_at: time_at(c, "/created_on").unwrap_or(0),
        url: str_at(c, "/links/html/href"),
        reactions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{OriginalUri, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use std::sync::{Arc, Mutex};

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../../tests/fixtures/bitbucket/", $name))
        };
    }

    const EMAIL: &str = "me@example.com";
    const TOKEN: &str = "ATATT-secret-token";
    const PR: &str = "/repositories/ws/repo/pullrequests/7";

    #[derive(Clone)]
    enum Reply {
        Json(&'static str),
        Status(u16),
        Redirect(&'static str),
    }

    /// Each request's path and query, with the Authorization header it carried.
    type Seen = Vec<(String, Option<String>)>;

    #[derive(Clone, Default)]
    struct Fixture {
        routes: Arc<Mutex<HashMap<String, Reply>>>,
        seen: Arc<Mutex<Seen>>,
        base: Arc<Mutex<String>>,
    }

    impl Fixture {
        fn route(&self, path: &str, reply: Reply) {
            self.routes.lock().unwrap().insert(path.to_string(), reply);
        }
        fn requests(&self) -> Seen {
            self.seen.lock().unwrap().clone()
        }
        fn count(&self, path: &str) -> usize {
            self.requests()
                .iter()
                .filter(|(p, _)| p.split('?').next() == Some(path))
                .count()
        }
    }

    async fn serve(
        State(fx): State<Fixture>,
        OriginalUri(uri): OriginalUri,
        headers: HeaderMap,
    ) -> Response {
        let auth = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let path_and_query = uri
            .path_and_query()
            .map(|p| p.to_string())
            .unwrap_or_default();
        fx.seen.lock().unwrap().push((path_and_query, auth));
        let reply = fx.routes.lock().unwrap().get(uri.path()).cloned();
        let base = fx.base.lock().unwrap().clone();
        match reply {
            Some(Reply::Json(body)) => (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                body.replace("{base}", &base),
            )
                .into_response(),
            Some(Reply::Status(code)) => StatusCode::from_u16(code).unwrap().into_response(),
            Some(Reply::Redirect(to)) => (
                StatusCode::FOUND,
                [(axum::http::header::LOCATION, format!("{base}{to}"))],
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    fn start(fx: &Fixture) -> String {
        let (tx, rx) = std::sync::mpsc::channel();
        let state = fx.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async move {
                let app = axum::Router::new().fallback(serve).with_state(state);
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                tx.send(format!("http://{addr}")).unwrap();
                axum::serve(listener, app).await.unwrap();
            });
        });
        let base = rx.recv().unwrap();
        *fx.base.lock().unwrap() = base.clone();
        base
    }

    fn client(base: &str) -> BitbucketClient {
        BitbucketClient::with_base_url(
            &Credentials {
                email: EMAIL.to_string(),
                token: Zeroizing::new(TOKEN.to_string()),
            },
            base,
        )
        .unwrap()
    }

    fn full_fixture() -> (Fixture, String) {
        let fx = Fixture::default();
        fx.route(PR, Reply::Json(fixture!("pullrequest.json")));
        fx.route(
            &format!("{PR}/statuses"),
            Reply::Json(fixture!("statuses.json")),
        );
        fx.route(
            &format!("{PR}/comments"),
            Reply::Json(fixture!("comments.json")),
        );
        fx.route(
            &format!("{PR}/diffstat"),
            Reply::Redirect("/repositories/ws/repo/diffstat/ws/repo:0123456789ab%0Dfedcba987654"),
        );
        fx.route(
            "/repositories/ws/repo/diffstat/ws/repo:0123456789ab%0Dfedcba987654",
            Reply::Json(fixture!("diffstat.json")),
        );
        fx.route(
            &format!("{PR}/commits"),
            Reply::Json(fixture!("commits.json")),
        );
        let base = start(&fx);
        (fx, base)
    }

    fn read(base: &str) -> Result<(PullRequestLink, PrDetail)> {
        client(base).read("ws", "repo", 7, PullRequestLinkSource::Detected, 5)
    }

    #[test]
    fn a_pull_request_maps_onto_the_tabs_types() {
        let (fx, base) = full_fixture();
        let (link, detail) = read(&base).unwrap();

        assert_eq!(link.host, "Bitbucket");
        assert_eq!(link.repository, "ws/repo");
        assert_eq!(link.number, 7);
        assert_eq!(link.url, "https://bitbucket.org/ws/repo/pull-requests/7");
        assert_eq!(link.state, PullRequestState::Open);
        assert!(link.is_draft);
        assert_eq!(link.title.as_deref(), Some("Add the read-only adapter"));
        assert_eq!(
            (link.additions, link.deletions, link.changed_files),
            (40, 4, 2)
        );
        assert_eq!(link.checks, Some(proto::PrChecks::Failing));
        assert_eq!(link.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(link.linked_at, 5);

        assert_eq!(detail.author.as_deref(), Some("Ana Author"));
        assert_eq!(detail.base_ref.as_deref(), Some("main"));
        assert_eq!(detail.head_ref.as_deref(), Some("feat/reader"));
        assert_eq!(detail.head_sha, "0123456789ab");
        assert_eq!(detail.commit_count, 2);
        assert_eq!(detail.mergeable, PrMergeable::Unknown);
        assert_eq!(detail.merge_state, PrMergeState::Unknown);
        assert!(detail.viewer.is_none());
        assert_eq!(
            detail.merge_disabled_reason.as_deref(),
            Some(READ_ONLY_REASON)
        );
        assert_eq!(detail.threads_message, None);

        let states: Vec<_> = detail
            .checks
            .iter()
            .map(|c| (c.name.as_str(), c.state))
            .collect();
        assert_eq!(
            states,
            vec![
                ("Pipeline #41 for feat/reader", PrCheckState::Passing),
                ("lint", PrCheckState::Failing),
                ("e2e", PrCheckState::Running),
            ]
        );
        assert_eq!(detail.checks[0].duration_ms, Some(120_000));
        assert_eq!(
            detail.checks[2].duration_ms, None,
            "a running build has no duration"
        );

        let reviews: Vec<_> = detail
            .reviews
            .iter()
            .map(|r| (r.author.as_str(), r.state.as_str()))
            .collect();
        assert_eq!(
            reviews,
            vec![
                ("Rui Reviewer", "APPROVED"),
                ("Cris Critic", "CHANGES_REQUESTED")
            ]
        );

        let bodies: Vec<_> = detail.comments.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(
            bodies,
            vec!["Looks close."],
            "deleted and pending remarks are not shown"
        );
        assert_eq!(detail.comments_total, 1);

        assert_eq!(detail.threads.len(), 2);
        let rename = &detail.threads[0];
        assert_eq!(rename.id, "102");
        assert_eq!(rename.path.as_deref(), Some("src/reader.rs"));
        assert_eq!(rename.line, Some(42));
        assert!(rename.resolved);
        let replies: Vec<_> = rename.comments.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(replies, vec!["Rename this?", "Done."]);
        let old = &detail.threads[1];
        assert_eq!(old.line, Some(3), "a removed line anchors on `from`");
        assert!(!old.resolved);

        assert_eq!(
            fx.count("/repositories/ws/repo/diffstat/ws/repo:0123456789ab%0Dfedcba987654"),
            1,
            "the diffstat redirect is followed"
        );
        for (path, auth) in fx.requests() {
            use base64::Engine as _;
            let expected = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{EMAIL}:{TOKEN}"))
            );
            assert_eq!(auth.as_deref(), Some(expected.as_str()), "{path}");
        }
    }

    #[test]
    fn states_map_declined_and_superseded_to_closed() {
        let mut pr: Value = serde_json::from_str(fixture!("pullrequest.json")).unwrap();
        let none = FollowUps {
            statuses: None,
            comments: None,
            diffstat: None,
            commits: None,
        };
        let ctx = MapContext {
            repository: "ws/repo".into(),
            number: 7,
            source: PullRequestLinkSource::Manual,
            linked_at: 1,
            synced_at: 2,
        };
        for (raw, want) in [
            ("MERGED", PullRequestState::Merged),
            ("DECLINED", PullRequestState::Closed),
            ("SUPERSEDED", PullRequestState::Closed),
            ("OPEN", PullRequestState::Open),
        ] {
            pr["state"] = Value::from(raw);
            let (link, _) = map_pull_request(&pr, &none, &ctx).unwrap();
            assert_eq!(link.state, want, "{raw}");
            assert_eq!(link.merged_at.is_some(), want == PullRequestState::Merged);
            assert_eq!(link.closed_at.is_some(), want == PullRequestState::Closed);
        }
        pr["participants"] = serde_json::json!([]);
        pr["description"] = Value::from("x".repeat(super::super::DETAIL_BODY_MAX + 10));
        let (link, detail) = map_pull_request(&pr, &none, &ctx).unwrap();
        assert_eq!(link.review_decision, None);
        assert_eq!(link.checks, None, "no statuses is no rollup");
        assert!(detail
            .body
            .unwrap()
            .contains("[truncated: showing first 4000"));
    }

    #[test]
    fn a_failed_follow_up_read_is_a_note_not_a_blank_page() {
        let fx = Fixture::default();
        fx.route(PR, Reply::Json(fixture!("pullrequest.json")));
        fx.route(&format!("{PR}/statuses"), Reply::Status(500));
        fx.route(
            &format!("{PR}/comments"),
            Reply::Json(fixture!("comments.json")),
        );
        fx.route(
            &format!("{PR}/diffstat"),
            Reply::Json(fixture!("diffstat.json")),
        );
        fx.route(
            &format!("{PR}/commits"),
            Reply::Json(fixture!("commits.json")),
        );
        let base = start(&fx);
        let (link, detail) = read(&base).unwrap();
        assert_eq!(link.number, 7);
        assert!(detail.checks.is_empty());
        let note = detail.threads_message.unwrap();
        assert!(
            note.contains("could not read the builds of PR #7"),
            "{note}"
        );
        assert!(note.contains("HTTP 500"), "{note}");
        assert_eq!(detail.threads.len(), 2, "the comments still arrived");
    }

    #[test]
    fn pagination_stops_at_the_named_cap() {
        let fx = Fixture::default();
        fx.route(PR, Reply::Json(fixture!("pullrequest.json")));
        let endless = r#"{"values": [{"id": 1, "content": {"raw": "again"}, "user": {"display_name": "Rui"}, "created_on": "2026-10-01T09:00:00+00:00"}], "next": "{base}/repositories/ws/repo/pullrequests/7/comments?page=next"}"#;
        fx.route(&format!("{PR}/comments"), Reply::Json(endless));
        fx.route(
            &format!("{PR}/statuses"),
            Reply::Json(fixture!("empty_page.json")),
        );
        fx.route(
            &format!("{PR}/diffstat"),
            Reply::Json(fixture!("empty_page.json")),
        );
        let commits = r#"{"values": [{"hash": "a"}], "next": "{base}/repositories/ws/repo/pullrequests/7/commits?page=next"}"#;
        fx.route(&format!("{PR}/commits"), Reply::Json(commits));
        let base = start(&fx);
        let (_, detail) = read(&base).unwrap();
        assert_eq!(fx.count(&format!("{PR}/comments")), COMMENT_PAGES_MAX);
        assert_eq!(fx.count(&format!("{PR}/commits")), COMMIT_PAGES_MAX);
        assert_eq!(detail.commit_count, 5, "the count saturates at the cap");
        assert_eq!(detail.comments_total, 3);
        let note = detail.threads_message.unwrap_or_default();
        assert!(note.contains("more than 300 comments"), "{note}");
        let requests = fx.requests();
        let first = &requests
            .iter()
            .find(|(p, _)| p.starts_with(&format!("{PR}/comments")))
            .unwrap()
            .0;
        assert!(first.contains("pagelen=100"), "{first}");
    }

    #[test]
    fn a_next_page_on_another_origin_is_never_sent_the_token() {
        let elsewhere = Fixture::default();
        let other = start(&elsewhere);
        let fx = Fixture::default();
        fx.route(PR, Reply::Json(fixture!("pullrequest.json")));
        let off_origin: &'static str = Box::leak(
            format!(r#"{{"values": [], "next": "{other}/repositories/ws/repo/pullrequests/7/comments?page=2"}}"#)
                .into_boxed_str(),
        );
        fx.route(&format!("{PR}/comments"), Reply::Json(off_origin));
        for follow_up in ["statuses", "diffstat", "commits"] {
            fx.route(
                &format!("{PR}/{follow_up}"),
                Reply::Json(fixture!("empty_page.json")),
            );
        }
        let base = start(&fx);
        let (_, detail) = read(&base).unwrap();
        let note = detail.threads_message.unwrap_or_default();
        assert!(note.contains("refusing to send the token there"), "{note}");
        assert!(!note.contains(TOKEN) && !note.contains("Basic"), "{note}");
        assert!(
            elsewhere.requests().is_empty(),
            "the other origin was asked"
        );
    }

    #[test]
    fn a_slug_that_could_leave_the_repository_path_is_refused_before_a_request() {
        let fx = Fixture::default();
        let base = start(&fx);
        for (workspace, repo) in [("..", "repo"), ("ws", "a/b"), ("ws", ".")] {
            let err = client(&base)
                .read(workspace, repo, 7, PullRequestLinkSource::Detected, 5)
                .unwrap_err()
                .to_string();
            assert!(err.contains("slug"), "{err}");
        }
        assert!(fx.requests().is_empty());
    }

    #[test]
    fn a_thread_whose_remarks_are_all_deleted_is_not_shown() {
        let values: Vec<Value> = serde_json::from_str(
            r#"[{"id": 1, "deleted": true, "inline": {"path": "a.rs", "to": 1}, "content": {"raw": ""}}]"#,
        )
        .unwrap();
        let (_, _, threads) = discussion(&values);
        assert!(threads.is_empty(), "{threads:?}");
    }

    #[test]
    fn the_branch_read_prefers_the_open_pull_request_and_quotes_the_branch() {
        let fx = Fixture::default();
        fx.route(
            "/repositories/ws/repo/pullrequests",
            Reply::Json(fixture!("branch_pullrequests.json")),
        );
        let base = start(&fx);
        let found = client(&base)
            .branch_pull_request("ws", "repo", "feat/\"odd\"")
            .unwrap();
        assert_eq!(found, Some(7));
        let (query, _) = fx.requests().remove(0);
        assert!(query.contains("state=OPEN"), "{query}");
        assert!(query.contains("state=SUPERSEDED"), "{query}");
        assert!(query.contains("sort=-updated_on"), "{query}");
        let decoded = query
            .replace("%22", "\"")
            .replace("%5C", "\\")
            .replace("%2F", "/")
            .replace("%3D", "=");
        assert!(
            decoded.contains(r#"source.branch.name="feat/\"odd\"""#),
            "{decoded}"
        );

        let empty = Fixture::default();
        empty.route(
            "/repositories/ws/repo/pullrequests",
            Reply::Json(fixture!("empty_page.json")),
        );
        let base = start(&empty);
        assert_eq!(
            client(&base)
                .branch_pull_request("ws", "repo", "x")
                .unwrap(),
            None
        );
    }

    #[test]
    fn each_http_refusal_is_named_and_never_carries_the_credentials() {
        for (status, needle) in [
            (401, "read:pullrequest:bitbucket"),
            (403, "one year"),
            (404, "HTTP 404"),
            (429, "1,000 API requests per hour per user"),
        ] {
            let fx = Fixture::default();
            fx.route(PR, Reply::Status(status));
            let base = start(&fx);
            let err = read(&base).unwrap_err().to_string();
            assert!(err.contains(needle), "{status}: {err}");
            assert!(err.contains(PR), "the endpoint is named: {err}");
            assert!(!err.contains(TOKEN), "{err}");
            assert!(!err.contains(EMAIL), "{err}");
            assert!(!err.contains("Basic"), "{err}");
            assert_eq!(fx.count(PR), 1, "{status} is not retried");
        }
    }
}

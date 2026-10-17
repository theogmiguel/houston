//! The phone client's routes beyond a pane's screen, feed and input: reads at
//! every tier, and pane lifecycle and git actions at `manage`. Each handler
//! authorizes its `Route`, then calls the daemon function the desktop uses.
use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use houston_protocol as proto;
use serde::Deserialize;
use serde_json::{json, Value};

use super::http::{authorize, blocking, error, Peer, Refused, Route};
use super::{ApiError, BODY_LIMIT, USAGE_WAIT};
use crate::daemon::{Daemon, RemoteSpawn};

pub(super) fn routes() -> Router<Arc<Daemon>> {
    Router::new()
        .route("/api/sessions/{id}/changes", get(changes))
        .route("/api/sessions/{id}/diff", get(diff))
        .route("/api/sessions/{id}/pr", get(pr))
        .route("/api/workspaces", get(workspaces))
        .route("/api/workspaces/prs", get(workspace_prs))
        .route("/api/tasks", get(tasks))
        .route("/api/usage", get(usage))
        .route("/api/spawn-options", get(spawn_options))
        .route("/api/sessions", post(spawn))
        .route("/api/sessions/{id}/rename", post(rename))
        .route("/api/sessions/{id}/respawn", post(respawn))
        .route("/api/sessions/{id}/sleep", post(sleep))
        .route("/api/sessions/{id}/wake", post(wake))
        .route("/api/sessions/{id}/close", post(close))
        .route("/api/sessions/{id}/commit", post(commit))
        .route("/api/sessions/{id}/push", post(push))
}

/// Header on a list reply the daemon cut at its cap; the value is the cap.
const TRUNCATED_HEADER: &str = "x-houston-truncated";

async fn read<T: Send + 'static>(
    daemon: Arc<Daemon>,
    headers: HeaderMap,
    peer: Peer,
    route: Route,
    call: impl FnOnce(&Daemon) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, Refused> {
    blocking(move || {
        authorize(&daemon, &headers, peer.0.ip(), route)?;
        call(&daemon).map_err(Refused::from)
    })
    .await
}

fn json_reply(result: Result<Value, Refused>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(refused) => refused.into_response(),
    }
}

fn list_reply(result: Result<(Value, bool), Refused>, limit: usize) -> Response {
    match result {
        Ok((items, truncated)) => {
            let mut resp = Json(items).into_response();
            if truncated {
                if let Ok(v) = axum::http::HeaderValue::from_str(&limit.to_string()) {
                    resp.headers_mut().insert(TRUNCATED_HEADER, v);
                }
            }
            resp
        }
        Err(refused) => refused.into_response(),
    }
}

async fn changes(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Read("GET /api/sessions/{id}/changes");
    json_reply(read(daemon, headers, peer, route, move |d| d.remote_changes(id)).await)
}

#[derive(Deserialize)]
struct DiffQuery {
    path: String,
}

async fn diff(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    query: Result<Query<DiffQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return error(
            StatusCode::BAD_REQUEST,
            "query is not valid: expected ?path=<a path listed by /changes>",
        );
    };
    let route = Route::Read("GET /api/sessions/{id}/diff");
    json_reply(
        read(daemon, headers, peer, route, move |d| {
            d.remote_diff(id, &query.path)
        })
        .await,
    )
}

async fn pr(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Read("GET /api/sessions/{id}/pr");
    json_reply(read(daemon, headers, peer, route, move |d| d.remote_pr(id)).await)
}

async fn workspaces(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Read("GET /api/workspaces");
    json_reply(read(daemon, headers, peer, route, |d| d.remote_workspaces()).await)
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

async fn workspace_prs(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return error(
            StatusCode::BAD_REQUEST,
            "query is not valid: expected ?path=<a workspace path from /api/workspaces>",
        );
    };
    let route = Route::Read("GET /api/workspaces/prs");
    list_reply(
        read(daemon, headers, peer, route, move |d| {
            d.remote_workspace_prs(&query.path)
        })
        .await,
        super::PR_LIST_MAX as usize,
    )
}

#[derive(Deserialize)]
struct TasksQuery {
    workspace: String,
}

async fn tasks(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
    query: Result<Query<TasksQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return error(
            StatusCode::BAD_REQUEST,
            "query is not valid: expected ?workspace=<a workspace path from /api/workspaces>",
        );
    };
    let route = Route::Read("GET /api/tasks");
    list_reply(
        read(daemon, headers, peer, route, move |d| {
            d.remote_tasks(&query.workspace)
        })
        .await,
        super::TASKS_MAX,
    )
}

/// Today's usage from the cache. A cold or stale cache recomputes for at most
/// `USAGE_WAIT`, then answers with what it holds, marked `stale`.
async fn usage(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Read("GET /api/usage");
    let held = read(Arc::clone(&daemon), headers, peer, route, |d| {
        Ok(d.remote_usage_cached())
    })
    .await;
    let held = match held {
        Ok(held) => held,
        Err(refused) => return refused.into_response(),
    };
    if let Some(value) = held.filter(|v| v["stale"] == Value::Bool(false)) {
        return Json(value).into_response();
    }
    let refresh = {
        let daemon = Arc::clone(&daemon);
        tokio::task::spawn_blocking(move || daemon.remote_usage_refresh())
    };
    // Past the wait the blocking scan keeps running and fills the cache for the next request.
    let _ = tokio::time::timeout(USAGE_WAIT, refresh).await;
    match daemon.remote_usage_cached() {
        Some(value) => Json(value).into_response(),
        None => Json(json!({
            "today": { "cost_usd": 0, "by_provider": [] },
            "limits": [],
            "stale": true,
        }))
        .into_response(),
    }
}

async fn spawn_options(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Read("GET /api/spawn-options");
    json_reply(read(daemon, headers, peer, route, |d| d.remote_spawn_options()).await)
}

fn body_refusal(what: &str, shape: &str, rej: &JsonRejection) -> Response {
    error(
        rej.status(),
        format!(
            "{what} body is not valid ({}): expected JSON {shape} within {BODY_LIMIT} bytes",
            rej.body_text()
        ),
    )
}

/// Runs a manage-tier action on `pane` (none for opening one), then records it in
/// the activity feed under the device's name. The title is read first, since a
/// closed pane has none left.
async fn manage(
    daemon: Arc<Daemon>,
    headers: HeaderMap,
    peer: Peer,
    route: Route,
    action: &'static str,
    pane: Option<u32>,
    call: impl FnOnce(&Arc<Daemon>) -> Result<(Option<u32>, Value), ApiError> + Send + 'static,
) -> Response {
    let result = blocking(move || {
        let device = authorize(&daemon, &headers, peer.0.ip(), route)?;
        let before = pane.map(|id| (id, daemon.remote_pane_title(id)));
        let (opened, reply) = call(&daemon).map_err(Refused::from)?;
        match (before, opened) {
            (Some((id, title)), _) => daemon.remote_record_action(id, action, &device.name, title),
            (None, Some(id)) => {
                let title = daemon.remote_pane_title(id);
                daemon.remote_record_action(id, action, &device.name, title)
            }
            (None, None) => {}
        }
        Ok(reply)
    })
    .await;
    json_reply(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnBody {
    kind: String,
    workspace: String,
    model: Option<String>,
    effort: Option<String>,
    profile: Option<u32>,
    worktree: Option<String>,
    prompt: Option<String>,
    /// Never honoured; present only so the refusal can name it.
    auto_approve: Option<Value>,
}

const SPAWN_SHAPE: &str = "{\"kind\": string, \"workspace\": string, \"model\"?: string, \
     \"effort\"?: string, \"profile\"?: number, \"worktree\"?: string, \"prompt\"?: string}";

async fn spawn(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    headers: HeaderMap,
    body: Result<Json<SpawnBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => return body_refusal("open-pane", SPAWN_SHAPE, &rej),
    };
    let route = Route::Manage("POST /api/sessions");
    manage(daemon, headers, peer, route, "spawn", None, move |d| {
        if body.auto_approve.is_some() {
            return Err(ApiError::Forbidden(
                "auto_approve is never accepted from a device: a pane opened here asks before \
                 it acts; turn auto-approve on from the computer"
                    .to_string(),
            ));
        }
        let kind = serde_json::from_value::<proto::AgentKind>(Value::String(body.kind.clone()))
            .map_err(|_| {
                ApiError::BadRequest(format!(
                    "kind {:?} is not a provider: expected one of claude, codex, antigravity, \
                     opencode, zcode",
                    body.kind
                ))
            })?;
        let effort = body
            .effort
            .as_ref()
            .map(|raw| {
                serde_json::from_value::<proto::ChatEffort>(Value::String(raw.clone())).map_err(
                    |_| {
                        ApiError::BadRequest(format!(
                            "effort {raw:?} is not an effort level: expected one of low, medium, \
                             high, xhigh, max, or null"
                        ))
                    },
                )
            })
            .transpose()?;
        let id = d.remote_spawn(RemoteSpawn {
            kind,
            workspace: body.workspace,
            model: body.model,
            effort,
            profile: body.profile,
            worktree: body.worktree,
            prompt: body.prompt,
        })?;
        Ok((Some(id), json!({ "id": id })))
    })
    .await
}

#[derive(Deserialize)]
struct RenameBody {
    title: String,
}

async fn rename(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    body: Result<Json<RenameBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => return body_refusal("rename", "{\"title\": string}", &rej),
    };
    let route = Route::Manage("POST /api/sessions/{id}/rename");
    manage(daemon, headers, peer, route, "rename", Some(id), move |d| {
        d.remote_rename(id, &body.title)?;
        Ok((None, json!({ "ok": true })))
    })
    .await
}

macro_rules! lifecycle {
    ($name:ident, $label:literal, $action:literal, $call:ident) => {
        async fn $name(
            State(daemon): State<Arc<Daemon>>,
            ConnectInfo(peer): ConnectInfo<Peer>,
            Path(id): Path<u32>,
            headers: HeaderMap,
        ) -> Response {
            let route = Route::Manage(concat!("POST /api/sessions/{id}/", $label));
            manage(daemon, headers, peer, route, $action, Some(id), move |d| {
                d.$call(id)?;
                Ok((None, json!({ "ok": true })))
            })
            .await
        }
    };
}

lifecycle!(respawn, "respawn", "respawn", remote_respawn);
lifecycle!(sleep, "sleep", "sleep", remote_sleep);
lifecycle!(wake, "wake", "wake", remote_wake);

#[derive(Deserialize)]
struct CloseBody {
    confirm: String,
}

async fn close(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    body: Result<Json<CloseBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => {
            return body_refusal(
                "close",
                "{\"confirm\": \"<the pane id as a string>\"}",
                &rej,
            )
        }
    };
    let route = Route::Manage("POST /api/sessions/{id}/close");
    manage(daemon, headers, peer, route, "close", Some(id), move |d| {
        d.remote_close(id, &body.confirm)?;
        Ok((None, json!({ "ok": true })))
    })
    .await
}

#[derive(Deserialize)]
struct CommitBody {
    message: String,
    paths: Option<Vec<String>>,
}

async fn commit(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    body: Result<Json<CommitBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => {
            return body_refusal(
                "commit",
                "{\"message\": string, \"paths\"?: string[] | null}",
                &rej,
            )
        }
    };
    let route = Route::Manage("POST /api/sessions/{id}/commit");
    manage(daemon, headers, peer, route, "commit", Some(id), move |d| {
        let done = d.remote_commit(id, &body.message, body.paths.as_deref())?;
        Ok((None, done))
    })
    .await
}

async fn push(
    State(daemon): State<Arc<Daemon>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Path(id): Path<u32>,
    headers: HeaderMap,
) -> Response {
    let route = Route::Manage("POST /api/sessions/{id}/push");
    manage(daemon, headers, peer, route, "push", Some(id), move |d| {
        let done = d.remote_git_push(id)?;
        Ok((None, done))
    })
    .await
}

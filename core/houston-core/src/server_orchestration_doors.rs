use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use houston_protocol as proto;
use serde_json::Value;

use super::{orch_err_response, orch_error, orch_scope};
use crate::daemon::Daemon;
use crate::orchestrate::doors::{self, InstructionSession, InstructionTarget};

fn invalid_payload(operation: &str, expected: &str, error: impl std::fmt::Display) -> Response {
    orch_error(
        StatusCode::BAD_REQUEST,
        anyhow::anyhow!("{operation} payload: expected {expected}; {error}"),
    )
}

async fn outcome(task: tokio::task::JoinHandle<anyhow::Result<Value>>) -> Response {
    match task.await {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(error)) => orch_err_response(error),
        Err(error) => orch_err_response(anyhow::anyhow!("orchestration worker failed: {error}")),
    }
}

pub(super) async fn deny(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Json<doors::DenyTarget>, JsonRejection>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let Json(request) = match payload {
        Ok(request) => request,
        Err(error) => {
            return invalid_payload(
                "deny",
                "{child: positive integer, episode_id: 1–64 ASCII letters, digits, colons, underscores or hyphens}",
                error.body_text(),
            )
        }
    };
    if let Err(error) = doors::session_id(request.child)
        .map_err(|error| error.replace("session", "child"))
        .and_then(|()| doors::episode_id(&request.episode_id))
    {
        return invalid_payload("deny", "a valid child and input episode id", error);
    }
    let request = proto::PaneDenyRequest {
        child: request.child,
        episode_id: request.episode_id,
    };
    outcome(tokio::task::spawn_blocking(move || {
        daemon.orchestrate_deny(scope.session_id, request)
    }))
    .await
}

pub(super) async fn escalate(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Json<proto::PaneEscalateRequest>, JsonRejection>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let Json(request) = match payload {
        Ok(request) => request,
        Err(error) => {
            return invalid_payload(
                "escalate",
                "{child: positive integer, reason: nonblank text up to 2000 characters}",
                error.body_text(),
            )
        }
    };
    if let Err(error) = doors::session_id(request.child)
        .map_err(|error| error.replace("session", "child"))
        .and_then(|()| doors::escalation_reason(&request.reason))
    {
        return invalid_payload("escalate", "a valid child and reason", error);
    }
    outcome(tokio::task::spawn_blocking(move || {
        daemon.orchestrate_escalate(scope.session_id, request)
    }))
    .await
}

pub(super) async fn instruction_list(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Query<InstructionSession>, QueryRejection>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let Query(request) = match payload {
        Ok(request) => request,
        Err(error) => {
            return invalid_payload(
                "instruction-list query",
                "session=POSITIVE_INTEGER",
                error.body_text(),
            )
        }
    };
    if let Err(error) = doors::session_id(request.session) {
        return invalid_payload("instruction-list", "a positive session id", error);
    }
    outcome(tokio::task::spawn_blocking(move || {
        Ok(serde_json::to_value(daemon.instruction_queue(
            Some(scope.session_id),
            request.session,
        )?)?)
    }))
    .await
}

pub(super) async fn instruction_get(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Query<InstructionTarget>, QueryRejection>,
) -> Response {
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let Query(request) = match payload {
        Ok(request) => request,
        Err(error) => {
            return invalid_payload(
                "instruction-get query",
                "session=POSITIVE_INTEGER&instruction_id=OPAQUE_ID",
                error.body_text(),
            )
        }
    };
    if let Err(error) = validate_target(&request) {
        return invalid_payload("instruction-get", "a valid instruction target", error);
    }
    outcome(tokio::task::spawn_blocking(move || {
        Ok(serde_json::to_value(daemon.instruction_get(
            Some(scope.session_id),
            request.session,
            &request.instruction_id,
        )?)?)
    }))
    .await
}

fn validate_target(request: &InstructionTarget) -> Result<(), String> {
    doors::session_id(request.session)?;
    doors::instruction_id(&request.instruction_id)
}

async fn instruction_control(
    daemon: Arc<Daemon>,
    headers: HeaderMap,
    payload: Result<Json<InstructionTarget>, JsonRejection>,
    resume: bool,
) -> Response {
    let operation = if resume {
        "instruction-resume"
    } else {
        "instruction-cancel"
    };
    let scope = match orch_scope(&daemon, &headers) {
        Ok(scope) => scope,
        Err(response) => return *response,
    };
    let Json(request) = match payload {
        Ok(request) => request,
        Err(error) => {
            return invalid_payload(
                operation,
                "{session: positive integer, instruction_id: opaque id}",
                error.body_text(),
            )
        }
    };
    if let Err(error) = validate_target(&request) {
        return invalid_payload(operation, "a valid instruction target", error);
    }
    outcome(tokio::task::spawn_blocking(move || {
        let snapshot = if resume {
            daemon.instruction_resume(
                Some(scope.session_id),
                request.session,
                &request.instruction_id,
            )?
        } else {
            daemon.instruction_cancel(
                Some(scope.session_id),
                request.session,
                &request.instruction_id,
            )?
        };
        Ok(serde_json::to_value(snapshot)?)
    }))
    .await
}

pub(super) async fn instruction_cancel(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Json<InstructionTarget>, JsonRejection>,
) -> Response {
    instruction_control(daemon, headers, payload, false).await
}

pub(super) async fn instruction_resume(
    State(daemon): State<Arc<Daemon>>,
    headers: HeaderMap,
    payload: Result<Json<InstructionTarget>, JsonRejection>,
) -> Response {
    instruction_control(daemon, headers, payload, true).await
}

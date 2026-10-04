//! The remote listener's router: the embedded web client and `/api/*`. Every
//! request passes the Host check; state-changing requests also pass the Origin
//! check; API calls other than pairing need a paired device's bearer token.
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{ApiError, BODY_LIMIT, SCREEN_LINES_DEFAULT, SCREEN_LINES_MAX};
use crate::daemon::Daemon;
use crate::db::RemoteDeviceRow;

const INDEX_HTML: &str = include_str!("pwa/index.html");
const MANIFEST: &str = include_str!("pwa/manifest.webmanifest");
const ICON_SVG: &str = include_str!("pwa/icon.svg");

pub fn router(daemon: Arc<Daemon>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon))
        .route("/api/pair", post(pair))
        .route("/api/me", get(me))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{id}/screen", get(screen))
        .route("/api/sessions/{id}/input", post(input))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn_with_state(daemon.clone(), guard))
        .with_state(daemon)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        error(status, self.to_string())
    }
}

/// `host[:port]` → lowercase host, keeping IPv6 brackets.
fn host_only(authority: &str) -> String {
    let authority = authority.trim().to_ascii_lowercase();
    if authority.starts_with('[') {
        return match authority.find(']') {
            Some(end) => authority[..=end].to_string(),
            None => authority,
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host.to_string(),
        _ => authority,
    }
}

async fn guard(State(daemon): State<Arc<Daemon>>, req: Request, next: Next) -> Response {
    let allowed = daemon.remote_config().allowed_hosts();
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()));
    let Some(host) = host else {
        return error(
            StatusCode::MISDIRECTED_REQUEST,
            "request has no Host header: expected one of the remote access host names",
        );
    };
    if !allowed.contains(&host_only(&host)) {
        return error(
            StatusCode::MISDIRECTED_REQUEST,
            format!(
                "host {host:?} is not served here: expected one of {}; set the public URL in \
                 Settings > Remote access to the address devices use",
                allowed.join(", ")
            ),
        );
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        if let Some(origin) = req.headers().get(header::ORIGIN) {
            let origin = origin.to_str().unwrap_or("");
            let origin_host = reqwest::Url::parse(origin)
                .ok()
                .and_then(|u| u.host_str().map(str::to_ascii_lowercase));
            if !origin_host.is_some_and(|h| allowed.contains(&h)) {
                return error(
                    StatusCode::FORBIDDEN,
                    format!(
                        "origin {origin:?} may not call this API: expected a page served from \
                         one of {}",
                        allowed.join(", ")
                    ),
                );
            }
        }
    }
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    resp
}

/// The inline script's hash, so the policy can refuse every other script.
fn content_security_policy() -> &'static str {
    static CSP: OnceLock<String> = OnceLock::new();
    CSP.get_or_init(|| {
        let script = INDEX_HTML
            .split_once("<script>")
            .and_then(|(_, rest)| rest.split_once("</script>"))
            .map(|(body, _)| body)
            .unwrap_or("");
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(script));
        format!(
            "default-src 'none'; script-src 'sha256-{hash}'; style-src 'unsafe-inline'; \
             img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; \
             form-action 'none'; frame-ancestors 'none'"
        )
    })
}

async fn index() -> Response {
    let mut resp = (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        INDEX_HTML,
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(content_security_policy()) {
        resp.headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, v);
    }
    resp
}

async fn manifest() -> Response {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        MANIFEST,
    )
        .into_response()
}

async fn icon() -> Response {
    ([(header::CONTENT_TYPE, "image/svg+xml")], ICON_SVG).into_response()
}

async fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "no such remote access route")
}

fn too_many(retry_secs: u64) -> Response {
    let mut resp = error(
        StatusCode::TOO_MANY_REQUESTS,
        super::lockout_message(retry_secs),
    );
    if let Ok(v) = HeaderValue::from_str(&retry_secs.to_string()) {
        resp.headers_mut().insert(header::RETRY_AFTER, v);
    }
    resp
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// A missing token is not a guess and does not count toward the lockout; a
/// wrong one does. While locked out nothing is checked at all.
fn authenticate(daemon: &Daemon, headers: &HeaderMap) -> Result<RemoteDeviceRow, Response> {
    let now = Instant::now();
    if let Err(secs) = daemon.remote.auth_check(now) {
        return Err(too_many(secs));
    }
    let Some(token) = bearer(headers) else {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "missing device token: expected `Authorization: Bearer <token>` from a paired device",
        ));
    };
    match daemon.remote_authenticate(token) {
        Some(device) => Ok(device),
        None => {
            daemon.remote.auth_failed(now);
            Err(error(
                StatusCode::UNAUTHORIZED,
                "device token is not valid: it was revoked or never issued; pair this device again",
            ))
        }
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Response> + Send + 'static,
) -> Result<T, Response> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(error(StatusCode::INTERNAL_SERVER_ERROR, format!("{e}"))))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    device_name: String,
}

async fn pair(
    State(daemon): State<Arc<Daemon>>,
    body: Result<Json<PairBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => {
            return error(
                rej.status(),
                format!(
                    "pairing body is not valid ({}): expected JSON {{\"code\": string, \"device_name\": string}}",
                    rej.body_text()
                ),
            )
        }
    };
    let result = blocking(move || {
        let now = Instant::now();
        if let Err(secs) = daemon.remote.auth_check(now) {
            return Err(too_many(secs));
        }
        match daemon.remote_pair(&body.code, &body.device_name) {
            Ok(pair) => Ok(pair),
            Err(e @ ApiError::Unauthorized(_)) => {
                daemon.remote.auth_failed(now);
                Err(e.into_response())
            }
            Err(e) => Err(e.into_response()),
        }
    })
    .await;
    match result {
        Ok((token, device_id)) => {
            Json(json!({ "token": token, "device_id": device_id })).into_response()
        }
        Err(resp) => resp,
    }
}

async fn me(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    match blocking(move || authenticate(&daemon, &headers)).await {
        Ok(device) => Json(json!({ "device_id": device.id, "name": device.name })).into_response(),
        Err(resp) => resp,
    }
}

async fn sessions(State(daemon): State<Arc<Daemon>>, headers: HeaderMap) -> Response {
    let result = blocking(move || {
        authenticate(&daemon, &headers)?;
        Ok(daemon.remote_sessions())
    })
    .await;
    match result {
        Ok(sessions) => Json(json!({ "sessions": sessions })).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct ScreenQuery {
    lines: Option<usize>,
}

async fn screen(
    State(daemon): State<Arc<Daemon>>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    query: Result<Query<ScreenQuery>, QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return error(
            StatusCode::BAD_REQUEST,
            format!("query is not valid: expected ?lines=<1..{SCREEN_LINES_MAX}>"),
        );
    };
    let lines = query.lines.unwrap_or(SCREEN_LINES_DEFAULT);
    let result = blocking(move || {
        authenticate(&daemon, &headers)?;
        daemon
            .remote_screen(id, lines)
            .map_err(IntoResponse::into_response)
    })
    .await;
    match result {
        Ok(lines) => Json(json!({ "id": id, "lines": lines })).into_response(),
        Err(resp) => resp,
    }
}

#[derive(Deserialize)]
struct InputBody {
    text: Option<String>,
    #[serde(default)]
    keys: Vec<String>,
}

async fn input(
    State(daemon): State<Arc<Daemon>>,
    Path(id): Path<u32>,
    headers: HeaderMap,
    body: Result<Json<InputBody>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rej) => {
            return error(
                rej.status(),
                format!(
                    "input body is not valid ({}): expected JSON {{\"text\"?: string, \"keys\"?: string[]}} \
                     within {BODY_LIMIT} bytes",
                    rej.body_text()
                ),
            )
        }
    };
    let result = blocking(move || {
        authenticate(&daemon, &headers)?;
        daemon
            .remote_input(id, body.text.as_deref(), &body.keys)
            .map_err(IntoResponse::into_response)
    })
    .await;
    match result {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(resp) => resp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_only_strips_ports_and_keeps_brackets() {
        assert_eq!(host_only("127.0.0.1:47823"), "127.0.0.1");
        assert_eq!(host_only("Box.ts.net"), "box.ts.net");
        assert_eq!(host_only("[::1]:47823"), "[::1]");
    }

    #[test]
    fn the_policy_hashes_the_inline_script() {
        assert!(content_security_policy().contains("script-src 'sha256-"));
        assert!(INDEX_HTML.matches("<script>").count() == 1);
    }
}

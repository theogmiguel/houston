use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::{Arc, RwLock, Weak};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use houston_protocol as proto;
use serde_json::{json, Value};

use crate::mcp_creds::McpScope;

pub const PROGRESS_TICK_DEFAULT: Duration = Duration::from_secs(10);

pub const SUPPORTED_PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub const PREFERRED_PROTOCOL: &str = "2025-06-18";

pub const SERVER_NAME: &str = "houston";

// generous for any real tool call, tight enough that a misbehaving client can't
// force an unbounded read off the /mcp socket
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Annotations {
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
    pub open_world: bool,
}

impl Annotations {
    pub fn readonly() -> Self {
        Self {
            read_only: true,
            destructive: false,
            idempotent: true,
            open_world: true,
        }
    }

    pub fn destructive() -> Self {
        Self {
            read_only: false,
            destructive: true,
            idempotent: false,
            open_world: true,
        }
    }

    fn to_json(self) -> Value {
        json!({
            "readOnlyHint": self.read_only,
            "destructiveHint": self.destructive,
            "idempotentHint": self.idempotent,
            "openWorldHint": self.open_world,
        })
    }

    /// A local, additive write: not a read, but not something a reviewer needs to gate
    /// either (nothing destroyed, nothing reaching outside this daemon).
    pub fn local_write() -> Self {
        Self {
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: false,
        }
    }
}

/// Mirrors Codex's own Auto-mode approval rule (`requires_mcp_tool_approval` in
/// `codex-rs/core/src/mcp_tool_call.rs`): destructive always gates, read-only never
/// does, otherwise it gates only if the tool can reach outside the sandbox.
pub(crate) fn codex_requires_approval(annotations: Annotations) -> bool {
    if annotations.destructive {
        true
    } else if annotations.read_only {
        false
    } else {
        annotations.open_world
    }
}

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: Annotations,
}

impl ToolSpec {
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": self.annotations.to_json(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct ToolError(pub String);

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub text: String,
    pub structured: Option<Value>,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            structured: None,
        }
    }

    pub fn structured(value: Value) -> Self {
        Self {
            text: serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
            structured: Some(value),
        }
    }

    fn to_json(&self) -> Value {
        let mut result = json!({
            "content": [{ "type": "text", "text": self.text }],
            "isError": false,
        });
        if let Some(structured) = &self.structured {
            result["structuredContent"] = structured.clone();
        }
        result
    }
}

const LISTEN_KEEPALIVE: Duration = Duration::from_secs(30);

// caps one session's open SSE streams so a reconnecting or leaked client can't
// accumulate them without bound
const MAX_LISTEN_STREAMS_PER_SESSION: usize = 4;

// a list-changed ping is safe to lose (the client re-lists on demand), so a slow
// reader is dropped past this many buffered notifications instead of backing up
const LISTEN_CHANNEL_DEPTH: usize = 8;

struct Listener {
    scope: McpScope,
    tx: tokio::sync::mpsc::Sender<Bytes>,
}

#[derive(Default)]
pub struct NotifierRegistry {
    listeners: std::sync::Mutex<Vec<Listener>>,
}

impl NotifierRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn open(&self, scope: McpScope) -> Result<tokio::sync::mpsc::Receiver<Bytes>, usize> {
        let mut listeners = self.listeners.lock().expect("mcp notifier lock");
        listeners.retain(|l| !l.tx.is_closed());
        let held = listeners
            .iter()
            .filter(|l| l.scope.session_id == scope.session_id)
            .count();
        if held >= MAX_LISTEN_STREAMS_PER_SESSION {
            return Err(held);
        }
        let (tx, rx) = tokio::sync::mpsc::channel(LISTEN_CHANNEL_DEPTH);
        listeners.push(Listener { scope, tx });
        Ok(rx)
    }

    pub fn close_session(&self, session_id: u32) {
        let mut listeners = self.listeners.lock().expect("mcp notifier lock");
        listeners.retain(|l| l.scope.session_id != session_id);
    }

    pub fn tools_changed_in(&self, workspace: &str) {
        self.push(|scope| scope.workspace_id == workspace);
    }

    pub fn tools_changed_everywhere(&self) {
        self.push(|_| true);
    }

    pub fn tools_changed_for_session(&self, session_id: u32) {
        self.push(|scope| scope.session_id == session_id);
    }

    fn push(&self, want: impl Fn(&McpScope) -> bool) {
        let frame = sse_event(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/tools/list_changed",
        }));
        let mut listeners = self.listeners.lock().expect("mcp notifier lock");
        listeners.retain(|listener| {
            if !want(&listener.scope) {
                return !listener.tx.is_closed();
            }
            match listener.tx.try_send(frame.clone()) {
                Ok(()) => true,
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                    tracing::warn!(
                        session = listener.scope.session_id,
                        "dropping an /mcp listening stream: {LISTEN_CHANNEL_DEPTH}                          notifications buffered and unread"
                    );
                    false
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
    }

    pub fn len(&self) -> usize {
        let mut listeners = self.listeners.lock().expect("mcp notifier lock");
        listeners.retain(|l| !l.tx.is_closed());
        listeners.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub trait ToolProvider: Send + Sync {
    fn tools(&self, scope: &McpScope) -> Vec<ToolSpec>;

    fn all_tools(&self) -> Vec<ToolSpec> {
        Vec::new()
    }

    fn instructions(&self, scope: &McpScope) -> Option<String> {
        let _ = scope;
        None
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;
}

#[derive(Default)]
pub struct ToolRegistry {
    providers: RwLock<Vec<Arc<dyn ToolProvider>>>,
    builtins: Option<Arc<BuiltinTools>>,
    daemon: std::sync::OnceLock<Weak<crate::daemon::Daemon>>,
}

impl ToolRegistry {
    pub fn with_builtins() -> Self {
        let builtins = Arc::new(BuiltinTools::default());
        let registry = Self {
            builtins: Some(Arc::clone(&builtins)),
            ..Self::default()
        };
        registry.register(builtins);
        registry
    }

    pub fn bind_daemon(&self, daemon: &Arc<crate::daemon::Daemon>) {
        if let Some(builtins) = &self.builtins {
            builtins.bind(daemon);
        }
        let _ = self.daemon.set(Arc::downgrade(daemon));
    }

    fn tool_role_for(&self, scope: &McpScope) -> Option<crate::orchestrate::ToolRole> {
        self.daemon
            .get()
            .and_then(Weak::upgrade)
            .map(|d| d.tool_role_of(scope.session_id))
    }

    pub fn register(&self, provider: Arc<dyn ToolProvider>) {
        self.providers
            .write()
            .expect("mcp tool registry lock")
            .push(provider);
    }

    pub fn list(&self, scope: &McpScope) -> Vec<ToolSpec> {
        let providers = self.providers.read().expect("mcp tool registry lock");
        let mut by_name: BTreeMap<String, ToolSpec> = BTreeMap::new();
        for provider in providers.iter() {
            for spec in provider.tools(scope) {
                by_name.insert(spec.name.clone(), spec);
            }
        }
        drop(providers);
        if let Some(role) = self.tool_role_for(scope) {
            by_name.retain(|name, _| role.advertises(name));
        }
        by_name.into_values().collect()
    }

    pub fn call_refusal(&self, scope: &McpScope, tool: &str) -> Option<ToolError> {
        let role = self.tool_role_for(scope)?;
        if !matches!(role, crate::orchestrate::ToolRole::Leaf) {
            return None;
        }
        if role.advertises(tool) {
            return None;
        }
        if !self.all().iter().any(|s| s.name == tool) {
            return None;
        }
        Some(ToolError(format!(
            "pane {} is a leaf child: it has `pane_submit` and `workspace_info`; \
             `{tool}` is not available to it",
            scope.session_id,
        )))
    }

    pub fn all(&self) -> Vec<ToolSpec> {
        let providers = self.providers.read().expect("mcp tool registry lock");
        let mut by_name: BTreeMap<String, ToolSpec> = BTreeMap::new();
        for provider in providers.iter() {
            for spec in provider.all_tools() {
                by_name.insert(spec.name.clone(), spec);
            }
        }
        by_name.into_values().collect()
    }

    fn instructions(&self, scope: &McpScope) -> String {
        let providers = self.providers.read().expect("mcp tool registry lock");
        let mut seen = std::collections::BTreeSet::new();
        let mut parts = Vec::new();
        for provider in providers.iter() {
            if let Some(text) = provider.instructions(scope) {
                if !text.is_empty() && seen.insert(text.clone()) {
                    parts.push(text);
                }
            }
        }
        parts.join("\n\n")
    }

    fn provider_for(&self, name: &str) -> Option<Arc<dyn ToolProvider>> {
        let providers = self.providers.read().expect("mcp tool registry lock");
        providers
            .iter()
            .rev()
            .find(|p| p.all_tools().iter().any(|s| s.name == name))
            .cloned()
    }
}

#[derive(Default)]
struct BuiltinTools {
    daemon: std::sync::OnceLock<Weak<crate::daemon::Daemon>>,
}

impl BuiltinTools {
    fn bind(&self, daemon: &Arc<crate::daemon::Daemon>) {
        let _ = self.daemon.set(Arc::downgrade(daemon));
    }

    fn request_id(&self, session: u32) -> Option<u32> {
        self.daemon
            .get()
            .and_then(Weak::upgrade)
            .and_then(|d| d.delegation_round_of(session))
    }
    fn specs() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "workspace_info".into(),
            title: "Get Houston workspace".into(),
            description: "Report the Houston workspace this session belongs to, and \
                          which request it is answering (`request_id`, the number \
                          `pane_submit` takes). Takes no arguments: the answer is fixed by \
                          the credential this session was spawned with and cannot be pointed \
                          at another workspace."
                .into(),
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            annotations: Annotations {
                open_world: false,
                ..Annotations::readonly()
            },
        }]
    }
}

impl ToolProvider for BuiltinTools {
    fn tools(&self, _scope: &McpScope) -> Vec<ToolSpec> {
        Self::specs()
    }

    fn all_tools(&self) -> Vec<ToolSpec> {
        Self::specs()
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        _args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            match name {
                "workspace_info" => {
                    let whoami = self
                        .daemon
                        .get()
                        .and_then(Weak::upgrade)
                        .and_then(|d| d.orchestrate_whoami_json(scope.session_id).ok());
                    let mut v = match whoami {
                        Some(info) => info,
                        None => json!({
                            "session_id": scope.session_id,
                            "workspace": scope.workspace_id,
                        }),
                    };
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert(
                            "request_id".into(),
                            self.request_id(scope.session_id)
                                .map(|n| json!(n))
                                .unwrap_or(Value::Null),
                        );
                    }
                    Ok(ToolOutput::structured(v))
                }
                other => Err(ToolError(format!(
                    "builtin provider has no tool {other:?}; expected one of [\"workspace_info\"]"
                ))),
            }
        })
    }
}

pub trait McpHost: Send + Sync {
    fn resolve(&self, raw_token: &str) -> Option<McpScope>;
    fn tools(&self) -> &ToolRegistry;

    fn agent_kind(&self, session: u32) -> Option<proto::AgentKind> {
        let _ = session;
        None
    }

    fn progress_tick(&self) -> Duration {
        PROGRESS_TICK_DEFAULT
    }

    fn notifier(&self) -> Option<&NotifierRegistry> {
        None
    }

    fn shutting_down(&self) -> bool {
        false
    }
}

fn refuse_if_mutating_during_shutdown(host: &dyn McpHost, tool: &str) -> Option<ToolError> {
    let read_only = host
        .tools()
        .all()
        .into_iter()
        .find(|s| s.name == tool)
        .is_some_and(|s| s.annotations.read_only);
    if read_only {
        None
    } else {
        Some(ToolError("refused: daemon is shutting down".to_string()))
    }
}

pub async fn handle_post(host: &dyn McpHost, headers: &HeaderMap, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_rpc_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            Value::Null,
            -32600,
            format!(
                "/mcp request body is {} bytes; the limit is {MAX_BODY_BYTES} bytes \
                 (MAX_BODY_BYTES). Send a smaller request.",
                body.len()
            ),
        );
    }

    let token = bearer_token(headers);
    let Some(scope) = token.as_deref().and_then(|t| host.resolve(t)) else {
        tracing::warn!(
            reason = if token.is_none() {
                "missing_bearer_token"
            } else {
                "unknown_or_expired_token"
            },
            "rejected an /mcp request with an unusable credential"
        );
        return unauthorized();
    };

    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(e) => {
            return json_rpc_error_response(
                StatusCode::BAD_REQUEST,
                Value::Null,
                -32700,
                format!("/mcp body is not valid JSON: {e}; expected a JSON-RPC 2.0 object"),
            )
        }
    };

    if parsed.is_array() {
        return json_rpc_error_response(
            StatusCode::BAD_REQUEST,
            Value::Null,
            -32600,
            "/mcp received a JSON-RPC batch (an array); this server accepts one request \
             object per POST, matching MCP 2025-06-18 which removed batching"
                .into(),
        );
    }

    dispatch(host, &scope, &parsed).await
}

pub async fn handle_listen(host: &dyn McpHost, headers: &HeaderMap) -> Response {
    let Some(notifier) = host.notifier() else {
        return handle_unsupported_method("GET");
    };
    let token = bearer_token(headers);
    let Some(scope) = token.as_deref().and_then(|t| host.resolve(t)) else {
        tracing::warn!(
            reason = if token.is_none() {
                "missing_bearer_token"
            } else {
                "unknown_or_expired_token"
            },
            "rejected an /mcp listening stream with an unusable credential"
        );
        return unauthorized();
    };

    let session = scope.session_id;
    let rx = match notifier.open(scope) {
        Ok(rx) => rx,
        Err(held) => {
            return json_rpc_error_response(
                StatusCode::TOO_MANY_REQUESTS,
                Value::Null,
                -32600,
                format!(
                    "session {session} already holds {held} open /mcp listening streams; the \
                     per-session limit is {MAX_LISTEN_STREAMS_PER_SESSION} \
                     (MAX_LISTEN_STREAMS_PER_SESSION). Close one before opening another — a \
                     client needs exactly one."
                ),
            )
        }
    };

    tracing::debug!(session, "/mcp listening stream opened");
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        match tokio::time::timeout(LISTEN_KEEPALIVE, rx.recv()).await {
            Ok(Some(frame)) => Some((Ok::<_, std::convert::Infallible>(frame), rx)),
            Ok(None) => None,
            Err(_) => Some((
                Ok::<_, std::convert::Infallible>(Bytes::from_static(b": keepalive\n\n")),
                rx,
            )),
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("static headers plus a streaming body always build a valid response")
}

pub fn handle_unsupported_method(method: &str) -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, GET")],
        axum::Json(json!({
            "error": "method_not_allowed",
            "message": format!(
                "/mcp accepts POST, and GET for the listening stream on a daemon that can push; \
                 got {method}. There is no Mcp-Session-Id — the bearer credential identifies \
                 the session."
            ),
        })),
    )
        .into_response()
}

fn gateway_delivery(kind: proto::AgentKind) -> bool {
    matches!(kind, proto::AgentKind::Codex)
}

const GATEWAY_INSTRUCTIONS: &str =
    "Most of this server's tools are served through a schema gateway to save you the cost \
     of resending every schema: call list_tools to see what call_tool can run. A few tools \
     that need no approval are listed directly, by their own name and schema, in tools/list \
     alongside list_tools and call_tool — call those directly, not through call_tool.";

/// The tools/list entries a Codex-scoped session gets directly, without going through
/// `call_tool` — the subset of `scope`'s own tools that [`codex_requires_approval`]
/// says Codex's Auto mode would not gate anyway.
fn gateway_direct_tools(host: &dyn McpHost, scope: &McpScope) -> Vec<ToolSpec> {
    host.tools()
        .list(scope)
        .into_iter()
        .filter(|spec| !codex_requires_approval(spec.annotations))
        .collect()
}

pub fn gateway_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_tools".into(),
            title: "List available tools".into(),
            description: "The full tool catalogue this server offers, optionally filtered \
                          by a case-insensitive substring of the tool name. Call this \
                          before call_tool."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Case-insensitive substring to match against tool names.",
                    },
                },
                "additionalProperties": false,
            }),
            annotations: Annotations {
                open_world: false,
                ..Annotations::readonly()
            },
        },
        ToolSpec {
            name: "call_tool".into(),
            title: "Call a tool".into(),
            description: "Run one tool from the list_tools catalogue by name, with its own \
                          arguments. Tools that need no approval are listed directly in \
                          tools/list instead and must be called by their own name, not \
                          through here."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "A tool name from list_tools." },
                    "args": { "type": "object", "description": "That tool's own arguments." },
                },
                "required": ["name"],
                "additionalProperties": false,
            }),
            annotations: Annotations::destructive(),
        },
    ]
}

enum GatewayCallError {
    Tool(ToolError),
    UnknownTool { name: String, known: Vec<String> },
}

async fn gateway_tools_call(
    host: &dyn McpHost,
    scope: &McpScope,
    name: &str,
    args: &Value,
) -> Result<ToolOutput, GatewayCallError> {
    match name {
        "list_tools" => {
            let filter = args
                .get("filter")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase);
            let tools: Vec<Value> = host
                .tools()
                .all()
                .iter()
                .filter(|s| {
                    filter
                        .as_deref()
                        .is_none_or(|f| s.name.to_ascii_lowercase().contains(f))
                })
                .map(ToolSpec::to_json)
                .collect();
            Ok(ToolOutput::structured(json!({ "tools": tools })))
        }
        "call_tool" => {
            let Some(target) = args.get("name").and_then(Value::as_str) else {
                return Err(GatewayCallError::Tool(ToolError(
                    "call_tool needs a string \"name\" argument naming a tool from list_tools"
                        .into(),
                )));
            };
            let call_args = args.get("args").cloned().unwrap_or_else(|| json!({}));
            let Some(provider) = host.tools().provider_for(target) else {
                let known: Vec<String> = host.tools().all().into_iter().map(|s| s.name).collect();
                return Err(GatewayCallError::UnknownTool {
                    name: target.to_string(),
                    known,
                });
            };
            if host.shutting_down() {
                if let Some(err) = refuse_if_mutating_during_shutdown(host, target) {
                    return Err(GatewayCallError::Tool(err));
                }
            }
            if let Some(err) = host.tools().call_refusal(scope, target) {
                return Err(GatewayCallError::Tool(err));
            }
            provider
                .call(scope, target, &call_args)
                .await
                .map_err(GatewayCallError::Tool)
        }
        other => Err(GatewayCallError::Tool(ToolError(format!(
            "gateway has no meta-tool {other:?}; expected \"list_tools\" or \"call_tool\""
        )))),
    }
}

async fn dispatch(host: &dyn McpHost, scope: &McpScope, request: &Value) -> Response {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let is_notification = request.get("id").is_none();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return json_rpc_error_response(
            StatusCode::BAD_REQUEST,
            id,
            -32600,
            format!(
                "JSON-RPC request has no string \"method\" field; got {}",
                summarize(request)
            ),
        );
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    if is_notification {
        tracing::debug!(method, "/mcp notification");
        return StatusCode::ACCEPTED.into_response();
    }

    match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PREFERRED_PROTOCOL);
            let agreed = if SUPPORTED_PROTOCOLS.contains(&requested) {
                requested
            } else {
                tracing::info!(
                    requested,
                    answered = PREFERRED_PROTOCOL,
                    "/mcp client asked for an unrecognised protocol revision"
                );
                PREFERRED_PROTOCOL
            };
            let mut result = json!({
                "protocolVersion": agreed,
                "capabilities": {
                    "tools": { "listChanged": host.notifier().is_some() },
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION"),
                },
            });
            let mut instructions = host.tools().instructions(scope);
            if host
                .agent_kind(scope.session_id)
                .is_some_and(gateway_delivery)
            {
                if !instructions.is_empty() {
                    instructions.push_str("\n\n");
                }
                instructions.push_str(GATEWAY_INSTRUCTIONS);
            }
            if !instructions.is_empty() {
                result["instructions"] = json!(instructions);
            }
            json_rpc_result(id, result)
        }
        "ping" => json_rpc_result(id, json!({})),
        "tools/list" => {
            let gateway = host
                .agent_kind(scope.session_id)
                .is_some_and(gateway_delivery);
            let specs = if gateway {
                let mut specs = gateway_tool_specs();
                specs.extend(gateway_direct_tools(host, scope));
                specs
            } else {
                host.tools().list(scope)
            };
            let tools: Vec<Value> = specs.iter().map(ToolSpec::to_json).collect();
            json_rpc_result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return json_rpc_error_response(
                    StatusCode::BAD_REQUEST,
                    id,
                    -32602,
                    format!(
                        "tools/call params has no string \"name\"; got {}",
                        summarize(&params)
                    ),
                );
            };
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let gateway = host
                .agent_kind(scope.session_id)
                .is_some_and(gateway_delivery);
            if gateway && !matches!(name, "list_tools" | "call_tool") {
                let direct = gateway_direct_tools(host, scope);
                let gated_but_known = !direct.iter().any(|s| s.name == name)
                    && host.tools().list(scope).iter().any(|s| s.name == name);
                if gated_but_known {
                    return json_rpc_result(
                        id,
                        json!({
                            "content": [{
                                "type": "text",
                                "text": format!(
                                    "{name:?} needs approval under the Codex gateway; call \
                                     it through call_tool instead of by name directly"
                                ),
                            }],
                            "isError": true,
                        }),
                    );
                }
            }
            if gateway && matches!(name, "list_tools" | "call_tool") {
                return match gateway_tools_call(host, scope, name, &args).await {
                    Ok(output) => json_rpc_result(id, output.to_json()),
                    Err(GatewayCallError::Tool(ToolError(message))) => json_rpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": message }],
                            "isError": true,
                        }),
                    ),
                    Err(GatewayCallError::UnknownTool { name, known }) => json_rpc_error_response(
                        StatusCode::BAD_REQUEST,
                        id,
                        -32602,
                        format!("no tool named {name:?}; this server offers {known:?}"),
                    ),
                };
            }
            let Some(provider) = host.tools().provider_for(name) else {
                let known: Vec<String> = host.tools().all().into_iter().map(|s| s.name).collect();
                return json_rpc_error_response(
                    StatusCode::BAD_REQUEST,
                    id,
                    -32602,
                    format!("no tool named {name:?}; this server offers {known:?}"),
                );
            };
            if let Some(ToolError(message)) = host.tools().call_refusal(scope, name) {
                return json_rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": message }],
                        "isError": true,
                    }),
                );
            }
            if host.shutting_down() {
                if let Some(ToolError(message)) = refuse_if_mutating_during_shutdown(host, name) {
                    return json_rpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": message }],
                            "isError": true,
                        }),
                    );
                }
            }
            let progress_token = params.get("_meta").and_then(|m| m.get("progressToken"));
            match progress_token {
                Some(token) => stream_tools_call(
                    provider,
                    scope.clone(),
                    name.to_string(),
                    args,
                    id,
                    token.clone(),
                    host.progress_tick(),
                ),
                None => match provider.call(scope, name, &args).await {
                    Ok(output) => json_rpc_result(id, output.to_json()),
                    Err(ToolError(message)) => json_rpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": message }],
                            "isError": true,
                        }),
                    ),
                },
            }
        }
        other => json_rpc_error_response(
            StatusCode::BAD_REQUEST,
            id,
            -32601,
            format!(
                "unknown method {other:?}; this server implements \
                 [\"initialize\", \"ping\", \"tools/list\", \"tools/call\"]"
            ),
        ),
    }
}

fn stream_tools_call(
    provider: Arc<dyn ToolProvider>,
    scope: McpScope,
    name: String,
    args: Value,
    id: Value,
    token: Value,
    tick: Duration,
) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(4);
    tokio::spawn(async move {
        let start = Instant::now();
        let call = provider.call(&scope, &name, &args);
        tokio::pin!(call);
        let mut interval = tokio::time::interval(tick);
        interval.tick().await;
        let result = loop {
            tokio::select! {
                res = &mut call => break res,
                _ = interval.tick() => {
                    let elapsed = start.elapsed().as_secs();
                    let note = json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": {
                            "progressToken": token,
                            "progress": elapsed,
                            "message": format!(
                                "tool still running ({elapsed}s elapsed); a browser act may be \
                                 awaiting the user's confirmation on screen (up to 120 s)"
                            ),
                        }
                    });
                    if tx.send(sse_event(&note)).await.is_err() {
                        return;
                    }
                }
            }
        };
        let response = match result {
            Ok(output) => json!({ "jsonrpc": "2.0", "id": id, "result": output.to_json() }),
            Err(ToolError(message)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{ "type": "text", "text": message }],
                    "isError": true,
                },
            }),
        };
        let _ = tx.send(sse_event(&response)).await;
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|frame| (Ok::<_, std::convert::Infallible>(frame), rx))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .expect("static headers plus a streaming body always build a valid response")
}

fn sse_event(value: &Value) -> Bytes {
    Bytes::from(format!("data: {value}\n\n"))
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let trimmed = rest.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [
            (header::WWW_AUTHENTICATE, "Bearer"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        axum::Json(json!({
            "error": "invalid_mcp_credential",
            "message": "A valid Houston session credential is required. Houston mints one per \
                        pane at spawn and revokes it when the session ends.",
        })),
    )
        .into_response()
}

fn json_rpc_result(id: Value, result: Value) -> Response {
    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn json_rpc_error_response(status: StatusCode, id: Value, code: i32, message: String) -> Response {
    (
        status,
        axum::Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

fn summarize(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let keys: Vec<&str> = map.keys().map(String::as_str).collect();
            format!("an object with keys {keys:?}")
        }
        Value::Array(items) => format!("an array of {} items", items.len()),
        Value::Null => "null".into(),
        Value::Bool(_) => "a boolean".into(),
        Value::Number(_) => "a number".into(),
        Value::String(_) => "a string".into(),
    }
}

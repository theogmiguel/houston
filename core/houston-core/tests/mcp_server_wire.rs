#![allow(clippy::disallowed_methods)]

mod common;

use houston_core::mcp_creds::McpScope;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod gateway {
    use super::*;
    use houston_core::mcp_server::{
        Annotations, BoxFuture, McpHost, ToolError, ToolOutput, ToolProvider, ToolRegistry,
        ToolSpec,
    };
    use houston_protocol::AgentKind;
    use std::collections::HashMap;

    struct EchoTool;

    impl ToolProvider for EchoTool {
        fn tools(&self, _scope: &McpScope) -> Vec<ToolSpec> {
            Self::specs()
        }
        fn all_tools(&self) -> Vec<ToolSpec> {
            Self::specs()
        }
        fn call<'a>(
            &'a self,
            scope: &'a McpScope,
            _name: &'a str,
            _args: &'a Value,
        ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
            Box::pin(async move {
                Ok(ToolOutput::structured(
                    json!({ "echoedWorkspace": scope.workspace_id }),
                ))
            })
        }
    }

    impl EchoTool {
        fn specs() -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "echo_workspace".into(),
                title: "Echo the caller's workspace".into(),
                description: "Test-only tool.".into(),
                input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                annotations: Annotations::readonly(),
            }]
        }
    }

    struct PushButtonTool;

    impl ToolProvider for PushButtonTool {
        fn tools(&self, _scope: &McpScope) -> Vec<ToolSpec> {
            Self::specs()
        }
        fn all_tools(&self) -> Vec<ToolSpec> {
            Self::specs()
        }
        fn call<'a>(
            &'a self,
            _scope: &'a McpScope,
            _name: &'a str,
            _args: &'a Value,
        ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
            Box::pin(async move { Ok(ToolOutput::text("pushed")) })
        }
    }

    impl PushButtonTool {
        fn specs() -> Vec<ToolSpec> {
            vec![ToolSpec {
                name: "push_button".into(),
                title: "Push a destructive test button".into(),
                description: "Test-only destructive tool.".into(),
                input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                annotations: Annotations::destructive(),
            }]
        }
    }

    struct GatewayHost {
        tools: ToolRegistry,
        scopes: HashMap<String, McpScope>,
        kinds: HashMap<u32, AgentKind>,
    }

    impl McpHost for GatewayHost {
        fn resolve(&self, raw_token: &str) -> Option<McpScope> {
            self.scopes.get(raw_token).cloned()
        }
        fn tools(&self) -> &ToolRegistry {
            &self.tools
        }
        fn agent_kind(&self, session: u32) -> Option<AgentKind> {
            self.kinds.get(&session).copied()
        }
    }

    fn host(sessions: &[(u32, &str, Option<AgentKind>)]) -> GatewayHost {
        let tools = ToolRegistry::with_builtins();
        tools.register(std::sync::Arc::new(EchoTool));
        tools.register(std::sync::Arc::new(PushButtonTool));
        let mut scopes = HashMap::new();
        let mut kinds = HashMap::new();
        for (session_id, token, kind) in sessions {
            scopes.insert(
                token.to_string(),
                McpScope {
                    session_id: *session_id,
                    workspace_id: token.to_string(),
                },
            );
            if let Some(k) = kind {
                kinds.insert(*session_id, *k);
            }
        }
        GatewayHost {
            tools,
            scopes,
            kinds,
        }
    }

    async fn call(host: &GatewayHost, token: &str, body: Value) -> Value {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let resp = houston_core::mcp_server::handle_post(
            host,
            &headers,
            axum::body::Bytes::from(body.to_string()),
        )
        .await;
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            panic!(
                "response body was not JSON ({e}): {:?}",
                String::from_utf8_lossy(&bytes)
            )
        })
    }

    #[tokio::test]
    async fn a_codex_pane_is_served_the_two_meta_tools_plus_approval_free_ones_directly() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(&h, "tok", rpc(1, "tools/list", json!({}))).await;
        let tools = res["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"list_tools"), "{res}");
        assert!(names.contains(&"call_tool"), "{res}");
        assert!(
            names.contains(&"echo_workspace"),
            "read-only tools go direct: {res}"
        );
        assert!(
            !names.contains(&"push_button"),
            "a destructive tool must stay behind call_tool: {res}"
        );
        let named = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap().clone();
        let list_tools = named("list_tools");
        assert_eq!(list_tools["annotations"]["readOnlyHint"], true, "{res}");
        assert_eq!(list_tools["annotations"]["openWorldHint"], false, "{res}");
        let call_tool = named("call_tool");
        assert_eq!(call_tool["annotations"]["destructiveHint"], true, "{res}");
        assert_eq!(
            call_tool["inputSchema"]["required"],
            json!(["name"]),
            "{res}"
        );
    }

    #[tokio::test]
    async fn a_codex_pane_calls_an_approval_free_tool_directly_by_name() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(
                1,
                "tools/call",
                json!({ "name": "echo_workspace", "arguments": {} }),
            ),
        )
        .await;
        assert_eq!(res["result"]["isError"], false, "{res}");
        assert_eq!(res["result"]["structuredContent"]["echoedWorkspace"], "tok");
    }

    #[tokio::test]
    async fn a_codex_pane_calling_a_gated_tool_directly_is_refused_naming_call_tool() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(
                1,
                "tools/call",
                json!({ "name": "push_button", "arguments": {} }),
            ),
        )
        .await;
        assert_eq!(res["result"]["isError"], true, "{res}");
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("push_button"), "{text}");
        assert!(text.contains("call_tool"), "{text}");
    }

    #[tokio::test]
    async fn the_codex_gateway_call_tool_round_trips_a_real_tool() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(
                1,
                "tools/call",
                json!({ "name": "call_tool", "arguments": { "name": "workspace_info", "args": {} } }),
            ),
        )
        .await;
        assert_eq!(res["result"]["isError"], false, "{res}");
        assert_eq!(
            res["result"]["structuredContent"]["workspace"], "tok",
            "the caller's OWN scope, unchanged by the gateway: {res}"
        );
    }

    #[tokio::test]
    async fn the_codex_gateway_call_tool_names_an_unknown_tool() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(
                1,
                "tools/call",
                json!({ "name": "call_tool", "arguments": { "name": "no_such_tool" } }),
            ),
        )
        .await;
        assert_eq!(res["error"]["code"], -32602, "{res}");
        let message = res["error"]["message"].as_str().unwrap();
        assert!(message.contains("no_such_tool"), "{message}");
        assert!(message.contains("workspace_info"), "{message}");
    }

    #[tokio::test]
    async fn the_codex_gateway_list_tools_filters_by_name_substring() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(
                1,
                "tools/call",
                json!({ "name": "list_tools", "arguments": { "filter": "ECHO" } }),
            ),
        )
        .await;
        let tools = res["result"]["structuredContent"]["tools"]
            .as_array()
            .unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["echo_workspace"], "{res}");
    }

    #[tokio::test]
    async fn the_codex_gateway_instructions_point_at_the_catalogue() {
        let h = host(&[(1, "tok", Some(AgentKind::Codex))]);
        let res = call(
            &h,
            "tok",
            rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" })),
        )
        .await;
        let instructions = res["result"]["instructions"].as_str().unwrap_or_default();
        assert!(instructions.contains("list_tools"), "{instructions}");
        assert!(instructions.contains("call_tool"), "{instructions}");
    }

    #[tokio::test]
    async fn a_non_codex_scope_never_sees_the_gateway() {
        let h = host(&[(1, "tok", Some(AgentKind::Claude))]);
        let res = call(&h, "tok", rpc(1, "tools/list", json!({}))).await;
        let names: Vec<&str> = res["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"workspace_info"), "{res:?}");
        assert!(names.contains(&"echo_workspace"), "{res:?}");
        assert!(
            !names.contains(&"list_tools") && !names.contains(&"call_tool"),
            "a non-gateway scope must never see the meta-tools: {res:?}"
        );

        let init = call(
            &h,
            "tok",
            rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" })),
        )
        .await;
        assert!(
            init["result"]
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty(),
            "no provider here has instructions, and the gateway must not add any: {init}"
        );
    }
}

struct HttpResponse {
    status: u16,
    content_type: String,
    body: String,
}

impl HttpResponse {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|e| panic!("body was not JSON ({e}): {:?}", self.body))
    }

    fn sse_messages(&self) -> Vec<Value> {
        assert!(
            self.content_type.contains("text/event-stream"),
            "expected an SSE response, got content-type {:?}: {:?}",
            self.content_type,
            self.body
        );
        self.body
            .split("\n\n")
            .map(str::trim)
            .filter(|frame| !frame.is_empty())
            .map(|frame| {
                let data = frame
                    .strip_prefix("data: ")
                    .unwrap_or_else(|| panic!("SSE frame has no \"data: \" prefix: {frame:?}"));
                serde_json::from_str(data)
                    .unwrap_or_else(|e| panic!("SSE frame data was not JSON ({e}): {data:?}"))
            })
            .collect()
    }
}

fn dechunk(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some((size_line, after_size)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.trim(), 16)
            .unwrap_or_else(|e| panic!("bad chunk size line {size_line:?} in {raw:?}: {e}"));
        if size == 0 {
            break;
        }
        out.push_str(&after_size[..size]);
        rest = &after_size[size + 2..];
    }
    out
}

async fn request(
    addr: std::net::SocketAddr,
    method: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> HttpResponse {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let mut head = format!(
        "{method} /mcp HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("no header/body split in response: {text:?}"));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("no status code in response head: {head:?}"));
    let content_type = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default();
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = if chunked {
        dechunk(body)
    } else {
        body.to_string()
    };
    HttpResponse {
        status,
        content_type,
        body,
    }
}

async fn post(addr: std::net::SocketAddr, token: &str, body: Value) -> HttpResponse {
    request(addr, "POST", Some(token), Some(body)).await
}

fn rpc(id: u32, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

struct SlowTool(std::time::Duration);

impl SlowTool {
    fn specs() -> Vec<houston_core::mcp_server::ToolSpec> {
        vec![houston_core::mcp_server::ToolSpec {
            name: "slow_tool".into(),
            title: "Slow tool".into(),
            description: "Sleeps before answering; exists for progress-notification tests.".into(),
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            annotations: houston_core::mcp_server::Annotations::readonly(),
        }]
    }
}

impl houston_core::mcp_server::ToolProvider for SlowTool {
    fn tools(&self, _scope: &McpScope) -> Vec<houston_core::mcp_server::ToolSpec> {
        Self::specs()
    }

    fn all_tools(&self) -> Vec<houston_core::mcp_server::ToolSpec> {
        Self::specs()
    }

    fn call<'a>(
        &'a self,
        _scope: &'a McpScope,
        _name: &'a str,
        _args: &'a Value,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<houston_core::mcp_server::ToolOutput, houston_core::mcp_server::ToolError>,
    > {
        Box::pin(async move {
            tokio::time::sleep(self.0).await;
            Ok(houston_core::mcp_server::ToolOutput::text("done"))
        })
    }
}

#[tokio::test]
async fn tools_call_with_progress_token_streams_notifications_then_the_final_response() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    daemon.mcp_tools.register(std::sync::Arc::new(SlowTool(
        std::time::Duration::from_millis(300),
    )));
    daemon.set_mcp_progress_tick_for_test(std::time::Duration::from_millis(40));
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(
            9,
            "tools/call",
            json!({ "name": "slow_tool", "_meta": { "progressToken": "tok-1" } }),
        ),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    assert!(
        res.content_type.contains("text/event-stream"),
        "a progressToken must upgrade the response to SSE: {:?}",
        res.content_type
    );
    let messages = res.sse_messages();
    let (notifications, final_messages): (Vec<&Value>, Vec<&Value>) = messages
        .iter()
        .partition(|m| m["method"] == "notifications/progress");
    assert!(
        !notifications.is_empty(),
        "no progress notification arrived before the final response: {messages:?}"
    );
    for note in &notifications {
        assert_eq!(note["params"]["progressToken"], "tok-1", "{note}");
        assert!(note["params"]["progress"].is_u64(), "{note}");
        assert!(
            note["params"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("confirmation"),
            "{note}"
        );
    }

    assert_eq!(
        final_messages.len(),
        1,
        "expected exactly one final response frame: {messages:?}"
    );
    let final_msg = final_messages[0];
    assert_eq!(final_msg["jsonrpc"], "2.0");
    assert_eq!(
        final_msg["id"], 9,
        "the final frame must name the original request id"
    );
    assert_eq!(final_msg["result"]["isError"], false, "{final_msg}");
}

#[tokio::test]
async fn tools_call_without_a_progress_token_gets_a_plain_json_response() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(1, "tools/call", json!({ "name": "workspace_info" })),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    assert!(
        res.content_type.contains("application/json"),
        "no progressToken must mean no SSE upgrade: {:?}",
        res.content_type
    );
    let value = res.json();
    assert_eq!(value["result"]["isError"], false, "{value}");
}

#[tokio::test]
async fn initialize_negotiates_and_names_the_server() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" })),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    let value = res.json();
    assert_eq!(value["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(value["result"]["serverInfo"]["name"], "houston");
    assert!(
        value["result"]["capabilities"]["tools"].is_object(),
        "the server must advertise the tools capability: {value}"
    );
    let instructions = value["result"]["instructions"]
        .as_str()
        .unwrap_or_else(|| panic!("the orchestration provider supplies instructions: {value}"));
    assert!(instructions.contains("Houston pane"), "{instructions}");
}

#[tokio::test]
async fn provider_instructions_reach_initialize_exactly_once() {
    struct Steering;
    impl houston_core::mcp_server::ToolProvider for Steering {
        fn tools(&self, _scope: &McpScope) -> Vec<houston_core::mcp_server::ToolSpec> {
            Vec::new()
        }
        fn instructions(&self, _scope: &McpScope) -> Option<String> {
            Some("Use the browser_* tools first.".to_string())
        }
        fn call<'a>(
            &'a self,
            _scope: &'a McpScope,
            name: &'a str,
            _args: &'a serde_json::Value,
        ) -> futures_util::future::BoxFuture<
            'a,
            Result<houston_core::mcp_server::ToolOutput, houston_core::mcp_server::ToolError>,
        > {
            Box::pin(async move {
                Err(houston_core::mcp_server::ToolError(format!(
                    "no tool {name:?}"
                )))
            })
        }
    }

    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    daemon.mcp_tools.register(std::sync::Arc::new(Steering));
    daemon.mcp_tools.register(std::sync::Arc::new(Steering));
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" })),
    )
    .await;
    let value = res.json();
    let instructions = value["result"]["instructions"]
        .as_str()
        .unwrap_or_else(|| panic!("initialize must carry the provider's instructions: {value}"));
    assert_eq!(
        instructions
            .matches("Use the browser_* tools first.")
            .count(),
        1,
        "registered twice, said once: {instructions}"
    );
}

#[tokio::test]
async fn an_unknown_protocol_revision_is_answered_not_refused() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(1, "initialize", json!({ "protocolVersion": "1999-01-01" })),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(
        res.json()["result"]["protocolVersion"],
        houston_core::mcp_server::PREFERRED_PROTOCOL,
        "an unknown revision must get our preferred one back, not an error"
    );
}

#[tokio::test]
async fn tools_list_carries_the_builtin_and_its_annotations() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(addr, &token, rpc(2, "tools/list", json!({}))).await;
    assert_eq!(res.status, 200, "{}", res.body);

    let value = res.json();
    let tools = value["result"]["tools"].as_array().unwrap();
    let info = tools
        .iter()
        .find(|t| t["name"] == "workspace_info")
        .unwrap_or_else(|| panic!("workspace_info missing from {value}"));
    assert_eq!(info["annotations"]["readOnlyHint"], true);
    assert_eq!(info["annotations"]["destructiveHint"], false);
    assert!(info["inputSchema"].is_object());
}

#[tokio::test]
async fn a_parentless_scope_in_a_disabled_workspace_is_not_shown_the_pane_tools() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(addr, &token, rpc(1, "tools/list", json!({}))).await;
    let value = res.json();
    let tools = value["result"]["tools"].as_array().unwrap();
    assert!(
        tools.iter().all(|t| t["name"] != "pane_spawn"),
        "no pane tool should be advertised to a disabled, parentless scope: {value}"
    );
    assert!(tools.iter().any(|t| t["name"] == "workspace_info"));
}

#[tokio::test]
async fn an_enabled_workspace_gets_the_full_pane_list() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let workspace = dir.path().display().to_string();
    daemon.workspace_add(&workspace).unwrap();
    daemon.orchestration_set(true).unwrap();
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: workspace,
    });

    let res = post(addr, &token, rpc(1, "tools/list", json!({}))).await;
    let value = res.json();
    let tools = value["result"]["tools"].as_array().unwrap();
    for name in [
        "pane_spawn",
        "pane_list",
        "pane_read",
        "pane_prompt",
        "pane_wait",
        "pane_kill",
    ] {
        assert!(
            tools.iter().any(|t| t["name"] == name),
            "{name} missing once the workspace has consented: {value}"
        );
    }
    assert!(
        tools.iter().all(|t| t["name"] != "pane_submit"),
        "pane_submit needs a parent to hand back to — a parentless pane \
         must not see the verb it can never use: {value}"
    );
}

#[tokio::test]
async fn a_tool_call_answers_with_the_credentials_own_workspace() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 42,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(3, "tools/call", json!({ "name": "workspace_info" })),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    let value = res.json();
    assert_eq!(value["result"]["isError"], false, "{value}");
    assert_eq!(
        value["result"]["structuredContent"]["workspace"],
        "/home/dev/proj"
    );
    assert_eq!(value["result"]["structuredContent"]["session_id"], 42);
}

#[tokio::test]
async fn two_credentials_never_see_each_others_workspace() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let a = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/alpha".into(),
    });
    let b = daemon.mcp_creds.issue(McpScope {
        session_id: 2,
        workspace_id: "/home/dev/beta".into(),
    });

    let call = json!({ "name": "workspace_info" });
    let res_a = post(addr, &a, rpc(1, "tools/call", call.clone())).await;
    let res_b = post(addr, &b, rpc(1, "tools/call", call)).await;

    assert_eq!(
        res_a.json()["result"]["structuredContent"]["workspace"],
        "/home/dev/alpha"
    );
    assert_eq!(
        res_b.json()["result"]["structuredContent"]["workspace"],
        "/home/dev/beta"
    );
}

#[tokio::test]
async fn a_request_with_no_token_is_refused() {
    let (addr, _dir, _daemon) = common::start_daemon_with_handle().await;
    let res = request(addr, "POST", None, Some(rpc(1, "tools/list", json!({})))).await;
    assert_eq!(res.status, 401, "{}", res.body);
    assert_eq!(res.json()["error"], "invalid_mcp_credential");
}

#[tokio::test]
async fn an_unknown_token_is_refused() {
    let (addr, _dir, _daemon) = common::start_daemon_with_handle().await;
    let res = post(addr, "not-a-real-token", rpc(1, "tools/list", json!({}))).await;
    assert_eq!(res.status, 401, "{}", res.body);
}

#[tokio::test]
async fn the_ws_token_is_not_an_mcp_credential() {
    let (addr, _dir, _daemon) = common::start_daemon_with_handle().await;
    let res = post(addr, common::TOKEN, rpc(1, "tools/list", json!({}))).await;
    assert_eq!(res.status, 401, "{}", res.body);
}

#[tokio::test]
async fn a_revoked_credential_stops_working() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 9,
        workspace_id: "/home/dev/proj".into(),
    });
    assert_eq!(
        post(addr, &token, rpc(1, "tools/list", json!({})))
            .await
            .status,
        200
    );

    daemon.mcp_creds.revoke_session(9);

    let res = post(addr, &token, rpc(2, "tools/list", json!({}))).await;
    assert_eq!(
        res.status, 401,
        "a revoked credential must stop working: {}",
        res.body
    );
}

#[tokio::test]
async fn an_unknown_tool_names_what_is_on_offer() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        rpc(1, "tools/call", json!({ "name": "definitely_not_a_tool" })),
    )
    .await;

    let value = res.json();
    let message = value["error"]["message"].as_str().unwrap();
    assert_eq!(value["error"]["code"], -32602, "{value}");
    assert!(
        message.contains("definitely_not_a_tool") && message.contains("workspace_info"),
        "the error must name the offending tool and the ones that exist: {message}"
    );
}

#[tokio::test]
async fn an_unknown_method_names_the_ones_implemented() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(addr, &token, rpc(1, "resources/list", json!({}))).await;
    let value = res.json();
    assert_eq!(value["error"]["code"], -32601, "{value}");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("tools/call"), "{message}");
}

#[tokio::test]
async fn a_notification_is_accepted_with_no_body() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;

    assert_eq!(res.status, 202, "{}", res.body);
}

#[tokio::test]
async fn a_json_rpc_batch_is_refused_by_name() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let res = post(
        addr,
        &token,
        json!([rpc(1, "tools/list", json!({})), rpc(2, "ping", json!({}))]),
    )
    .await;

    assert_eq!(res.status, 400, "{}", res.body);
    let message = res.json()["error"]["message"].as_str().unwrap().to_string();
    assert!(message.contains("batch"), "{message}");
}

#[tokio::test]
async fn get_needs_a_credential_and_delete_is_still_refused_by_name() {
    let (addr, _dir, _daemon) = common::start_daemon_with_handle().await;
    let res = request(addr, "GET", None, None).await;
    assert_eq!(res.status, 401, "{}", res.body);

    let res = request(addr, "DELETE", None, None).await;
    assert_eq!(res.status, 405, "{}", res.body);
    assert_eq!(res.json()["error"], "method_not_allowed");
    let message = res.json()["message"].as_str().unwrap().to_string();
    assert!(message.contains("POST"), "{message}");
    assert!(message.contains("GET"), "{message}");
}

#[tokio::test]
async fn the_listening_stream_cap_is_named_when_it_trips() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(open_listen_stream(addr, &token).await);
    }
    assert_eq!(daemon.mcp_notify.len(), 4);

    let res = request(addr, "GET", Some(&token), None).await;
    assert_eq!(res.status, 429, "{}", res.body);
    let message = res.json()["error"]["message"].as_str().unwrap().to_string();
    assert!(message.contains("limit is 4"), "names the cap: {message}");
    assert!(
        message.contains("already holds 4"),
        "names what is held: {message}"
    );
    drop(held);
}

#[tokio::test]
async fn malformed_json_is_a_parse_error_not_a_panic() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });

    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = "{not json";
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\
         Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw);
    assert!(text.contains("400"), "{text}");
    assert!(text.contains("-32700"), "{text}");
}

#[tokio::test]
async fn ping_answers() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/home/dev/proj".into(),
    });
    let res = post(addr, &token, rpc(7, "ping", json!({}))).await;
    assert_eq!(res.status, 200, "{}", res.body);
    assert_eq!(res.json()["id"], 7);
}

fn token_from_claude_launch(launch: &houston_core::mcp_launch::Launch) -> String {
    let idx = launch
        .args
        .iter()
        .position(|a| a == "--mcp-config")
        .expect("a Claude launch must carry --mcp-config");
    let config: Value = serde_json::from_str(&launch.args[idx + 1]).unwrap();
    config["mcpServers"]["houston"]["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn the_token_a_claude_spawn_carries_authenticates_for_its_own_workspace() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;

    let launch = daemon.mint_mcp_launch(
        77,
        houston_protocol::AgentKind::Claude,
        std::path::Path::new("/home/dev/spawned"),
    );
    let token = token_from_claude_launch(&launch);

    let res = post(
        addr,
        &token,
        rpc(1, "tools/call", json!({ "name": "workspace_info" })),
    )
    .await;

    assert_eq!(res.status, 200, "{}", res.body);
    let value = res.json();
    assert_eq!(
        value["result"]["structuredContent"]["workspace"],
        "/home/dev/spawned"
    );
    assert_eq!(value["result"]["structuredContent"]["session_id"], 77);
}

#[tokio::test]
async fn the_token_a_codex_spawn_exports_authenticates() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;

    let launch = daemon.mint_mcp_launch(
        78,
        houston_protocol::AgentKind::Codex,
        std::path::Path::new("/home/dev/codexproj"),
    );
    let token = launch
        .env
        .iter()
        .find(|(k, _)| k == houston_core::mcp_launch::CODEX_TOKEN_ENV)
        .map(|(_, v)| v.clone())
        .expect("Codex must export a token");

    let res = post(
        addr,
        &token,
        rpc(1, "tools/call", json!({ "name": "workspace_info" })),
    )
    .await;
    assert_eq!(
        res.json()["result"]["structuredContent"]["workspace"],
        "/home/dev/codexproj"
    );
}

#[tokio::test]
async fn a_shell_pane_mints_a_credential_that_authenticates() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;

    for agent in [
        houston_protocol::AgentKind::Shell,
        houston_protocol::AgentKind::Antigravity,
        houston_protocol::AgentKind::Custom,
    ] {
        let launch = daemon.mint_mcp_launch(1, agent, std::path::Path::new("/home/dev/x"));
        assert!(
            launch.args.is_empty(),
            "{agent:?} cannot be configured by flag: {:?}",
            launch.args
        );
        let token = launch
            .env
            .iter()
            .find(|(k, _)| k == houston_core::mcp_launch::CODEX_TOKEN_ENV)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("{agent:?} must export a token"));
        let res = post(
            addr,
            &token,
            rpc(1, "tools/call", json!({ "name": "workspace_info" })),
        )
        .await;
        assert_eq!(
            res.json()["result"]["structuredContent"]["workspace"],
            "/home/dev/x",
            "{agent:?}'s exported token must resolve to its own workspace"
        );
    }
}

#[tokio::test]
async fn an_ssh_pane_mints_no_credential() {
    let (_addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let before = daemon.mcp_creds.len();
    let launch = daemon.mint_mcp_launch(
        1,
        houston_protocol::AgentKind::Ssh,
        std::path::Path::new("/home/dev/x"),
    );
    assert!(launch.is_empty(), "{launch:?}");
    assert_eq!(
        daemon.mcp_creds.len(),
        before,
        "probing an SSH pane must not mint a credential"
    );
}

#[tokio::test]
async fn two_spawned_panes_are_scoped_apart() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;

    let alpha = token_from_claude_launch(&daemon.mint_mcp_launch(
        1,
        houston_protocol::AgentKind::Claude,
        std::path::Path::new("/home/dev/alpha"),
    ));
    let beta = token_from_claude_launch(&daemon.mint_mcp_launch(
        2,
        houston_protocol::AgentKind::Claude,
        std::path::Path::new("/home/dev/beta"),
    ));
    assert_ne!(alpha, beta, "two panes must not share a credential");

    let call = json!({ "name": "workspace_info" });
    assert_eq!(
        post(addr, &alpha, rpc(1, "tools/call", call.clone()))
            .await
            .json()["result"]["structuredContent"]["workspace"],
        "/home/dev/alpha"
    );
    assert_eq!(
        post(addr, &beta, rpc(1, "tools/call", call)).await.json()["result"]["structuredContent"]
            ["workspace"],
        "/home/dev/beta"
    );
}

#[tokio::test]
async fn respawning_a_session_id_retires_the_previous_credential() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let path = std::path::Path::new("/home/dev/proj");

    let first = token_from_claude_launch(&daemon.mint_mcp_launch(
        5,
        houston_protocol::AgentKind::Claude,
        path,
    ));
    let second = token_from_claude_launch(&daemon.mint_mcp_launch(
        5,
        houston_protocol::AgentKind::Claude,
        path,
    ));

    assert_eq!(
        post(addr, &first, rpc(1, "tools/list", json!({})))
            .await
            .status,
        401,
        "the superseded credential must stop working"
    );
    assert_eq!(
        post(addr, &second, rpc(1, "tools/list", json!({})))
            .await
            .status,
        200
    );
}

#[tokio::test]
#[ignore = "drives the real `claude` CLI; run manually with -- --ignored"]
async fn flagless_claude_connects_through_the_registered_user_scope_entry() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/tmp/ws".into(),
    });
    let endpoint = format!("http://{addr}");

    let scratch = tempfile::tempdir().unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", scratch.path());

    let outcome = houston_core::mcp_register::run(scratch.path(), std::path::Path::new("claude"))
        .await
        .expect("registration against the scratch config dir");
    assert!(outcome.contains("registered"), "{outcome}");

    let stored = std::fs::read_to_string(scratch.path().join(".claude.json")).unwrap();
    assert!(
        stored.contains("${HOUSTON_MCP_URL}"),
        "the stored entry must hold the placeholder, not a value: {stored}"
    );
    assert!(
        houston_core::mcp_register::decide(Some(&stored))
            == houston_core::mcp_register::Decision::AlreadyRegistered,
        "a second boot must see the entry the CLI wrote: {stored}"
    );

    let output = tokio::process::Command::new("claude")
        .args(["mcp", "list"])
        .env("CLAUDE_CONFIG_DIR", scratch.path())
        .env(houston_core::mcp_launch::URL_ENV, format!("{endpoint}/mcp"))
        .env(houston_core::mcp_launch::CODEX_TOKEN_ENV, &token)
        .output()
        .await
        .expect("running `claude mcp list`");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        text.contains("houston") && text.contains("Connected"),
        "`claude mcp list` with only the pane environment must reach this \
         daemon through the expanded entry; got:\n{text}"
    );
}

async fn open_listen_stream(addr: std::net::SocketAddr, token: &str) -> tokio::net::TcpStream {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let head = format!(
        "GET /mcp HTTP/1.1\r\nHost: {addr}\r\nAccept: text/event-stream\r\n\
         Authorization: Bearer {token}\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();
    let mut seen = Vec::new();
    let mut byte = [0u8; 1];
    while !seen.ends_with(b"\r\n\r\n") {
        let n = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read(&mut byte))
            .await
            .expect("timed out reading the listening stream's response head")
            .unwrap();
        assert!(
            n == 1,
            "listening stream closed before its head was complete"
        );
        seen.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&seen).into_owned();
    assert!(head.contains(" 200 "), "{head}");
    assert!(
        head.to_ascii_lowercase().contains("text/event-stream"),
        "{head}"
    );
    stream
}

async fn listen_until(stream: &mut tokio::net::TcpStream, needle: &str) -> String {
    let mut acc = String::new();
    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_else(|| panic!("timed out waiting for {needle:?}; read so far: {acc:?}"));
        let n = tokio::time::timeout(remaining, stream.read(&mut buf))
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; read so far: {acc:?}"))
            .unwrap();
        assert!(
            n > 0,
            "listening stream closed while waiting for {needle:?}: {acc:?}"
        );
        acc.push_str(&String::from_utf8_lossy(&buf[..n]));
        if acc.contains(needle) {
            return acc;
        }
    }
}

#[tokio::test]
async fn switching_orchestration_on_pushes_tools_list_changed_to_running_panes() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let ws = dir.path().join("consented");
    std::fs::create_dir_all(&ws).unwrap();
    let ws = ws.display().to_string();
    daemon.workspace_add(&ws).unwrap();

    let other = dir.path().join("elsewhere");
    std::fs::create_dir_all(&other).unwrap();
    let other = other.display().to_string();
    daemon.workspace_add(&other).unwrap();

    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: ws.clone(),
    });
    let bystander_token = daemon.mcp_creds.issue(McpScope {
        session_id: 2,
        workspace_id: other.clone(),
    });
    let mut listening = open_listen_stream(addr, &token).await;
    let mut bystander = open_listen_stream(addr, &bystander_token).await;

    let res = post(addr, &token, rpc(1, "tools/list", json!({}))).await;
    let names: Vec<String> = res.json()["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(!names.iter().any(|n| n == "pane_spawn"), "{names:?}");

    tokio::task::spawn_blocking({
        let daemon = std::sync::Arc::clone(&daemon);
        move || daemon.orchestration_set(true).unwrap()
    })
    .await
    .unwrap();

    let seen = listen_until(&mut listening, "notifications/tools/list_changed").await;
    assert!(seen.contains("\"jsonrpc\":\"2.0\""), "{seen}");

    let res = post(addr, &token, rpc(2, "tools/list", json!({}))).await;
    let tools = res.json()["result"]["tools"].as_array().unwrap().clone();
    assert!(
        tools.iter().any(|t| t["name"] == "pane_spawn"),
        "pane_spawn must be advertised once the switch is on: {}",
        res.body
    );

    let description = tools.iter().find(|t| t["name"] == "pane_list").unwrap()["description"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(description.contains("ORCHESTRATION IS ON"), "{description}");
    assert!(
        description.contains("4 of 4 child slots free"),
        "{description}"
    );
    assert!(description.contains("depth cap 1"), "{description}");

    listen_until(&mut bystander, "notifications/tools/list_changed").await;
}

#[tokio::test]
async fn the_global_switch_pushes_at_every_listening_pane() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let ws = dir.path().join("anywhere");
    std::fs::create_dir_all(&ws).unwrap();
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: ws.display().to_string(),
    });
    let mut listening = open_listen_stream(addr, &token).await;

    tokio::task::spawn_blocking({
        let daemon = std::sync::Arc::clone(&daemon);
        move || daemon.orchestration_set(false).unwrap()
    })
    .await
    .unwrap();

    listen_until(&mut listening, "notifications/tools/list_changed").await;
}

#[tokio::test]
async fn a_listening_stream_dies_with_its_session() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 77,
        workspace_id: "/home/dev/proj".into(),
    });
    let _stream = open_listen_stream(addr, &token).await;
    assert_eq!(daemon.mcp_notify.len(), 1);

    daemon.mcp_notify.close_session(77);
    assert_eq!(daemon.mcp_notify.len(), 0);
}

#[tokio::test]
async fn a_child_coming_or_going_pushes_tools_list_changed_at_its_parent() {
    let (addr, dir, daemon) = common::start_daemon_with_handle().await;
    let ws = dir.path().join("slots");
    std::fs::create_dir_all(&ws).unwrap();
    let ws = ws.display().to_string();
    daemon.workspace_add(&ws).unwrap();

    let parent = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: ws.clone(),
    });
    let sibling = daemon.mcp_creds.issue(McpScope {
        session_id: 2,
        workspace_id: ws.clone(),
    });
    let mut listening = open_listen_stream(addr, &parent).await;
    let mut bystander = open_listen_stream(addr, &sibling).await;

    daemon.mcp_notify.tools_changed_for_session(1);

    let seen = listen_until(&mut listening, "notifications/tools/list_changed").await;
    assert!(seen.contains("\"jsonrpc\":\"2.0\""), "{seen}");
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(300),
            listen_until(&mut bystander, "list_changed"),
        )
        .await
        .is_err(),
        "a pane whose own slots did not move must not be made to re-list"
    );
}

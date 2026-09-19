mod common;

use houston_core::mcp_creds::McpScope;
use houston_core::mcp_server::{
    Annotations, BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct ProbeTools;

impl ProbeTools {
    fn specs() -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "probe_read".into(),
                title: "Probe read".into(),
                description: "Always answers, shutdown or not.".into(),
                input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                annotations: Annotations::readonly(),
            },
            ToolSpec {
                name: "probe_write".into(),
                title: "Probe write".into(),
                description: "Would mutate something.".into(),
                input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                annotations: Annotations::destructive(),
            },
        ]
    }
}

impl ToolProvider for ProbeTools {
    fn tools(&self, _scope: &McpScope) -> Vec<ToolSpec> {
        Self::specs()
    }
    fn all_tools(&self) -> Vec<ToolSpec> {
        Self::specs()
    }
    fn call<'a>(
        &'a self,
        _scope: &'a McpScope,
        name: &'a str,
        _args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            match name {
                "probe_read" => Ok(ToolOutput::structured(json!({ "read": true }))),
                "probe_write" => Ok(ToolOutput::structured(json!({ "mutated": true }))),
                other => Err(ToolError(format!("no tool named {other:?}"))),
            }
        })
    }
}

async fn call_tool(addr: std::net::SocketAddr, token: &str, id: u32, name: &str) -> Value {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/mcp"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name },
        }))
        .send()
        .await
        .expect("posting /mcp tools/call");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    resp.json().await.expect("decoding JSON-RPC response")
}

#[tokio::test]
async fn shutdown_refuses_a_mutating_tool_and_still_answers_a_read_only_one() {
    let (addr, _dir, daemon) = common::start_daemon_with_handle().await;
    daemon.mcp_tools.register(Arc::new(ProbeTools));
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: 1,
        workspace_id: "/tmp".into(),
    });

    daemon.reap_set_exit_hook_for_test(Box::new(|| {}));
    daemon
        .manage_shutdown()
        .expect("shutdown with no live sessions must succeed");
    assert!(daemon.is_shutting_down());

    let read = call_tool(addr, &token, 1, "probe_read").await;
    assert_eq!(
        read["result"]["isError"],
        json!(false),
        "a read_only tool must still answer during shutdown: {read}"
    );

    let write = call_tool(addr, &token, 2, "probe_write").await;
    assert_eq!(
        write["result"]["isError"],
        json!(true),
        "a mutating tool must be refused during shutdown: {write}"
    );
    let text = write["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        text.contains("shutting down"),
        "the refusal must name why: {text:?}"
    );
}

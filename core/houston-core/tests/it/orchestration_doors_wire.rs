#![cfg(unix)]

use crate::common;

use houston_core::daemon::{CreateParams, Daemon};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::sync::Arc;

struct Rig {
    daemon: Arc<Daemon>,
    base: String,
    token: String,
    session: u32,
    _state: tempfile::TempDir,
}

impl Rig {
    async fn new() -> Self {
        let (addr, state, daemon) = common::start_daemon_with_handle().await;
        let workspace = state.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        daemon
            .workspace_add(&workspace.display().to_string())
            .unwrap();
        let pane = daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: workspace.clone(),
                cmd: Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
                model: None,
                effort: None,
            })
            .unwrap();
        let token = daemon.mcp_creds.issue(McpScope {
            session_id: pane.id,
            workspace_id: workspace.display().to_string(),
        });
        Self {
            daemon,
            base: format!("http://{addr}"),
            token,
            session: pane.id,
            _state: state,
        }
    }

    async fn post(&self, path: &str, payload: Value) -> (u16, Value) {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .json(&payload)
            .send()
            .await
            .unwrap();
        (response.status().as_u16(), response.json().await.unwrap())
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.daemon.kill(self.session);
    }
}

#[tokio::test]
async fn typed_http_doors_identify_invalid_payloads_and_values() {
    let rig = Rig::new().await;
    let (status, body) = rig
        .post("/orchestrate/prompt", json!({"session":1,"text":false}))
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("prompt payload: expected"));
    for (payload, offending) in [
        (json!({"child":0,"reason":"decision"}), "child 0"),
        (json!({"child":1,"reason":" \n"}), "reason"),
        (json!({"child":"bad","reason":"decision"}), "bad"),
        (json!({"child":1}), "reason"),
        (json!({"child":1,"reason":"x".repeat(2001)}), "2000"),
    ] {
        let (status, body) = rig.post("/orchestrate/escalate", payload).await;
        assert_eq!(status, 400, "{body}");
        let error = body["error"].as_str().unwrap();
        assert!(
            error.contains("escalate payload") && error.contains("expected"),
            "{error}"
        );
        assert!(error.contains(offending), "{error}");
    }
    for (payload, offending) in [
        (json!({"child":0,"episode_id":"id"}), "child 0"),
        (json!({"child":1,"episode_id":"../bad"}), "../bad"),
        (json!({"child":1,"episode_id":""}), "episode_id"),
        (json!({"child":1,"episode_id":"x".repeat(65)}), "1–64"),
        (json!({"child":"bad","episode_id":"id"}), "bad"),
        (json!({"child":1,"episode_id":false}), "false"),
        (json!({"child":1}), "episode_id"),
        (json!({"child":1,"episode_id":"id","extra":true}), "extra"),
    ] {
        let (status, body) = rig.post("/orchestrate/deny", payload).await;
        assert_eq!(status, 400, "{body}");
        let error = body["error"].as_str().unwrap();
        assert!(
            error.contains("deny payload") && error.contains("expected"),
            "{error}"
        );
        assert!(error.contains(offending), "{error}");
    }
    for path in [
        "/orchestrate/instruction-cancel",
        "/orchestrate/instruction-resume",
    ] {
        for (payload, offending) in [
            (json!({"session":1,"instruction_id":"../bad"}), "../bad"),
            (json!({"session":0,"instruction_id":"id"}), "session 0"),
            (json!({"session":1,"instruction_id":"x".repeat(65)}), "1–64"),
            (json!({"session":1}), "instruction_id"),
            (
                json!({"session":1,"instruction_id":"id","extra":true}),
                "extra",
            ),
        ] {
            let (status, body) = rig.post(path, payload).await;
            assert_eq!(status, 400, "{path}: {body}");
            let error = body["error"].as_str().unwrap();
            assert!(
                error.contains("payload") && error.contains("expected"),
                "{error}"
            );
            assert!(error.contains(offending), "{error}");
        }
    }
    for path in [
        "/orchestrate/instruction-list?session=bad",
        "/orchestrate/instruction-get?session=1",
        "/orchestrate/instruction-get?session=1&instruction_id=a%26session%3D2",
    ] {
        let response = reqwest::Client::new()
            .get(format!("{}{path}", rig.base))
            .bearer_auth(&rig.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 400, "{path}");
        let body: Value = response.json().await.unwrap();
        assert!(
            body["error"].as_str().unwrap().contains("expected"),
            "{body}"
        );
    }
}

#[tokio::test]
async fn http_doors_require_a_pane_credential() {
    let rig = Rig::new().await;
    for (method, path, body) in [
        (
            reqwest::Method::GET,
            "/orchestrate/instruction-list?session=1",
            None,
        ),
        (
            reqwest::Method::GET,
            "/orchestrate/instruction-get?session=1&instruction_id=id",
            None,
        ),
        (
            reqwest::Method::POST,
            "/orchestrate/instruction-cancel",
            Some(json!({"session":1,"instruction_id":"id"})),
        ),
        (
            reqwest::Method::POST,
            "/orchestrate/instruction-resume",
            Some(json!({"session":1,"instruction_id":"id"})),
        ),
        (
            reqwest::Method::POST,
            "/orchestrate/deny",
            Some(json!({"child":1,"episode_id":"provider:12:1"})),
        ),
        (
            reqwest::Method::POST,
            "/orchestrate/escalate",
            Some(json!({"child":1,"reason":"decision"})),
        ),
    ] {
        let mut request = reqwest::Client::new().request(method, format!("{}{path}", rig.base));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status().as_u16(), 401, "{path}");
    }
}

#[tokio::test]
async fn permission_doors_refuse_unrelated_panes() {
    let rig = Rig::new().await;
    for (path, payload) in [
        (
            "/orchestrate/deny",
            json!({"child":rig.session,"episode_id":"provider:12:1"}),
        ),
        (
            "/orchestrate/escalate",
            json!({"child":rig.session,"reason":"Operator decision"}),
        ),
    ] {
        let (status, body) = rig.post(path, payload).await;
        assert_ne!(status, 200, "{path}: {body}");
        assert!(body["error"].is_string(), "{body}");
    }
}

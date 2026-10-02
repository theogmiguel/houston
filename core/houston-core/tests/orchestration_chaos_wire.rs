#![cfg(unix)]

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const PROVIDERS: [&str; 6] = [
    "claude",
    "codex",
    "antigravity",
    "opencode",
    "cursor",
    "grok",
];
const SEEDS: [u64; 3] = [1, 42, 0x5eed];
// Covers the twelve-child concurrency case with spare capacity for nested fixtures.
const LIVE_CAP: u32 = 16;
// Fake waits request 20 seconds; allow one second for transport and log dispatch.
const CALL_LATENCY_MAX_US: u64 = 21_000_000;
// Serializes process-wide PATH/HOME isolation and limits simultaneous PTY fixtures.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<tempfile::TempDir> = OnceLock::new();

fn shim_dir() -> &'static Path {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        for name in ["claude", "codex", "agy", "opencode", "cursor-agent", "grok"] {
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_fake_agent"), dir.path().join(name))
                .unwrap();
        }
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path}", dir.path().display()));
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", home);
        dir
    })
    .path()
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    workspace: PathBuf,
    endpoint: String,
    tokens: std::sync::Mutex<std::collections::HashMap<u32, String>>,
    server: tokio::task::JoinHandle<()>,
    hooks: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
        self.hooks.abort();
        for session in self.daemon.list() {
            let _ = self.daemon.kill(session.id);
            let _ = self.daemon.close(session.id);
        }
    }
}

impl Rig {
    async fn new() -> Self {
        shim_dir();
        let state = tempfile::tempdir().unwrap();
        let home = state.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(state.path(), home.join(".houston-chaos")).unwrap();
        let workspace = state.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "chaos-test-token".into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        daemon.reap_set_exit_hook_for_test(Box::new(|| {}));
        daemon.workspace_add(workspace.to_str().unwrap()).unwrap();
        daemon.orchestration_set(true).unwrap();
        daemon.set_orchestration_caps(LIVE_CAP, 3).unwrap();
        let (addr, server) =
            houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
                .await
                .unwrap();
        daemon.set_port(addr.port());
        let hooks = tokio::spawn({
            let daemon = daemon.clone();
            async move {
                // Poll only hook drop receipts; inbox delivery remains exclusively on MCP.
                let mut interval = tokio::time::interval(Duration::from_millis(10));
                loop {
                    interval.tick().await;
                    daemon.hook_drop_tick_for_test();
                    daemon.delegation_watch_tick();
                }
            }
        });
        Self {
            daemon,
            state,
            workspace,
            endpoint: format!("http://{addr}/mcp"),
            tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
            server,
            hooks,
        }
    }

    fn pane(&self, agent: proto::AgentKind, cmd: Vec<String>) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent,
                project_dir: self.workspace.clone(),
                cmd: Some(cmd),
                cols: 80,
                rows: 24,
                cwd_from: None,
                shell_integration: false,
                auto_approve: false,
                acp: None,
                profile: None,
                prompt: None,
            })
            .unwrap()
            .id
    }

    fn parent(&self) -> u32 {
        self.pane(
            proto::AgentKind::Custom,
            vec!["sh".into(), "-c".into(), "stty -echo; exec cat".into()],
        )
    }

    async fn fake_parent(&self, provider: &str, seed: u64) -> u32 {
        let updates = self.daemon.subscribe();
        let script = self.script(
            provider,
            seed,
            "parent",
            json!([
                {"op":"stop"},{"op":"wait_prompt"},{"op":"hang"}
            ]),
        );
        let agent = serde_json::from_value(json!(provider)).unwrap();
        let parent = self.pane(
            agent,
            vec![
                env!("CARGO_BIN_EXE_fake_agent").into(),
                format!("@fake:{}", script.display()),
            ],
        );
        self.wait_for_initial_stop(parent, updates).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if self.daemon.session_status(parent).unwrap() == Some(proto::AgentStatus::Idle)
                && self
                    .logs()
                    .iter()
                    .any(|e| e["event"] == "step" && e["data"]["op"] == "wait_prompt")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fake parent did not become idle: {:?}",
                self.logs()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        parent
    }

    async fn wait_for_initial_stop(
        &self,
        session: u32,
        mut updates: tokio::sync::broadcast::Receiver<houston_core::daemon::Outbound>,
    ) {
        tokio::time::timeout(Duration::from_secs(20), async move {
            let mut working = false;
            loop {
                let event = updates.recv().await.unwrap();
                if let houston_core::daemon::Outbound::Control(text) = event {
                    if let proto::ServerMsg::AgentStatus {
                        session: id,
                        status,
                    } = serde_json::from_str(&text).unwrap()
                    {
                        if id == session {
                            if status == proto::AgentStatus::Working {
                                working = true;
                            } else if working && status == proto::AgentStatus::Idle {
                                break;
                            }
                        }
                    }
                }
            }
        })
        .await
        .expect("fake CLI's initial prompt and Stop hooks were not applied");
    }

    fn token(&self, session: u32) -> String {
        self.tokens
            .lock()
            .unwrap()
            .entry(session)
            .or_insert_with(|| {
                self.daemon.mcp_creds.issue(McpScope {
                    session_id: session,
                    workspace_id: self.workspace.display().to_string(),
                })
            })
            .clone()
    }

    async fn raw_call(&self, session: u32, tool: &str, args: Value) -> Value {
        let (wire_tool, args) = if self.daemon.agent_kind_of(session)
            == Some(proto::AgentKind::Codex)
            && matches!(
                tool,
                "pane_spawn" | "pane_send_keys" | "pane_prompt" | "pane_kill"
            ) {
            ("call_tool", json!({"name":tool,"args":args}))
        } else {
            (tool, args)
        };
        let response: Value = reqwest::Client::builder().no_proxy().build().unwrap()
            .post(&self.endpoint).bearer_auth(self.token(session))
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":wire_tool,"arguments":args}}))
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        assert!(response.get("error").is_none(), "{tool}: {response}");
        response["result"].clone()
    }

    async fn call(&self, session: u32, tool: &str, args: Value) -> Value {
        let result = self.raw_call(session, tool, args).await;
        assert_ne!(result["isError"], true, "{tool}: {result}");
        result["structuredContent"].clone()
    }

    fn script(&self, provider: &str, seed: u64, name: &str, steps: Value) -> PathBuf {
        let path = self.state.path().join(format!("{name}.json"));
        std::fs::write(
            &path,
            json!({"provider":provider,"seed":seed,"home":self.state.path().join("home"),
            "helper":env!("CARGO_BIN_EXE_tr-helper"),
            "fixtures":Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hooks"),
            "log":self.state.path().join(format!("{name}.jsonl")),"steps":steps})
            .to_string(),
        )
        .unwrap();
        path
    }

    async fn spawn(&self, parent: u32, provider: &str, script: &Path, extra: Value) -> u32 {
        let mut args =
            json!({"kind":provider,"prompt":format!("@fake:{}",script.display()),"reusable":true});
        for (key, value) in extra.as_object().unwrap() {
            args[key] = value.clone();
        }
        self.call(parent, "pane_spawn", args).await["session"]
            .as_u64()
            .unwrap() as u32
    }

    async fn wait(&self, parent: u32, child: u32) -> Vec<Value> {
        let reply = self
            .raw_call(
                parent,
                "pane_wait",
                json!({"session":child,"timeout_ms":20000}),
            )
            .await;
        assert_ne!(reply["isError"], true, "{reply}");
        let result = &reply["structuredContent"];
        let text = reply["content"][0]["text"].as_str().unwrap();
        let persisted = self.daemon.inbox_rows_for_test(parent);
        for row in result["rows"].as_array().unwrap() {
            let saved = persisted
                .iter()
                .find(|saved| Some(saved.id) == row["id"].as_i64())
                .unwrap();
            assert!(
                text.contains(saved.body.trim()),
                "MCP text lost row {}'s body",
                saved.id
            );
        }
        assert_ne!(
            result["timed_out"],
            true,
            "child {child} timed out; logs: {:?}",
            self.logs()
        );
        result["rows"].as_array().unwrap().clone()
    }

    fn logs(&self) -> Vec<Value> {
        let mut events = Vec::new();
        for entry in std::fs::read_dir(self.state.path()).unwrap().flatten() {
            if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                let mut previous = 0;
                let mut call: Option<(String, u64)> = None;
                let text = std::fs::read_to_string(entry.path()).unwrap();
                let complete = text.rsplit_once('\n').map_or("", |(complete, _)| complete);
                for line in complete.lines() {
                    let event: Value = serde_json::from_str(line).unwrap();
                    let stamp = event["us"].as_u64().unwrap();
                    assert!(
                        stamp >= previous,
                        "non-monotonic event log {}",
                        entry.path().display()
                    );
                    previous = stamp;
                    if event["event"] == "call" {
                        call = Some((event["data"]["tool"].as_str().unwrap().to_string(), stamp));
                    } else if event["event"] == "reply" {
                        let (tool, began) = call.take().expect("reply without a logged call");
                        assert_eq!(event["data"]["tool"], tool);
                        assert!(
                            stamp - began <= CALL_LATENCY_MAX_US,
                            "fake {tool} exceeded the 20-second wait/transport budget: {} us",
                            stamp - began
                        );
                    }
                    events.push(event);
                }
            }
        }
        events
    }

    fn check(&self, parent: u32, deliveries: &[(u32, Vec<Value>)], expected_kind: &str) {
        let db = rusqlite::Connection::open(self.state.path().join("test.db")).unwrap();
        let mut ids = std::collections::HashSet::new();
        for (child, delivered) in deliveries {
            let mut previous = 0;
            for row in delivered.iter().filter(|row| row["kind"] == expected_kind) {
                let id = row["id"].as_i64().unwrap();
                assert!(ids.insert(id), "duplicate delivery {id}");
                assert!(id > previous, "out-of-order result for child {child}");
                previous = id;
                let (to, from, via, confirmed): (u32,u32,String,Option<i64>) = db.query_row(
                    "SELECT to_session,from_session,delivered_via,delivered_at FROM pane_inbox WHERE id=?1",[id],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
                assert_eq!((to, from, via.as_str()), (parent, *child, "wait"));
                assert!(confirmed.is_some(), "undelivered wait {id}");
            }
            let count: usize = db.query_row("SELECT COUNT(*) FROM pane_inbox WHERE from_session=?1 AND kind=?2 AND superseded=0",rusqlite::params![child,expected_kind],|r|r.get(0)).unwrap();
            assert_eq!(
                count,
                delivered
                    .iter()
                    .filter(|r| r["kind"] == expected_kind)
                    .count(),
                "unresolved child {child}: delivered={delivered:?}; logs={:?}",
                self.logs()
            );
            assert!(
                count > 0,
                "no {expected_kind} for child {child}; delivered={delivered:?}; logs={:?}",
                self.logs()
            );
        }
        let active_parents: usize = db.query_row(
            "SELECT COUNT(*) FROM (SELECT parent_session FROM delegations WHERE state='working' GROUP BY parent_session HAVING COUNT(*)>?1)",
            [LIVE_CAP],|r|r.get(0)).unwrap();
        assert_eq!(
            active_parents, 0,
            "configured live-child cap {LIVE_CAP} exceeded"
        );
        for info in self.daemon.list() {
            if !info.state.is_live() {
                if let Some(row) = self.daemon.delegation_of(info.id) {
                    assert_ne!(row.state, "working", "dead child {} left working", info.id);
                }
            }
        }
        let operator: usize = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE to_session=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(operator, 0, "live parent results must never reach operator");
        for event in self.logs() {
            assert_ne!(event["event"], "error", "{event}");
        }
    }
}

async fn scenario(provider: &str, seed: u64, name: &str, count: usize) {
    let r = Rig::new().await;
    let parent = r.parent();
    let mut children = Vec::new();
    let other = r.state.path().join("other-workspace");
    if name == "cross_workspace" {
        std::fs::create_dir_all(&other).unwrap();
        r.daemon.workspace_add(other.to_str().unwrap()).unwrap();
    }
    for index in 0..count {
        let summary = format!("RESULT-{seed}-{index}");
        let body_bytes = if index + 1 == count {
            houston_core::orchestrate::SUBMIT_BODY_MAX_CHARS - summary.len()
        } else {
            index * 1599
        };
        let steps = match name {
            "child_crash" => json!([{"op":"crash"}]),
            _ => json!([
                {"op":"wait_file","path":r.state.path().join("release-children")},
                {"op":"think","ms":seed % 13},
                {"op":"submit","summary":summary,"bytes":body_bytes}
            ]),
        };
        let script = r.script(
            provider,
            seed.wrapping_add(index as u64),
            &format!("child-{index}"),
            steps,
        );
        let extra = if name == "cross_workspace" {
            json!({"target_workspace":other})
        } else {
            json!({})
        };
        children.push(r.spawn(parent, provider, &script, extra).await);
    }
    std::fs::write(r.state.path().join("release-children"), b"").unwrap();
    let mut deliveries = Vec::new();
    for child in children {
        if name == "cross_workspace" {
            let info = r.daemon.list().into_iter().find(|s| s.id == child).unwrap();
            assert_eq!(info.spawned_by, Some(parent));
            assert_eq!(info.project_dir, other.display().to_string());
        }
        let rows = r.wait(parent, child).await;
        let repeat = r
            .call(parent, "pane_wait", json!({"session":child,"timeout_ms":1}))
            .await;
        assert_eq!(
            repeat["timed_out"], true,
            "duplicate result delivered for child {child}: {repeat}"
        );
        deliveries.push((child, rows));
    }
    r.check(
        parent,
        &deliveries,
        if name == "child_crash" {
            "exited"
        } else {
            "result"
        },
    );
    if name != "child_crash" {
        let submitted = r
            .logs()
            .iter()
            .filter(|e| e["event"] == "reply" && e["data"]["tool"] == "pane_submit")
            .count();
        assert_eq!(submitted, count, "one successful submission per child");
        for (child, _) in &deliveries {
            let delegation = r.daemon.delegation_of(*child).unwrap();
            assert!(delegation.settled_at.is_some());
            assert!(delegation.retained_until.is_some());
        }
    }
}

async fn nesting(provider: &str, seed: u64, background: bool) {
    let r = Rig::new().await;
    let root = r.parent();
    let grandchild = r.script(
        provider,
        seed,
        "grandchild",
        json!([
            {"op":"think","ms":if background {300} else {seed%17}},{"op":"submit","summary":"GRANDCHILD","bytes":100}
        ]),
    );
    let mut steps = vec![
        json!({"op":"spawn","args":{"kind":provider,"prompt":format!("@fake:{}",grandchild.display()),"reusable":true}}),
    ];
    if background {
        steps.push(json!({"op":"background_wait","ms":30}));
    }
    steps.extend([
        json!({"op":"wait_all"}),
        json!({"op":"submit","summary":"CHILD","bytes":0}),
    ]);
    let child_script = r.script(provider, seed, "child", json!(steps));
    let child = r.spawn(root, provider, &child_script, json!({})).await;
    let rows = r.wait(root, child).await;
    r.check(root, &[(child, rows)], "result");
    let logs = r.logs();
    let waits: Vec<_> = logs
        .iter()
        .filter(|e| e["event"] == "reply" && e["data"]["tool"] == "pane_wait")
        .collect();
    assert_eq!(waits.len(), 1, "one blocking wait for one nested result");
    assert_eq!(
        waits[0]["data"]["result"]["rows"][0]["summary"],
        "GRANDCHILD"
    );
    assert_eq!(
        logs.iter()
            .filter(|e| e["event"] == "call" && e["data"]["tool"] == "pane_wait")
            .count(),
        if background { 2 } else { 1 }
    );
}

async fn parent_crash(provider: &str, seed: u64, ancestor_alive: bool) {
    let r = Rig::new().await;
    let root = r.parent();
    let parent_script = r.script(provider, seed, "parent", json!([{"op":"hang"}]));
    let parent = r.spawn(root, provider, &parent_script, json!({})).await;
    let script = r.script(
        provider,
        seed,
        "child",
        json!([
            {"op":"think","ms":250},{"op":"submit","summary":"ORPHAN-RESULT","bytes":seed%100}
        ]),
    );
    let child = r.spawn(parent, provider, &script, json!({})).await;
    r.daemon.kill(parent).unwrap();
    if ancestor_alive {
        let rows = r.wait(root, child).await;
        r.check(root, &[(child, rows)], "result");
        let row = r
            .daemon
            .inbox_rows_for_test(root)
            .into_iter()
            .find(|row| row.from_session == Some(child) && row.kind == "result")
            .unwrap();
        assert_eq!(row.original_to, Some(parent));
        assert!(
            !r.daemon
                .inbox_rows_for_test(root)
                .iter()
                .any(|row| { row.from_session == Some(child) && row.kind == "no_handback" }),
            "a rerouted handback must not produce a false no_handback"
        );
    } else {
        r.daemon.kill(root).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let rows = r.daemon.inbox_rows_for_test(0);
            if let Some(row) = rows.iter().find(|row| {
                row.from_session == Some(child) && row.kind == "result" && row.ready_at.is_some()
            }) {
                assert_eq!(row.original_to, Some(parent));
                assert_eq!(
                    rows.iter()
                        .filter(|row| row.from_session == Some(child) && row.kind == "result")
                        .count(),
                    1
                );
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "orphan result missing: {:?}",
                r.logs()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

async fn interrupted_wait(provider: &str, seed: u64) {
    let r = Rig::new().await;
    let parent = r.parent();
    let release = r.state.path().join("release-after-disconnect");
    let script = r.script(
        provider,
        seed,
        "child",
        json!([
            {"op":"wait_file","path":release},{"op":"submit","summary":"AFTER-DISCONNECT","bytes":0}
        ]),
    );
    let child = r.spawn(parent, provider, &script, json!({})).await;
    let headers = reqwest::Client::builder().no_proxy().timeout(Duration::from_millis(30)).build().unwrap()
        .post(&r.endpoint).bearer_auth(r.token(parent))
        .json(&json!({"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"pane_wait","arguments":{"session":child,"timeout_ms":20000}}}))
        .send().await;
    let response = match headers {
        Ok(response) => response.json::<Value>().await,
        Err(error) => Err(error),
    };
    assert!(response.is_err(), "the abandoned wait must disconnect");
    std::fs::write(release, b"").unwrap();
    let rows = r.wait(parent, child).await;
    r.check(parent, &[(child, rows)], "result");
}

async fn retention(provider: &str, seed: u64) {
    let r = Rig::new().await;
    let parent = r.parent();
    let script = r.script(
        provider,
        seed,
        "child",
        json!([{"op":"submit","summary":"RETAINED","bytes":seed%30}]),
    );
    let child = r
        .spawn(parent, provider, &script, json!({"reusable":false}))
        .await;
    let rows = r.wait(parent, child).await;
    r.check(parent, &[(child, rows)], "result");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if r.daemon
            .list()
            .iter()
            .any(|s| s.id == child && s.state == proto::SessionState::Exited)
        {
            break;
        }
        r.daemon.delegation_watch_tick();
        assert!(
            tokio::time::Instant::now() < deadline,
            "child {child} never settled"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        !r.daemon.scrollback(child, None).unwrap().data.is_empty(),
        "settled scrollback persisted"
    );
    let retained = r
        .daemon
        .delegation_of(child)
        .unwrap()
        .retained_until
        .unwrap();
    r.daemon
        .delegation_watch_tick_with_clocks_for_test(0, retained + 1);
    assert!(
        !r.daemon.list().iter().any(|s| s.id == child),
        "expired retained child remains"
    );
}

async fn caps(provider: &str, seed: u64) {
    let r = Rig::new().await;
    r.daemon.set_orchestration_caps(1, 1).unwrap();
    let parent = r.parent();
    let script = r.script(provider, seed, "child", json!([{"op":"hang"}]));
    r.spawn(parent, provider, &script, json!({})).await;
    let refusal = r
        .raw_call(
            parent,
            "pane_spawn",
            json!({"kind":provider,"prompt":format!("@fake:{}",script.display())}),
        )
        .await;
    assert_eq!(refusal["isError"], true);
    let message = refusal["content"][0]["text"].as_str().unwrap();
    for expected in ["spawn refused", "1 live children", "cap 1"] {
        assert!(message.contains(expected), "missing {expected}: {message}");
    }
    assert_eq!(r.daemon.list().len(), 2, "refused spawn created a session");
}

async fn paste_recovery(provider: &str, seed: u64, hold: bool) {
    let r = Rig::new().await;
    let parent = r.fake_parent(provider, seed).await;
    if hold {
        r.daemon
            .note_operator_keystroke(parent, b"unfinished composer");
        r.daemon
            .write_stdin(parent, b"unfinished composer")
            .unwrap();
    }
    let script = r.script(
        provider,
        seed,
        "child",
        json!([{"op":"submit","summary":"PASTE-RESULT","bytes":seed%100}]),
    );
    let child = r.spawn(parent, provider, &script, json!({})).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if r.daemon
            .inbox_rows_for_test(parent)
            .iter()
            .any(|row| row.from_session == Some(child) && row.ready_at.is_some())
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "child never made result ready: {:?}",
            r.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if !hold {
        r.daemon.fail_next_stdin_write_after_for_test(parent, 12);
    }
    if hold {
        assert!(r.daemon.paste_hold_reason(parent).is_some());
        r.daemon.drain_pending_inbox(parent);
        assert!(r
            .daemon
            .inbox_rows_for_test(parent)
            .iter()
            .all(|row| row.delivered_at.is_none()));
    } else {
        r.daemon.inbox_deliver_now(parent).unwrap();
    }
    let rows = r.wait(parent, child).await;
    r.check(parent, &[(child, rows)], "result");
    assert_eq!(r.daemon.inbox_rows_for_test(0).len(), 0);
}

async fn paste_idle(provider: &str, seed: u64) {
    let r = Rig::new().await;
    let parent = r.fake_parent(provider, seed).await;
    let script = r.script(
        provider,
        seed,
        "child",
        json!([{"op":"submit","summary":"IDLE-PASTE","bytes":seed%100}]),
    );
    let child = r.spawn(parent, provider, &script, json!({})).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if r.daemon
            .inbox_rows_for_test(parent)
            .iter()
            .any(|row| row.from_session == Some(child) && row.ready_at.is_some())
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "result never ready: {:?}",
            r.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    r.daemon.inbox_deliver_now(parent).unwrap();
    loop {
        let received = r.logs().iter().any(|event| {
            event["event"] == "prompt"
                && event["data"]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("IDLE-PASTE"))
        });
        if let Some(row) = r.daemon.inbox_rows_for_test(parent).iter().find(|row| {
            row.from_session == Some(child)
                && row.delivered_at.is_some()
                && (matches!(provider, "antigravity" | "opencode") || row.confirmed_at.is_some())
                && received
        }) {
            assert_eq!(row.delivered_via.as_deref(), Some("paste"));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "paste never confirmed: {:?}; logs={:?}",
            r.daemon.inbox_rows_for_test(parent),
            r.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let duplicate = r
        .call(parent, "pane_wait", json!({"session":child,"timeout_ms":1}))
        .await;
    assert_eq!(duplicate["timed_out"], true);
}

async fn concurrency(provider: &str, seed: u64) {
    let r = Rig::new().await;
    let other = r.state.path().join("other-workspace");
    std::fs::create_dir_all(&other).unwrap();
    r.daemon.workspace_add(other.to_str().unwrap()).unwrap();
    let roots = [r.parent(), r.parent(), r.parent()];
    let unrelated = r.parent();
    let mut pending = Vec::new();
    for (group, parent) in roots.iter().enumerate() {
        for index in 0..4 {
            let script = r.script(provider,seed+index,&format!("child-{group}-{index}"),json!([
                {"op":"think","ms":seed%13},{"op":"submit","summary":format!("GROUP-{group}-{index}"),"bytes":index*1024}
            ]));
            pending.push((
                *parent,
                script,
                if group % 2 == 1 {
                    json!({"target_workspace":other})
                } else {
                    json!({})
                },
            ));
        }
    }
    let spawns = pending
        .iter()
        .map(|(parent, script, extra)| r.spawn(*parent, provider, script, extra.clone()));
    let started = Instant::now();
    let (children, input) = tokio::join!(futures_util::future::join_all(spawns), async {
        r.daemon.write_stdin(unrelated, b"UNRELATED-INPUT\n")
    });
    input.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "spawn liveness deadline exceeded"
    );
    for (parent, group) in roots.iter().zip(children.chunks(4)) {
        let mut deliveries = Vec::new();
        for child in group {
            deliveries.push((*child, r.wait(*parent, *child).await));
        }
        r.check(*parent, &deliveries, "result");
    }
    assert!(
        String::from_utf8_lossy(&r.daemon.scrollback(unrelated, None).unwrap().data)
            .contains("UNRELATED-INPUT")
    );
}

async fn needs_input(provider: &str, seed: u64) {
    if provider == "cursor" {
        eprintln!("SKIP needs_input provider=cursor: no supported lifecycle event fixture");
        return;
    }
    let r = Rig::new().await;
    let parent = r.parent();
    let script = r.script(
        provider,
        seed,
        "child",
        json!([
            {"op":"ask"},{"op":"submit","summary":"ANSWERED","bytes":0}
        ]),
    );
    let extra = if provider == "codex" {
        json!({"auto_approve":false})
    } else {
        json!({})
    };
    let child = r.spawn(parent, provider, &script, extra).await;
    let rows = r.wait(parent, child).await;
    assert!(
        rows.iter().any(|r| r["kind"] == "needs_input"),
        "expected question: {rows:?}"
    );
    assert_eq!(
        r.daemon.session_status(child).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );
    r.daemon
        .delegation_watch_tick_at(houston_core::daemon::now_ms() + 60000);
    assert_eq!(
        r.daemon.session_status(child).unwrap(),
        Some(proto::AgentStatus::NeedsInput)
    );
    let timed_out = r
        .call(parent, "pane_wait", json!({"session":child,"timeout_ms":1}))
        .await;
    assert_eq!(
        timed_out["timed_out"], true,
        "unanswered question stays visible"
    );
    if provider == "grok" {
        eprintln!("PARTIAL needs_input provider=grok: visibility verified; no captured resolution fixture");
        r.check(parent, &[(child, rows)], "needs_input");
        return;
    }
    r.call(
        parent,
        "pane_send_keys",
        json!({"session":child,"keys":["y","enter"]}),
    )
    .await;
    let rows = r.wait(parent, child).await;
    r.check(parent, &[(child, rows)], "result");
}

async fn ordered_rounds(provider: &str, seed: u64) {
    let r = Rig::new().await;
    let parent = r.parent();
    let script = r.script(
        provider,
        seed,
        "child",
        json!([
            {"op":"submit","summary":"FIRST","bytes":0},
            {"op":"wait_prompt"},
            {"op":"submit","summary":"SECOND","bytes":seed%100,"request_id":2}
        ]),
    );
    let child = r.spawn(parent, provider, &script, json!({})).await;
    let mut rows = r.wait(parent, child).await;
    assert_eq!(rows[0]["summary"], "FIRST");
    r.call(
        parent,
        "pane_prompt",
        json!({"session":child,"text":"next round"}),
    )
    .await;
    let second = r.wait(parent, child).await;
    assert_eq!(second[0]["summary"], "SECOND");
    rows.extend(second);
    r.check(parent, &[(child, rows)], "result");
}

async fn lane_full(provider: &str, seed: u64) {
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        provider,
        seed,
        "held-lane",
        json!([{"op":"stop"},{"op":"wait_prompt"},{"op":"hang"}]),
    );
    let updates = rig.daemon.subscribe();
    let child = rig.spawn(parent, provider, &script, json!({})).await;
    rig.wait_for_initial_stop(child, updates).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while rig.daemon.session_status(child).unwrap() != Some(proto::AgentStatus::Idle)
        || !rig
            .logs()
            .iter()
            .any(|event| event["event"] == "step" && event["data"]["op"] == "wait_prompt")
    {
        assert!(
            Instant::now() < deadline,
            "held composer did not become idle"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    rig.daemon
        .note_operator_keystroke(child, b"unfinished composer");
    rig.daemon
        .write_stdin(child, b"unfinished composer")
        .unwrap();
    for index in 0..16 {
        rig.daemon
            .orchestrate_prompt(parent, child, &format!("nudge-{seed}-{index}"))
            .unwrap();
    }
    let error = rig
        .daemon
        .orchestrate_prompt(parent, child, "refused-nudge")
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("16 nudges queued") && error.contains("limit is 16"),
        "{error}"
    );
    let result = rig
        .call(
            parent,
            "pane_wait",
            json!({"session":child,"kind":"operator_note","timeout_ms":20000}),
        )
        .await;
    let rows = result["rows"].as_array().unwrap().clone();
    assert_eq!(
        rows.iter()
            .filter(|row| row["reason"] == "lane_full")
            .count(),
        1
    );
    assert!(
        !rig.logs().iter().any(|event| event["event"] == "prompt"),
        "held lane accepted a prompt: {:?}",
        rig.logs()
    );
    rig.check(parent, &[(child, rows)], "operator_note");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn fast_provider_seed_matrix() {
    let _guard = SERIAL.lock().await;
    for name in [
        "fan_out",
        "child_crash",
        "cross_workspace",
        "nesting",
        "background_wait",
        "parent_crash",
        "ancestor_crash",
        "interrupted_wait",
        "retention",
        "needs_input",
        "ordered_rounds",
        "paste_partial",
        "paste_idle",
        "composer_hold",
        "lane_full",
        "concurrency",
        "caps",
    ] {
        if std::env::var("HOUSTON_CHAOS_SCENARIO")
            .is_ok_and(|only| !only.split(',').any(|selected| selected == name))
        {
            continue;
        }
        for provider in PROVIDERS {
            if std::env::var("HOUSTON_CHAOS_PROVIDER").is_ok_and(|only| only != provider) {
                continue;
            }
            for seed in SEEDS {
                eprintln!("chaos scenario={name} provider={provider} seed={seed}");
                match name {
                    "nesting" => nesting(provider, seed, false).await,
                    "background_wait" => nesting(provider, seed, true).await,
                    "parent_crash" => parent_crash(provider, seed, false).await,
                    "ancestor_crash" => parent_crash(provider, seed, true).await,
                    "interrupted_wait" => interrupted_wait(provider, seed).await,
                    "retention" => retention(provider, seed).await,
                    "needs_input" => needs_input(provider, seed).await,
                    "ordered_rounds" => ordered_rounds(provider, seed).await,
                    "paste_partial" => paste_recovery(provider, seed, false).await,
                    "paste_idle" => paste_idle(provider, seed).await,
                    "composer_hold" => paste_recovery(provider, seed, true).await,
                    "lane_full" => lane_full(provider, seed).await,
                    "concurrency" => concurrency(provider, seed).await,
                    "caps" => caps(provider, seed).await,
                    _ => {
                        scenario(provider, seed, name, if name == "fan_out" { 5 } else { 1 }).await
                    }
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "500 hermetic delegations; run explicitly for soak coverage"]
async fn soak_500_delegations() {
    let _guard = SERIAL.lock().await;
    let started = Instant::now();
    let base = std::env::var("HOUSTON_CHAOS_SEED")
        .ok()
        .map(|v| v.parse::<u64>().unwrap())
        .unwrap_or_else(rand::random);
    eprintln!("soak base_seed={base}");
    let mut random = base.max(1);
    for index in 0..100 {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let seed = random;
        let provider = PROVIDERS[(seed as usize) % PROVIDERS.len()];
        let name = if seed.is_multiple_of(7) {
            "child_crash"
        } else if seed.is_multiple_of(5) {
            "cross_workspace"
        } else {
            "fan_out"
        };
        eprintln!(
            "soak delegation={} provider={provider} seed={seed} scenario={name}",
            (index + 1) * 5
        );
        scenario(provider, seed, name, 5).await;
    }
    eprintln!(
        "soak delegations=500 failures=0 base_seed={base} elapsed={:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_non_live_stdin_refuses_without_reporting_delivery() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    rig.daemon.kill(parent).unwrap();
    let error = rig
        .daemon
        .write_stdin_counting(parent, b"lost prompt")
        .unwrap_err();
    assert!(error.nothing_written());
    assert!(error.to_string().contains("live"));
    rig.daemon
        .write_stdin_from_renderer(parent, b"ignored")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_rest_wait_confirms_the_completed_body_without_replaying_it() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        "claude",
        1,
        "rest-child",
        json!([{"op":"submit","summary":"REST-BODY","bytes":2048}]),
    );
    let child = rig.spawn(parent, "claude", &script, json!({})).await;
    let response: Value = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(rig.endpoint.replace("/mcp", "/orchestrate/wait"))
        .header("Connection", "close")
        .bearer_auth(rig.token(parent))
        .json(&json!({"session":child,"timeout_ms":20000}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(response["rows"][0]["body"]
        .as_str()
        .unwrap()
        .contains("REST-BODY"));
    let row = rig
        .daemon
        .inbox_rows_for_test(parent)
        .into_iter()
        .find(|row| row.from_session == Some(child) && row.kind == "result")
        .unwrap();
    assert!(
        row.delivered_at.is_some(),
        "a completed REST body was released instead of confirmed: {row:?}"
    );
    assert_eq!(row.delivered_via.as_deref(), Some("wait"));
    let repeated = rig
        .call(parent, "pane_wait", json!({"session":child,"timeout_ms":1}))
        .await;
    assert_eq!(
        repeated["timed_out"], true,
        "completed REST body replayed: {repeated}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_stop_confirmation_has_its_own_deadline() {
    let _serial = SERIAL.lock().await;
    let state = tempfile::tempdir().unwrap();
    let app = axum::Router::new()
        .route("/inbox/reserve", axum::routing::post(|| async {
            tokio::time::sleep(Duration::from_millis(190)).await;
            axum::Json(json!({"rows":[{"id":1}], "delivery_id":"receipt", "expires_at":houston_core::hook_drop::now_ms()+30000, "text":"answer"}))
        }))
        .route("/inbox/delivered", axum::routing::post(|| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            axum::Json(json!({"confirmed":1}))
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = state.path().to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        houston_core::spawn::command(env!("CARGO_BIN_EXE_tr-helper"))
            .args(["hook", "Stop", "--agent", "claude"])
            .env("HOME", home)
            .env("HOUSTON_CHANNEL", "chaos")
            .env("HOUSTON_SESSION", "123")
            .env("TR_SESSION", "123")
            .env("HOUSTON_MCP_URL", format!("http://{addr}/mcp"))
            .env("HOUSTON_MCP_TOKEN", "test-credential")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("block"));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("confirming reservation"), "{stderr}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_mcp_wait_carries_one_body_copy() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        "claude",
        42,
        "one-body",
        json!([{"op":"submit","summary":"one-copy","bytes":2048}]),
    );
    let child = rig.spawn(parent, "claude", &script, json!({})).await;
    let reply = rig
        .raw_call(
            parent,
            "pane_wait",
            json!({"session":child,"timeout_ms":20000}),
        )
        .await;
    assert_ne!(reply["isError"], true);
    assert!(reply["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("one-copy"));
    assert!(
        reply["structuredContent"]["rows"][0].get("body").is_none(),
        "{reply}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_a_partial_composer_submit_resolves_the_wait_only_row() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.fake_parent("claude", 42).await;
    rig.daemon
        .fail_next_stdin_write_after_for_test(parent, usize::MAX);
    let script = rig.script(
        "claude",
        42,
        "partial-full",
        json!([{"op":"submit","summary":"PARTIAL-FULL","bytes":1024}]),
    );
    let child = rig.spawn(parent, "claude", &script, json!({})).await;
    let db = rusqlite::Connection::open(rig.state.path().join("test.db")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let id = loop {
        let row: Option<(i64, Option<String>)> = db
            .query_row(
                "SELECT id,reason FROM pane_inbox WHERE from_session=?1 AND kind='result'",
                [child],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((id, Some(reason))) = row {
            if reason.starts_with("partial:") {
                break id;
            }
        }
        assert!(Instant::now() < deadline, "partial paste never recorded");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    rig.daemon.write_stdin(parent, b"\r").unwrap();
    loop {
        let resolved: Option<i64> = db
            .query_row(
                "SELECT resolved_at FROM pane_inbox WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        if resolved.is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "operator submitted the partial composer but its row remained waitable: {:?}",
            rig.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let again = rig
        .call(parent, "pane_wait", json!({"session":child,"timeout_ms":1}))
        .await;
    assert_eq!(again["timed_out"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_a_submitted_paste_database_error_does_not_repaste() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.fake_parent("claude", 1).await;
    let db = rusqlite::Connection::open(rig.state.path().join("test.db")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_paste_receipt BEFORE UPDATE OF delivered_at ON pane_inbox WHEN NEW.delivered_via='paste' BEGIN SELECT RAISE(FAIL, 'injected paste receipt failure'); END;").unwrap();
    let script = rig.script(
        "claude",
        1,
        "persist-failure",
        json!([{"op":"submit","summary":"PERSIST-FAILURE","bytes":512}]),
    );
    let child = rig.spawn(parent, "claude", &script, json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let resolved: Option<Option<i64>> = db
            .query_row(
                "SELECT resolved_at FROM pane_inbox WHERE from_session=?1 AND kind='result'",
                [child],
                |r| r.get(0),
            )
            .ok();
        if resolved.flatten().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "submitted paste failure remained unresolved: {:?}",
            rig.logs()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let count = rig
        .logs()
        .iter()
        .filter(|event| {
            event["event"] == "prompt" && event["data"].to_string().contains("PERSIST-FAILURE")
        })
        .count();
    assert_eq!(
        count, 1,
        "a submitted paste must not be replayed after its DB receipt fails"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_kill_remains_responsive_behind_a_blocked_pty_write() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let child = rig.pane(
        proto::AgentKind::Custom,
        vec![
            "sh".into(),
            "-c".into(),
            "stty raw -echo; exec sleep 60".into(),
        ],
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = rig.daemon.clone();
    let writing = std::thread::spawn(move || {
        let _ = tx.send(writer.write_stdin_counting(child, &vec![b'x'; 64000]));
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err(), "fixture must block on unread stdin");
    let killer = rig.daemon.clone();
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || killer.kill(child)),
    )
    .await
    .expect("kill blocked behind stdin")
    .unwrap()
    .unwrap();
    let result = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("writer did not cancel");
    writing.join().unwrap();
    assert!(
        result.is_err(),
        "teardown must not acknowledge an unfinished paste"
    );
    assert!(rig
        .daemon
        .list()
        .iter()
        .any(|pane| pane.id == child && !pane.state.is_live()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn r1_operator_close_uses_the_delegation_before_teardown() {
    let _serial = SERIAL.lock().await;
    for submitted in [false, true] {
        let rig = Rig::new().await;
        let parent = rig.parent();
        let steps = if submitted {
            json!([{"op":"submit","summary":"SETTLED","bytes":64}])
        } else {
            json!([{"op":"hang"}])
        };
        let script = rig.script("claude", 42, "close-notice", steps);
        let child = rig.spawn(parent, "claude", &script, json!({})).await;
        if submitted {
            rig.wait(parent, child).await;
        }
        rig.daemon.session_close_checked(child, false).unwrap();
        let notices = rig
            .daemon
            .inbox_rows_for_test(parent)
            .into_iter()
            .filter(|row| row.kind == "operator_note")
            .count();
        assert_eq!(
            notices,
            usize::from(!submitted),
            "closing a settled child must be quiet; closing a working child must notify its parent"
        );
    }
}

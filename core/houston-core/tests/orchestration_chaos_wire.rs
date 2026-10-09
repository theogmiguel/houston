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
        std::env::remove_var("CODEX_HOME");
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
        daemon.install_consented_agent_hooks();
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
                model: None,
                effort: None,
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
            let body = saved.body.trim();
            if saved.kind == "result" && body.chars().count() > 4096 {
                let excerpt: String = body.chars().take(4096).collect();
                assert!(
                    text.contains(&excerpt),
                    "MCP text lost row {}'s excerpt",
                    saved.id
                );
                assert!(text.contains(&format!("\"result_id\":{}", saved.id)));
                let full = self
                    .call(
                        parent,
                        "pane_get",
                        json!({"session":saved.from_session.unwrap(),"result_id":saved.id}),
                    )
                    .await;
                assert_eq!(full["body"], saved.body, "stored result body changed");
            } else {
                assert!(text.contains(body), "MCP text lost row {}'s body", saved.id);
            }
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h4_wait_caps_follow_the_parent_not_its_children() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    for (provider, expected) in [
        ("claude", 90_000),
        ("cursor", 30_000),
        ("codex", 600_000),
        ("grok", 600_000),
        ("opencode", 600_000),
        ("antigravity", 30_000),
    ] {
        let agent = serde_json::from_value(json!(provider)).unwrap();
        let parent = rig.pane(agent, vec!["sh".into(), "-c".into(), "exec cat".into()]);
        let result = rig
            .call(parent, "pane_wait", json!({"timeout_ms":700_000}))
            .await;
        assert_eq!(result["nothing_to_wait_on"], true, "{provider}: {result}");
        assert_eq!(result["wait_cap_ms"], expected, "{provider}: {result}");
        assert_eq!(result["requested_timeout_ms"], 700_000);
        assert!(result["cap_note"].as_str().unwrap().contains(provider));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h4_grok_schema_terminals_reach_the_parent_with_distinct_outcomes() {
    let _serial = SERIAL.lock().await;
    for (event, outcome) in [
        ("StopFailure", "turn_failed"),
        ("StopCancelled", "turn_interrupted"),
        ("SessionEnd", "session_ended"),
    ] {
        let rig = Rig::new().await;
        let parent = rig.parent();
        let script = rig.script(
            "grok",
            42,
            "terminal",
            json!([
                {"op":"hook", "event":event, "fixture":format!("grok-1.0.13-schema-{event}.json")},
                {"op":"hang"}
            ]),
        );
        let child = rig.spawn(parent, "grok", &script, json!({})).await;
        let response = rig
            .call(
                parent,
                "pane_wait",
                json!({"session":child,"timeout_ms":20_000}),
            )
            .await;
        let rows = rig.daemon.inbox_rows_for_test(parent);
        assert!(
            rows.iter()
                .any(|row| row.reason.as_deref() == Some(outcome)),
            "{event}: {response}"
        );
        assert_eq!(
            rig.daemon.session_status(child).unwrap(),
            Some(proto::AgentStatus::Idle)
        );
        assert!(rig
            .daemon
            .list()
            .iter()
            .find(|pane| pane.id == child)
            .unwrap()
            .state
            .is_live());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h4_auto_review_marker_is_deduplicated_wait_only_and_cleared() {
    use houston_core::hook_drop::{drop_dir, now_ms, write_drop, HookDrop};
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.fake_parent("claude", 42).await;
    let script = rig.script("codex", 42, "review-stall", json!([{"op":"hang"}]));
    let child = rig.spawn(parent, "codex", &script, json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        rig.daemon.hook_drop_tick_for_test();
        if rig.daemon.session_status(child).unwrap() == Some(proto::AgentStatus::Working) {
            break;
        }
        assert!(Instant::now() < deadline, "startup prompt was not applied");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let drop = HookDrop {
        session: child,
        agent: Some("codex".into()),
        event: "PermissionRequest".into(),
        prompt_id: Some("review-turn".into()),
        tool_name: Some("Bash".into()),
        tool_input_fingerprint: Some("input-digest".into()),
        ..Default::default()
    };
    let directory = drop_dir(rig.state.path());
    write_drop(&directory, &drop, now_ms()).unwrap();
    rig.daemon.hook_drop_tick_for_test();
    let raised_at = now_ms() + houston_core::orchestrate::CODEX_AUTO_REVIEW_STALL_MS + 1;
    rig.daemon.subagent_expiry_tick_at(raised_at);
    rig.daemon.subagent_expiry_tick_at(raised_at + 1);
    let markers: Vec<_> = rig
        .daemon
        .inbox_rows_for_test(parent)
        .into_iter()
        .filter(|row| row.reason.as_deref() == Some("approval_outcome_unobserved"))
        .collect();
    assert_eq!(markers.len(), 1);
    assert!(markers[0].body.contains("stalled?") && markers[0].body.contains("elapsed"));
    assert_eq!(
        rig.daemon.session_status(child).unwrap(),
        Some(proto::AgentStatus::Working)
    );
    assert!(rig.daemon.delegation_of(child).unwrap().stalled);
    assert!(matches!(
        rig.daemon
            .inbox_reserve_for_stop_hook(parent, now_ms())
            .unwrap(),
        houston_core::orchestrate::StopHookReserveOutcome::Empty
    ));
    let resolution = HookDrop {
        event: "PostToolUse".into(),
        ..drop
    };
    write_drop(&directory, &resolution, now_ms()).unwrap();
    rig.daemon.hook_drop_tick_for_test();
    assert!(!rig.daemon.delegation_of(child).unwrap().stalled);
    assert!(rig
        .daemon
        .inbox_rows_for_test(parent)
        .iter()
        .find(|row| row.id == markers[0].id)
        .unwrap()
        .resolved_at
        .is_some());
    rig.daemon.subagent_expiry_tick_at(raised_at + 2);
    assert_eq!(
        rig.daemon
            .inbox_rows_for_test(parent)
            .iter()
            .filter(|row| row.reason.as_deref() == Some("approval_outcome_unobserved"))
            .count(),
        1
    );
    assert!(!rig.logs().iter().any(
        |record| record["event"] == "prompt" && record["data"].to_string().contains("stalled?")
    ));
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h4_auto_review_with_its_command_running_is_not_stalled() {
    use houston_core::hook_drop::{drop_dir, now_ms, write_drop, HookDrop};
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.fake_parent("claude", 42).await;
    let script = rig.script(
        "codex",
        42,
        "review-approved",
        json!([{"op":"run_command","secs":60}, {"op":"hang"}]),
    );
    let child = rig.spawn(parent, "codex", &script, json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        rig.daemon.hook_drop_tick_for_test();
        if rig.daemon.session_status(child).unwrap() == Some(proto::AgentStatus::Working) {
            break;
        }
        assert!(Instant::now() < deadline, "startup prompt was not applied");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let drop = HookDrop {
        session: child,
        agent: Some("codex".into()),
        event: "PermissionRequest".into(),
        prompt_id: Some("review-turn".into()),
        tool_name: Some("Bash".into()),
        tool_input_fingerprint: Some("input-digest".into()),
        ..Default::default()
    };
    write_drop(&drop_dir(rig.state.path()), &drop, now_ms()).unwrap();
    rig.daemon.hook_drop_tick_for_test();
    let raised_at = now_ms() + houston_core::orchestrate::CODEX_AUTO_REVIEW_STALL_MS + 1;
    rig.daemon.subagent_expiry_tick_at(raised_at);
    assert!(
        !rig.daemon
            .inbox_rows_for_test(parent)
            .iter()
            .any(|row| row.reason.as_deref() == Some("approval_outcome_unobserved")),
        "an approved command that is still executing is not an unobserved approval"
    );
    assert!(!rig.daemon.delegation_of(child).unwrap().stalled);
}

#[cfg(feature = "test-barriers")]
#[path = "common/mod.rs"]
mod common;

#[cfg(feature = "test-barriers")]
mod daemon_crash {
    use super::*;
    use futures_util::SinkExt;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Child, Stdio};
    use tokio_tungstenite::tungstenite::Message;

    // Cold subprocess startup and restore are slower than in-process hook replay.
    const DEADLINE: Duration = Duration::from_secs(60);

    struct ProcessRig {
        home: tempfile::TempDir,
        workspace: PathBuf,
        barriers: PathBuf,
        child: Option<Child>,
        discovery: Value,
    }

    impl Drop for ProcessRig {
        fn drop(&mut self) {
            self.stop();
        }
    }

    impl ProcessRig {
        fn state(&self) -> PathBuf {
            self.home.path().join(".houston-chaos")
        }
        fn database(&self) -> rusqlite::Connection {
            let db = rusqlite::Connection::open(self.state().join("houston.db")).unwrap();
            db.busy_timeout(DEADLINE).unwrap();
            db
        }
        fn stop(&mut self) {
            if let Some(mut child) = self.child.take() {
                let discovery: Value = serde_json::from_slice(
                    &std::fs::read(self.state().join("daemon.json")).unwrap(),
                )
                .unwrap();
                let pid = discovery["pid"].as_u64().unwrap() as u32;
                assert_eq!(
                    pid,
                    child.id(),
                    "channel discovery must name this exact child"
                );
                houston_core::pid::signal_process_checked_identity(
                    pid,
                    houston_core::pid::Signal::Kill,
                    discovery["pid_creation"].as_u64(),
                )
                .unwrap();
                child.wait().unwrap();
            }
        }
        async fn start(&mut self) {
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.home.path().join("daemon.log"))
                .unwrap();
            let child =
                common::hermetic_command(env!("CARGO_BIN_EXE_houston-core"), self.home.path())
                    .env("HOUSTON_CHANNEL", "chaos")
                    .env("HOUSTON_DISABLE_SWARM_AUTOLAUNCH", "1")
                    .env("HOUSTON_TEST_BARRIER_DIR", &self.barriers)
                    .env("HOUSTON_TEST_INBOX_WAIT_ONLY", "1")
                    .stdout(Stdio::null())
                    .stderr(log)
                    .spawn()
                    .unwrap();
            let pid = child.id();
            self.child = Some(child);
            let deadline = Instant::now() + DEADLINE;
            loop {
                if let Ok(raw) = std::fs::read(self.state().join("daemon.json")) {
                    if let Ok(discovery) = serde_json::from_slice::<Value>(&raw) {
                        if discovery["pid"] == pid {
                            self.discovery = discovery;
                            return;
                        }
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "subprocess did not publish discovery: {}",
                    std::fs::read_to_string(self.home.path().join("daemon.log"))
                        .unwrap_or_default()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        fn script(&self, name: &str, provider: &str, steps: Value) -> PathBuf {
            let path = self.home.path().join(format!("{name}.json"));
            std::fs::write(
                &path,
                json!({"provider":provider,"seed":42,"home":self.home.path(),
                "helper":env!("CARGO_BIN_EXE_tr-helper"),
                "fixtures":Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hooks"),
                "log":self.home.path().join(format!("{name}.jsonl")),"steps":steps,"resume_metadata":true})
                .to_string(),
            )
            .unwrap();
            path
        }
        async fn new() -> Self {
            let home = tempfile::tempdir().unwrap();
            let workspace = home.path().join("workspace");
            let barriers = home.path().join("barriers");
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::create_dir_all(&barriers).unwrap();
            let rig = Self {
                home,
                workspace,
                barriers,
                child: None,
                discovery: Value::Null,
            };
            std::fs::create_dir_all(rig.state()).unwrap();
            let db = houston_core::db::Db::open(&rig.state().join("houston.db")).unwrap();
            db.set_setting(houston_core::orchestrate::ENABLED_KEY, "1")
                .unwrap();
            db.set_setting("updates_check", "0").unwrap();
            db.set_setting("orchestration_max_spawn_depth", "3")
                .unwrap();
            db.add_workspace(rig.workspace.to_str().unwrap(), "crash fixture")
                .unwrap();
            drop(db);
            // The shared helper creates all provider refusals and preserves this PATH in login shells.
            let _ = common::hermetic_command(env!("CARGO_BIN_EXE_houston-core"), rig.home.path());
            for (name, provider) in [
                ("claude", "claude"),
                ("codex", "codex"),
                ("agy", "antigravity"),
                ("opencode", "opencode"),
                ("cursor-agent", "cursor"),
                ("grok", "grok"),
            ] {
                let script = rig.script(
                    &format!("resume-{provider}"),
                    provider,
                    json!([{"op":"hang"}]),
                );
                let shim = rig.home.path().join("provider-shims").join(name);
                let content = format!("#!/bin/sh\ncase \"$1\" in mcp|--help|--version) exit 0;; esac\ncase \"$*\" in *@fake:*) exec '{}' \"$@\";; *) exec '{}' '@fake:{}' \"$@\";; esac\n",
                    env!("CARGO_BIN_EXE_fake_agent"), env!("CARGO_BIN_EXE_fake_agent"), script.display());
                std::fs::write(&shim, content).unwrap();
                std::fs::set_permissions(shim, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            rig
        }
        async fn ws(&self) -> common::WsStream {
            common::connect_and_hello(
                format!("127.0.0.1:{}", self.discovery["port"].as_u64().unwrap())
                    .parse()
                    .unwrap(),
                self.discovery["token"].as_str().unwrap(),
            )
            .await
        }
        fn arm(&self, point: &str) {
            let _ = std::fs::remove_file(self.barriers.join("reached"));
            std::fs::write(self.barriers.join("armed"), point).unwrap();
        }
        async fn reached(&self, point: &str) -> u32 {
            let deadline = Instant::now() + DEADLINE;
            loop {
                if let Ok(receipt) = std::fs::read_to_string(self.barriers.join("reached")) {
                    if let Some(id) = receipt.strip_prefix(&format!("{point} ")) {
                        return id.parse().unwrap();
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "{point} barrier not reached: {}",
                    std::fs::read_to_string(self.home.path().join("daemon.log"))
                        .unwrap_or_default()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        async fn await_child(&self) -> u32 {
            let deadline = Instant::now() + DEADLINE;
            loop {
                let id = self
                    .database()
                    .query_row(
                        "SELECT child_session FROM delegations WHERE role='crash-child'",
                        [],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(id) = id {
                    return id;
                }
                assert!(Instant::now() < deadline, "no child delegation");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        fn received_results(&self) -> Vec<String> {
            let log = std::fs::read_to_string(self.home.path().join("resume-parent.jsonl"))
                .or_else(|_| std::fs::read_to_string(self.home.path().join("resume-claude.jsonl")))
                .unwrap_or_default();
            log.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|event| event["event"] == "reply" && event["data"]["tool"] == "pane_wait")
                .flat_map(|event| {
                    event["data"]["result"]["rows"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                })
                .filter(|row| row["kind"] == "result")
                .map(|row| row["summary"].as_str().unwrap().to_string())
                .collect()
        }
        fn seed_resume(&self, id: u32) {
            // This is the same persisted handle/transcript shape produced by authoritative hook promotion.
            let conversation = uuid::Uuid::from_u128(u128::from(id)).to_string();
            let transcript = self.home.path().join(format!("{conversation}.jsonl"));
            std::fs::write(&transcript, "conversation metadata\n").unwrap();
            houston_core::db::Db::open(&self.state().join("houston.db"))
                .unwrap()
                .set_session_resume_handle(
                    id,
                    Some((&conversation, Some(transcript.to_str().unwrap()))),
                )
                .unwrap();
        }
    }

    async fn crash_at(provider: &str, point: &str) {
        let mut rig = ProcessRig::new().await;
        let go = rig.home.path().join("go");
        let wait = rig.home.path().join("wait");
        let script = rig.script("child", provider, json!([
            {"op":"call","tool":"pane_submit","args":{"body":"FIRST","summary":"FIRST","request_id":0}},
            {"op":"wait_file","path":go},
            {"op":"call","tool":"pane_submit","args":{"body":"SECOND","summary":"SECOND","request_id":1}},
            {"op":"stop"},{"op":"hang"}
        ]));
        let probe_script = rig.script("restore-probe", provider, json!([{"op":"hang"}]));
        let parent_script = rig.script("parent", "claude", json!([
            {"op":"spawn","args":{"kind":provider,"prompt":format!("@fake:{}",script.display()),"role":"crash-child","reusable":true}},
            {"op":"spawn","args":{"kind":provider,"prompt":format!("@fake:{}",probe_script.display()),"role":"restore-probe","reusable":true}},
            {"op":"wait_file","path":wait}, {"op":"wait_all"},{"op":"hang"}
        ]));
        if point == "spawn" {
            rig.arm(point);
        }
        rig.start().await;
        let mut ws = rig.ws().await;
        let _ = common::next_control(&mut ws).await;
        let message = json!({"type":"session_create","agent":"claude","project_dir":rig.workspace,
            "cmd":[env!("CARGO_BIN_EXE_fake_agent"),format!("@fake:{}",parent_script.display())],
            "cols":80,"rows":24,"shell_integration":false});
        ws.send(Message::text(message.to_string())).await.unwrap();
        let parent = common::expect_created(&mut ws).await.id;
        let child = if point == "spawn" {
            rig.reached(point).await
        } else {
            rig.await_child().await
        };
        rig.seed_resume(parent);
        if provider != "grok" {
            rig.seed_resume(child);
        }
        if point != "spawn" {
            let deadline = Instant::now() + DEADLINE;
            loop {
                let probe: Option<u32> = rig
                    .database()
                    .query_row(
                        "SELECT child_session FROM delegations WHERE role='restore-probe'",
                        [],
                        |r| r.get(0),
                    )
                    .ok();
                if let Some(probe) = probe {
                    if provider != "grok" {
                        rig.seed_resume(probe);
                    }
                    break;
                }
                assert!(Instant::now() < deadline, "restore probe did not spawn");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let deadline = Instant::now() + DEADLINE;
            loop {
                let count: i64 = rig
                    .database()
                    .query_row(
                        "SELECT COUNT(*) FROM pane_inbox WHERE kind='result' AND summary='FIRST'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                if count == 1 {
                    break;
                }
                assert!(Instant::now() < deadline, "first submit did not persist");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            rig.arm(point);
            std::fs::write(go, "go").unwrap();
            if point == "reservation" {
                let deadline = Instant::now() + DEADLINE;
                loop {
                    let ready: i64 = rig.database().query_row("SELECT COUNT(*) FROM pane_inbox WHERE kind='result' AND ready_at IS NOT NULL", [], |r| r.get(0)).unwrap();
                    if ready == 2 {
                        break;
                    }
                    assert!(Instant::now() < deadline, "results never became eligible");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                std::fs::write(wait, "wait").unwrap();
            }
            rig.reached(point).await;
        }
        rig.stop();
        drop(ws);
        let db = rig.database();
        let delivered: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE kind='result' AND delivered_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            delivered, 0,
            "{provider}/{point}: killed response must not consume results"
        );
        let pending: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE kind='result'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let reserved: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE delivery_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if point == "reservation" {
            assert_eq!(reserved, 2);
        }
        let old_receipts: Vec<String> = db
            .prepare("SELECT DISTINCT delivery_id FROM pane_inbox WHERE delivery_id IS NOT NULL")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        drop(db);
        std::fs::remove_file(rig.barriers.join("armed")).unwrap();
        // Resumed fixtures never resubmit. They resolve the previous turn and explicitly wait.
        rig.script(
            "resume-claude",
            "claude",
            json!([
                {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},
                {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},
                {"op":"hang"}
            ]),
        );
        rig.script(
            &format!("resume-{provider}"),
            provider,
            json!([{"op":"stop"},{"op":"hang"}]),
        );
        if provider == "claude" {
            // The resume invocation names the original conversation, so select scripts by that identity.
            let shim = rig.home.path().join("provider-shims/claude");
            let parent_resume = rig.home.path().join("resume-parent.json");
            rig.script(
                "resume-parent",
                "claude",
                json!([
                    {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},
                    {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},{"op":"hang"}
                ]),
            );
            let child_resume = rig.home.path().join("resume-claude.json");
            let conversation = uuid::Uuid::from_u128(u128::from(parent)).to_string();
            std::fs::write(&shim, format!("#!/bin/sh\ncase \"$1\" in mcp|--help|--version) exit 0;; esac\ncase \"$*\" in *'{conversation}'*) exec '{}' '@fake:{}' \"$@\";; *) exec '{}' '@fake:{}' \"$@\";; esac\n",
                env!("CARGO_BIN_EXE_fake_agent"),parent_resume.display(),env!("CARGO_BIN_EXE_fake_agent"),child_resume.display())).unwrap();
        }
        rig.start().await;
        let deadline = Instant::now() + DEADLINE;
        loop {
            let count: i64 = rig.database().query_row("SELECT COUNT(*) FROM pane_inbox WHERE kind='result' AND delivered_at IS NOT NULL AND (delivered_via != 'paste' OR confirmed_at IS NOT NULL)", [], |r| r.get(0)).unwrap();
            let notices: i64 = rig
                .database()
                .query_row(
                    "SELECT COUNT(*) FROM pane_inbox WHERE kind='restored'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if count == pending && rig.received_results().len() as i64 == pending && notices == 1 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{provider}/{point}: replay never delivered: daemon={} parent={} child={} rows={:?}",
                std::fs::read_to_string(rig.home.path().join("daemon.log")).unwrap_or_default(),
                std::fs::read_to_string(rig.home.path().join("resume-parent.jsonl")).unwrap_or_else(|_| std::fs::read_to_string(rig.home.path().join("resume-claude.jsonl")).unwrap_or_default()),
                std::fs::read_to_string(rig.home.path().join(format!("resume-{provider}.jsonl"))).unwrap_or_default(),
                rig.database().prepare("SELECT summary,to_session,ready_at,delivered_at,confirmed_at,reason,delivery_id FROM pane_inbox").unwrap().query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,Option<i64>>(2)?,r.get::<_,Option<i64>>(3)?,r.get::<_,Option<i64>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?))).unwrap().map(Result::unwrap).collect::<Vec<_>>()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let db = rig.database();
        let results: Vec<(String, String)> = db
            .prepare("SELECT summary,delivered_via FROM pane_inbox WHERE kind='result' ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            results.len() as i64,
            pending,
            "{provider}/{point}: duplicate submissions"
        );
        if pending == 2 {
            assert_eq!(rig.received_results(), ["FIRST", "SECOND"]);
            assert_eq!(
                results.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
                ["FIRST", "SECOND"]
            );
        }
        assert!(
            results
                .iter()
                .all(|r| matches!(r.1.as_str(), "wait" | "paste" | "stop_hook")),
            "{results:?}"
        );
        let notices: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE kind='restored'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(notices, 1, "{provider}/{point}: one restored roster notice");
        for receipt in old_receipts {
            let held: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM pane_inbox WHERE delivery_id = ?1",
                    [&receipt],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(held, 0, "restart must free old reservation {receipt}");
        }
        let recipient: u32 = db
            .query_row(
                "SELECT to_session FROM pane_inbox WHERE kind='restored'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(
            recipient, parent,
            "restoration must mint a new session identity"
        );
        let misrouted: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE kind='result' AND to_session != ?1",
                [recipient],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(misrouted, 0, "all replies follow their restored parent");
        let notice: String = db
            .query_row(
                "SELECT body FROM pane_inbox WHERE kind='restored'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&notice).unwrap()[0]["resumed"],
            provider != "grok"
        );
        eprintln!("h4 crash provider={provider} point={point} results={pending} restored=1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn h4_daemon_crash_routes_through_an_unresumed_parent_to_the_live_ancestor() {
        let _serial = SERIAL.lock().await;
        let mut rig = ProcessRig::new().await;
        let go = rig.home.path().join("ancestor-go");
        let leaf_script = rig.script("leaf", "codex", json!([
            {"op":"wait_file","path":go},
            {"op":"call","tool":"pane_submit","args":{"body":"ANCESTOR","summary":"ANCESTOR","request_id":0}},
            {"op":"stop"},{"op":"hang"}
        ]));
        let middle_script = rig.script("middle", "grok", json!([
            {"op":"spawn","args":{"kind":"codex","prompt":format!("@fake:{}",leaf_script.display()),"role":"leaf","reusable":true}},
            {"op":"hang"}
        ]));
        let root_script = rig.script("root", "claude", json!([
            {"op":"spawn","args":{"kind":"grok","prompt":format!("@fake:{}",middle_script.display()),"role":"middle","reusable":true}},
            {"op":"hang"}
        ]));
        rig.start().await;
        let mut ws = rig.ws().await;
        let _ = common::next_control(&mut ws).await;
        ws.send(Message::text(
            json!({"type":"session_create","agent":"claude","project_dir":rig.workspace,
            "cmd":[env!("CARGO_BIN_EXE_fake_agent"),format!("@fake:{}",root_script.display())],
            "cols":80,"rows":24,"shell_integration":false})
            .to_string(),
        ))
        .await
        .unwrap();
        let root = common::expect_created(&mut ws).await.id;
        let deadline = Instant::now() + DEADLINE;
        loop {
            let count: i64 = rig
                .database()
                .query_row("SELECT COUNT(*) FROM delegations", [], |r| r.get(0))
                .unwrap();
            if count == 2 {
                break;
            }
            assert!(Instant::now() < deadline, "nested delegation did not spawn");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        rig.seed_resume(root);
        rig.arm("staging");
        std::fs::write(go, "go").unwrap();
        rig.reached("staging").await;
        rig.stop();
        drop(ws);
        std::fs::remove_file(rig.barriers.join("armed")).unwrap();
        rig.script(
            "resume-claude",
            "claude",
            json!([
                {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},
                {"op":"call","tool":"pane_wait","args":{"timeout_ms":20000}},{"op":"hang"}
            ]),
        );
        rig.start().await;
        let deadline = Instant::now() + DEADLINE;
        loop {
            let count: i64 = rig.database().query_row("SELECT COUNT(*) FROM pane_inbox WHERE summary='ANCESTOR' AND delivered_at IS NOT NULL AND (delivered_via != 'paste' OR confirmed_at IS NOT NULL)", [], |r| r.get(0)).unwrap();
            if count == 1 && rig.received_results() == ["ANCESTOR"] {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "ancestor did not receive recovered handback"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let db = rig.database();
        let recipient: u32 = db
            .query_row(
                "SELECT to_session FROM pane_inbox WHERE kind='restored'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(recipient, root);
        let (actual, original, reason): (u32, Option<u32>, Option<String>) = db
            .query_row(
                "SELECT to_session,original_to,reason FROM pane_inbox WHERE summary='ANCESTOR'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(actual, recipient);
        assert!(original.is_some());
        assert_eq!(reason.as_deref(), Some("parent_dead"));
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pane_inbox WHERE summary='ANCESTOR'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let body: String = db
            .query_row(
                "SELECT body FROM pane_inbox WHERE kind='restored'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()[0]["resumed"],
            false
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn h4_exact_daemon_crash_points_recover_durable_inbox_rows() {
        let _serial = SERIAL.lock().await;
        for provider in ["claude", "codex", "grok"] {
            for point in ["spawn", "staging", "reservation", "completion"] {
                if std::env::var("HOUSTON_CRASH_CASE")
                    .is_ok_and(|case| case != format!("{provider}/{point}"))
                {
                    continue;
                }
                crash_at(provider, point).await;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn h4_codex_missing_call_identity_cannot_be_cleared_by_an_unrelated_tool() {
    use houston_core::hook_drop::{drop_dir, now_ms, write_drop, HookDrop};
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script("codex", 42, "missing-identity", json!([{"op":"hang"}]));
    let child = rig.spawn(parent, "codex", &script, json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        rig.daemon.hook_drop_tick_for_test();
        if rig.daemon.session_status(child).unwrap() == Some(proto::AgentStatus::Working) {
            break;
        }
        assert!(Instant::now() < deadline, "startup prompt was not applied");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let directory = drop_dir(rig.state.path());
    let permission = HookDrop {
        session: child,
        agent: Some("codex".into()),
        event: "PermissionRequest".into(),
        prompt_id: Some("turn".into()),
        tool_name: Some("Bash".into()),
        ..Default::default()
    };
    write_drop(&directory, &permission, now_ms()).unwrap();
    rig.daemon.hook_drop_tick_for_test();
    write_drop(
        &directory,
        &HookDrop {
            event: "PostToolUse".into(),
            ..permission.clone()
        },
        now_ms(),
    )
    .unwrap();
    rig.daemon.hook_drop_tick_for_test();
    assert_eq!(
        rig.daemon
            .list()
            .iter()
            .find(|pane| pane.id == child)
            .unwrap()
            .delegation
            .as_ref()
            .unwrap()
            .hold_reason
            .as_deref(),
        Some("auto-review in progress")
    );
    write_drop(
        &directory,
        &HookDrop {
            event: "Interrupt".into(),
            ..permission
        },
        now_ms(),
    )
    .unwrap();
    rig.daemon.hook_drop_tick_for_test();
    assert!(rig
        .daemon
        .list()
        .iter()
        .find(|pane| pane.id == child)
        .unwrap()
        .delegation
        .as_ref()
        .unwrap()
        .hold_reason
        .is_none());
}

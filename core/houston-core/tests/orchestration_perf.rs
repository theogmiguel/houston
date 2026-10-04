#![cfg(unix)]

mod common;

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::mcp_creds::McpScope;
use houston_core::mcp_server::ToolProvider;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

// Two hundred receipts expose tail latency without a long-running soak.
const ITERATIONS: usize = 200;
// Sequential delegations leave room for a nested fixture without hitting spawn caps.
const LIVE_CAP: u32 = 4;
// Fake waits request twenty seconds, with one second for local transport.
const CALL_LATENCY_MAX_US: u64 = 21_000_000;
// Serializes process-wide fixture environment and all timing samples.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<tempfile::TempDir> = OnceLock::new();

// 7250 ms leaves 50% headroom above the measured 4823701 us spawn p95.
const SPAWN_FIRST_HOOK_CEILING_US: Option<u64> = Some(7_250_000);
// 1050 ms leaves 50% headroom above the measured 698831 us submit/wait p95.
const SUBMIT_WAIT_CEILING_US: Option<u64> = Some(1_050_000);
// 120 ms leaves 50% headroom above the measured 79832 us paste/composer p95.
const PASTE_COMPOSER_CEILING_US: Option<u64> = Some(120_000);
// 150 ms leaves 50% headroom above the measured 100041 us leaf p95.
const POST_TOOL_USE_LEAF_CEILING_US: Option<u64> = Some(150_000);
// 155 ms leaves 52% headroom above the measured 101623 us orchestrator p95.
const POST_TOOL_USE_ORCHESTRATOR_CEILING_US: Option<u64> = Some(155_000);
// 1250 ms leaves 51% headroom above the measured 826352 us restart p95.
const RESTART_RESTORED_CEILING_US: Option<u64> = Some(1_250_000);
// Preserve the existing 512-character delegation gate.
const SMALL_DELEGATION_BYTE_BUDGET: Option<usize> = Some(2800);
// 6000 bytes leaves 27% headroom above the measured 4730-byte 3072-character report.
const DELEGATION_BYTE_BUDGET: Option<usize> = Some(6000);
// 6000 bytes leaves 21% headroom above the measured 4957-byte 4096-character envelope.
const PARENT_RESULT_BYTE_BUDGET: Option<usize> = Some(6000);

fn monotonic_us() -> u64 {
    let mut clock = std::mem::MaybeUninit::<libc::timespec>::uninit();
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, clock.as_mut_ptr()) },
        0
    );
    let clock = unsafe { clock.assume_init() };
    clock.tv_sec as u64 * 1_000_000 + clock.tv_nsec as u64 / 1000
}

fn report(metric: &str, samples: &mut [u64], ceiling: Option<u64>) {
    assert_eq!(samples.len(), ITERATIONS);
    println!("{metric} samples_us={samples:?}");
    samples.sort_unstable();
    let p50 = samples[ITERATIONS / 2 - 1];
    let p95 = samples[ITERATIONS * 95 / 100 - 1];
    let max = samples[ITERATIONS - 1];
    println!("{metric} | {p50} | {p95} | {max} | {ceiling:?} | microseconds");
    if let Some(limit) = ceiling {
        assert!(
            p95 <= limit,
            "{metric}: p95 {p95} us exceeds ceiling {limit} us; max {max} us"
        );
    }
}

fn bytes(metric: &str, value: &Value, ceiling: Option<usize>) -> usize {
    let size = serde_json::to_vec(value).unwrap().len();
    println!("{metric} | {size} | {ceiling:?} | serialized bytes");
    if let Some(limit) = ceiling {
        assert!(
            size <= limit,
            "{metric}: {size} bytes exceeds budget {limit} bytes"
        );
    }
    size
}

fn shim_dir() -> &'static Path {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let command = common::hermetic_command(env!("CARGO_BIN_EXE_fake_agent"), &home);
        for (key, value) in command.get_envs() {
            if let Some(value) = value {
                std::env::set_var(key, value);
            }
        }
        let shims = home.join("provider-shims");
        for name in ["claude", "codex", "agy", "opencode", "cursor-agent", "grok"] {
            let shim = shims.join(name);
            std::fs::remove_file(&shim).unwrap();
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_fake_agent"), shim).unwrap();
        }
        dir
    })
    .path()
}

struct SessionCleanup(Arc<Daemon>);

impl Drop for SessionCleanup {
    fn drop(&mut self) {
        for session in self.0.list() {
            let _ = self.0.close(session.id);
        }
    }
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    workspace: PathBuf,
    endpoint: String,
    tokens: std::sync::Mutex<std::collections::HashMap<u32, String>>,
    hooks: tokio::task::JoinHandle<()>,
    server: tokio::task::JoinHandle<()>,
    calls: std::sync::Mutex<Vec<(u32, String)>>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.hooks.abort();
        self.server.abort();
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
        let daemon = Daemon::new(DaemonConfig {
            token: common::TOKEN.into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        let (addr, server) =
            houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
                .await
                .unwrap();
        daemon.set_port(addr.port());
        let home = state.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(state.path(), home.join(".houston-chaos")).unwrap();
        let workspace = state.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        daemon.reap_set_exit_hook_for_test(Box::new(|| {}));
        daemon.workspace_add(workspace.to_str().unwrap()).unwrap();
        daemon.orchestration_set(true).unwrap();
        daemon.set_orchestration_caps(LIVE_CAP, 3).unwrap();

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
            hooks,
            server,
            calls: std::sync::Mutex::new(Vec::new()),
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
        self.calls.lock().unwrap().push((session, tool.to_string()));
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
            "log":self.state.path().join(format!("{name}.jsonl")),"steps":steps,"resume_metadata":true})
            .to_string(),
        )
        .unwrap();
        path
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
}

impl Rig {
    async fn rpc(&self, session: u32, method: &str, params: Value) -> Value {
        let response: Value = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(&self.endpoint)
            .bearer_auth(self.token(session))
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    async fn receipt(&self, name: &str, event: &str) {
        let path = self.state.path().join(format!("{name}.jsonl"));
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if std::fs::read_to_string(&path)
                    .unwrap_or_default()
                    .lines()
                    .any(|line| {
                        serde_json::from_str::<Value>(line).is_ok_and(|row| row["event"] == event)
                    })
                {
                    return;
                }
                // Only fixture receipts are sampled; no pane status or inbox polling.
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("fake-agent receipt did not arrive within 30 seconds");
    }
}

#[tokio::test]
#[ignore = "measure on an idle machine at normal priority"]
async fn spawn_to_first_hook() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let mut samples = Vec::new();
    for iteration in 0..ITERATIONS {
        let script = rig.script(
            "claude",
            iteration as u64 + 1,
            "child",
            json!([{"op":"hang"}]),
        );
        let mut events = rig.daemon.observe();
        let began = Instant::now();
        let result = rig.call(parent, "pane_spawn", json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true})).await;
        let child = result["session"].as_u64().unwrap() as u32;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let proto::ServerMsg::AgentStatus { session, .. } =
                    common::next_broadcast_control(&mut events).await
                {
                    if session == child {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        samples.push(began.elapsed().as_micros() as u64);
        rig.daemon.close(child).unwrap();
    }
    report(
        "spawn -> created -> first applied hook",
        &mut samples,
        SPAWN_FIRST_HOOK_CEILING_US,
    );
}

#[tokio::test]
#[ignore = "measure on an idle machine at normal priority"]
async fn submit_to_wait_and_delegation_bytes() {
    submit_to_wait_and_delegation_bytes_fixture(ITERATIONS, 3072).await;
}

async fn submit_to_wait_and_delegation_bytes_fixture(iterations: usize, body_bytes: usize) {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let mut samples = Vec::new();
    for iteration in 0..iterations {
        let gate = rig.state.path().join(format!("submit-{iteration}"));
        let script = rig.script(
            "claude",
            iteration as u64 + 1,
            &format!("child-{iteration}"),
            json!([
                {"op":"wait_file","path":gate},
                {"op":"submit","summary":"RESULT","bytes":body_bytes},{"op":"hang"}
            ]),
        );
        let spawn = rig.raw_call(parent, "pane_spawn", json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true})).await;
        let child = spawn["structuredContent"]["session"].as_u64().unwrap() as u32;
        rig.receipt(&format!("child-{iteration}"), "hook").await;
        std::fs::write(&gate, "").unwrap();
        let wait = rig
            .raw_call(
                parent,
                "pane_wait",
                json!({"session":child,"timeout_ms":20000}),
            )
            .await;
        let received_us = monotonic_us();
        let submitted_us = rig
            .logs()
            .iter()
            .filter(|row| row["event"] == "call" && row["data"]["tool"] == "pane_submit")
            .map(|row| row["monotonic_us"].as_u64().unwrap())
            .max()
            .unwrap();
        samples.push(received_us.checked_sub(submitted_us).unwrap());
        assert_ne!(wait["isError"], true, "{wait}");
        assert!(
            wait["structuredContent"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["kind"] == "result"),
            "{wait}"
        );
        let calls: Vec<String> = rig
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(session, _)| *session == parent)
            .skip(iteration * 2)
            .map(|(_, tool)| tool.clone())
            .collect();
        let logged = rig.logs();
        assert_eq!(
            logged
                .iter()
                .filter(|row| row["event"] == "call" && row["data"]["tool"] == "pane_submit")
                .count(),
            iteration + 1
        );
        assert_eq!(
            calls.len(),
            2,
            "delegation requires spawn and one blocking wait"
        );
        let total =
            bytes("spawn", &spawn, None) + bytes("wait + result", &wait, PARENT_RESULT_BYTE_BUDGET);
        println!(
            "typical delegation | {total} | {DELEGATION_BYTE_BUDGET:?} | bytes; parent calls {}",
            calls.len()
        );
        if body_bytes <= 512 {
            assert!(serde_json::to_vec(&wait).unwrap().len() <= 2400);
            assert!(total <= SMALL_DELEGATION_BYTE_BUDGET.unwrap());
        }
        if body_bytes <= 4096 {
            assert!(wait["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains(&"x".repeat(body_bytes)));
            assert!(!wait["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("full body: pane_get"));
        }
        if let Some(limit) = DELEGATION_BYTE_BUDGET {
            assert!(
                total <= limit,
                "delegation: {total} bytes exceeds budget {limit}"
            );
        }
        rig.daemon.close(child).unwrap();
    }
    if iterations == ITERATIONS {
        report(
            "pane_submit call -> wait response",
            &mut samples,
            SUBMIT_WAIT_CEILING_US,
        );
    }
}

#[tokio::test]
#[ignore = "measure on an idle machine at normal priority"]
async fn door_three_to_composer() {
    door_three_to_composer_fixture(ITERATIONS).await;
}

async fn door_three_to_composer_fixture(iterations: usize) {
    let _serial = SERIAL.lock().await;
    let mut samples = Vec::new();
    for iteration in 0..iterations {
        let rig = Rig::new().await;
        let parent = rig.fake_parent("claude", iteration as u64 + 1).await;
        let gate = rig.state.path().join("submit-gate");
        let script = rig.script("claude", iteration as u64 + 1, "child", json!([
            {"op":"wait_file","path":gate},{"op":"submit","summary":"PASTE_RESULT","bytes":64},{"op":"hang"}
        ]));
        let child = rig.call(parent, "pane_spawn", json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true})).await["session"].as_u64().unwrap() as u32;
        rig.receipt("child", "hook").await;
        let pasted_us = Arc::new(std::sync::atomic::AtomicU64::new(0));
        rig.daemon.inbox_set_paste_hook_for_test(Box::new({
            let pasted_us = pasted_us.clone();
            move |session| {
                if session == parent {
                    pasted_us.store(monotonic_us(), std::sync::atomic::Ordering::SeqCst);
                }
            }
        }));
        std::fs::write(&gate, "").unwrap();
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                rig.daemon.swarm_mail_tick_for_test();
                if rig.logs().iter().any(|row| {
                    row["event"] == "prompt" && row["data"].to_string().contains("PASTE_RESULT")
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("door three did not reach fake composer");
        let received_us = rig
            .logs()
            .iter()
            .find(|row| {
                row["event"] == "prompt" && row["data"].to_string().contains("PASTE_RESULT")
            })
            .unwrap()["monotonic_us"]
            .as_u64()
            .unwrap();
        samples.push(
            received_us
                .checked_sub(pasted_us.load(std::sync::atomic::Ordering::SeqCst))
                .unwrap(),
        );
        assert!(rig
            .daemon
            .inbox_rows_for_test(parent)
            .iter()
            .any(|row| row.from_session == Some(child)
                && row.delivered_via.as_deref() == Some("paste")));
    }
    if iterations == ITERATIONS {
        report(
            "door three PTY paste -> composer receipt",
            &mut samples,
            PASTE_COMPOSER_CEILING_US,
        );
    }
}

#[tokio::test]
async fn shipped_guidance_requires_blocking_wait_without_diagnostic_loops() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let advertisement = rig.rpc(parent, "tools/list", json!({})).await;
    let provider = houston_core::mcp_orchestration::OrchestrationTools::new(&rig.daemon);
    let scope = McpScope {
        session_id: parent,
        workspace_id: rig.workspace.display().to_string(),
    };
    let duty = provider.instructions(&scope).unwrap();
    assert!(
        duty.contains("pane_wait"),
        "missing blocking wait duty: {duty}"
    );
    let tools = advertisement["tools"].as_array().unwrap();
    let wait = tools
        .iter()
        .find(|tool| tool["name"] == "pane_wait")
        .unwrap();
    let guidance = wait["description"].as_str().unwrap().to_lowercase();
    assert!(
        guidance.contains("block")
            && guidance.contains("after pane_spawn")
            && guidance.contains("do not poll"),
        "pane_wait must advertise blocking: {guidance}"
    );
    let all: Vec<Value> = provider
        .all_tools()
        .iter()
        .map(|tool| tool.to_json())
        .collect();
    for tool in tools.iter().chain(all.iter()) {
        let text = tool["description"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .replace('`', "");
        assert!(
            !text.contains("before deciding to wait"),
            "{} contradicts blocking wait duty: {text}",
            tool["name"]
        );
        let positive: String = text
            .split([';', '.', ','])
            .filter(|clause| {
                let clause = clause.trim();
                !clause.starts_with("do not ")
                    && !clause.starts_with("don't ")
                    && !clause.starts_with("never ")
            })
            .collect::<Vec<_>>()
            .join(";");
        for advice in [
            "poll pane_get",
            "poll pane_list",
            "loop pane_get",
            "loop pane_list",
            "repeatedly call pane_get",
            "repeatedly call pane_list",
            "keep checking pane_get",
            "keep checking pane_list",
        ] {
            assert!(
                !positive.contains(advice),
                "{} encourages diagnostic polling: {text}",
                tool["name"]
            );
        }
    }
    let empty = rig
        .raw_call(parent, "pane_wait", json!({"timeout_ms":1}))
        .await;
    let text = empty.to_string().to_lowercase();
    assert!(
        !text.contains("poll pane_get") && !text.contains("poll pane_list"),
        "{empty}"
    );
}

#[tokio::test]
#[ignore = "record actual tool advertisement and refusal byte counts"]
async fn advertisement_and_error_bytes() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let provider = houston_core::mcp_orchestration::OrchestrationTools::new(&rig.daemon);
    let all: Vec<Value> = provider
        .all_tools()
        .iter()
        .map(|tool| tool.to_json())
        .collect();
    bytes("all orchestration tools", &json!(all), None);
    for agent in [proto::AgentKind::Custom, proto::AgentKind::Codex] {
        let parent = rig.pane(agent, vec!["sh".into(), "-c".into(), "exec cat".into()]);
        bytes(
            &format!("{agent:?} enabled tools/list"),
            &rig.rpc(parent, "tools/list", json!({})).await,
            None,
        );
        if agent == proto::AgentKind::Codex {
            bytes(
                "gateway list_tools",
                &rig.raw_call(parent, "list_tools", json!({})).await,
                None,
            );
        }
        bytes(
            "invalid kind refusal",
            &rig.raw_call(
                parent,
                "pane_spawn",
                json!({"kind":"droid","prompt":"work"}),
            )
            .await,
            None,
        );
        rig.daemon.orchestration_set(false).unwrap();
        bytes(
            &format!("{agent:?} disabled tools/list"),
            &rig.rpc(parent, "tools/list", json!({})).await,
            None,
        );
        rig.daemon.orchestration_set(true).unwrap();
    }
}

#[test]
#[ignore = "measure hook startup through drop receipt on an idle machine"]
fn post_tool_use_drop_overhead() {
    // The async fixtures and this synchronous test share the environment lock.
    let _serial = SERIAL.blocking_lock();
    for enabled in [false, true] {
        let mut samples = Vec::new();
        for _ in 0..ITERATIONS {
            let home = tempfile::tempdir().unwrap();
            let signal = home.path().join("orchestrator");
            if enabled {
                std::fs::write(&signal, "").unwrap();
            }
            let drops = home.path().join(".houston-perfhook/hooks/drop");
            let mut command =
                common::hermetic_command(env!("CARGO_BIN_EXE_houston-core"), home.path());
            command
                .args(["hook", "PostToolUse"])
                .env("HOUSTON_CHANNEL", "perfhook")
                .env("TR_SESSION", "99")
                .env("HOUSTON_TOOL_BOUNDARY_CONTEXT", &signal)
                .env("HOUSTON_MCP_URL", "http://127.0.0.1:9/mcp")
                .env("HOUSTON_MCP_TOKEN", "fixture")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let began = Instant::now();
            let mut child = command.spawn().unwrap();
            let mut elapsed = None;
            loop {
                if drops.read_dir().is_ok_and(|mut entries| {
                    entries.any(|entry| {
                        entry.is_ok_and(|entry| {
                            entry.path().extension().is_some_and(|ext| ext == "json")
                        })
                    })
                }) {
                    elapsed = Some(began.elapsed().as_micros() as u64);
                    break;
                }
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                if began.elapsed() > Duration::from_secs(30) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("PostToolUse did not write a drop within 30 seconds; orchestrator={enabled}");
                }
                std::thread::sleep(Duration::from_micros(100));
            }
            assert!(child.wait().unwrap().success());
            // A process can exit between the last directory read and try_wait.
            let elapsed = elapsed.unwrap_or_else(|| {
                assert!(drops.read_dir().unwrap().next().is_some());
                began.elapsed().as_micros() as u64
            });
            samples.push(elapsed);
        }
        report(
            if enabled {
                "PostToolUse orchestrator -> drop"
            } else {
                "PostToolUse leaf -> drop"
            },
            &mut samples,
            if enabled {
                POST_TOOL_USE_ORCHESTRATOR_CEILING_US
            } else {
                POST_TOOL_USE_LEAF_CEILING_US
            },
        );
    }
}

#[tokio::test]
#[ignore = "measure restored children and MCP notice delivery on an idle machine"]
async fn restart_to_restored_notice() {
    restart_to_restored_notice_fixture(ITERATIONS).await;
}

async fn restart_to_restored_notice_fixture(iterations: usize) {
    let _serial = SERIAL.lock().await;
    let mut samples = Vec::new();
    for iteration in 0..iterations {
        let rig = Rig::new().await;
        let parent_script = rig.script(
            "claude",
            iteration as u64 + 1,
            "restart-parent",
            json!([{"op":"hang"}]),
        );
        let parent = rig.pane(
            proto::AgentKind::Claude,
            vec![
                env!("CARGO_BIN_EXE_fake_agent").into(),
                format!("@fake:{}", parent_script.display()),
            ],
        );
        let script = rig.script(
            "claude",
            iteration as u64 + 1,
            "restart-child",
            json!([{"op":"hang"}]),
        );
        let child = rig.call(parent, "pane_spawn", json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true})).await["session"].as_u64().unwrap() as u32;
        rig.receipt("restart-parent", "hook").await;
        rig.receipt("restart-child", "hook").await;
        rig.daemon.checkpoint_scrollback().unwrap();
        let path = rig.state.path().join("restart.db");
        let source = rusqlite::Connection::open(rig.state.path().join("test.db")).unwrap();
        source
            .execute("VACUUM INTO ?1", [path.to_str().unwrap()])
            .unwrap();
        drop(source);
        let db = houston_core::db::Db::open(&path).unwrap();
        for id in [parent, child] {
            let conversation = uuid::Uuid::from_u128(u128::from(id)).to_string();
            let transcript = rig.workspace.join(format!("{conversation}.jsonl"));
            std::fs::write(&transcript, "conversation metadata\n").unwrap();
            db.set_session_resume_handle(
                id,
                Some((&conversation, Some(transcript.to_str().unwrap()))),
            )
            .unwrap();
        }
        drop(db);
        let began = Instant::now();
        let restarted = Daemon::new_with_safe_mode_flags_for_test(
            DaemonConfig {
                token: common::TOKEN.into(),
                db_path: path,
            },
            houston_core::daemon::SafeModeFlags::default(),
        )
        .unwrap();
        restarted.reap_set_exit_hook_for_test(Box::new(|| {}));
        let _cleanup = SessionCleanup(restarted.clone());
        let sessions = restarted.list();
        let restored_parent = sessions
            .iter()
            .find(|session| session.session_origin == Some(parent))
            .expect("parent was not restored");
        let restored_child = sessions
            .iter()
            .find(|session| session.session_origin == Some(child))
            .expect("child was not restored");
        assert_eq!(restored_child.spawned_by, Some(restored_parent.id));
        let (addr, server) =
            houston_core::server::start(restarted.clone(), "127.0.0.1:0".parse().unwrap())
                .await
                .unwrap();
        restarted.set_port(addr.port());
        let token = restarted.mcp_creds.issue(McpScope {
            session_id: restored_parent.id,
            workspace_id: rig.workspace.display().to_string(),
        });
        let result: Value = reqwest::Client::builder().no_proxy().build().unwrap().post(format!("http://{addr}/mcp")).bearer_auth(token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pane_wait","arguments":{"timeout_ms":20000}}}))
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        assert!(
            result["result"]["structuredContent"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["kind"] == "restored"),
            "{result}"
        );
        assert!(restarted
            .inbox_rows_for_test(restored_parent.id)
            .iter()
            .any(|row| row.kind == "restored" && row.delivered_via.as_deref() == Some("wait")));
        samples.push(began.elapsed().as_micros() as u64);
        server.abort();
        for session in restarted.list() {
            let _ = restarted.close(session.id);
        }
    }
    if iterations == ITERATIONS {
        report(
            "restart -> children restored -> notice delivered",
            &mut samples,
            RESTART_RESTORED_CEILING_US,
        );
    }
}

#[tokio::test]
#[ignore = "record maximum result envelope before setting a parent excerpt budget"]
async fn oversized_result_byte_budget() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        "claude",
        1,
        "large-result",
        json!([
            {"op":"submit","summary":"LARGE_RESULT","bytes":12000},{"op":"hang"}
        ]),
    );
    let spawn = rig
        .raw_call(
            parent,
            "pane_spawn",
            json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true}),
        )
        .await;
    let child = spawn["structuredContent"]["session"].as_u64().unwrap() as u32;
    let wait = rig
        .raw_call(
            parent,
            "pane_wait",
            json!({"session":child,"timeout_ms":20000}),
        )
        .await;
    assert_ne!(wait["isError"], true, "{wait}");
    let rows = rig.daemon.inbox_rows_for_test(parent);
    let result = rows
        .iter()
        .find(|row| row.kind == "result")
        .expect("result was not persisted");
    assert!(
        result.body.contains("submit truncated"),
        "existing storage clip was lost"
    );
    assert!(
        !result
            .body
            .contains(&"x".repeat(houston_core::orchestrate::SUBMIT_BODY_MAX_CHARS + 1)),
        "existing submit cap was relaxed"
    );
    bytes("maximum result envelope", &wait, PARENT_RESULT_BYTE_BUDGET);
    assert!(
        wait["structuredContent"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row.get("body").is_none()),
        "body duplicated in structured metadata: {wait}"
    );
}

#[tokio::test]
async fn h2_result_excerpt_preserves_full_body_on_demand() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        "claude",
        1,
        "excerpt-result",
        json!([
            {"op":"submit","summary":"DETAILS","bytes":12000},{"op":"hang"}
        ]),
    );
    let child = rig
        .call(
            parent,
            "pane_spawn",
            json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true}),
        )
        .await["session"]
        .as_u64()
        .unwrap() as u32;
    let wait = rig
        .raw_call(
            parent,
            "pane_wait",
            json!({"session":child,"timeout_ms":20000}),
        )
        .await;
    let text = wait["content"][0]["text"].as_str().unwrap();
    let row = rig
        .daemon
        .inbox_rows_for_test(parent)
        .into_iter()
        .find(|row| row.kind == "result")
        .unwrap();
    println!(
        "result envelope baseline bytes={}",
        serde_json::to_vec(&wait).unwrap().len()
    );
    assert!(
        !text.contains(&"x".repeat(4097)),
        "parent received an unbounded body"
    );
    assert!(text.contains("result_id"));
    assert!(wait["structuredContent"].get("waited_ms").is_none());
    let full = rig
        .call(
            parent,
            "pane_get",
            json!({"session":child,"result_id":row.id}),
        )
        .await;
    assert_eq!(full["body"], row.body);
    assert!(row.body.contains("submit truncated"));
    let stranger = rig.parent();
    let denied = rig
        .raw_call(
            stranger,
            "pane_get",
            json!({"session":child,"result_id":row.id}),
        )
        .await;
    assert_eq!(denied["isError"], true);
    for args in [
        json!({"session":parent,"result_id":row.id}),
        json!({"session":child,"result_id":0}),
        json!({"session":child,"result_id":i64::MAX}),
    ] {
        assert_eq!(
            rig.raw_call(parent, "pane_get", args).await["isError"],
            true
        );
    }
    rig.daemon.close(child).unwrap();
    let retained = rig
        .call(
            parent,
            "pane_get",
            json!({"session":child,"result_id":row.id}),
        )
        .await;
    assert_eq!(retained["body"], row.body);
    let url = format!(
        "{}/orchestrate/get?session={child}&result_id={}",
        rig.endpoint.trim_end_matches("/mcp"),
        row.id
    );
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let cli_result: Value = client
        .get(&url)
        .bearer_auth(rig.token(parent))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cli_result["body"], row.body);
    assert!(!client
        .get(&url)
        .bearer_auth(rig.token(stranger))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
}

#[tokio::test]
async fn h2_timing_boundaries_use_correlated_receipts() {
    submit_to_wait_and_delegation_bytes_fixture(1, 512).await;
    submit_to_wait_and_delegation_bytes_fixture(1, 3072).await;
    door_three_to_composer_fixture(1).await;
    restart_to_restored_notice_fixture(1).await;
}

#[tokio::test]
async fn h2_cli_wait_result_excerpt_matches_mcp() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let script = rig.script(
        "claude",
        1,
        "cli-excerpt",
        json!([
            {"op":"submit","summary":"CLI_DETAILS","bytes":12000},{"op":"hang"}
        ]),
    );
    let child = rig
        .call(
            parent,
            "pane_spawn",
            json!({"kind":"claude","prompt":format!("@fake:{}",script.display()),"reusable":true}),
        )
        .await["session"]
        .as_u64()
        .unwrap() as u32;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = rig.endpoint.trim_end_matches("/mcp");
    let wait: Value = client
        .post(format!("{base}/orchestrate/wait"))
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
    let row = wait["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "result")
        .unwrap();
    let body = row["body"].as_str().unwrap();
    println!(
        "CLI result envelope bytes={}",
        serde_json::to_vec(&wait).unwrap().len()
    );
    assert!(
        !body.contains(&"x".repeat(4097)),
        "CLI parent received an unbounded body"
    );
    assert!(body.contains("result_id"));
    assert!(wait.get("waited_ms").is_none());
    let stored = rig
        .daemon
        .inbox_rows_for_test(parent)
        .into_iter()
        .find(|stored| stored.id == row["id"].as_i64().unwrap())
        .unwrap();
    assert!(stored.body.contains("submit truncated"));
    let full: Value = client
        .get(format!(
            "{base}/orchestrate/get?session={child}&result_id={}",
            stored.id
        ))
        .bearer_auth(rig.token(parent))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(full["body"], stored.body);
}

#[tokio::test]
async fn claude_enabled_advertisement_stays_under_byte_budget() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.pane(
        proto::AgentKind::Claude,
        vec!["sh".into(), "-c".into(), "exec cat".into()],
    );
    let advertisement = rig.rpc(parent, "tools/list", json!({})).await;
    // Measured: 17,374 B of orchestration tools (825 B of them pane_pr_watch / pane_pr_unwatch)
    // plus 6,627 B for the eleven task_* tools a top-level pane gets at the default Read and
    // write Tasks access.
    bytes("claude/enabled", &advertisement, Some(24_001));
}

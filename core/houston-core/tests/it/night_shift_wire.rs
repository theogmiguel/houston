#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // env-ratchet: fixture git and shim setup

use crate::common;

use houston_core::daemon::Daemon;
use houston_core::hook_drop::HookDrop;
use houston_core::mcp_creds::McpScope;
use houston_core::night_shift::preflight::{Facts, MachineFacts, ProviderFacts};
use houston_protocol as proto;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const MINUTE: i64 = 60_000;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed in {}", dir.display());
}

fn shim_dir() -> PathBuf {
    static SHIM: OnceLock<PathBuf> = OnceLock::new();
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["codex", "claude", "opencode", "zcode"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'ARGV:%s\\n' \"$*\"\necho FIXTURE-READY\nexec cat\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    })
    .clone()
}

fn shim_env() -> houston_core::host_env::HostEnv {
    let dir = shim_dir();
    let base = common::base_env();
    let path_env = base.var("PATH").unwrap_or_default();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    base.with("PATH", Some(format!("{}:{path_env}", dir.display())))
        .with("HOME", Some(&home))
        .without("CODEX_HOME")
}

fn healthy_facts() -> Facts {
    Facts {
        orchestration_enabled: true,
        providers: [
            proto::AgentKind::Claude,
            proto::AgentKind::Codex,
            proto::AgentKind::Zcode,
            proto::AgentKind::Opencode,
        ]
        .into_iter()
        .map(|provider| ProviderFacts {
            provider,
            hooks_on: true,
            cli_present: true,
        })
        .collect(),
        machine: MachineFacts {
            on_battery: Some(false),
            memory_free_mib: Some(32 * 1024),
            disk_free_mib: Some(500 * 1024),
            reboot_pending: Some(false),
            active_hours: None,
            inhibitor_available: true,
        },
    }
}

type AwakeLog = Arc<Mutex<Vec<(u32, bool)>>>;

pub(crate) struct Rig {
    pub(crate) daemon: Arc<Daemon>,
    pub(crate) addr: SocketAddr,
    state: tempfile::TempDir,
    ws: PathBuf,
    awake: AwakeLog,
}

pub(crate) async fn rig() -> Rig {
    shim_dir();
    let (addr, state, daemon) = common::start_daemon_with_handle_in(shim_env()).await;
    let ws = state.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let ws = std::fs::canonicalize(ws).unwrap();
    git(&ws, &["init", "-q"]);
    git(&ws, &["commit", "-q", "--allow-empty", "-m", "init"]);
    daemon.workspace_add(&ws.display().to_string()).unwrap();
    daemon.set_night_shift_facts_for_test(Some(healthy_facts()));
    let awake: AwakeLog = Arc::default();
    let log = Arc::clone(&awake);
    daemon.set_night_shift_awake_for_test(Some(Arc::new(move |run, held| {
        log.lock().unwrap().push((run, held));
    })));
    daemon.set_routine_pane_cmd_for_test(vec![
        "sh".into(),
        "-c".into(),
        "stty -echo; echo ORCHESTRATOR-UP; exec cat".into(),
    ]);
    Rig {
        daemon,
        addr,
        state,
        ws,
        awake,
    }
}

struct State {
    routine: Option<proto::Routine>,
    settings: proto::NightShiftSettings,
    revision: String,
    runs: Vec<proto::NightRun>,
}

impl Rig {
    fn ws_str(&self) -> String {
        self.ws.display().to_string()
    }

    fn state(&self) -> State {
        match self.daemon.night_shift_state(&self.ws_str(), None).unwrap() {
            proto::ServerMsg::NightShiftState {
                routine,
                settings,
                revision,
                runs,
                ..
            } => State {
                routine,
                settings,
                revision,
                runs,
            },
            other => panic!("night_shift_state answers NightShiftState, not {other:?}"),
        }
    }

    fn create(&self) -> proto::Routine {
        self.daemon.night_shift_create(&self.ws_str()).unwrap();
        self.state().routine.expect("the routine exists")
    }

    /// Creates the routine with checks configured, ready to run.
    pub(crate) fn ready(
        &self,
        edit: impl FnOnce(&mut proto::NightShiftSettings),
    ) -> proto::Routine {
        let routine = self.create();
        let st = self.state();
        let mut s = st.settings;
        s.checks = vec!["true".into()];
        edit(&mut s);
        self.daemon
            .night_shift_update(routine.id, s, &st.revision)
            .unwrap();
        routine
    }

    pub(crate) fn run(&self, run_id: u32) -> proto::NightRun {
        self.state()
            .runs
            .into_iter()
            .find(|r| r.run_id == run_id)
            .expect("the run is listed")
    }

    pub(crate) fn run_now(&self, routine: u32, minutes: i64) -> proto::NightRun {
        let until = houston_core::daemon::now_unix_ms() + minutes * MINUTE;
        match self.daemon.night_shift_run_now(routine, until).unwrap() {
            proto::ServerMsg::NightShiftRunEvent { run } => self.run(run.run_id),
            other => panic!("run now answers a run event, not {other:?}"),
        }
    }

    pub(crate) fn token(&self, session: u32) -> String {
        self.daemon.mcp_creds.issue(McpScope {
            session_id: session,
            workspace_id: self.ws_str(),
        })
    }

    fn in_flight(&self, routine: u32) -> bool {
        self.daemon.routine_runs_in_flight().contains(&routine)
    }

    fn live(&self, session: u32) -> bool {
        self.daemon
            .list()
            .iter()
            .any(|s| s.id == session && s.state.is_live())
    }

    fn report_dir(&self, run: &proto::NightRun) -> PathBuf {
        Path::new(&run.report_path).parent().unwrap().to_path_buf()
    }

    fn brief(&self, run: &proto::NightRun) -> String {
        std::fs::read_to_string(self.report_dir(run).join("brief.md")).unwrap()
    }

    async fn spawn_child(&self, parent: u32, kind: &str) -> (u16, Value) {
        let token = self.token(parent);
        http_json(
            self.addr,
            "/orchestrate/spawn",
            &token,
            json!({ "kind": kind, "prompt": "work", "reusable": true }),
        )
        .await
    }

    async fn night(&self, session: u32, verb: &str, body: Value) -> (u16, Value) {
        http_json(
            self.addr,
            &format!("/night/{verb}"),
            &self.token(session),
            body,
        )
        .await
    }

    async fn drop_hook(&self, drop: HookDrop) {
        let event = drop.event.clone();
        let path = houston_core::hook_drop::write_drop(
            &houston_core::hook_drop::drop_dir(self.state.path()),
            &drop,
            houston_core::daemon::now_ms(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{event} drop never applied"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn turn_end(&self, session: u32) {
        self.drop_hook(HookDrop {
            session,
            agent: Some("claude".into()),
            event: "UserPromptSubmit".into(),
            ..Default::default()
        })
        .await;
        self.drop_hook(HookDrop {
            session,
            agent: Some("claude".into()),
            event: "Stop".into(),
            ..Default::default()
        })
        .await;
    }

    fn notes(&self, session: u32, needle: &str) -> usize {
        self.daemon
            .inbox_rows_for_test(session)
            .iter()
            .filter(|r| r.summary.contains(needle))
            .count()
    }
}

async fn http_json(addr: SocketAddr, path: &str, token: &str, body: Value) -> (u16, Value) {
    let (path, token) = (path.to_string(), token.to_string());
    tokio::task::spawn_blocking(move || {
        let payload = body.to_string();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\
             Accept: application/json, text/event-stream\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        stream.write_all(req.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, resp) = raw.split_once("\r\n\r\n").expect("http head/body split");
        let status: u16 = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("http status line");
        let body = if head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            let mut rest = resp;
            let mut out = String::new();
            while let Some((size, after)) = rest.split_once("\r\n") {
                let size = usize::from_str_radix(size.trim(), 16).unwrap();
                if size == 0 {
                    break;
                }
                out.push_str(&after[..size]);
                rest = &after[size + 2..];
            }
            out
        } else {
            resp.to_string()
        };
        (status, serde_json::from_str(&body).unwrap_or(Value::String(body)))
    })
    .await
    .unwrap()
}

async fn tool_names(addr: SocketAddr, token: &str) -> Vec<String> {
    let (status, v) = http_json(
        addr,
        "/mcp",
        token,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }),
    )
    .await;
    assert_eq!(status, 200, "{v}");
    v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn settings_rows(state: &Path, routine: u32) -> i64 {
    let conn = rusqlite::Connection::open(state.join("test.db")).unwrap();
    conn.query_row(
        "SELECT COUNT(*) FROM night_shift_settings WHERE routine_id = ?1",
        [routine],
        |r| r.get(0),
    )
    .unwrap()
}

// ---- S1 ----

#[tokio::test]
async fn create_is_paused_with_defaults_and_idempotent() {
    let r = rig().await;
    let created = r.create();
    assert_eq!(created.kind, proto::RoutineKind::NightShift);
    assert!(!created.enabled, "created paused");
    assert!(created.isolate);
    assert_eq!(
        created.permission_mode,
        proto::ChatPermissionMode::BypassPermissions
    );
    assert_eq!(created.workspace_id.as_deref(), Some(r.ws_str().as_str()));
    let st = r.state();
    assert_eq!(st.settings, houston_core::night_shift::settings::defaults());
    let d = &st.settings;
    assert_eq!(
        (
            d.window.start.hour,
            d.window.start.minute,
            d.window.wrap_up.hour,
            d.window.wrap_up.minute,
            d.window.hard_stop.hour,
            d.window.hard_stop.minute
        ),
        (23, 30, 6, 45, 7, 30)
    );
    assert!(d.window.nights.is_empty());
    assert_eq!(d.focus.reliability, proto::NightFocusLevel::Normal);
    assert_eq!(d.focus.performance, proto::NightFocusLevel::Normal);
    assert_eq!(d.focus.ui_polish, proto::NightFocusLevel::Off);
    assert_eq!(d.orchestrator.provider, proto::AgentKind::Claude);
    assert_eq!(
        d.workers.iter().map(|w| w.provider).collect::<Vec<_>>(),
        [proto::AgentKind::Zcode, proto::AgentKind::Claude]
    );
    assert_eq!(d.live_workers, 4);
    assert_eq!(d.reviewer, None);
    assert_eq!(d.output, proto::NightOutput::Prs);
    assert!(d.themed && d.screenshots && d.hold_for_qa);
    assert_eq!(d.max_changes_per_pr, 5);
    assert_eq!(d.app_check, None);
    assert!(d.checks.is_empty());
    assert_eq!(d.safety_cap_pane_hours, 60);
    assert_eq!(d.questions, proto::NightQuestions::Park);

    r.daemon.night_shift_create(&r.ws_str()).unwrap();
    let again = r.state().routine.unwrap();
    assert_eq!(
        again.id, created.id,
        "a second create answers the same routine"
    );
    let proto::ServerMsg::Routines { routines, .. } = r.daemon.routine_list() else {
        panic!("routine_list answers Routines");
    };
    assert_eq!(
        routines
            .iter()
            .filter(|x| x.kind == proto::RoutineKind::NightShift)
            .count(),
        1
    );
}

#[tokio::test]
async fn stale_revision_is_refused() {
    let r = rig().await;
    let routine = r.create();
    let st = r.state();
    let mut s = st.settings.clone();
    s.goal = "first".into();
    r.daemon
        .night_shift_update(routine.id, s.clone(), &st.revision)
        .unwrap();
    let current = r.state().revision;
    s.goal = "second".into();
    let err = r
        .daemon
        .night_shift_update(routine.id, s, &st.revision)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(&st.revision),
        "names the stale revision: {err}"
    );
    assert!(err.contains(&current), "names the current revision: {err}");
    assert_eq!(r.state().settings.goal, "first");
}

#[tokio::test]
async fn merge_output_needs_verify_and_app_check() {
    let r = rig().await;
    let routine = r.create();
    let st = r.state();
    let mut s = st.settings.clone();
    s.output = proto::NightOutput::MergeQueue;
    let err = r
        .daemon
        .night_shift_update(routine.id, s.clone(), &st.revision)
        .unwrap_err()
        .to_string();
    assert!(err.contains("verification command"), "{err}");
    assert!(err.contains("App check"), "{err}");
    r.daemon
        .merge_queue_settings_set(&r.ws_str(), false, "true", 30)
        .unwrap();
    s.app_check = Some(proto::NightAppCheck {
        start_command: "bun run dev".into(),
        address: "http://127.0.0.1:5173".into(),
        smoke_flows: vec!["open settings".into()],
    });
    r.daemon
        .night_shift_update(routine.id, s, &st.revision)
        .expect("both set: accepted");
    assert_eq!(r.state().settings.output, proto::NightOutput::MergeQueue);
}

#[tokio::test]
async fn delete_removes_settings() {
    let r = rig().await;
    let routine = r.create();
    assert_eq!(settings_rows(r.state.path(), routine.id), 1);
    let listed = match r.daemon.routine_list() {
        proto::ServerMsg::Routines { routines, .. } => {
            routines.into_iter().find(|x| x.id == routine.id).unwrap()
        }
        _ => unreachable!(),
    };
    assert_eq!(listed.kind, proto::RoutineKind::NightShift);
    r.daemon
        .routine_delete(routine.id, &listed.revision)
        .unwrap();
    assert_eq!(settings_rows(r.state.path(), routine.id), 0);
    assert!(r.state().routine.is_none());
}

// ---- S2 ----

#[tokio::test]
async fn run_fires_isolated_with_composed_brief() {
    let r = rig().await;
    let routine = r.ready(|s| {
        s.goal = "CI stays green".into();
        s.focus.test_gaps = proto::NightFocusLevel::High;
        s.checks = vec!["cargo test -p core".into()];
    });
    let run = r.run_now(routine.id, 120);
    assert_eq!(run.phase, proto::NightRunPhase::Running);
    let session = run.session_id.expect("the orchestrator pane opened");
    let pane = r
        .daemon
        .list()
        .into_iter()
        .find(|s| s.id == session)
        .unwrap();
    assert_ne!(Path::new(&pane.project_dir), r.ws.as_path());
    assert!(
        Path::new(&pane.project_dir).join(".git").is_file(),
        "the pane runs in a linked worktree: {}",
        pane.project_dir
    );
    let row = match r.daemon.routine_list() {
        proto::ServerMsg::Routines { routines, .. } => {
            routines.into_iter().find(|x| x.id == routine.id).unwrap()
        }
        _ => unreachable!(),
    };
    assert_eq!(
        row.permission_mode,
        proto::ChatPermissionMode::BypassPermissions
    );
    let brief = r.brief(&run);
    for needle in [
        "/goal CI stays green",
        "test gaps High",
        "zcode (GLM-5.3-Flash), then claude (opus)",
        "`cargo test -p core`",
        "draft pull requests only",
        "Ledger of earlier runs",
        &run.report_path,
    ] {
        assert!(brief.contains(needle), "the brief names {needle:?}");
    }
    assert!(brief.chars().count() <= proto::ROUTINE_PROMPT_MAX);
}

#[tokio::test]
async fn not_capped_and_not_settled_by_turn_end() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 180);
    let session = run.session_id.unwrap();
    r.daemon
        .routine_tick_at(run.started_at_ms + proto::ROUTINE_RUN_MAX_MS as i64 + MINUTE);
    assert!(
        r.in_flight(routine.id),
        "30 minutes do not stop a Night shift run"
    );
    assert!(r.live(session));
    r.turn_end(session).await;
    assert!(
        r.in_flight(routine.id),
        "a turn end before night_report does not settle the run"
    );
    assert_eq!(r.run(run.run_id).phase, proto::NightRunPhase::Running);
}

#[tokio::test]
async fn wrap_up_is_delivered_once() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let session = run.session_id.unwrap();
    r.daemon.routine_tick_at(run.wrap_up_at_ms - MINUTE);
    assert_eq!(r.notes(session, "Night shift wrap-up"), 0);
    r.daemon.routine_tick_at(run.wrap_up_at_ms + 1_000);
    r.daemon.routine_tick_at(run.wrap_up_at_ms + 16_000);
    assert_eq!(r.notes(session, "Night shift wrap-up"), 1);
    assert_eq!(r.run(run.run_id).phase, proto::NightRunPhase::WrappingUp);
    assert!(r.in_flight(routine.id));
}

#[tokio::test]
async fn hard_stop_kills_descendants_then_orchestrator() {
    let r = rig().await;
    r.daemon.orchestration_set(true).unwrap();
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let orchestrator = run.session_id.unwrap();
    let mut children = Vec::new();
    for kind in ["codex", "claude"] {
        let (status, body) = r.spawn_child(orchestrator, kind).await;
        assert_eq!(status, 200, "{body}");
        children.push(body["session_id"].as_u64().unwrap() as u32);
    }
    let (status, body) = r.spawn_child(children[0], "opencode").await;
    if status == 200 {
        children.push(body["session_id"].as_u64().unwrap() as u32);
    }
    r.daemon.routine_tick_at(run.hard_stop_at_ms + 1_000);
    let order = r.daemon.night_shift_stop_order(run.run_id);
    assert_eq!(order.last(), Some(&orchestrator), "{order:?}");
    for child in &children {
        assert!(
            order[..order.len() - 1].contains(child),
            "child {child} closed before the orchestrator: {order:?}"
        );
    }
    for pane in children.iter().chain([&orchestrator]) {
        wait_until("panes to close", || !r.live(*pane)).await;
    }
    let settled = r.run(run.run_id);
    assert_eq!(settled.phase, proto::NightRunPhase::Settled);
    assert_eq!(settled.stop_reason, Some(proto::NightStopReason::HardStop));
    assert!(!r.in_flight(routine.id));
}

#[tokio::test]
async fn wrap_up_and_stop_now() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 240);
    let session = run.session_id.unwrap();
    r.daemon.night_shift_wrap_up_now(run.run_id).unwrap();
    assert_eq!(r.notes(session, "Night shift wrap-up"), 1);
    assert_eq!(r.run(run.run_id).phase, proto::NightRunPhase::WrappingUp);
    r.daemon.night_shift_stop_now(run.run_id).unwrap();
    let stopped = r.run(run.run_id);
    assert_eq!(stopped.phase, proto::NightRunPhase::Settled);
    assert_eq!(stopped.stop_reason, Some(proto::NightStopReason::Stopped));
    wait_until("the orchestrator to close", || !r.live(session)).await;
    assert!(r.daemon.night_shift_stop_now(run.run_id).is_err());
}

#[tokio::test]
async fn safety_cap_stops_run() {
    let r = rig().await;
    let routine = r.ready(|s| s.safety_cap_pane_hours = 1);
    let run = r.run_now(routine.id, 240);
    r.daemon.routine_tick_at(run.started_at_ms + 30 * MINUTE);
    assert!(r.in_flight(routine.id), "half a pane-hour is under the cap");
    r.daemon.routine_tick_at(run.started_at_ms + 61 * MINUTE);
    let stopped = r.run(run.run_id);
    assert_eq!(stopped.stop_reason, Some(proto::NightStopReason::SafetyCap));
    let detail = stopped.stop_detail.unwrap();
    assert!(detail.contains("1 pane-hour safety cap"), "{detail}");
    assert!(
        detail.contains("1.02 pane-hours"),
        "names the value: {detail}"
    );
    assert!(stopped.cost.pane_hours >= 1.0);
    assert!(!r.in_flight(routine.id));
}

// ---- S3 ----

#[tokio::test]
async fn night_tools_only_for_orchestrator() {
    let r = rig().await;
    r.daemon.orchestration_set(true).unwrap();
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let orchestrator = run.session_id.unwrap();
    let names = tool_names(r.addr, &r.token(orchestrator)).await;
    for verb in ["plan", "pr", "lesson", "decision", "report"] {
        assert!(names.contains(&format!("night_{verb}")), "{names:?}");
    }
    let (status, body) = r.spawn_child(orchestrator, "codex").await;
    assert_eq!(status, 200, "{body}");
    let worker = body["session_id"].as_u64().unwrap() as u32;
    let names = tool_names(r.addr, &r.token(worker)).await;
    assert!(!names.iter().any(|n| n.starts_with("night_")), "{names:?}");
    let (status, body) = r.night(worker, "plan", json!({ "title": "sneak" })).await;
    assert_ne!(status, 200);
    assert!(
        body.to_string().contains(&format!("pane {worker}")),
        "names the pane: {body}"
    );
    let (status, body) = r
        .night(
            orchestrator,
            "plan",
            json!({ "title": "Faster attach", "theme": "perf" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let entries = r.run(run.run_id).entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, proto::NightEntryKind::Plan);
}

#[tokio::test]
async fn report_publish_bounds_and_settles() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let session = run.session_id.unwrap();
    let report = PathBuf::from(&run.report_path);
    let (status, body) = r
        .night(session, "report", json!({ "summary": "done" }))
        .await;
    assert_ne!(status, 200);
    assert!(body.to_string().contains("does not exist"), "{body}");
    std::fs::write(&report, "x".repeat(300 * 1024)).unwrap();
    let (status, body) = r
        .night(session, "report", json!({ "summary": "done" }))
        .await;
    assert_ne!(status, 200);
    let text = body.to_string();
    assert!(
        text.contains(&(300 * 1024).to_string()),
        "names the size: {text}"
    );
    assert!(text.contains("262144"), "names the cap: {text}");
    std::fs::write(&report, "# Morning\n\nTwo PRs.\n").unwrap();
    let (status, body) = r
        .night(
            session,
            "report",
            json!({ "summary": "2 PRs", "merge_order": [12, 9] }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    let published = r.run(run.run_id);
    assert!(published.report_published);
    assert_eq!(published.summary.as_deref(), Some("2 PRs"));
    assert_eq!(published.merge_order, [12, 9]);
    assert!(
        r.in_flight(routine.id),
        "it settles at the turn end, not before"
    );
    r.turn_end(session).await;
    wait_until("the run to settle", || !r.in_flight(routine.id)).await;
    let settled = r.run(run.run_id);
    assert_eq!(settled.phase, proto::NightRunPhase::Settled);
    assert_eq!(settled.stop_reason, Some(proto::NightStopReason::Report));
    let proto::ServerMsg::NightShiftReport { markdown, .. } =
        r.daemon.night_shift_report(run.run_id).unwrap()
    else {
        panic!("night_shift_report answers NightShiftReport");
    };
    assert!(markdown.contains("Two PRs."));
}

#[tokio::test]
async fn ledger_digest_reaches_next_brief() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let first = r.run_now(routine.id, 120);
    let o = first.session_id.unwrap();
    for (verb, body) in [
        (
            "plan",
            json!({ "title": "Rewrite the tray", "deferred": true }),
        ),
        ("plan", json!({ "title": "Kept plan" })),
        ("lesson", json!({ "title": "Use nextest for core tests" })),
        (
            "lesson",
            json!({ "title": "Resize races", "flaky_test": "pty::resize_race" }),
        ),
    ] {
        let (status, v) = r.night(o, verb, body).await;
        assert_eq!(status, 200, "{v}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    r.daemon.night_shift_stop_now(first.run_id).unwrap();
    let second = r.run_now(routine.id, 120);
    let brief = r.brief(&second);
    let at = |needle: &str| {
        brief
            .find(needle)
            .unwrap_or_else(|| panic!("the second brief names {needle:?}"))
    };
    let (flaky, lesson, deferred) = (
        at("[flaky test] pty::resize_race"),
        at("[lesson] Use nextest for core tests"),
        at("[deferred] Rewrite the tray"),
    );
    assert!(flaky < lesson && lesson < deferred, "newest first");
    assert!(!brief.contains("Kept plan"));
}

#[tokio::test]
async fn settle_broadcasts_one_notice() {
    let r = rig().await;
    let mut ws = common::connect_and_hello(r.addr, common::TOKEN).await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let o = run.session_id.unwrap();
    for body in [
        json!({ "number": 12, "title": "Tray fix", "theme": "reliability" }),
        json!({ "number": 13, "title": "Faster diff", "theme": "performance" }),
    ] {
        assert_eq!(r.night(o, "pr", body).await.0, 200);
    }
    assert_eq!(
        r.night(o, "decision", json!({ "title": "Drop Windows 10?" }))
            .await
            .0,
        200
    );
    r.daemon.night_shift_stop_now(run.run_id).unwrap();
    let mut notices = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), common::next_control(&mut ws)).await
        {
            Ok(proto::ServerMsg::NightShiftNotice {
                run_id, headline, ..
            }) => notices.push((run_id, headline)),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert_eq!(notices, [(run.run_id, "2 PRs, 1 decision".to_string())]);
}

#[tokio::test]
async fn decision_answered_once() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let o = run.session_id.unwrap();
    assert_eq!(
        r.night(
            o,
            "decision",
            json!({ "title": "Keep the old API?", "options": ["keep", "remove"] })
        )
        .await
        .0,
        200
    );
    let entry = r.run(run.run_id).entries[0].clone();
    assert!(entry.body.contains("keep | remove"));
    r.daemon.night_shift_decide(entry.id, "remove").unwrap();
    let err = r
        .daemon
        .night_shift_decide(entry.id, "keep")
        .unwrap_err()
        .to_string();
    assert!(err.contains("\"remove\""), "names the first answer: {err}");
    let decided = r.run(run.run_id).entries[0].clone();
    assert_eq!(decided.choice.as_deref(), Some("remove"));
    assert!(decided.decided_at_ms.is_some());
}

// ---- S4 ----

#[tokio::test]
async fn blocking_preflight_refuses_run() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let mut facts = healthy_facts();
    facts.machine.memory_free_mib = Some(1024);
    facts.machine.on_battery = Some(true);
    r.daemon.set_night_shift_facts_for_test(Some(facts));
    let before = r.daemon.list().len();
    let run = r.run_now(routine.id, 120);
    assert_eq!(run.phase, proto::NightRunPhase::Refused);
    assert_eq!(run.session_id, None);
    assert_eq!(r.daemon.list().len(), before, "no pane opened");
    let blocks: Vec<&str> = run
        .preflight
        .iter()
        .filter(|i| i.status == proto::PreflightStatus::Block)
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(blocks, ["on_battery", "memory"]);
    assert!(
        run.preflight.len() > blocks.len(),
        "the refused run carries every item"
    );
    let memory = run.preflight.iter().find(|i| i.id == "memory").unwrap();
    assert_eq!(memory.limit.as_deref(), Some("6144 MiB"));
    assert_eq!(memory.actual.as_deref(), Some("1024 MiB"));
    assert!(!r.in_flight(routine.id));
    let proto::ServerMsg::RoutineRuns { runs } = r.daemon.routine_runs_list(Some(routine.id))
    else {
        panic!("routine_runs_list answers RoutineRuns");
    };
    assert_eq!(runs[0].status, proto::RoutineRunStatus::EngineRefused);
}

#[tokio::test]
async fn keep_awake_held_for_run() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    assert_eq!(*r.awake.lock().unwrap(), [(run.run_id, true)]);
    assert_eq!(r.run(run.run_id).keep_awake, proto::NightKeepAwake::Held);
    r.daemon.night_shift_stop_now(run.run_id).unwrap();
    assert_eq!(
        *r.awake.lock().unwrap(),
        [(run.run_id, true), (run.run_id, false)]
    );
    assert_eq!(r.run(run.run_id).keep_awake, proto::NightKeepAwake::Off);
}

/// Restarts reopen the database in a second daemon, as a daemon start does.
#[tokio::test]
async fn restart_resumes_or_settles() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 240);
    let session = run.session_id.unwrap();
    let until = houston_core::daemon::now_unix_ms() + 60 * MINUTE;
    assert!(
        r.daemon.night_shift_run_now(routine.id, until).is_err(),
        "one run per routine at a time"
    );

    // Same daemon, run forgotten as a restart forgets it: the pane is live
    // and the hard stop is ahead, so the run continues.
    r.daemon.forget_routine_runs_for_test();
    r.daemon.set_night_shift_awake_for_test(None);
    let log = Arc::clone(&r.awake);
    r.daemon
        .set_night_shift_awake_for_test(Some(Arc::new(move |run, held| {
            log.lock().unwrap().push((run, held));
        })));
    r.daemon
        .night_shift_recover_at(run.started_at_ms + 10 * MINUTE);
    assert!(r.in_flight(routine.id), "resumed before wrap-up");
    let resumed = r.run(run.run_id);
    assert_eq!(resumed.session_id, Some(session));
    assert_eq!(resumed.interruptions.len(), 1);
    assert!(resumed.interruptions[0].resumed);
    assert_eq!(
        r.awake.lock().unwrap().last(),
        Some(&(run.run_id, true)),
        "keep-awake re-acquired"
    );

    // Past wrap-up the run settles, with the interruption recorded.
    r.daemon.forget_routine_runs_for_test();
    r.daemon.night_shift_recover_at(run.wrap_up_at_ms + MINUTE);
    let settled = r.run(run.run_id);
    assert_eq!(settled.phase, proto::NightRunPhase::Settled);
    assert_eq!(settled.stop_reason, Some(proto::NightStopReason::Restart));
    assert_eq!(settled.interruptions.len(), 2);
    assert!(!settled.interruptions[1].resumed);
    assert!(!r.in_flight(routine.id));
    wait_until("the late pane to close", || !r.live(session)).await;
}

#[tokio::test]
async fn interrupted_run_survives_a_database_reopen() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 240);
    let db = houston_core::db::Db::open(&r.state.path().join("test.db")).unwrap();
    let row = db.night_run(run.run_id).unwrap().unwrap();
    assert!(
        row.ended_at_ms.is_none(),
        "reopening keeps the run in flight"
    );
    let proto::ServerMsg::RoutineRuns { runs } = r.daemon.routine_runs_list(Some(routine.id))
    else {
        panic!("routine_runs_list answers RoutineRuns");
    };
    assert_eq!(runs[0].status, proto::RoutineRunStatus::Running);
}

// ---- S5 ----

#[tokio::test]
async fn claude_limit_marks_provider() {
    let r = rig().await;
    r.daemon.orchestration_set(true).unwrap();
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let o = run.session_id.unwrap();
    let (status, body) = r.spawn_child(o, "claude").await;
    assert_eq!(status, 200, "{body}");
    let child = body["session_id"].as_u64().unwrap() as u32;
    for _ in 0..2 {
        r.drop_hook(HookDrop {
            session: child,
            agent: Some("claude".into()),
            event: "UserPromptSubmit".into(),
            ..Default::default()
        })
        .await;
        r.drop_hook(HookDrop {
            session: child,
            agent: Some("claude".into()),
            event: "StopFailure".into(),
            error: Some("rate_limit".into()),
            ..Default::default()
        })
        .await;
    }
    assert_eq!(r.run(run.run_id).limited, [proto::AgentKind::Claude]);
    assert_eq!(
        r.notes(o, "Night shift: claude limited"),
        1,
        "the orchestrator is told once"
    );
    let note = r
        .daemon
        .inbox_rows_for_test(o)
        .into_iter()
        .find(|row| row.summary.contains("Night shift: claude limited"))
        .expect("the Night shift note");
    assert!(
        note.body.contains("zcode"),
        "names the next provider: {}",
        note.body
    );
}

#[tokio::test]
async fn spawn_substitutes_next_provider() {
    let r = rig().await;
    r.daemon.orchestration_set(true).unwrap();
    let routine = r.ready(|s| {
        s.workers = vec![
            proto::NightAgent {
                provider: proto::AgentKind::Claude,
                model: None,
            },
            proto::NightAgent {
                provider: proto::AgentKind::Codex,
                model: None,
            },
        ];
    });
    let run = r.run_now(routine.id, 120);
    let o = run.session_id.unwrap();
    let (status, body) = r.spawn_child(o, "claude").await;
    assert_eq!(status, 200, "{body}");
    let first = body["session_id"].as_u64().unwrap() as u32;
    r.daemon
        .night_shift_mark_limited_for_test(first, proto::AgentKind::Claude);
    let (status, body) = r.spawn_child(o, "claude").await;
    assert_eq!(status, 200, "{body}");
    let child = body["session_id"].as_u64().unwrap() as u32;
    assert_eq!(
        r.daemon.agent_kind_of(child),
        Some(proto::AgentKind::Codex),
        "the limited provider was swapped"
    );
    let warnings = body.to_string();
    assert!(
        warnings.contains("night_shift_substituted")
            && warnings.contains("requested claude, started codex"),
        "{warnings}"
    );
    let (status, body) = r.spawn_child(o, "grok").await;
    assert_ne!(status, 200);
    assert!(body.to_string().contains("grok"), "{body}");
    r.daemon
        .night_shift_mark_limited_for_test(child, proto::AgentKind::Codex);
    let (status, body) = r.spawn_child(o, "codex").await;
    assert_ne!(status, 200);
    let text = body.to_string();
    assert!(text.contains("claude") && text.contains("codex"), "{text}");
}

#[tokio::test]
async fn zcode_stall_with_failed_probe_marks_provider() {
    let r = rig().await;
    r.daemon.orchestration_set(true).unwrap();
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 600);
    let o = run.session_id.unwrap();
    let (status, body) = r.spawn_child(o, "zcode").await;
    assert_eq!(status, 200, "{body}");
    let child = body["session_id"].as_u64().unwrap() as u32;
    r.daemon
        .set_session_status_for_test(child, proto::AgentStatus::Working);
    let t0 = houston_core::daemon::now_unix_ms();
    r.daemon.night_shift_tick_at(t0);
    r.daemon.set_night_shift_zcode_probe_for_test(Some(true));
    r.daemon.night_shift_tick_at(t0 + 21 * MINUTE);
    assert!(
        r.run(run.run_id).limited.is_empty(),
        "a passing probe is not a limit"
    );
    r.daemon.set_night_shift_zcode_probe_for_test(Some(false));
    r.daemon.night_shift_tick_at(t0 + 42 * MINUTE);
    assert_eq!(r.run(run.run_id).limited, [proto::AgentKind::Zcode]);
    assert_eq!(r.notes(o, "Night shift: zcode limited"), 1);
}

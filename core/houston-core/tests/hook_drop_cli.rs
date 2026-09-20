#![allow(clippy::disallowed_methods)]
#![cfg(unix)]

use houston_core::hook_drop::{self, HookDrop};
use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_houston-core")
}

const CHANNEL: &str = "hooktest";

struct Fixture {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    project_dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let project_dir = home.join("code").join("myproj");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::create_dir_all(home.join(format!(".houston-{CHANNEL}"))).unwrap();
        Self {
            _tmp: tmp,
            home,
            project_dir,
        }
    }

    fn state_dir(&self) -> PathBuf {
        self.home.join(format!(".houston-{CHANNEL}"))
    }

    fn drop_dir(&self) -> PathBuf {
        hook_drop::drop_dir(&self.state_dir())
    }

    fn run_hook(&self, event: &str, session: u32, stdin: &str) -> (i32, String, String) {
        self.run_provider_hook(event, session, None, stdin)
    }

    fn run_provider_hook(
        &self,
        event: &str,
        session: u32,
        agent: Option<&str>,
        stdin: &str,
    ) -> (i32, String, String) {
        let mut cmd = Command::new(bin());
        cmd.arg("hook").arg(event).arg("--houston-managed");
        if let Some(agent) = agent {
            cmd.arg("--agent").arg(agent);
        }
        cmd.env_clear();
        cmd.env("HOME", &self.home);
        cmd.env("HOUSTON_CHANNEL", CHANNEL);
        cmd.env("TR_SESSION", session.to_string());
        cmd.current_dir(&self.project_dir);
        run_with_stdin(cmd, stdin)
    }
    fn run_hook_via_launcher(
        &self,
        state_dir_name: &str,
        event: &str,
        session: u32,
        stdin: &str,
    ) -> (i32, String, String) {
        let bin_dir = self.home.join(state_dir_name).join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let launcher = bin_dir.join("claude-hook");
        std::os::unix::fs::symlink(bin(), &launcher).unwrap();
        let mut cmd = Command::new(&launcher);
        cmd.arg("hook").arg(event).arg("--houston-managed");
        cmd.env_clear();
        cmd.env("HOME", &self.home);
        cmd.env("HOUSTON_CHANNEL", CHANNEL);
        cmd.env("TR_SESSION", session.to_string());
        cmd.current_dir(&self.project_dir);
        run_with_stdin(cmd, stdin)
    }
}

fn run_with_stdin(mut cmd: Command, stdin: &str) -> (i32, String, String) {
    use std::io::Write as _;
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("spawning the hook helper");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn drops(dir: &Path) -> Vec<HookDrop> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| hook_drop::parse_drop_name(n).is_some())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
        .iter()
        .map(|n| serde_json::from_slice(&std::fs::read(dir.join(n)).unwrap()).unwrap())
        .collect()
}

#[test]
fn a_hook_writes_a_drop_file_with_no_daemon_and_no_port() {
    let f = Fixture::new();
    let (code, stdout, stderr) = f.run_hook(
        "Stop",
        7,
        r#"{"session_id":"abc-123","cwd":"/home/dev/proj"}"#,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "", "an observe-only hook must print nothing");

    let got = drops(&f.drop_dir());
    assert_eq!(got.len(), 1, "exactly one drop file: {got:?}");
    assert_eq!(got[0].event, "Stop");
    assert_eq!(got[0].session, 7);
    assert_eq!(got[0].cwd.as_deref(), Some("/home/dev/proj"));
}

#[test]
fn the_prompt_rides_the_prompt_event_only_and_only_its_head() {
    let f = Fixture::new();
    let long = "x".repeat(hook_drop::PROMPT_CAPTURE_CHARS + 50);
    let (code, _, stderr) = f.run_hook(
        "UserPromptSubmit",
        3,
        &format!(r#"{{"session_id":"s","prompt":"{long}"}}"#),
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    let (code, _, stderr) = f.run_hook("Stop", 3, r#"{"session_id":"s","prompt":"not lifted"}"#);
    assert_eq!(code, 0, "stderr: {stderr}");

    let got = drops(&f.drop_dir());
    assert_eq!(got.len(), 2, "{got:?}");
    let submit = got.iter().find(|d| d.event == "UserPromptSubmit").unwrap();
    assert_eq!(
        submit.prompt.as_deref().map(str::len),
        Some(hook_drop::PROMPT_CAPTURE_CHARS)
    );
    let stop = got.iter().find(|d| d.event == "Stop").unwrap();
    assert_eq!(stop.prompt, None);
}

#[test]
fn provider_prompt_seams_carry_the_first_prompt() {
    let f = Fixture::new();
    let (code, _, stderr) = f.run_provider_hook(
        "PreInvocation",
        8,
        Some("antigravity"),
        r#"{"prompt":"inspect the parser"}"#,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    let (code, _, stderr) = f.run_provider_hook(
        "notify",
        9,
        Some("codex"),
        r#"{"input-messages":["repair the migration"]}"#,
    );
    assert_eq!(code, 0, "stderr: {stderr}");

    let antigravity = drops(&f.drop_dir())
        .into_iter()
        .find(|drop| drop.session == 8)
        .unwrap();
    assert_eq!(antigravity.prompt.as_deref(), Some("inspect the parser"));
    let codex = drops(&f.drop_dir())
        .into_iter()
        .find(|drop| drop.session == 9)
        .unwrap();
    assert_eq!(codex.prompt.as_deref(), Some("repair the migration"));
}

#[test]
fn an_odd_payload_costs_the_field_never_the_status_event() {
    for (label, stdin) in [
        ("absent", r#"{"session_id":"x"}"#),
        ("non-string", r#"{"cwd":12345}"#),
        ("not json", "not json at all"),
        ("empty", ""),
    ] {
        let f = Fixture::new();
        let (code, _, stderr) = f.run_hook("UserPromptSubmit", 3, stdin);
        assert_eq!(code, 0, "{label}: stderr {stderr}");
        let got = drops(&f.drop_dir());
        assert_eq!(got.len(), 1, "{label}: the event must still land: {got:?}");
        assert_eq!(got[0].event, "UserPromptSubmit", "{label}");
        assert_eq!(got[0].session, 3, "{label}");
        assert_eq!(
            got[0].cwd, None,
            "{label}: a bad cwd is dropped, not coerced"
        );
    }
}

#[test]
fn a_hook_outside_a_tr_pane_writes_nothing() {
    let f = Fixture::new();
    let mut cmd = Command::new(bin());
    cmd.arg("hook").arg("Stop");
    cmd.env_clear();
    cmd.env("HOME", &f.home);
    cmd.env("HOUSTON_CHANNEL", CHANNEL);
    let (code, stdout, _) = run_with_stdin(cmd, "{}");
    assert_eq!(code, 0);
    assert_eq!(stdout, "");
    assert!(drops(&f.drop_dir()).is_empty());
}

#[test]
fn consecutive_events_keep_their_order_in_the_drop_names() {
    let f = Fixture::new();
    f.run_hook("UserPromptSubmit", 4, "{}");
    f.run_hook("Stop", 4, "{}");
    let got = drops(&f.drop_dir());
    assert_eq!(
        got.iter().map(|d| d.event.as_str()).collect::<Vec<_>>(),
        vec!["UserPromptSubmit", "Stop"],
        "an inverted pair leaves the pane wrong indefinitely — nothing re-asserts v19 status"
    );

    let names: Vec<String> = {
        let mut n: Vec<String> = std::fs::read_dir(f.drop_dir())
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| hook_drop::parse_drop_name(n).is_some())
            .collect();
        n.sort();
        n
    };
    assert_eq!(names.len(), 2);
    let a = hook_drop::parse_drop_name(&names[0]).unwrap();
    let b = hook_drop::parse_drop_name(&names[1]).unwrap();
    assert_eq!(a.session, 4);
    assert_eq!(b.session, 4);
    assert!(
        (a.ms, a.seq) < (b.ms, b.seq),
        "the applied order is (ms, seq): {names:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_refused_drop_directory_is_reported_on_stderr_and_never_on_stdout() {
    let f = Fixture::new();
    let elsewhere = f.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::create_dir_all(f.drop_dir().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, f.drop_dir()).unwrap();

    let (code, stdout, stderr) = f.run_hook("Stop", 9, "{}");
    assert_eq!(code, 0, "a hook must never fail Claude's turn");
    assert_eq!(
        stdout, "",
        "a diagnostic must never reach stdout: {stdout:?}"
    );
    assert!(
        stderr.contains("refusing to chmod through it"),
        "the refusal itself must be named: {stderr:?}"
    );
    assert!(
        stderr.contains(&f.drop_dir().display().to_string()),
        "the offending path must be named: {stderr:?}"
    );
    assert!(
        stderr.contains("status transition is lost"),
        "the consequence must be named, not just the errno: {stderr:?}"
    );
}

struct Scope {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl Scope {
    fn new(labels: &[&str]) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("wt/.houston/swarm/1");
        let layout = houston_core::scope::ScopeLayout::from_scope(root.clone());
        let owned: Vec<String> = labels.iter().map(|l| l.to_string()).collect();
        layout.create_all(&owned).unwrap();
        Self { _tmp: tmp, root }
    }
}

fn run_swarm_hook(
    f: &Fixture,
    scope: &Scope,
    label: &str,
    event: &str,
    session: u32,
) -> (i32, String, String) {
    let mut cmd = Command::new(bin());
    cmd.arg("hook").arg(event).arg("--houston-managed");
    cmd.env_clear();
    cmd.env("HOME", &f.home);
    cmd.env("HOUSTON_CHANNEL", CHANNEL);
    cmd.env("TR_SESSION", session.to_string());
    cmd.env("TR_SWARM_SCOPE", &scope.root);
    cmd.env("SWARM_AGENT_NAME", label);
    run_with_stdin(cmd, "{}")
}

#[test]
fn a_hook_fired_with_a_stale_tr_swarm_scope_writes_its_drop_under_the_config_dir() {
    let f = Fixture::new();
    let scope = Scope::new(&["Alice"]);
    let (code, _, stderr) = run_swarm_hook(&f, &scope, "Alice", "Stop", 12);
    assert_eq!(code, 0, "stderr: {stderr}");

    let landed = drops(&f.drop_dir());
    assert_eq!(landed.len(), 1, "the config dir holds it: {landed:?}");
    assert_eq!(landed[0].event, "Stop");
    assert!(
        drops(&hook_drop::drop_dir(&scope.root)).is_empty(),
        "a stale TR_SWARM_SCOPE must not redirect the drop any more"
    );
}

#[test]
fn a_drop_file_round_trips_every_field_it_can_carry() {
    let full = HookDrop {
        v: hook_drop::DROP_V,
        event: "Stop".into(),
        session: 7,
        cwd: Some("/home/user/code/myproj".into()),
        transcript_path: Some("/home/user/.claude/projects/p/sess.jsonl".into()),
        agent: Some("claude".into()),
        prompt: Some("do the thing".into()),
        last_message: Some("Waiting for the agent to complete...".into()),
        background_tasks: Some(0),
        internal_prompt: false,
        reason: Some("Bash".into()),
        notification_type: Some("permission_prompt".into()),
        stop_hook_active: true,
        prompt_id: Some("prompt-abc".into()),
        pending_task_ids: vec!["task-1".into(), "task-2".into()],
        task_id: Some("task-1".into()),
        agent_id: Some("agent-9".into()),
        tool_use_id: Some("toolu_1".into()),
        stop_continued: true,
        session_id: Some("conv-root-1".into()),
        fully_idle: Some(true),
        tool_name: Some("ask_question".into()),
    };
    let text = serde_json::to_string(&full).expect("serialize");
    let back: HookDrop = serde_json::from_str(&text).expect("parse");
    assert_eq!(back, full, "every field survives the round trip: {text}");
}

#[test]
fn a_drop_file_from_before_these_fields_still_parses() {
    let old = r#"{"v":1,"event":"UserPromptSubmit","session":42}"#;
    let back: HookDrop = serde_json::from_str(old).expect("parse");
    assert_eq!(back.v, hook_drop::DROP_V);
    assert_eq!(back.event, "UserPromptSubmit");
    assert_eq!(back.session, 42);
    assert_eq!(back.last_message, None);
    assert_eq!(back.background_tasks, None);
    assert!(!back.internal_prompt);
    assert_eq!(back.reason, None);
    assert_eq!(back.notification_type, None);
    assert!(!back.stop_hook_active);
    assert_eq!(back.prompt_id, None);
    assert!(back.pending_task_ids.is_empty());
    assert_eq!(back.task_id, None);
    assert_eq!(back.agent_id, None);
    assert_eq!(back.tool_use_id, None);
    assert!(!back.stop_continued);
}

#[test]
#[cfg(unix)]
fn only_the_panes_own_channel_launcher_drops_the_event() {
    let f = Fixture::new();
    let (code, out, err) =
        f.run_hook_via_launcher(".houston", "UserPromptSubmit", 7, r#"{"prompt":"hi"}"#);
    assert_eq!(code, 0, "a hook must never disrupt the CLI: {err}");
    assert!(out.is_empty(), "nothing reaches the CLI's context: {out:?}");
    assert!(
        err.contains("another channel"),
        "the stand-down names itself on stderr: {err:?}"
    );
    assert!(
        drops(&f.drop_dir()).is_empty(),
        "the other channel's launcher wrote a drop"
    );

    let (code, _, err) = f.run_hook_via_launcher(
        &format!(".houston-{CHANNEL}"),
        "UserPromptSubmit",
        7,
        r#"{"prompt":"hi"}"#,
    );
    assert_eq!(code, 0, "{err}");
    let written = drops(&f.drop_dir());
    assert_eq!(
        written.len(),
        1,
        "the pane's own launcher drops exactly once: {written:?}"
    );
    assert_eq!(written[0].event, "UserPromptSubmit");
}

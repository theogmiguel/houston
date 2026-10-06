#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::Daemon;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static SHIM: OnceLock<PathBuf> = OnceLock::new();

/// Fake agent CLIs that print their cwd, their task env and their argv, so a
/// test sees what the daemon actually launched.
fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\n# Raw input like a real agent TUI: canonical mode would hold the paste's\n\
                 # unterminated last line inside the tty until a newline.\n\
                 stty -echo -icanon 2>/dev/null\nprintf 'CWD:%s\\n' \"$PWD\"\n\
                 printf 'TASK:%s\\n' \"$HOUSTON_TASK\"\nprintf 'ARG:%s\\n' \"$@\"\n\
                 echo FIXTURE-READY\nexec cat\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    ws_dir: PathBuf,
}

async fn rig(name: &str) -> Rig {
    shim_dir();
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let ws_dir = state.path().join(name);
    std::fs::create_dir_all(&ws_dir).unwrap();
    init_repo(&ws_dir);
    let ws_dir = ws_dir.canonicalize().unwrap();
    daemon.workspace_add(&ws_dir.display().to_string()).unwrap();
    Rig {
        daemon,
        state,
        ws_dir,
    }
}

impl Rig {
    fn workspace(&self) -> String {
        self.ws_dir.display().to_string()
    }

    fn db_path(&self) -> PathBuf {
        self.state.path().join("test.db")
    }

    fn create_task(&self, title: &str, description: &str, acceptance: &[&str]) -> i64 {
        let patch = proto::TaskPatch {
            title: Some(title.to_string()),
            description: Some(description.to_string()),
            acceptance: Some(acceptance.iter().map(|s| s.to_string()).collect()),
            ..Default::default()
        };
        match self
            .daemon
            .task_save(&self.workspace(), None, None, patch)
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }

    fn runs(&self) -> Vec<Run> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, attempt, state, session_id, worktree_path, branch, \
                        provider, reason FROM backlog_task_runs ORDER BY id",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(Run {
                id: r.get(0)?,
                task_id: r.get(1)?,
                attempt: r.get(2)?,
                state: r.get(3)?,
                session_id: r.get(4)?,
                worktree_path: r.get(5)?,
                branch: r.get(6)?,
                provider: r.get(7)?,
                reason: r.get(8)?,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn task_status(&self, id: i64) -> String {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.query_row(
            "SELECT status FROM backlog_tasks WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn worktree_rows(&self) -> Vec<(String, String, Option<u32>)> {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        let mut stmt = conn
            .prepare("SELECT path, branch, created_by_session FROM managed_worktrees ORDER BY path")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    async fn await_output(&self, session: u32, needle: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let replay = self.daemon.scrollback(session, None).unwrap();
            let text = String::from_utf8_lossy(&replay.data).into_owned();
            if text.contains(needle) {
                return text;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "session {session} never printed {needle:?}: {text:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Run {
    id: i64,
    task_id: i64,
    attempt: u32,
    state: String,
    session_id: Option<u32>,
    worktree_path: Option<String>,
    branch: Option<String>,
    provider: String,
    reason: Option<String>,
}

#[tokio::test]
async fn start_creates_a_worktree_branch_and_a_bound_session() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-basic").await;
    let id = r.create_task(
        "Fix login",
        "The login page crashes when the password field is empty.",
        &["Login no longer crashes", "A test covers it"],
    );

    let reply = r
        .daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let proto::ServerMsg::TaskChanged { id: changed, .. } = reply else {
        panic!("expected TaskChanged, got {reply:?}");
    };
    assert_eq!(changed, id);

    let runs = r.runs();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let run = &runs[0];
    assert_eq!(run.state, "running");
    assert_eq!(run.provider, "grok");
    assert_eq!(run.attempt, 1);
    let session = run.session_id.expect("the run bounds a session");
    let branch = run.branch.clone().unwrap();
    assert!(
        branch.starts_with("houston/task/hou-1-fix-login"),
        "{branch}"
    );
    let worktree = PathBuf::from(run.worktree_path.clone().unwrap());
    assert!(worktree.is_dir(), "{}", worktree.display());
    let in_workspace = r.ws_dir.join(".houston").join("worktrees");
    assert!(
        worktree.starts_with(&in_workspace),
        "the task worktree lives under {} like a pane_spawn worktree: {}",
        in_workspace.display(),
        worktree.display()
    );
    let porcelain = git(&r.ws_dir, &["worktree", "list", "--porcelain"]);
    let entry = porcelain
        .split("\n\n")
        .find(|block| {
            block
                .lines()
                .any(|line| line == format!("worktree {}", worktree.display()))
        })
        .unwrap_or_else(|| panic!("the task worktree is registered: {porcelain}"));
    assert!(
        entry.contains(&format!("branch refs/heads/{branch}")),
        "the branch is checked out: {porcelain}"
    );

    let listed = r.daemon.list();
    let info = listed.iter().find(|s| s.id == session).expect("session");
    assert_eq!(info.cwd, worktree.display().to_string());
    assert_eq!(
        info.project_dir,
        r.workspace(),
        "the pane belongs to the workspace, not to its worktree"
    );
    assert!(info.title.starts_with("HOU-1 "), "{:?}", info.title);
    let task = info.task.as_ref().expect("the pane carries its task");
    assert_eq!(task.key, "HOU-1");
    assert_eq!(task.run_id, run.id);
    assert_eq!(task.run_state, proto::TaskRunState::Running);

    let out = r.await_output(session, "FIXTURE-READY").await;
    assert!(out.contains("TASK:HOU-1"), "{out:?}");
    assert!(
        out.contains("CWD:") && out.contains(&worktree.display().to_string()),
        "{out:?}"
    );
    assert!(out.contains("The login page crashes"), "{out:?}");
    assert!(out.contains("Login no longer crashes"), "{out:?}");
    assert!(out.contains("<<<HOUSTON-TASK-DATA"), "{out:?}");

    assert_eq!(r.task_status(id), "in_progress");
    assert_eq!(
        r.worktree_rows(),
        vec![(worktree.display().to_string(), branch.clone(), None)],
        "a task tree records no pane as its creator"
    );
}

#[tokio::test]
async fn start_refusals_name_the_limit_the_actual_and_the_operation() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-refusals").await;

    // A second live run while the first is running.
    let first = r.create_task("Held", "", &["It is done"]);
    r.daemon
        .task_start(first, proto::AgentKind::Grok, None)
        .unwrap();
    let msg = r
        .daemon
        .task_start(first, proto::AgentKind::Grok, None)
        .unwrap();
    let proto::ServerMsg::TaskRefused {
        kind,
        limit,
        requested,
        message,
        ..
    } = msg
    else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Busy);
    assert_eq!(limit, Some(proto::TASK_LIVE_IMPLEMENTATION_RUNS));
    assert_eq!(requested, Some(2));
    assert!(message.contains("task_start"), "{message}");
    assert!(message.contains("HOU-1"), "{message}");
    assert!(message.contains("limit is 1"), "{message}");
    assert!(message.contains("pane"), "{message}");

    // An archived task.
    let archived = r.create_task("Archived", "", &[]);
    let proto::ServerMsg::TaskChanged { revision, .. } =
        r.daemon.task_archive(archived, true, 1).unwrap()
    else {
        panic!("expected TaskChanged");
    };
    let _ = revision;
    let msg = r
        .daemon
        .task_start(archived, proto::AgentKind::Grok, None)
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(message.contains("archived"), "{message}");

    let guarded = r.create_task("Guarded", "", &["It is done"]);
    let _ = r
        .daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Off)
        .unwrap();
    let msg = r
        .daemon
        .task_start(guarded, proto::AgentKind::Grok, None)
        .unwrap();
    assert!(
        matches!(msg, proto::ServerMsg::TaskChanged { .. }),
        "user Start is independent of agent Tasks access: {msg:?}"
    );
    let session = r
        .runs()
        .into_iter()
        .find(|run| run.task_id == guarded)
        .unwrap()
        .session_id
        .unwrap();
    r.daemon.kill(session).unwrap();
    let _ = r
        .daemon
        .tasks_access_set(&r.workspace(), proto::TasksAccess::Write)
        .unwrap();

    // A provider Houston cannot spawn, refused by name.
    let droid = r.create_task("Droid task", "", &[]);
    let msg = r
        .daemon
        .task_start(droid, proto::AgentKind::Droid, None)
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(message.to_lowercase().contains("droid"), "{message}");
    assert!(message.contains("cannot be started"), "{message}");
}

#[tokio::test]
async fn a_restart_reuses_the_same_branch_and_worktree() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-restart").await;
    let id = r.create_task("Reuse me", "desc", &["It is done"]);

    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let first = r.runs().pop().unwrap();
    let first_branch = first.branch.clone().unwrap();
    let first_tree = first.worktree_path.clone().unwrap();
    let stopped = r
        .daemon
        .task_run_control(first.id, proto::TaskRunAction::Stop)
        .unwrap();
    assert!(matches!(stopped, proto::ServerMsg::TaskChanged { .. }));
    assert_eq!(r.runs()[0].state, "cancelled");

    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let runs = r.runs();
    assert_eq!(runs.len(), 2, "{runs:?}");
    let second = &runs[1];
    assert_eq!(second.attempt, 2);
    assert_eq!(second.branch.as_deref(), Some(first_branch.as_str()));
    assert_eq!(second.worktree_path.as_deref(), Some(first_tree.as_str()));
    assert_eq!(second.state, "running");
    assert_eq!(
        r.worktree_rows().len(),
        1,
        "re-Start leaves the one recorded tree"
    );
}

#[tokio::test]
async fn a_brief_over_the_cap_is_refused_before_anything_is_created() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-cap").await;
    let id = r.create_task(
        "Too big",
        &"x".repeat(proto::TASK_BRIEF_MAX_BYTES),
        &["It is done"],
    );

    let msg = r
        .daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let proto::ServerMsg::TaskRefused {
        kind,
        limit,
        requested,
        message,
        ..
    } = msg
    else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Limit);
    assert_eq!(limit, Some(proto::TASK_BRIEF_MAX_BYTES as u32));
    assert!(requested.unwrap() > proto::TASK_BRIEF_MAX_BYTES as u64);
    assert!(message.contains("task_start"), "{message}");
    assert!(message.contains("bytes in the task brief"), "{message}");
    assert!(r.runs().is_empty(), "nothing was created");
    assert!(
        !r.state.path().join("worktrees").exists(),
        "a refused Start leaves no worktree"
    );
}

#[tokio::test]
async fn a_long_brief_gets_a_unique_prompt_file_per_attempt() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-prompt-file").await;
    let id = r.create_task(
        "Long brief",
        &"y".repeat(proto::TASK_BRIEF_MAX_BYTES - 2_000),
        &["It fits"],
    );

    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let first = r.runs().pop().unwrap();
    let first_session = first.session_id.unwrap();
    r.await_output(first_session, "FIXTURE-READY").await;
    // The session belongs to the workspace, so its prompt files live there like
    // any other session's, not inside the task worktree.
    let prompts = r.ws_dir.join(".houston").join("prompts");
    let attempt_one = prompts.join("prompt-task-hou-1-attempt-1.md");
    let first_contents = std::fs::read_to_string(&attempt_one)
        .unwrap_or_else(|e| panic!("reading {}: {e}", attempt_one.display()));
    assert!(
        first_contents.contains("<<<HOUSTON-TASK-DATA"),
        "the file carries the brief"
    );
    assert!(
        first_contents.contains(&format!("Houston task HOU-1 (id {id}):")),
        "the brief names the key and the database id: {}",
        &first_contents[..first_contents.len().min(200)]
    );

    r.daemon
        .task_run_control(first.id, proto::TaskRunAction::Stop)
        .unwrap();
    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let runs = r.runs();
    assert_eq!(runs.len(), 2, "{runs:?}");
    let second = &runs[1];
    assert_eq!(second.attempt, 2);
    r.await_output(second.session_id.unwrap(), "FIXTURE-READY")
        .await;
    let attempt_two = prompts.join("prompt-task-hou-1-attempt-2.md");
    assert!(
        attempt_two.is_file(),
        "attempt 2 writes its own prompt file, not the fixed session label"
    );
    assert_eq!(
        std::fs::read_to_string(&attempt_one).unwrap(),
        first_contents,
        "attempt 1's file is not overwritten"
    );
}

#[tokio::test]
async fn start_settings_default_to_claude_and_send_and_refuse_a_dead_provider() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-settings").await;
    let proto::ServerMsg::TaskStartSettings {
        agent, delivery, ..
    } = r.daemon.tasks_start_settings_state(&r.workspace())
    else {
        panic!("expected TaskStartSettings");
    };
    assert_eq!(agent, proto::AgentKind::Claude);
    assert_eq!(delivery, proto::TaskPromptDelivery::Send);

    let msg = r
        .daemon
        .tasks_start_settings_set(
            &r.workspace(),
            proto::AgentKind::Droid,
            proto::TaskPromptDelivery::Send,
        )
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(message.to_lowercase().contains("droid"), "{message}");

    let msg = r
        .daemon
        .tasks_start_settings_set(
            &r.workspace(),
            proto::AgentKind::Codex,
            proto::TaskPromptDelivery::Prefill,
        )
        .unwrap();
    let proto::ServerMsg::TaskStartSettings {
        agent, delivery, ..
    } = msg
    else {
        panic!("expected TaskStartSettings, got {msg:?}");
    };
    assert_eq!(agent, proto::AgentKind::Codex);
    assert_eq!(delivery, proto::TaskPromptDelivery::Prefill);
}

#[tokio::test]
async fn prefill_places_the_brief_in_the_input_box_without_submitting_it() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-prefill").await;
    let id = r.create_task("Prefilled", "Prefill delivery body.", &["one"]);

    r.daemon
        .tasks_start_settings_set(
            &r.workspace(),
            proto::AgentKind::Grok,
            proto::TaskPromptDelivery::Prefill,
        )
        .unwrap();
    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let run = r.runs().pop().unwrap();
    let session = run.session_id.unwrap();
    // Wait for the paste's own end marker: the brief arrives in chunks, so a
    // read that stops at the first HOUSTON-TASK-DATA byte can precede it.
    let out = r.await_output(session, "\u{1b}[201~").await;
    assert!(out.contains("Prefill delivery body."), "{out:?}");
    let paste_end = out
        .find("\u{1b}[201~")
        .expect("the brief arrives as a bracketed paste");
    assert!(
        !out[paste_end + "\u{1b}[201~".len()..].starts_with('\r'),
        "prefill must not submit with Enter: {out:?}"
    );
    // The brief was not also handed over as argv.
    // The paste can land before the fixture's `stty -echo`, so the tty may echo
    // it ahead of the fixture's own output; the argv report starts at `CWD:`.
    let fixture = out.find("FIXTURE-READY").unwrap();
    let argv_report = &out[out.find("CWD:").unwrap()..fixture];
    assert!(
        !argv_report.contains("<<<HOUSTON-TASK-DATA"),
        "the launched argv does not carry the brief: {out:?}"
    );
    assert_eq!(r.task_status(id), "in_progress");
}

#[tokio::test]
async fn start_requires_workspace_and_can_assign_an_unassigned_task() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-unassigned").await;
    let proto::ServerMsg::TaskChanged { id, .. } = r
        .daemon
        .task_save(
            "",
            None,
            None,
            proto::TaskPatch {
                title: Some("Unassigned start".to_string()),
                acceptance: Some(vec!["It starts".to_string()]),
                ..Default::default()
            },
        )
        .unwrap()
    else {
        panic!("expected create");
    };
    let proto::ServerMsg::TaskRefused { message, .. } = r
        .daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap()
    else {
        panic!("expected refusal");
    };
    assert!(
        message.contains("task_start.workspace") && message.contains("HOU-1"),
        "{message}"
    );
    assert!(r.runs().is_empty());
    let started = r
        .daemon
        .task_start_in(id, proto::AgentKind::Grok, None, Some(r.workspace()), false)
        .unwrap();
    assert!(
        matches!(started, proto::ServerMsg::TaskChanged { .. }),
        "{started:?}"
    );
    let proto::ServerMsg::TaskDetail { task, .. } = r.daemon.task_get(id).unwrap() else {
        panic!("expected detail");
    };
    assert_eq!(task.workspace.as_deref(), Some(r.workspace().as_str()));
    assert_eq!(task.key, "HOU-1");
    let session = r.runs()[0].session_id.unwrap();
    r.daemon.kill(session).unwrap();
}

#[tokio::test]
async fn a_linked_tasks_brief_carries_its_links_as_data() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-links").await;
    let id = r.create_task("Linked work", "Body.", &["It works"]);
    rusqlite::Connection::open(r.db_path())
        .unwrap()
        .execute(
            "INSERT INTO backlog_task_links (task_id, provider, external_id, url, fetched_at) \
             VALUES (?1, 'slack', 'C1:1800000000.000100', 'https://example.test/p1', 5)",
            [id],
        )
        .unwrap();
    let proto::ServerMsg::TaskDetail { task, .. } = r.daemon.task_get(id).unwrap() else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.links.len(), 1, "{:?}", task.links);
    assert_eq!(task.links[0].provider, "slack");

    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let session = r.runs()[0].session_id.unwrap();
    let out = r.await_output(session, "FIXTURE-READY").await;
    // The last opening marker starts the block; the first names it in prose.
    let data = out
        .rsplit("<<<HOUSTON-TASK-DATA")
        .next()
        .and_then(|rest| rest.split("HOUSTON-TASK-DATA>>>").next())
        .unwrap_or_else(|| panic!("the brief has a data block: {out:?}"));
    assert!(
        data.contains("Links:")
            && data.contains("slack C1:1800000000.000100 https://example.test/p1"),
        "the link sits inside the untrusted block: {data:?}"
    );
}

#[tokio::test]
async fn a_task_that_is_not_ready_is_refused_by_name_until_started_anyway() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-gate").await;
    let id = r.create_task("Vague", "", &["[?] Which page?"]);

    let msg = r
        .daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let proto::ServerMsg::TaskRefused { kind, message, .. } = msg else {
        panic!("expected TaskRefused, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::NotReady);
    assert!(
        message.contains("task_start")
            && message.contains("HOU-1")
            && message.contains("at least one acceptance item")
            && message.contains("1 open question"),
        "the refusal names the operation, the task and what it lacks: {message}"
    );
    assert!(r.runs().is_empty(), "a refused Start creates nothing");
    assert_eq!(r.task_status(id), "backlog");

    let started = r
        .daemon
        .task_start_in(id, proto::AgentKind::Grok, None, None, true)
        .unwrap();
    assert!(
        matches!(started, proto::ServerMsg::TaskChanged { .. }),
        "start anyway skips the gate: {started:?}"
    );
    let session = r.runs()[0].session_id.unwrap();
    r.daemon.kill(session).unwrap();
}

#[tokio::test]
async fn a_github_linked_tasks_brief_asks_the_pull_request_to_close_the_issue() {
    let _guard = SERIAL.lock().await;
    let r = rig("start-closes").await;
    let id = r.create_task("Issue work", "Body.", &["It works"]);
    rusqlite::Connection::open(r.db_path())
        .unwrap()
        .execute(
            "INSERT INTO backlog_task_links (task_id, provider, external_id, url, fetched_at) \
             VALUES (?1, 'github', 'o/r#12', 'https://github.com/o/r/issues/12', 5)",
            [id],
        )
        .unwrap();
    r.daemon
        .task_start(id, proto::AgentKind::Grok, None)
        .unwrap();
    let session = r.runs()[0].session_id.unwrap();
    let out = r.await_output(session, "FIXTURE-READY").await;
    let after_data = out
        .rsplit("HOUSTON-TASK-DATA>>>")
        .next()
        .unwrap_or_default();
    assert!(
        after_data.contains("Closes o/r#12"),
        "Houston's own line, outside the data block, names the closing keyword: {out:?}"
    );
}

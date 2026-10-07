#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        for name in ["grok", "codex", "claude", "agy", "opencode", "cursor-agent"] {
            let path = dir.join(name);
            std::fs::write(
                &path,
                "#!/bin/sh\nstty -echo 2>/dev/null\nprintf 'ARG:%s\\n' \"$@\"\n\
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

    fn parent(&self) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Custom,
                project_dir: self.ws_dir.clone(),
                cmd: Some(vec![
                    "sh".into(),
                    "-c".into(),
                    "stty -echo; echo PARENT-UP; exec cat".into(),
                ]),
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
            .expect("fixture pane spawns")
            .id
    }

    fn ready_task(&self, title: &str, priority: proto::TaskPriority) -> i64 {
        let patch = proto::TaskPatch {
            title: Some(title.to_string()),
            status: Some(proto::TaskStatus::Todo),
            priority: Some(priority),
            acceptance: Some(vec!["The queued task can be started".to_string()]),
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

    fn run_count(&self) -> i64 {
        let conn = rusqlite::Connection::open(self.db_path()).unwrap();
        conn.query_row("SELECT COUNT(*) FROM backlog_task_runs", [], |r| r.get(0))
            .unwrap()
    }
}

#[tokio::test]
async fn queue_refuses_when_the_free_slots_are_short_of_the_request() {
    let _guard = SERIAL.lock().await;
    let r = rig("queue-short").await;
    r.daemon.orchestration_set(true).unwrap();
    r.daemon.set_orchestration_caps(2, 2).unwrap();
    let parent = r.parent();
    r.ready_task("A", proto::TaskPriority::Urgent);
    r.ready_task("B", proto::TaskPriority::High);
    r.ready_task("C", proto::TaskPriority::None);

    let msg = r.daemon.task_queue_run(parent, 3, None).unwrap();
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
    assert_eq!(limit, Some(2), "the cap is named");
    assert_eq!(requested, Some(3), "the requested count is named");
    assert!(message.contains('3'), "{message}");
    assert!(message.contains("cap of 2"), "{message}");
    assert!(message.contains("nothing was queued"), "{message}");
    assert_eq!(r.run_count(), 0, "a refused queue run starts nothing");
}

#[tokio::test]
async fn queue_starts_the_top_ready_tasks_in_priority_order() {
    let _guard = SERIAL.lock().await;
    let r = rig("queue-start").await;
    r.daemon.orchestration_set(true).unwrap();
    r.daemon.set_orchestration_caps(2, 2).unwrap();
    let parent = r.parent();
    r.ready_task("Urgent first", proto::TaskPriority::Urgent);
    r.ready_task("High second", proto::TaskPriority::High);
    r.ready_task("No priority third", proto::TaskPriority::None);

    let msg = r
        .daemon
        .task_queue_run(parent, 2, Some(proto::AgentKind::Grok))
        .unwrap();
    let proto::ServerMsg::TaskQueueResult {
        started,
        refused,
        ready_count,
        free_children,
        ..
    } = msg
    else {
        panic!("expected TaskQueueResult, got {msg:?}");
    };
    assert_eq!(started, vec!["HOU-1".to_string(), "HOU-2".to_string()]);
    assert!(refused.is_empty(), "{refused:?}");
    assert_eq!(ready_count, 1, "one ready task is left");
    assert_eq!(free_children, 0, "both slots are now occupied");
    assert_eq!(r.run_count(), 2);

    let msg = r
        .daemon
        .task_queue_run(parent, 1, Some(proto::AgentKind::Grok))
        .unwrap();
    let proto::ServerMsg::TaskRefused {
        kind,
        limit,
        requested,
        message,
        ..
    } = msg
    else {
        panic!("expected TaskRefused with no free slot, got {msg:?}");
    };
    assert_eq!(kind, proto::TaskErrorKind::Limit);
    assert_eq!(limit, Some(2));
    assert_eq!(requested, Some(1));
    assert!(message.contains("free child slot"), "{message}");
}

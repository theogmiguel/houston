#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

//! The GitHub Issues connector against a fake `gh` on PATH: it serves issue
//! lists with ETags, opens and comments on issues, and records every call.

mod common;

use common::start_daemon_with_handle;
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, OnceLock};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The PATH the test binary started with; each rig puts its fake `gh` first.
static PATH: OnceLock<String> = OnceLock::new();

/// Issue 12 carries the label and is assigned; 13 is only assigned; 14 is a
/// pull request, which the issues endpoint also lists.
const LABELLED: &str = r#"[{"number":12,"title":"Footer overlaps","body":"It overlaps.\n- [ ] Footer clears the button\n- [x] Already fine","html_url":"https://github.com/o/r/issues/12","user":{"login":"ana"},"updated_at":"2026-10-05T10:00:00Z"},{"number":14,"title":"A pull request","body":null,"html_url":"https://github.com/o/r/pull/14","user":{"login":"ana"},"updated_at":"2026-10-05T10:00:00Z","pull_request":{}}]"#;
const ASSIGNED: &str = r#"[{"number":13,"title":"Rename the button","body":"","html_url":"https://github.com/o/r/issues/13","user":{"login":"bo"},"updated_at":"2026-10-05T11:00:00Z"},{"number":12,"title":"Footer overlaps","body":"It overlaps.\n- [ ] Footer clears the button\n- [x] Already fine","html_url":"https://github.com/o/r/issues/12","user":{"login":"ana"},"updated_at":"2026-10-05T10:00:00Z"}]"#;

fn write_fake_gh(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(dir.join("next"), "99\n").unwrap();
    std::fs::write(dir.join("labelled.json"), LABELLED).unwrap();
    std::fs::write(dir.join("assigned.json"), ASSIGNED).unwrap();
    let d = dir.display();
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> {d}/calls.log
case "$1" in
  --version) echo 'gh version 2.0.0'; exit 0;;
  auth) exit 0;;
esac
if [ "$1" = api ] && [ "$2" = user ]; then echo octo; exit 0; fi
if [ "$1" = api ] && [ "$2" = -i ]; then
  case "${{11}}" in
    labels=houston) tag='"lbl1"'; file={d}/labelled.json;;
    assignee=octo) tag='"asg1"'; file={d}/assigned.json;;
    *) printf 'HTTP/2.0 422 Unprocessable\n\n{{"message":"bad filter"}}'; exit 1;;
  esac
  if [ "${{13}}" = "If-None-Match: $tag" ]; then
    printf 'HTTP/2.0 304 Not Modified\nEtag: %s\n\n' "$tag"; exit 1
  fi
  printf 'HTTP/2.0 200 OK\nEtag: %s\n\n' "$tag"; cat "$file"; exit 0
fi
if [ "$1" = issue ]; then
  verb="$2"; number="$3"
  while [ $# -gt 0 ]; do
    if [ "$1" = --body-file ]; then shift; cat "$1" >> {d}/bodies.log; echo '---' >> {d}/bodies.log; fi
    shift
  done
  if [ "$verb" = create ]; then
    n=$(cat {d}/next); echo $((n + 1)) > {d}/next
    echo "https://github.com/o/r/issues/$n"; exit 0
  fi
  echo "https://github.com/o/r/issues/$number#issuecomment-1"; exit 0
fi
if [ "$1" = pr ]; then echo 'no pull requests found for branch' >&2; exit 1; fi
exit 1
"#
    );
    let path = dir.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
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
}

struct Rig {
    daemon: Arc<houston_core::daemon::Daemon>,
    state: tempfile::TempDir,
    ws: String,
    bin: tempfile::TempDir,
}

async fn rig(name: &str, remote: &str) -> Rig {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let dir = state.path().join(name);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["remote", "add", "origin", remote]);
    let ws = dir.canonicalize().unwrap().display().to_string();
    daemon.workspace_add(&ws).unwrap();
    let bin = tempfile::tempdir().unwrap();
    write_fake_gh(bin.path());
    let path = PATH.get_or_init(|| std::env::var("PATH").unwrap_or_default());
    std::env::set_var("PATH", format!("{}:{path}", bin.path().display()));
    Rig {
        daemon,
        state,
        ws,
        bin,
    }
}

impl Rig {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state.path().join("test.db")).unwrap()
    }

    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.bin.path().join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn runs_none(&self) -> bool {
        let n: i64 = self
            .db()
            .query_row("SELECT COUNT(*) FROM backlog_task_runs", [], |r| r.get(0))
            .unwrap();
        n == 0
    }

    fn bodies(&self) -> String {
        std::fs::read_to_string(self.bin.path().join("bodies.log")).unwrap_or_default()
    }

    fn set(&self, enabled: bool, label: Option<&str>, open_on_create: bool) -> proto::ServerMsg {
        self.daemon
            .task_github_set(
                &self.ws,
                proto::TaskGithubSettings {
                    enabled,
                    label: label.map(str::to_string),
                    open_on_create,
                },
            )
            .unwrap()
    }

    /// (number, title, status, created_by, external_id) of every task.
    fn tasks(&self) -> Vec<(u32, String, String, String, Option<String>)> {
        let conn = self.db();
        let mut stmt = conn
            .prepare(
                "SELECT t.number, t.title, t.status, t.created_by, l.external_id \
                 FROM backlog_tasks t LEFT JOIN backlog_task_links l ON l.task_id = t.id \
                 ORDER BY t.number",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn create(&self, title: &str) -> i64 {
        match self
            .daemon
            .task_save(
                &self.ws,
                None,
                None,
                proto::TaskPatch {
                    title: Some(title.to_string()),
                    description: Some("Typed into Houston.".into()),
                    acceptance: Some(vec!["It works".into()]),
                    ..Default::default()
                },
            )
            .unwrap()
        {
            proto::ServerMsg::TaskChanged { id, .. } => id,
            other => panic!("expected TaskChanged, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn settings_refuse_by_name_and_need_a_github_remote() {
    let _guard = SERIAL.lock().await;
    let r = rig("gh-settings-bb", "https://bitbucket.org/o/r.git").await;

    let long = "x".repeat(proto::TASK_GITHUB_LABEL_MAX + 1);
    let proto::ServerMsg::TaskRefused {
        kind,
        limit,
        requested,
        message,
        ..
    } = r.set(false, Some(&long), false)
    else {
        panic!("expected a refusal");
    };
    assert_eq!(kind, proto::TaskErrorKind::Limit);
    assert_eq!(limit, Some(proto::TASK_GITHUB_LABEL_MAX as u32));
    assert_eq!(requested, Some(51));
    assert!(message.contains("task_github_set"), "{message}");

    let proto::ServerMsg::TaskRefused { kind, message, .. } = r.set(true, None, false) else {
        panic!("expected a refusal");
    };
    assert_eq!(kind, proto::TaskErrorKind::Invalid);
    assert!(
        message.contains("bitbucket.org") && message.contains("github.com"),
        "the refusal names the remote and what was expected: {message}"
    );
    let proto::ServerMsg::TaskGithub { settings, .. } = r.daemon.task_github_state(&r.ws) else {
        panic!("expected the state");
    };
    assert!(!settings.enabled, "a refused change stores nothing");
}

#[tokio::test]
async fn enabled_imports_labelled_and_assigned_issues_once_and_polls_with_etags() {
    let _guard = SERIAL.lock().await;
    let r = rig("gh-import", "https://github.com/o/r.git").await;

    let proto::ServerMsg::TaskGithub {
        settings,
        repository,
        ..
    } = r.set(true, Some(" houston "), false)
    else {
        panic!("expected the state");
    };
    assert_eq!(repository.as_deref(), Some("o/r"));
    assert_eq!(
        settings.label.as_deref(),
        Some("houston"),
        "the label is trimmed"
    );

    r.daemon.task_github_sync(&r.ws);
    let tasks = r.tasks();
    assert_eq!(
        tasks,
        vec![
            (
                1,
                "Footer overlaps".to_string(),
                "backlog".to_string(),
                "github:ana".to_string(),
                Some("o/r#12".to_string())
            ),
            (
                2,
                "Rename the button".to_string(),
                "backlog".to_string(),
                "github:bo".to_string(),
                Some("o/r#13".to_string())
            ),
        ],
        "one task per issue, the pull request skipped, issue 12 filed once"
    );
    let proto::ServerMsg::TaskDetail {
        task, acceptance, ..
    } = r.daemon.task_get(1).unwrap()
    else {
        panic!("expected the detail");
    };
    assert_eq!(
        acceptance
            .iter()
            .map(|a| a.text.as_str())
            .collect::<Vec<_>>(),
        vec!["Footer clears the button"],
        "unchecked task-list items become acceptance"
    );
    assert_eq!(
        task.links[0].url.as_deref(),
        Some("https://github.com/o/r/issues/12")
    );
    assert!(r.runs_none(), "importing starts nothing");

    r.daemon.task_github_sync(&r.ws);
    assert_eq!(r.tasks().len(), 2, "a second poll files nothing");
    let calls = r.calls();
    assert!(
        calls
            .iter()
            .any(|c| c.contains("labels=houston") && c.contains("If-None-Match: \"lbl1\"")),
        "the second poll sends the ETag: {calls:?}"
    );
    assert!(
        !calls.iter().any(|c| c.starts_with("issue")),
        "importing writes nothing to GitHub: {calls:?}"
    );
    let proto::ServerMsg::TaskGithub {
        last_sync_at_ms,
        error,
        ..
    } = r.daemon.task_github_state(&r.ws)
    else {
        panic!("expected the state");
    };
    assert!(last_sync_at_ms.is_some());
    assert_eq!(error, None);
}

#[tokio::test]
async fn houston_tasks_open_issues_and_a_handback_comments_once() {
    let _guard = SERIAL.lock().await;
    let r = rig("gh-write", "https://github.com/o/r.git").await;
    r.set(true, Some("houston"), false);

    let first = r.create("Typed task");
    let opened = r.daemon.task_github_open_issue(first).unwrap();
    assert!(
        matches!(opened, proto::ServerMsg::TaskChanged { .. }),
        "{opened:?}"
    );
    let proto::ServerMsg::TaskDetail { task, .. } = r.daemon.task_get(first).unwrap() else {
        panic!("expected the detail");
    };
    assert_eq!(task.links[0].external_id, "o/r#99");
    assert!(task.links[0].synced_at_ms.is_some());
    let bodies = r.bodies();
    assert!(
        bodies.contains("Typed into Houston.")
            && bodies.contains("- [ ] It works")
            && bodies.contains("Filed from Houston task HOU-1"),
        "the issue carries the description and acceptance: {bodies}"
    );
    assert!(
        r.calls()
            .iter()
            .any(|c| c.starts_with("issue create") && c.contains("--label houston")),
        "{:?}",
        r.calls()
    );
    let proto::ServerMsg::TaskRefused { message, .. } =
        r.daemon.task_github_open_issue(first).unwrap()
    else {
        panic!("expected a refusal");
    };
    assert!(
        message.contains("already has GitHub issue o/r#99"),
        "{message}"
    );

    // "Always": a new task opens its issue on the next poll; imports do not.
    r.set(true, Some("houston"), true);
    let second = r.create("Second typed task");
    r.daemon.task_github_sync(&r.ws);
    let creates = r
        .calls()
        .iter()
        .filter(|c| c.starts_with("issue create"))
        .count();
    assert_eq!(creates, 2, "{:?}", r.calls());
    let proto::ServerMsg::TaskDetail { task, .. } = r.daemon.task_get(second).unwrap() else {
        panic!("expected the detail");
    };
    assert_eq!(task.links[0].external_id, "o/r#100");

    // A handed-back run of a linked task comments on its issue, once.
    r.db()
        .execute(
            "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, branch, \
                 initial_revision, summary, started_at, ended_at) \
             VALUES (?1, 1, 'implementation', 'handed_back', 'claude', \
                 'houston/task/hou-1-typed-task', 1, 'done', 0, 1)",
            [first],
        )
        .unwrap();
    r.daemon.task_github_sync(&r.ws);
    r.daemon.task_github_sync(&r.ws);
    let comments: Vec<String> = r
        .calls()
        .into_iter()
        .filter(|c| c.starts_with("issue comment"))
        .collect();
    assert_eq!(comments.len(), 1, "{comments:?}");
    assert!(
        comments[0].starts_with("issue comment 99 --repo o/r"),
        "{comments:?}"
    );
    assert!(
        r.bodies().contains("houston/task/hou-1-typed-task") && r.bodies().contains("none yet"),
        "the comment names the branch and the pull request: {}",
        r.bodies()
    );
}

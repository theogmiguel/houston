#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

// Every test points the process-wide PATH at its own fake gh.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const MOVED: &str = "fedcba9876543210fedcba9876543210fedcba98";

fn git_repo(dir: &Path, remote: Option<&str>) {
    std::fs::create_dir_all(dir).unwrap();
    let mut steps = vec![vec!["init", "-q"]];
    if let Some(remote) = remote {
        steps.push(vec!["remote", "add", "origin", remote]);
    }
    for args in steps {
        assert!(Command::new("git")
            .args(&args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
    }
}

/// gh answers from files in `bin`: `pr-N.json`, `threads-N.json` (else no threads) and
/// `merge-refused` (else `pr merge` succeeds); the stacks preview is a 404. Every call
/// is appended to `gh.log`.
fn write_fake_gh(bin: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin).unwrap();
    let dir = bin.display();
    let script = format!(
        r#"#!/bin/sh
D='{dir}'
printf '%s\n' "$*" >> "$D/gh.log"
case "$1" in
  --version) echo 'gh version 2.0.0'; exit 0;;
  auth) exit 0;;
esac
if [ "$1" = pr ] && [ "$2" = view ]; then
  if [ -f "$D/pr-$3.json" ]; then cat "$D/pr-$3.json"; exit 0; fi
  echo "GraphQL: Could not resolve to a PullRequest with the number of $3." >&2; exit 1
fi
if [ "$1" = pr ] && [ "$2" = merge ]; then
  if [ -f "$D/merge-refused" ]; then cat "$D/merge-refused" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = api ] && [ "$2" = graphql ]; then
  input=$(cat)
  n=$(printf '%s' "$input" | grep -o '"number":[0-9]*' | head -n1 | cut -d: -f2)
  case "$input" in
    *reviewThreads*)
      if [ -f "$D/threads-$n.json" ]; then cat "$D/threads-$n.json"; else
        echo '{{"data":{{"repository":{{"pullRequest":{{"id":"x","reviewThreads":{{"totalCount":0,"pageInfo":{{"hasNextPage":false}},"nodes":[]}}}}}}}}}}'
      fi
      exit 0;;
    *) echo '{{"data":{{"repository":{{"viewerPermission":"WRITE","pullRequest":{{"viewerCanUpdate":true,"viewerDidAuthor":true,"viewerCanUpdateBranch":false}}}}}}}}'; exit 0;;
  esac
fi
if [ "$1" = api ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
exit 1
"#
    );
    let path = bin.join("gh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct Pr<'a> {
    number: u32,
    state: &'a str,
    sha: &'a str,
    branch: String,
    check: Option<&'a str>,
    cross_repository: bool,
}

impl<'a> Pr<'a> {
    fn open(number: u32) -> Self {
        Pr {
            number,
            state: "OPEN",
            sha: SHA,
            branch: format!("houston/change-{number}"),
            check: None,
            cross_repository: false,
        }
    }

    fn json(&self) -> String {
        let checks = match self.check {
            Some(conclusion) => format!(
                r#"[{{"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"{conclusion}"}}]"#
            ),
            None => "[]".into(),
        };
        format!(
            r#"{{"number":{n},"url":"https://github.com/owner/repo/pull/{n}","state":"{state}","mergedAt":{merged},"headRefOid":"{sha}","title":"Change {n}","author":{{"login":"author"}},"isDraft":false,"baseRefName":"main","headRefName":"{branch}","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":{checks},"comments":[],"reviews":[],"isCrossRepository":{cross}}}"#,
            n = self.number,
            state = self.state,
            merged = if self.state == "MERGED" {
                "\"2026-10-04T00:00:00Z\""
            } else {
                "null"
            },
            sha = self.sha,
            branch = self.branch,
            cross = self.cross_repository,
        )
    }
}

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    workspace: String,
    bin: PathBuf,
    previous_path: Option<std::ffi::OsString>,
}

impl Rig {
    async fn new() -> Self {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let dir = state.path().join("workspace");
        git_repo(&dir, Some("https://github.com/owner/repo.git"));
        let workspace = dir.canonicalize().unwrap().display().to_string();
        daemon.workspace_add(&workspace).unwrap();
        let bin = state.path().join("bin");
        write_fake_gh(&bin);
        let previous_path = std::env::var_os("PATH");
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                bin.display(),
                previous_path
                    .as_deref()
                    .unwrap_or_default()
                    .to_string_lossy()
            ),
        );
        Rig {
            daemon,
            state,
            workspace,
            bin,
            previous_path,
        }
    }

    fn pr(&self, pr: Pr<'_>) {
        std::fs::write(self.bin.join(format!("pr-{}.json", pr.number)), pr.json()).unwrap();
    }

    fn enqueue(&self, number: u32, depends_on: Option<u32>) -> anyhow::Result<u32> {
        self.daemon
            .merge_queue_enqueue(&self.workspace, &number.to_string(), depends_on, None)
            .map(|e| e.position)
    }

    fn entries(&self) -> Vec<proto::MergeQueueEntry> {
        self.daemon.merge_queue_entries(&self.workspace).unwrap()
    }

    fn order(&self) -> Vec<u32> {
        self.entries().iter().map(|e| e.number).collect()
    }

    fn entry(&self, number: u32) -> proto::MergeQueueEntry {
        self.entries()
            .into_iter()
            .find(|e| e.number == number)
            .unwrap_or_else(|| panic!("#{number} is not queued"))
    }

    /// Takes the calls gh received since the last take.
    fn take_calls(&self, prefix: &str) -> Vec<String> {
        let log = self.bin.join("gh.log");
        let calls = std::fs::read_to_string(&log).unwrap_or_default();
        std::fs::write(&log, "").unwrap();
        calls
            .lines()
            .filter(|l| l.starts_with(prefix))
            .map(str::to_string)
            .collect()
    }

    fn pane(&self) -> u32 {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Claude,
                project_dir: PathBuf::from(&self.workspace),
                cmd: Some(vec!["/bin/sh".into(), "-c".into(), "exec sleep 60".into()]),
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
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(path) = self.previous_path.take() {
            std::env::set_var("PATH", path);
        }
    }
}

fn refusal(result: anyhow::Result<impl std::fmt::Debug>) -> String {
    format!("{:#}", result.expect_err("expected a refusal"))
}

#[tokio::test]
async fn entries_queue_in_fifo_order_and_wait_behind_what_they_depend_on() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    for n in [12, 13, 14] {
        rig.pr(Pr::open(n));
    }
    let pane = rig.pane();
    let entry = rig
        .daemon
        .merge_queue_enqueue_from_pane(pane, "12", None)
        .unwrap();
    assert_eq!((entry.position, entry.session), (1, Some(pane)));
    assert_eq!(entry.status, proto::MergeQueueStatus::Ready, "{entry:?}");
    assert_eq!(rig.enqueue(13, Some(12)).unwrap(), 2);
    assert_eq!(rig.enqueue(14, None).unwrap(), 3);
    assert_eq!(rig.order(), [12, 13, 14]);

    // Re-enqueueing replaces depends_on in place: #12 now waits behind #14,
    // and #13 still waits behind #12.
    rig.enqueue(12, Some(14)).unwrap();
    assert_eq!(rig.order(), [14, 12, 13]);
    assert_eq!(
        rig.entry(12).session,
        Some(pane),
        "the enqueuing pane is kept"
    );

    // The agent verb takes a URL of this repository, and dequeues by number.
    rig.pr(Pr::open(15));
    rig.daemon
        .merge_queue_enqueue_from_pane(pane, "https://github.com/owner/repo/pull/15", None)
        .unwrap();
    rig.daemon
        .merge_queue_dequeue_from_pane(pane, "15")
        .unwrap();
    assert_eq!(rig.order(), [14, 12, 13]);
    assert!(
        refusal(rig.daemon.merge_queue_dequeue(&rig.workspace, "15"))
            .contains("not in the merge queue")
    );
    let _ = rig.daemon.kill(pane);
}

#[tokio::test]
async fn cycles_unknown_dependencies_other_repositories_and_a_full_queue_are_refused_by_name() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    for n in 1..=(proto::MERGE_QUEUE_MAX_ENTRIES + 1) {
        rig.pr(Pr::open(n));
    }
    rig.enqueue(1, None).unwrap();
    rig.enqueue(2, Some(1)).unwrap();

    let cycle = refusal(rig.enqueue(1, Some(2)));
    assert!(cycle.contains("#1 → #2 → #1"), "{cycle}");
    let own = refusal(rig.enqueue(3, Some(3)));
    assert!(own.contains("cannot depend on itself"), "{own}");
    let unknown = refusal(rig.enqueue(3, Some(99)));
    assert!(
        unknown.contains("#99") && unknown.contains("enqueue #99 first"),
        "{unknown}"
    );

    let other = refusal(rig.daemon.merge_queue_enqueue(
        &rig.workspace,
        "https://github.com/someone/else/pull/3",
        None,
        None,
    ));
    assert!(
        other.contains("someone/else") && other.contains("another repository"),
        "{other}"
    );
    rig.pr(Pr {
        cross_repository: true,
        ..Pr::open(3)
    });
    let fork = refusal(rig.enqueue(3, None));
    assert!(fork.contains("fork"), "{fork}");
    rig.pr(Pr {
        state: "CLOSED",
        ..Pr::open(3)
    });
    assert!(refusal(rig.enqueue(3, None)).contains("only an open pull request"));
    rig.pr(Pr::open(3));

    for n in 3..=proto::MERGE_QUEUE_MAX_ENTRIES {
        rig.enqueue(n, None).unwrap();
    }
    let full = refusal(rig.enqueue(proto::MERGE_QUEUE_MAX_ENTRIES + 1, None));
    let limit = proto::MERGE_QUEUE_MAX_ENTRIES;
    assert!(full.contains(&format!("holds {limit} entries")), "{full}");
    assert!(full.contains(&format!("limit is {limit}")), "{full}");
    assert!(
        full.contains(&format!("enqueue PR #{}", limit + 1)),
        "{full}"
    );
    assert_eq!(rig.entries().len(), limit as usize);

    // A workspace with no GitHub remote has no queue.
    let plain = rig.state.path().join("plain");
    git_repo(&plain, None);
    let plain = plain.canonicalize().unwrap().display().to_string();
    rig.daemon.workspace_add(&plain).unwrap();
    let no_remote = refusal(rig.daemon.merge_queue_enqueue(&plain, "1", None, None));
    assert!(
        no_remote.contains("no git remote") && no_remote.contains("no merge queue"),
        "{no_remote}"
    );
    let gitlab = rig.state.path().join("gitlab");
    git_repo(&gitlab, Some("https://gitlab.com/owner/repo.git"));
    let gitlab = gitlab.canonicalize().unwrap().display().to_string();
    rig.daemon.workspace_add(&gitlab).unwrap();
    let not_github = refusal(rig.daemon.merge_queue_enqueue(&gitlab, "1", None, None));
    assert!(not_github.contains("not on GitHub"), "{not_github}");
}

#[tokio::test]
async fn gates_fail_closed_and_each_entry_names_one_blocking_reason() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.pr(Pr::open(12));
    rig.enqueue(12, None).unwrap();
    assert_eq!(rig.entry(12).status, proto::MergeQueueStatus::Ready);

    // A failing check is GitHub's own merge gate.
    rig.pr(Pr {
        check: Some("FAILURE"),
        ..Pr::open(12)
    });
    rig.daemon.pr_watch_tick();
    let entry = rig.entry(12);
    assert_eq!(entry.status, proto::MergeQueueStatus::Blocked);
    assert!(
        entry.reason.as_deref().unwrap().contains("failing check"),
        "{entry:?}"
    );

    // An unresolved review thread blocks.
    rig.pr(Pr::open(12));
    std::fs::write(
        rig.bin.join("threads-12.json"),
        r#"{"data":{"repository":{"pullRequest":{"id":"x","reviewThreads":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[{"id":"t1","isResolved":false,"isOutdated":false,"path":"src/lib.rs","line":3,"comments":{"totalCount":0,"pageInfo":{"hasNextPage":false},"nodes":[]}}]}}}}}"#,
    )
    .unwrap();
    rig.daemon.pr_watch_tick();
    assert_eq!(
        rig.entry(12).reason.as_deref(),
        Some("PR #12 has 1 unresolved review thread")
    );
    std::fs::remove_file(rig.bin.join("threads-12.json")).unwrap();

    // A read that fails keeps no earlier answer: the entry is blocked by the failure.
    std::fs::remove_file(rig.bin.join("pr-12.json")).unwrap();
    rig.daemon.pr_watch_tick();
    let entry = rig.entry(12);
    assert_eq!(entry.status, proto::MergeQueueStatus::Blocked);
    assert!(
        entry
            .reason
            .as_deref()
            .unwrap()
            .contains("could not read PR #12"),
        "{entry:?}"
    );
    // Without a verification command the verification gate does not apply.
    assert!(entry
        .gates
        .iter()
        .filter(|g| matches!(
            g.kind,
            proto::MergeQueueGateKind::Mergeable | proto::MergeQueueGateKind::ReviewThreads
        ))
        .all(|g| g.state == proto::MergeQueueGateState::Failed));

    // A task Slice also needs its newest reviewer verdict to be pass.
    rig.pr(Pr::open(12));
    rig.daemon.pr_watch_tick();
    assert_eq!(rig.entry(12).status, proto::MergeQueueStatus::Ready);
    let task = slice_on_branch(&rig, "houston/change-12");
    let entry = rig.entry(12);
    let reviewer = entry
        .gates
        .iter()
        .find(|g| g.kind == proto::MergeQueueGateKind::Reviewer)
        .unwrap();
    assert_eq!(reviewer.state, proto::MergeQueueGateState::Failed);
    assert!(
        entry
            .reason
            .as_deref()
            .unwrap()
            .contains("no reviewer verdict"),
        "{entry:?}"
    );
    review_run(&rig, task, "running");
    assert!(rig.entry(12).reason.unwrap().contains("still running"));
    review_run(&rig, task, "needs_review");
    assert!(rig.entry(12).reason.unwrap().contains("not pass"));
    review_run(&rig, task, "handed_back");
    assert_eq!(rig.entry(12).status, proto::MergeQueueStatus::Ready);
}

/// A Slice task whose implementation run handed back `branch`, as task
/// execution records it.
fn slice_on_branch(rig: &Rig, branch: &str) -> i64 {
    let proto::ServerMsg::TaskChanged { id, .. } = rig
        .daemon
        .task_save(
            &rig.workspace,
            None,
            None,
            proto::TaskPatch {
                title: Some("Ship the change".into()),
                ..Default::default()
            },
        )
        .unwrap()
    else {
        panic!("expected TaskChanged");
    };
    let conn = rusqlite::Connection::open(rig.state.path().join("test.db")).unwrap();
    conn.execute(
        "INSERT INTO backlog_task_domain (task_id, kind) VALUES (?1, 'slice')",
        [id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, branch, \
             initial_revision, started_at, ended_at) \
         VALUES (?1, 1, 'implementation', 'handed_back', 'claude', ?2, 1, 0, 1)",
        rusqlite::params![id, branch],
    )
    .unwrap();
    id
}

fn review_run(rig: &Rig, task: i64, state: &str) {
    let conn = rusqlite::Connection::open(rig.state.path().join("test.db")).unwrap();
    conn.execute(
        "INSERT INTO backlog_task_runs (task_id, attempt, kind, state, provider, \
             initial_revision, started_at) \
         VALUES (?1, 1, 'review', ?2, 'codex', 1, 2)",
        rusqlite::params![task, state],
    )
    .unwrap();
}

#[tokio::test]
async fn only_the_head_merges_pinned_to_its_commit_and_the_next_entry_moves_up() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    for n in [12, 13] {
        rig.pr(Pr::open(n));
        rig.enqueue(n, None).unwrap();
    }
    rig.take_calls("");

    let not_head = refusal(rig.daemon.merge_queue_merge_head(
        &rig.workspace,
        13,
        SHA,
        proto::PrMergeMethod::Squash,
    ));
    assert!(
        not_head.contains("only the head") && not_head.contains("#12 is first"),
        "{not_head}"
    );
    assert!(rig.take_calls("pr merge").is_empty());

    rig.pr(Pr {
        sha: MOVED,
        ..Pr::open(12)
    });
    let moved = refusal(rig.daemon.merge_queue_merge_head(
        &rig.workspace,
        12,
        SHA,
        proto::PrMergeMethod::Squash,
    ));
    assert!(moved.contains("head moved"), "{moved}");
    assert!(rig.take_calls("pr merge").is_empty());

    rig.pr(Pr {
        check: Some("FAILURE"),
        ..Pr::open(12)
    });
    let blocked = refusal(rig.daemon.merge_queue_merge_head(
        &rig.workspace,
        12,
        SHA,
        proto::PrMergeMethod::Squash,
    ));
    assert!(
        blocked.contains("blocked") && blocked.contains("failing check"),
        "{blocked}"
    );
    assert!(rig.take_calls("pr merge").is_empty());

    rig.pr(Pr::open(12));
    std::fs::write(
        rig.bin.join("merge-refused"),
        "GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)\n",
    )
    .unwrap();
    let method = refusal(rig.daemon.merge_queue_merge_head(
        &rig.workspace,
        12,
        SHA,
        proto::PrMergeMethod::Squash,
    ));
    assert!(
        method.contains("squash merge") && method.contains("not allowed"),
        "{method}"
    );
    std::fs::remove_file(rig.bin.join("merge-refused")).unwrap();
    rig.take_calls("");

    rig.daemon
        .merge_queue_merge_head(&rig.workspace, 12, SHA, proto::PrMergeMethod::Squash)
        .unwrap();
    assert_eq!(
        rig.take_calls("pr merge"),
        [format!("pr merge 12 --match-head-commit {SHA} --squash")]
    );
    assert_eq!(rig.order(), [13]);
    assert_eq!(rig.entry(13).position, 1, "the next entry is now first");
    let proto::ServerMsg::MergeQueue { log, .. } =
        rig.daemon.merge_queue_snapshot(&rig.workspace).unwrap()
    else {
        panic!("expected a merge queue snapshot");
    };
    assert_eq!(log.len(), 1);
    assert_eq!(
        (
            log[0].kind,
            log[0].number,
            log[0].head_sha.as_deref(),
            log[0].method,
            log[0].unattended
        ),
        (
            proto::MergeQueueLogKind::Merge,
            12,
            Some(SHA),
            Some(proto::PrMergeMethod::Squash),
            false
        )
    );
}

#[tokio::test]
async fn an_entry_leaves_when_its_pull_request_closes_or_merges_outside_the_queue() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    for n in [12, 13, 14] {
        rig.pr(Pr::open(n));
    }
    rig.enqueue(12, None).unwrap();
    rig.enqueue(13, Some(12)).unwrap();
    rig.enqueue(14, Some(13)).unwrap();

    // A watch of the same pull request shares the tick's one read with the queue.
    let pane = rig.pane();
    rig.daemon.pr_watch_start(pane, "12").unwrap();
    rig.take_calls("");
    rig.daemon.pr_watch_tick();
    assert_eq!(rig.take_calls("pr view 12").len(), 1);

    // Merged outside the queue: it leaves, and its dependent no longer waits.
    rig.pr(Pr {
        state: "MERGED",
        ..Pr::open(12)
    });
    rig.daemon.pr_watch_tick();
    assert_eq!(rig.order(), [13, 14]);
    assert_eq!(rig.entry(13).depends_on, None);
    assert_eq!(rig.entry(13).status, proto::MergeQueueStatus::Ready);

    // Closed outside the queue: it leaves, and its dependent is blocked by name.
    rig.pr(Pr {
        state: "CLOSED",
        ..Pr::open(13)
    });
    rig.daemon.pr_watch_tick();
    assert_eq!(rig.order(), [14]);
    let entry = rig.entry(14);
    assert_eq!(entry.status, proto::MergeQueueStatus::Blocked);
    assert_eq!(
        entry.reason.as_deref(),
        Some("depends on #13, which left the queue without merging")
    );
    let proto::ServerMsg::MergeQueue { log, .. } =
        rig.daemon.merge_queue_snapshot(&rig.workspace).unwrap()
    else {
        panic!("expected a merge queue snapshot");
    };
    assert!(log.is_empty(), "only queue merges are history: {log:?}");
    let _ = rig.daemon.kill(pane);
}

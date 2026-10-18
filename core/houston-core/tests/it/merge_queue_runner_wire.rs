//! The merge queue's runner against real repositories: a workspace whose
//! `origin` is a local bare repository (its path names `github.com/owner/repo`,
//! so the queue takes it for GitHub) and the `fake_gh` fixture as `gh`. Every
//! Git path runs on Linux and Windows alike.
#![allow(clippy::disallowed_methods)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

// Every test points the process-wide PATH at its own fake gh.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(tree: &Path, file: &str, content: &str, message: &str) -> String {
    std::fs::write(tree.join(file), content).unwrap();
    git(tree, &["add", file]);
    git(tree, &["commit", "-q", "-m", message]);
    git(tree, &["rev-parse", "HEAD"])
}

/// A remote path with forward slashes, as a URL is written: the queue reads
/// `owner/name` from the path after `github.com`.
fn slashed(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// A pane that lives until the test ends: an agent pane, so it is an owner.
fn agent_pane(daemon: &Arc<Daemon>, dir: &Path) -> u32 {
    // An agent pane's launch appends the CLI's own arguments: a script ignores them.
    #[cfg(unix)]
    let cmd = vec!["sh".into(), "-c".into(), "exec sleep 600".into()];
    #[cfg(windows)]
    let cmd = {
        let script = dir.join(".sleep.ps1");
        std::fs::write(&script, "Start-Sleep -Seconds 600").unwrap();
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.display().to_string(),
        ]
    };
    daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Claude,
            project_dir: dir.to_path_buf(),
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

struct Rig {
    daemon: Arc<Daemon>,
    state: tempfile::TempDir,
    workspace: String,
    root: PathBuf,
    origin: PathBuf,
    bin: PathBuf,
    previous_path: Option<std::ffi::OsString>,
}

impl Rig {
    async fn new() -> Self {
        let (_addr, state, daemon) = start_daemon_with_handle().await;
        let origin = state
            .path()
            .join("github.com")
            .join("owner")
            .join("repo.git");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        let root = state.path().join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.email", "t@t.local"),
            ("user.name", "t"),
            ("core.autocrlf", "false"),
        ] {
            git(&root, &["config", key, value]);
        }
        commit(&root, "app.txt", "one\ntwo\nthree\n", "init");
        git(&root, &["remote", "add", "origin", &slashed(&origin)]);
        git(&root, &["push", "-q", "origin", "main"]);
        let workspace = root.display().to_string();
        daemon.workspace_add(&workspace).unwrap();

        let bin = state.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let gh = bin.join(format!("gh{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(env!("CARGO_BIN_EXE_fake_gh"), &gh).unwrap();
        std::fs::write(bin.join("origin"), origin.display().to_string()).unwrap();
        let previous_path = std::env::var_os("PATH");
        let mut paths = vec![bin.clone()];
        paths.extend(std::env::split_paths(
            previous_path.as_deref().unwrap_or_default(),
        ));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        Rig {
            daemon,
            state,
            workspace,
            root,
            origin,
            bin,
            previous_path,
        }
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state.path().join("test.db")).unwrap()
    }

    /// A Houston-managed worktree on `houston/<slug>` with one commit, pushed,
    /// and the pull request gh reports for it.
    fn change(&self, number: u32, slug: &str, file: &str, content: &str) -> PathBuf {
        let branch = format!("houston/{slug}");
        let path = self.root.join(".houston").join("worktrees").join(slug);
        git(
            &self.root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch,
                &path.display().to_string(),
                "main",
            ],
        );
        commit(&path, file, content, slug);
        git(&path, &["push", "-q", "origin", &branch]);
        let common = git(
            &self.root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        self.db()
            .execute(
                "INSERT INTO managed_worktrees
                    (path, repo_common_dir, branch, base_branch, provenance, created_at_ms)
                 VALUES (?1, ?2, ?3, 'origin/main', 'pane_spawn', 0)",
                rusqlite::params![path.display().to_string(), common, branch],
            )
            .unwrap();
        self.pr(number, &branch);
        path
    }

    fn pr(&self, number: u32, branch: &str) {
        let json = format!(
            r#"{{"number":{number},"url":"https://github.com/owner/repo/pull/{number}","state":"OPEN","mergedAt":null,"headRefOid":"0000000000000000000000000000000000000000","title":"Change {number}","author":{{"login":"author"}},"isDraft":false,"baseRefName":"main","headRefName":"{branch}","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[],"comments":[],"reviews":[],"isCrossRepository":false}}"#
        );
        std::fs::write(self.bin.join(format!("pr-{number}.json")), json).unwrap();
    }

    /// Moves `main` in origin with a commit made in the workspace.
    fn advance_base(&self, file: &str, content: &str) -> String {
        let sha = commit(&self.root, file, content, "base moves");
        git(&self.root, &["push", "-q", "origin", "main"]);
        sha
    }

    fn origin_tip(&self, branch: &str) -> String {
        git(
            &self.origin,
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
    }

    fn enqueue(&self, number: u32, session: Option<u32>) {
        self.daemon
            .merge_queue_enqueue(&self.workspace, &number.to_string(), None, session)
            .unwrap();
    }

    fn settings(&self, policy: bool, command: &str) {
        self.daemon
            .merge_queue_settings_set(&self.workspace, policy, command, 30)
            .unwrap();
    }

    fn entries(&self) -> Vec<proto::MergeQueueEntry> {
        self.daemon.merge_queue_entries(&self.workspace).unwrap()
    }

    fn entry(&self, number: u32) -> proto::MergeQueueEntry {
        self.entries()
            .into_iter()
            .find(|e| e.number == number)
            .unwrap_or_else(|| panic!("#{number} is not queued"))
    }

    async fn tick(&self) {
        let daemon = self.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.merge_queue_runner_tick())
            .await
            .unwrap();
    }

    /// The calls gh received, of one kind.
    fn calls(&self, prefix: &str) -> Vec<String> {
        std::fs::read_to_string(self.bin.join("gh.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with(prefix))
            .map(str::to_string)
            .collect()
    }

    fn log(&self) -> Vec<proto::MergeQueueLogEntry> {
        match self.daemon.merge_queue_snapshot(&self.workspace).unwrap() {
            proto::ServerMsg::MergeQueue { log, .. } => log,
            other => panic!("not a snapshot: {other:?}"),
        }
    }

    fn inbox(&self, summary_like: &str) -> Vec<(u32, String)> {
        let db = self.db();
        let mut stmt = db
            .prepare("SELECT to_session, body FROM pane_inbox WHERE summary LIKE ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([summary_like], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(path) = self.previous_path.take() {
            std::env::set_var("PATH", path);
        }
    }
}

/// A command that passes only on a tree that has the base's change in it.
const NEEDS_BASE: &str = "git cat-file -e HEAD:base.txt";

#[tokio::test]
async fn a_verified_head_is_pushed_with_a_lease_and_merged_at_exactly_that_commit() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let tree = rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    let base = rig.advance_base("base.txt", "base\n");
    // A live agent in another managed worktree hears that the base moved.
    let other = rig.change(2, "two", "two.txt", "two\n");
    let watcher = agent_pane(&rig.daemon, &other);
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(1, None);
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::WaitingForSlot);

    rig.tick().await;

    assert!(
        rig.entries().iter().all(|e| e.number != 1),
        "#1 merged and left: {:?}",
        rig.entries()
    );
    let verified = rig.origin_tip("houston/one");
    assert_ne!(verified, head, "the rebased commit was pushed");
    assert_eq!(
        git(&rig.root, &["rev-parse", &format!("{verified}^")]),
        base,
        "the pushed commit sits on the base it was verified on"
    );
    let merges = rig.calls("pr merge 1");
    assert_eq!(merges.len(), 1, "{merges:?}");
    assert!(
        merges[0].contains(&format!("--match-head-commit {verified}"))
            && merges[0].contains("--squash"),
        "{}",
        merges[0]
    );
    assert_eq!(rig.origin_tip("main"), verified);
    let log = rig.log();
    let push = log
        .iter()
        .find(|e| e.kind == proto::MergeQueueLogKind::Push)
        .expect("a push row");
    assert_eq!(push.old_sha.as_deref(), Some(head.as_str()));
    assert_eq!(push.new_sha.as_deref(), Some(verified.as_str()));
    let merge = log
        .iter()
        .find(|e| e.kind == proto::MergeQueueLogKind::Merge)
        .expect("a merge row");
    assert_eq!(merge.old_sha.as_deref(), Some(base.as_str()));
    assert_eq!(merge.new_sha.as_deref(), Some(verified.as_str()));
    assert!(merge.unattended && push.unattended);
    let away = match rig.daemon.merge_queue_snapshot(&rig.workspace).unwrap() {
        proto::ServerMsg::MergeQueue { away, .. } => away,
        _ => unreachable!(),
    };
    assert_eq!(away.merged, 1);
    let notes = rig.inbox("The base moved:%");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, watcher);
    assert!(
        !tree.join("base.txt").exists(),
        "no working tree is touched"
    );
    let scratch = rig.state.path().join("merge-queue").join("verify");
    assert!(!scratch.exists(), "the scratch worktree is removed");
    let _ = rig.daemon.kill(watcher);
}

#[tokio::test]
async fn the_lease_refuses_a_push_once_the_branch_moved_on_the_remote() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let tree = rig.change(1, "one", "one.txt", "one\n");
    rig.advance_base("base.txt", "base\n");
    rig.settings(false, NEEDS_BASE);
    rig.enqueue(1, None);
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Ready, "{entry:?}");
    let verification = entry.verification.clone().expect("verified");
    assert!(
        rig.calls("pr merge").is_empty(),
        "with the policy off the user merges"
    );

    // Someone pushes to the branch after the verification.
    commit(&tree, "late.txt", "late\n", "late push");
    git(&tree, &["push", "-q", "origin", "houston/one"]);
    let moved = rig.origin_tip("houston/one");

    let refused = rig
        .daemon
        .merge_queue_merge_head(
            &rig.workspace,
            1,
            &entry.head_sha,
            proto::PrMergeMethod::Squash,
        )
        .expect_err("the lease holds");
    let refused = format!("{refused:#}");
    assert!(refused.contains("lease"), "{refused}");
    assert_eq!(
        rig.origin_tip("houston/one"),
        moved,
        "nothing was overwritten"
    );
    assert_ne!(moved, verification.verified_sha);
    assert!(rig.calls("pr merge").is_empty());
}

#[tokio::test]
async fn pushes_to_the_base_or_to_a_branch_houston_did_not_create_are_refused_by_name() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let base = rig
        .daemon
        .merge_queue_push_guard(&rig.workspace, "main", Some("main"))
        .unwrap_err()
        .to_string();
    assert!(
        base.contains("refusing to push to main") && base.contains("base"),
        "{base}"
    );
    let default = rig
        .daemon
        .merge_queue_push_guard(&rig.workspace, "main", Some("release"))
        .unwrap_err()
        .to_string();
    assert!(default.contains("default branch"), "{default}");
    let unrecorded = rig
        .daemon
        .merge_queue_push_guard(&rig.workspace, "houston/stray", Some("main"))
        .unwrap_err()
        .to_string();
    assert!(
        unrecorded.contains("managed-worktree records"),
        "{unrecorded}"
    );

    // A queued pull request from a branch outside houston/* verifies, but the
    // queue never pushes its rebased commit.
    git(&rig.root, &["checkout", "-q", "-b", "feature/x"]);
    commit(&rig.root, "x.txt", "x\n", "x");
    git(&rig.root, &["push", "-q", "origin", "feature/x"]);
    git(&rig.root, &["checkout", "-q", "main"]);
    let head = rig.origin_tip("feature/x");
    rig.pr(3, "feature/x");
    rig.advance_base("base.txt", "base\n");
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(3, None);
    rig.tick().await;
    assert_eq!(rig.origin_tip("feature/x"), head, "nothing was pushed");
    let entry = rig.entry(3);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    assert!(
        entry
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("houston/*"),
        "{entry:?}"
    );
    assert!(rig.calls("pr merge").is_empty());
}

#[tokio::test]
async fn a_conflict_goes_to_the_live_owner_and_parks_once_the_owner_is_gone() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let tree = rig.change(1, "one", "app.txt", "one\nTWO\nthree\n");
    rig.advance_base("app.txt", "one\n2\nthree\n");
    rig.settings(true, NEEDS_BASE);
    let owner = agent_pane(&rig.daemon, &tree);
    rig.enqueue(1, Some(owner));
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Fixing, "{entry:?}");
    assert_eq!(entry.position, 0, "out of line");
    let failure = entry.failure.clone().expect("a failure");
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Conflict);
    assert_eq!(failure.files, ["app.txt"]);
    assert_eq!(failure.handed_to, Some(owner));
    let notes = rig.inbox("Merge queue:%");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, owner);
    assert!(notes[0].1.contains("- app.txt"), "{}", notes[0].1);
    rig.tick().await;
    assert_eq!(
        rig.inbox("Merge queue:%").len(),
        1,
        "one row, not one per pass"
    );

    // The owner ends; the same failure on a retry parks the entry instead.
    rig.daemon.kill(owner).unwrap();
    let _ = rig.daemon.close(owner);
    rig.daemon.merge_queue_retry(&rig.workspace, 1).unwrap();
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    assert_eq!(entry.failure.as_ref().unwrap().handed_to, None);
    assert!(rig
        .log()
        .iter()
        .any(|e| e.kind == proto::MergeQueueLogKind::Park && e.number == 1));
    match rig.daemon.merge_queue_summary().unwrap() {
        proto::ServerMsg::MergeQueueSummary { parked, .. } => {
            assert_eq!(parked.len(), 1);
            assert_eq!(parked[0].parked, 1);
        }
        other => panic!("{other:?}"),
    }
    assert!(rig.calls("pr merge").is_empty());
}

#[tokio::test]
async fn a_parked_entry_re_enters_when_its_head_moves() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let tree = rig.change(1, "one", "one.txt", "one\n");
    rig.settings(false, "echo boom && exit 1");
    rig.enqueue(1, None);
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    let failure = entry.failure.unwrap();
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Failed);
    assert!(
        failure
            .output_tail
            .as_deref()
            .unwrap_or_default()
            .contains("boom"),
        "{failure:?}"
    );

    // The fix lands on the branch; the next read puts the new head in line.
    commit(&tree, "fix.txt", "fix\n", "fix");
    git(&tree, &["push", "-q", "origin", "houston/one"]);
    rig.settings(false, "git --version");
    let daemon = rig.daemon.clone();
    tokio::task::spawn_blocking(move || daemon.pr_watch_tick())
        .await
        .unwrap();
    let entry = rig.entry(1);
    assert_eq!(entry.position, 1, "{entry:?}");
    assert_eq!(entry.failure, None);
    rig.tick().await;
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Ready);
}

#[tokio::test]
async fn a_pause_stops_the_push_and_the_merge_and_keeps_the_entry_in_line() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    rig.advance_base("base.txt", "base\n");
    rig.settings(false, NEEDS_BASE);
    rig.enqueue(1, None);
    rig.tick().await;
    assert!(rig.entry(1).verification.is_some());

    rig.daemon
        .merge_queue_pause(Some(&rig.workspace), true)
        .unwrap();
    rig.settings(true, NEEDS_BASE);
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Paused, "{entry:?}");
    assert!(entry.verification.is_some(), "the verification is kept");
    assert_eq!(rig.origin_tip("houston/one"), head, "nothing was pushed");
    assert!(rig.calls("pr merge").is_empty(), "nothing was merged");
    let refused = rig
        .daemon
        .merge_queue_merge_head(&rig.workspace, 1, &head, proto::PrMergeMethod::Squash)
        .unwrap_err()
        .to_string();
    assert!(refused.contains("paused"), "{refused}");

    // The global pause holds every queue the same way.
    rig.daemon
        .merge_queue_pause(Some(&rig.workspace), false)
        .unwrap();
    rig.daemon.merge_queue_pause(None, true).unwrap();
    rig.tick().await;
    assert!(rig.calls("pr merge").is_empty());
    rig.daemon.merge_queue_pause(None, false).unwrap();
    rig.tick().await;
    assert_eq!(
        rig.calls("pr merge 1").len(),
        1,
        "resuming merges the still-verified head"
    );
}

#[tokio::test]
async fn merge_when_verified_refuses_to_turn_on_without_a_command() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    let refused = rig
        .daemon
        .merge_queue_settings_set(&rig.workspace, true, "  ", 30)
        .unwrap_err()
        .to_string();
    assert!(refused.contains("Verification command"), "{refused}");
    let limit = rig
        .daemon
        .merge_queue_settings_set(&rig.workspace, false, "true", 0)
        .unwrap_err()
        .to_string();
    assert!(
        limit.contains("1 to 240 minutes") && limit.contains("got 0"),
        "{limit}"
    );
    rig.settings(true, "git --version");
    let refused = rig
        .daemon
        .merge_queue_settings_set(&rig.workspace, true, "", 30)
        .unwrap_err()
        .to_string();
    assert!(refused.contains("Verification command"), "{refused}");
    match rig.daemon.merge_queue_snapshot(&rig.workspace).unwrap() {
        proto::ServerMsg::MergeQueue { settings, .. } => {
            let settings = settings.unwrap();
            assert!(settings.merge_when_verified);
            assert_eq!(settings.verification_command, "git --version");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn one_slot_serialises_verification_across_workspaces() {
    let _serial = SERIAL.lock().await;
    let a = Rig::new().await;
    // A second workspace on the same daemon, with its own origin.
    let b_root = a.state.path().join("second");
    let b_origin = a
        .state
        .path()
        .join("b")
        .join("github.com")
        .join("owner")
        .join("other.git");
    std::fs::create_dir_all(&b_origin).unwrap();
    git(&b_origin, &["init", "-q", "--bare", "-b", "main"]);
    std::fs::create_dir_all(&b_root).unwrap();
    git(&b_root, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.email", "t@t.local"),
        ("user.name", "t"),
        ("core.autocrlf", "false"),
    ] {
        git(&b_root, &["config", key, value]);
    }
    commit(&b_root, "app.txt", "b\n", "init");
    git(&b_root, &["remote", "add", "origin", &slashed(&b_origin)]);
    git(&b_root, &["push", "-q", "origin", "main"]);
    git(&b_root, &["checkout", "-q", "-b", "houston/b"]);
    commit(&b_root, "b.txt", "b\n", "b");
    git(&b_root, &["push", "-q", "origin", "houston/b"]);
    git(&b_root, &["checkout", "-q", "main"]);
    let b_workspace = b_root.display().to_string();
    a.daemon.workspace_add(&b_workspace).unwrap();

    a.change(1, "one", "one.txt", "one\n");
    let marks = a.state.path().join("marks.txt");
    #[cfg(unix)]
    let slow = |name: &str| {
        format!(
            "echo {name}-start >> '{p}' && sleep 2 && echo {name}-end >> '{p}'",
            p = marks.display()
        )
    };
    #[cfg(windows)]
    let slow = |name: &str| {
        format!(
            "echo {name}-start>> \"{p}\" && ping -n 3 127.0.0.1 > nul && echo {name}-end>> \"{p}\"",
            p = marks.display()
        )
    };
    a.settings(false, &slow("a"));
    a.enqueue(1, None);
    // gh answers both workspaces from one directory; #2 is the second repository's.
    let json = std::fs::read_to_string(a.bin.join("pr-1.json"))
        .unwrap()
        .replace("pull/1", "pull/2")
        .replace("\"number\":1", "\"number\":2")
        .replace("houston/one", "houston/b")
        .replace("owner/repo", "owner/other");
    std::fs::write(a.bin.join("pr-2.json"), json).unwrap();
    // The fake reads heads from the first origin only: mirror the second's branch there.
    let b_head = git(&b_origin, &["rev-parse", "refs/heads/houston/b"]);
    git(
        &a.origin,
        &[
            "fetch",
            "-q",
            &b_origin.display().to_string(),
            "houston/b:houston/b",
        ],
    );
    assert_eq!(a.origin_tip("houston/b"), b_head);
    a.daemon
        .merge_queue_settings_set(&b_workspace, false, &slow("b"), 30)
        .unwrap();
    a.daemon
        .merge_queue_enqueue(&b_workspace, "2", None, None)
        .unwrap();

    let first = {
        let daemon = a.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.merge_queue_runner_tick())
    };
    let second = {
        let daemon = a.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.merge_queue_runner_tick())
    };
    let mut saw_waiting = false;
    for _ in 0..200 {
        let statuses: Vec<_> = [&a.workspace, &b_workspace]
            .iter()
            .map(|w| a.daemon.merge_queue_entries(w).unwrap()[0].status)
            .collect();
        assert!(
            statuses
                .iter()
                .filter(|s| **s == proto::MergeQueueStatus::Verifying)
                .count()
                <= 1,
            "{statuses:?}"
        );
        saw_waiting |= statuses.contains(&proto::MergeQueueStatus::Verifying)
            && statuses.contains(&proto::MergeQueueStatus::WaitingForSlot);
        if first.is_finished() && second.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    first.await.unwrap();
    second.await.unwrap();
    a.tick().await;
    assert!(
        saw_waiting,
        "one head verified while the other waited for the slot"
    );
    let marks: Vec<String> = std::fs::read_to_string(&marks)
        .unwrap()
        .lines()
        .map(|l| l.trim().to_string())
        .collect();
    assert_eq!(marks.len(), 4, "{marks:?}");
    for pair in marks.chunks(2) {
        let name = pair[0].trim_end_matches("-start");
        assert_eq!(
            pair[1],
            format!("{name}-end"),
            "runs never overlap: {marks:?}"
        );
    }
    assert!(a.entry(1).verification.is_some());
    assert!(a.daemon.merge_queue_entries(&b_workspace).unwrap()[0]
        .verification
        .is_some());
}

#[test]
fn a_command_past_its_limit_times_out_with_the_tail_of_its_output() {
    let dir = houston_core::fixture_dirs::tempdir_outside_git();
    let origin = dir.path().join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    let root = dir.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.email", "t@t.local"]);
    git(&root, &["config", "user.name", "t"]);
    commit(&root, "a.txt", "a\n", "init");
    git(
        &root,
        &["remote", "add", "origin", &origin.display().to_string()],
    );
    git(&root, &["push", "-q", "origin", "main"]);
    git(&root, &["push", "-q", "origin", "main:houston/x"]);
    let head = git(&root, &["rev-parse", "HEAD"]);
    #[cfg(unix)]
    let command = "echo started && sleep 30";
    #[cfg(windows)]
    let command = "echo started && ping -n 30 127.0.0.1 > nul";
    let scratch = dir.path().join("scratch");
    let started = std::time::Instant::now();
    let outcome =
        houston_core::merge_queue_verify::verify(&houston_core::merge_queue_verify::Request {
            repo: &root,
            remote: "origin",
            base_ref: "main",
            head_ref: "houston/x",
            head_sha: &head,
            command,
            limit: Duration::from_secs(2),
            scratch: &scratch,
        })
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "the limit ended it"
    );
    match outcome {
        houston_core::merge_queue_verify::Outcome::TimedOut { tail, .. } => {
            assert!(tail.contains("started"), "{tail}")
        }
        other => panic!("expected a timeout, got {other:?}"),
    }
    assert!(!scratch.exists(), "the scratch worktree is removed");
    assert!(
        !git(&root, &["worktree", "list"]).contains("scratch"),
        "and unregistered"
    );
}

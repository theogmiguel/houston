//! The merge queue's runner against real repositories: `origin` is a local bare repository
//! whose path names `github.com/owner/repo`, and `fake_gh` is `gh`, so every path runs on
//! Linux and Windows alike.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, commit, git, slashed, Rig, NEEDS_BASE, SERIAL};

use houston_protocol as proto;
use std::time::Duration;

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
            stack: None,
        })
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(25),
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

#[tokio::test]
async fn a_rebase_needs_no_configured_git_identity_and_commits_as_the_head_author() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    let base = rig.advance_base("base.txt", "base\n");
    // Empty local values override any global identity; git may not guess one.
    git(&rig.root, &["config", "user.name", ""]);
    git(&rig.root, &["config", "user.email", ""]);
    git(&rig.root, &["config", "user.useConfigOnly", "true"]);
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(1, None);

    rig.tick().await;

    assert!(
        rig.entries().iter().all(|e| e.number != 1),
        "#1 merged and left: {:?}",
        rig.entries()
    );
    let merged = rig.origin_tip("main");
    assert_eq!(git(&rig.root, &["rev-parse", &format!("{merged}^")]), base);
    assert_eq!(
        git(&rig.origin, &["log", "-1", "--format=%cn <%ce>", &merged]),
        "t <t@t.local>",
        "the rebased commit's committer is the head commit's author"
    );
    assert_eq!(
        git(&rig.root, &["config", "--get", "user.useConfigOnly"]),
        "true"
    );
    assert_eq!(
        git(&rig.root, &["config", "--local", "--get", "user.name"]),
        "",
        "no identity was written to the repository's config"
    );
    assert_eq!(
        git(&rig.root, &["config", "--local", "--get", "user.email"]),
        "",
        "no identity was written to the repository's config"
    );
}

/// GitHub's answer for a pull request whose branch conflicts with its base.
fn github_reports_a_conflict(rig: &Rig, number: u32) {
    rig.pr_set(number, "mergeable", "CONFLICTING".into());
    rig.pr_set(number, "mergeStateStatus", "DIRTY".into());
}

#[tokio::test]
async fn a_pull_request_github_reports_conflicting_is_rebased_and_parks_on_a_real_conflict() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "app.txt", "one\nTWO\nthree\n");
    rig.change(2, "two", "two.txt", "two\n");
    rig.advance_base("app.txt", "one\n2\nthree\n");
    github_reports_a_conflict(&rig, 1);
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue(2, None);

    let entry = rig.entry(1);
    assert_eq!(
        entry.status,
        proto::MergeQueueStatus::WaitingForSlot,
        "GitHub's conflict waits for the verification's rebase: {entry:?}"
    );
    let mergeable = entry
        .gates
        .iter()
        .find(|g| g.kind == proto::MergeQueueGateKind::Mergeable)
        .unwrap();
    assert_eq!(mergeable.state, proto::MergeQueueGateState::Pending);
    assert!(
        mergeable
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("conflicts with main") && r.contains("rebases")),
        "{mergeable:?}"
    );

    rig.tick().await;

    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    let failure = entry.failure.expect("a failure");
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Conflict);
    assert_eq!(failure.files, ["app.txt"]);

    for _ in 0..3 {
        if rig.entries().iter().all(|e| e.number != 2) {
            break;
        }
        rig.tick().await;
    }
    assert!(
        rig.entries().iter().all(|e| e.number != 2),
        "#2 merged past the parked #1: {:?}",
        rig.entries()
    );
    assert!(rig.calls("pr merge 1").is_empty());
}

#[tokio::test]
async fn a_pull_request_github_reports_conflicting_lands_once_a_clean_rebase_is_pushed() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    let base = rig.advance_base("base.txt", "base\n");
    github_reports_a_conflict(&rig, 1);
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(1, None);
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::WaitingForSlot);

    rig.tick().await;

    let pushed = rig.origin_tip("houston/one");
    assert_ne!(pushed, head, "the clean rebase was pushed");
    assert_eq!(git(&rig.root, &["rev-parse", &format!("{pushed}^")]), base);
    assert!(
        rig.calls("pr merge 1").is_empty(),
        "no merge while GitHub still reports the old conflict"
    );

    // GitHub recomputes against the pushed commit.
    rig.pr_set(1, "mergeable", "MERGEABLE".into());
    rig.pr_set(1, "mergeStateStatus", "CLEAN".into());
    rig.read_pass().await;
    rig.tick().await;

    assert!(
        rig.entries().iter().all(|e| e.number != 1),
        "#1 merged and left: {:?}",
        rig.entries()
    );
    assert_eq!(rig.origin_tip("main"), pushed);
}

/// GitHub's answer for a pull request with one unresolved review thread.
fn github_reports_an_unresolved_thread(rig: &Rig, number: u32) {
    rig.flag(
        &format!("threads-{number}.json"),
        r#"{"data":{"repository":{"pullRequest":{"id":"x","reviewThreads":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[{"id":"t1","isResolved":false,"isOutdated":false,"path":"app.txt","line":1,"comments":{"totalCount":0,"pageInfo":{"hasNextPage":false},"nodes":[]}}]}}}}}"#,
    );
}

fn merge_refusal(rig: &Rig, number: u32) -> String {
    let head = rig.entry(number).head_sha;
    let refused = rig
        .daemon
        .merge_queue_merge_head(&rig.workspace, number, &head, proto::PrMergeMethod::Squash)
        .expect_err("the merge is refused");
    format!("{refused:#}")
}

#[tokio::test]
async fn an_unresolved_review_thread_lets_the_next_entry_merge_and_goes_first_once_resolved() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    rig.change(2, "two", "two.txt", "two\n");
    github_reports_an_unresolved_thread(&rig, 1);
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue(2, None);

    let first = rig.entry(1);
    assert_eq!(first.status, proto::MergeQueueStatus::Blocked, "{first:?}");
    assert_eq!(first.position, 1, "a blocked entry keeps its rank");
    let next = rig.entry(2);
    assert_eq!(
        next.status,
        proto::MergeQueueStatus::WaitingForSlot,
        "{next:?}"
    );
    let refused = merge_refusal(&rig, 1);
    assert!(
        refused.contains("#2 goes next") && refused.contains("unresolved review thread"),
        "{refused}"
    );

    rig.tick().await;

    assert!(
        rig.entries().iter().all(|e| e.number != 2),
        "#2 merged past the blocked #1: {:?}",
        rig.entries()
    );
    assert!(rig.calls("pr merge 1").is_empty());
    assert_eq!(rig.entry(1).position, 1);

    // The thread is resolved on GitHub. The user's Merge reads #1 again before
    // the read pass does, finds it next, and leaves it to verify first.
    rig.unflag("threads-1.json");
    let refused = merge_refusal(&rig, 1);
    assert!(refused.contains("has not passed verification"), "{refused}");
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::WaitingForSlot);
    rig.tick().await;
    assert!(
        rig.entries().is_empty(),
        "#1 merged once its thread was resolved: {:?}",
        rig.entries()
    );
    let merges = rig.calls("pr merge");
    assert!(
        merges.len() == 2
            && merges[0].starts_with("pr merge 2")
            && merges[1].starts_with("pr merge 1"),
        "{merges:?}"
    );
}

#[tokio::test]
async fn a_dependent_of_a_blocked_entry_waits_while_an_independent_entry_merges() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    rig.change_on(2, "two", "houston/one", "two.txt", "two\n");
    rig.change(3, "three", "three.txt", "three\n");
    github_reports_an_unresolved_thread(&rig, 1);
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, None);
    rig.enqueue(3, None);

    let dependent = rig.entry(2);
    assert_eq!(
        dependent.status,
        proto::MergeQueueStatus::Blocked,
        "{dependent:?}"
    );
    assert_eq!(
        dependent.reason.as_deref(),
        Some("waits for #1, which is blocked")
    );
    let refused = merge_refusal(&rig, 2);
    assert!(
        refused.contains("#3 goes next") && refused.contains("waits for #1"),
        "{refused}"
    );

    rig.tick().await;

    let left: Vec<u32> = rig.entries().iter().map(|e| e.number).collect();
    assert_eq!(left, [1, 2], "only #3 merged");
    assert!(rig.calls("pr merge 1").is_empty() && rig.calls("pr merge 2").is_empty());
    assert_eq!(rig.calls("pr merge 3").len(), 1);
    assert_eq!(
        rig.entry(2).reason.as_deref(),
        Some("waits for #1, which is blocked")
    );
}

#[tokio::test]
async fn an_entry_github_is_still_computing_holds_the_entries_behind_it() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    rig.change(2, "two", "two.txt", "two\n");
    rig.change(3, "three", "three.txt", "three\n");
    github_reports_an_unresolved_thread(&rig, 1);
    rig.pr_set(2, "mergeable", "UNKNOWN".into());
    rig.pr_set(2, "mergeStateStatus", "UNKNOWN".into());
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue(2, None);
    rig.enqueue(3, None);

    let computing = rig.entry(2);
    assert_eq!(computing.status, proto::MergeQueueStatus::Blocked);
    assert!(
        computing
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("still computing")),
        "{computing:?}"
    );
    let behind = rig.entry(3);
    assert_eq!(
        behind.status,
        proto::MergeQueueStatus::Blocked,
        "{behind:?}"
    );
    assert!(
        behind
            .reason
            .as_deref()
            .is_some_and(|r| r.starts_with("the queue waits for #2: ")),
        "{behind:?}"
    );

    rig.tick().await;

    assert_eq!(rig.entries().len(), 3, "nothing moved: {:?}", rig.entries());
    assert!(rig.calls("pr merge").is_empty());
    assert!(rig.entry(3).verification.is_none(), "#3 was not verified");
    let refused = merge_refusal(&rig, 3);
    assert!(
        refused.contains("no entry goes next") && refused.contains("#2"),
        "{refused}"
    );

    // GitHub settles: #2 goes, past the blocked #1 and before #3.
    rig.pr_set(2, "mergeable", "MERGEABLE".into());
    rig.pr_set(2, "mergeStateStatus", "CLEAN".into());
    rig.read_pass().await;
    rig.tick().await;
    let merges = rig.calls("pr merge");
    assert!(
        merges.first().is_some_and(|m| m.starts_with("pr merge 2")),
        "{merges:?}"
    );
    assert!(rig.calls("pr merge 1").is_empty());
}

/// The memory floor belongs to Night shift's checks and `hs-pane heavy`; an
/// ordinary verification still takes a free slot below it.
#[tokio::test]
async fn the_memory_floor_does_not_hold_an_ordinary_verification() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.change(1, "one", "one.txt", "one\n");
    rig.advance_base("base.txt", "base\n");
    rig.settings(false, NEEDS_BASE);
    rig.enqueue(1, None);
    let low = houston_core::night_shift::preflight::Facts {
        orchestration_enabled: true,
        providers: Vec::new(),
        machine: houston_core::night_shift::preflight::MachineFacts {
            memory_free_mib: Some(1024),
            ..Default::default()
        },
    };
    rig.daemon.set_night_shift_facts_for_test(Some(low));

    assert!(
        rig.daemon.merge_queue_take_slot_for_test(&rig.workspace, 1),
        "an ordinary verification takes the slot below the memory floor"
    );
    rig.tick().await;

    assert_eq!(
        rig.entry(1).status,
        proto::MergeQueueStatus::Ready,
        "the ordinary verification ran: {:?}",
        rig.entry(1)
    );
    let held = rig
        .daemon
        .build_slot_request(9_999, "acquire", None)
        .unwrap();
    assert!(
        held["holder"]
            .as_str()
            .is_some_and(|h| h.contains("1024 MiB free")),
        "hs-pane heavy still waits for the floor: {held}"
    );
    assert!(
        !rig.daemon.night_take_build_slot_for_test(&rig.workspace, 5),
        "Night shift still waits for the floor"
    );
}

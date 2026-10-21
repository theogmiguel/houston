//! Restacking dependents against real repositories: a branch built on its dependency's
//! branch is replayed onto the base from the fork point once the dependency squash-merges,
//! retargeted when its pull request named that branch, then verified and landed.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, commit, git, Rig, SERIAL};

use houston_protocol as proto;

/// The files one commit changes.
fn changed(rig: &Rig, sha: &str) -> Vec<String> {
    git(&rig.root, &["diff", "--name-only", &format!("{sha}^"), sha])
        .lines()
        .map(str::to_string)
        .collect()
}

fn rows(rig: &Rig, kind: proto::MergeQueueLogKind, number: u32) -> Vec<proto::MergeQueueLogEntry> {
    rig.log()
        .into_iter()
        .filter(|e| e.kind == kind && e.number == number)
        .collect()
}

#[tokio::test]
async fn a_dependent_built_on_a_squash_merged_branch_is_restacked_retargeted_and_landed() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("squash", "");
    rig.change(1, "a", "a.txt", "a\n");
    let a0 = rig.origin_tip("houston/a");
    rig.change_on(2, "b", "houston/a", "b.txt", "b\n");
    let b0 = rig.origin_tip("houston/b");
    // B's pull request targets A's branch, not main.
    rig.pr_set(2, "baseRefName", "houston/a".into());
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, None);

    rig.tick().await;

    assert!(rig.entries().is_empty(), "both landed: {:?}", rig.entries());
    let b1 = rig.origin_tip("houston/b");
    assert_ne!(b1, b0, "the restacked commit was pushed with the lease");
    let squash_a = git(&rig.root, &["rev-parse", &format!("{b1}^")]);
    assert_eq!(
        git(&rig.origin, &["rev-parse", "refs/heads/main^"]),
        squash_a,
        "B sits on A's squash commit, and main merged B on top of it"
    );
    assert_eq!(
        changed(&rig, &b1),
        ["b.txt"],
        "only B's own commit was replayed, not A's original one"
    );
    let edits = rig.calls("pr edit 2");
    assert_eq!(edits, ["pr edit 2 --base main"], "{edits:?}");
    let retarget = rows(&rig, proto::MergeQueueLogKind::Retarget, 2);
    assert_eq!(retarget.len(), 1, "{retarget:?}");
    assert_eq!(retarget[0].ref_name.as_deref(), Some("main"));
    assert!(
        retarget[0]
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("houston/a"),
        "{retarget:?}"
    );
    let restack = rows(&rig, proto::MergeQueueLogKind::Restack, 2);
    assert_eq!(restack.len(), 1, "{:?}", rig.log());
    assert_eq!(restack[0].old_sha.as_deref(), Some(b0.as_str()));
    assert_eq!(restack[0].new_sha.as_deref(), Some(b1.as_str()));
    assert_eq!(restack[0].fork_sha.as_deref(), Some(a0.as_str()));
    let push = rows(&rig, proto::MergeQueueLogKind::Push, 2);
    assert_eq!(push[0].old_sha.as_deref(), Some(b0.as_str()));
    let merges = rig.calls("pr merge 2");
    assert!(
        merges.len() == 1 && merges[0].contains(&format!("--match-head-commit {b1}")),
        "{merges:?}"
    );
}

#[tokio::test]
async fn a_dependency_in_order_only_is_rebased_plainly() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("squash", "");
    rig.change(1, "a", "a.txt", "a\n");
    rig.change(2, "b", "b.txt", "b\n");
    let b0 = rig.origin_tip("houston/b");
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, None);

    rig.tick().await;

    assert!(rig.entries().is_empty(), "{:?}", rig.entries());
    let b1 = rig.origin_tip("houston/b");
    assert_ne!(b1, b0, "B was rebased onto A's squash commit");
    assert_eq!(changed(&rig, &b1), ["b.txt"]);
    assert!(
        rows(&rig, proto::MergeQueueLogKind::Restack, 2).is_empty(),
        "sharing only base history is not a restack: {:?}",
        rig.log()
    );
    assert!(rig.calls("pr edit").is_empty());
}

#[tokio::test]
async fn a_three_level_chain_restacks_one_level_per_landing() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("squash", "");
    rig.change(1, "a", "a.txt", "a\n");
    let a0 = rig.origin_tip("houston/a");
    rig.change_on(2, "b", "houston/a", "b.txt", "b\n");
    let b0 = rig.origin_tip("houston/b");
    rig.change_on(3, "c", "houston/b", "c.txt", "c\n");
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, None);
    rig.enqueue_after(3, 2, None);

    rig.tick().await;

    assert!(rig.entries().is_empty(), "{:?}", rig.entries());
    let c1 = rig.origin_tip("houston/c");
    assert_eq!(
        changed(&rig, &c1),
        ["c.txt"],
        "only C's commit was replayed"
    );
    let b_restack = rows(&rig, proto::MergeQueueLogKind::Restack, 2);
    assert_eq!(b_restack[0].fork_sha.as_deref(), Some(a0.as_str()));
    let c_restack = rows(&rig, proto::MergeQueueLogKind::Restack, 3);
    assert_eq!(
        c_restack[0].fork_sha.as_deref(),
        Some(b0.as_str()),
        "C's fork point is the old head B's push row recorded"
    );
    let tree = git(&rig.origin, &["ls-tree", "--name-only", "refs/heads/main"]);
    for file in ["a.txt", "b.txt", "c.txt", "app.txt"] {
        assert!(tree.lines().any(|l| l == file), "{file} missing: {tree}");
    }
}

#[tokio::test]
async fn a_restack_conflict_goes_to_the_owner_and_parks_without_one() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("squash", "");
    rig.change(1, "a", "a.txt", "a\n");
    let b_tree = rig.change_on(2, "b", "houston/a", "app.txt", "one\nB\nthree\n");
    // The base moves under both: A rebases cleanly, B's replay conflicts.
    rig.advance_base("app.txt", "one\nZ\nthree\n");
    rig.settings(true, "git --version");
    let owner = agent_pane(&rig.daemon, &b_tree);
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, Some(owner));

    rig.tick().await;

    assert!(rig.entries().iter().all(|e| e.number != 1), "A landed");
    let entry = rig.entry(2);
    assert_eq!(entry.status, proto::MergeQueueStatus::Fixing, "{entry:?}");
    let failure = entry.failure.clone().unwrap();
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Conflict);
    assert_eq!(failure.files, ["app.txt"]);
    assert!(
        failure.message.starts_with("Restacking onto main@") && failure.message.contains("#1's"),
        "{}",
        failure.message
    );
    let notes = rig.inbox("Merge queue:%");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, owner);

    rig.daemon.kill(owner).unwrap();
    let _ = rig.daemon.close(owner);
    rig.daemon.merge_queue_retry(&rig.workspace, 2).unwrap();
    rig.tick().await;
    let entry = rig.entry(2);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    assert!(rows(&rig, proto::MergeQueueLogKind::Park, 2).len() == 1);
    assert!(rows(&rig, proto::MergeQueueLogKind::Restack, 2).is_empty());
}

#[tokio::test]
async fn a_dependent_with_no_recorded_fork_point_is_refused_by_name() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("squash", "");
    let a_tree = rig.change(1, "a", "a.txt", "a\n");
    commit(&a_tree, "a2.txt", "a2\n", "a2");
    git(&a_tree, &["push", "-q", "origin", "houston/a"]);
    rig.change_on(2, "b", "houston/a", "b.txt", "b\n");
    let b0 = rig.origin_tip("houston/b");
    // A is rewritten before the queue ever reads it: B was built on a head
    // Houston never recorded.
    std::fs::write(a_tree.join("a2.txt"), "a2 amended\n").unwrap();
    git(
        &a_tree,
        &["commit", "-q", "-a", "--amend", "-m", "a2 amended"],
    );
    git(&a_tree, &["push", "-q", "-f", "origin", "houston/a"]);
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.enqueue_after(2, 1, None);

    rig.tick().await;

    let entry = rig.entry(2);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    let failure = entry.failure.unwrap();
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Refused);
    assert!(
        failure.message.contains("no fork point")
            && failure.message.contains("does not guess")
            && failure.message.contains("#1"),
        "{}",
        failure.message
    );
    assert_eq!(rig.origin_tip("houston/b"), b0, "nothing was pushed");
    assert!(rig.calls("pr merge 2").is_empty());
}

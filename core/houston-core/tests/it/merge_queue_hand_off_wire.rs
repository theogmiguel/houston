//! The hand-off to GitHub against real repositories: where the base requires GitHub's
//! merge queue, or the repository allows auto-merge with required checks, the verified
//! head goes to GitHub instead of Houston's own merge, and Houston watches it there.
#![allow(clippy::disallowed_methods)]

use crate::merge_queue_rig::{agent_pane, Rig, NEEDS_BASE, SERIAL};

use houston_protocol as proto;

fn hand_off(rig: &Rig) -> Option<proto::MergeQueueHandOffInfo> {
    match rig.snapshot() {
        proto::ServerMsg::MergeQueue { hand_off, .. } => hand_off,
        other => panic!("not a snapshot: {other:?}"),
    }
}

fn failing_ci() -> serde_json::Value {
    serde_json::json!([{
        "__typename": "CheckRun", "name": "ci", "status": "COMPLETED", "conclusion": "FAILURE"
    }])
}

#[tokio::test]
async fn a_merge_queue_base_gets_the_verified_head_enqueued_and_houston_finishes_after_github() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("merge-queue", "");
    rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    rig.advance_base("base.txt", "base\n");
    let other = rig.change(9, "nine", "nine.txt", "nine\n");
    let watcher = agent_pane(&rig.daemon, &other);
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(1, None);

    rig.tick().await;

    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Watching, "{entry:?}");
    assert_eq!(
        entry.reason.as_deref(),
        Some("In GitHub's merge queue (position 1)")
    );
    let hold = entry.github.clone().expect("GitHub holds it");
    assert_eq!(hold.mode, proto::MergeQueueHandOff::MergeQueue);
    assert_eq!(hold.head_sha, head, "the head itself is enqueued");
    assert_eq!(
        rig.origin_tip("houston/one"),
        head,
        "GitHub builds the merge group: nothing is pushed"
    );
    assert!(rig.calls("pr merge").is_empty(), "Houston did not merge");
    assert!(rig.has_flag("queued-1"));
    assert!(rig
        .log()
        .iter()
        .any(|e| e.kind == proto::MergeQueueLogKind::HandOff && e.number == 1));
    rig.tick().await;
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Watching);

    rig.github_merges(1);
    rig.read_pass().await;
    rig.tick().await;

    assert!(
        rig.entries().iter().all(|e| e.number != 1),
        "{:?}",
        rig.entries()
    );
    let merge = rig
        .log()
        .into_iter()
        .find(|e| e.kind == proto::MergeQueueLogKind::Merge && e.number == 1)
        .expect("a merge row");
    assert_eq!(
        merge.detail.as_deref(),
        Some("Merged by GitHub's merge queue")
    );
    assert_eq!(merge.head_sha.as_deref(), Some(head.as_str()));
    assert_eq!(merge.new_sha, Some(rig.origin_tip("main")));
    let notes = rig.inbox("The base moved:%");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, watcher);
    let _ = rig.daemon.kill(watcher);
}

#[tokio::test]
async fn dequeue_and_an_ejection_take_the_entry_back_from_githubs_merge_queue() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("merge-queue", "");
    rig.change(1, "one", "one.txt", "one\n");
    rig.change(2, "two", "two.txt", "two\n");
    rig.settings(true, "git --version");
    rig.enqueue(1, None);
    rig.tick().await;
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Watching);

    rig.daemon.merge_queue_dequeue(&rig.workspace, "1").unwrap();
    assert!(
        !rig.has_flag("queued-1"),
        "dequeued from GitHub's merge queue"
    );
    assert!(rig.entries().is_empty());

    rig.enqueue(2, None);
    rig.tick().await;
    assert_eq!(rig.entry(2).status, proto::MergeQueueStatus::Watching);
    rig.unflag("queued-2");
    rig.flag("removed-2", "The merge group's required checks failed");
    rig.read_pass().await;
    rig.tick().await;

    let entry = rig.entry(2);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    let failure = entry.failure.unwrap();
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::Ejected);
    assert_eq!(
        failure.message,
        "GitHub's merge queue removed PR #2: The merge group's required checks failed"
    );
    assert_eq!(entry.github, None);
    assert!(rig
        .log()
        .iter()
        .any(|e| e.kind == proto::MergeQueueLogKind::Park && e.number == 2));
}

#[tokio::test]
async fn auto_merge_is_pinned_to_the_verified_commit_turned_off_by_a_pause_and_ends_on_a_failure() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("auto-merge-allowed", "");
    rig.flag("required-checks", "ci");
    rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    rig.advance_base("base.txt", "base\n");
    rig.settings(true, NEEDS_BASE);
    rig.enqueue(1, None);

    rig.tick().await;

    let verified = rig.origin_tip("houston/one");
    assert_ne!(verified, head, "the verified commit is lease-pushed first");
    let auto = rig.calls("pr merge 1 --auto");
    assert_eq!(
        auto,
        [format!(
            "pr merge 1 --auto --match-head-commit {verified} --squash"
        )]
    );
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Watching, "{entry:?}");
    assert_eq!(
        entry.reason,
        Some(format!(
            "Auto-merge is on for {}; GitHub merges once required checks pass",
            &verified[..7]
        ))
    );

    // A pause turns auto-merge off; resuming hands the same verified commit back.
    rig.daemon
        .merge_queue_pause(Some(&rig.workspace), true)
        .unwrap();
    assert_eq!(rig.calls("pr merge 1 --disable-auto").len(), 1);
    assert!(!rig.has_flag("auto-1"));
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Paused, "{entry:?}");
    assert_eq!(entry.github, None);
    rig.daemon
        .merge_queue_pause(Some(&rig.workspace), false)
        .unwrap();
    rig.tick().await;
    assert_eq!(rig.calls("pr merge 1 --auto").len(), 2);
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Watching);

    // GitHub turns auto-merge off on its own: the failure path, with its reason.
    rig.unflag("auto-1");
    rig.flag("removed-1", "Base branch was modified");
    rig.read_pass().await;
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    assert_eq!(
        entry.failure.as_ref().unwrap().message,
        "GitHub turned auto-merge off for PR #1: Base branch was modified"
    );

    // Back in line, a failing check on the handed-off commit ends it too.
    rig.unflag("removed-1");
    rig.daemon.merge_queue_retry(&rig.workspace, 1).unwrap();
    rig.tick().await;
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Watching);
    rig.pr_set(1, "statusCheckRollup", failing_ci());
    rig.read_pass().await;
    rig.tick().await;
    let entry = rig.entry(1);
    assert_eq!(entry.status, proto::MergeQueueStatus::Parked, "{entry:?}");
    let failure = entry.failure.unwrap();
    assert_eq!(failure.kind, proto::MergeQueueFailureKind::ChecksFailed);
    assert!(failure.message.contains("ci"), "{}", failure.message);
    assert!(!rig.has_flag("auto-1"), "auto-merge was turned off");
    assert!(
        rig.calls("pr merge 1 --match").is_empty(),
        "Houston never merged"
    );
}

#[tokio::test]
async fn the_hand_off_rides_on_the_reads_that_already_happen_and_is_cached() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    rig.flag("merge-queue", "");
    rig.change(1, "one", "one.txt", "one\n");
    rig.enqueue(1, None);
    for _ in 0..3 {
        rig.read_pass().await;
    }
    let views = rig.calls("pr view").len();
    let graphql = rig.calls("api graphql").len();
    assert_eq!(
        graphql,
        2 * views,
        "each read is one access query and one thread query, as before the hand-off"
    );
    let cached = hand_off(&rig).expect("cached from the reads");
    assert_eq!(cached.mode, proto::MergeQueueHandOff::MergeQueue);
    assert_eq!(cached.base_ref.as_deref(), Some("main"));
    assert!(!cached.from_refusal);

    // With nothing queued nothing is read, and the policy line still has its path.
    rig.daemon.merge_queue_dequeue(&rig.workspace, "1").unwrap();
    rig.read_pass().await;
    assert_eq!(rig.calls("pr view").len(), views);
    assert_eq!(hand_off(&rig), Some(cached));
}

#[tokio::test]
async fn a_merge_refused_for_githubs_merge_queue_fails_with_githubs_words_and_teaches_the_cache() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    // GitHub hides whether the base has a merge queue: Houston merges.
    rig.flag("merge-queue-hidden", "");
    let refusal = "Changes must be made through the merge queue";
    rig.flag("merge-refused", refusal);
    rig.change(1, "one", "one.txt", "one\n");
    let head = rig.origin_tip("houston/one");
    rig.enqueue(1, None);
    assert_eq!(hand_off(&rig), None, "an unknown is never a hand-off");

    let refused = rig
        .daemon
        .merge_queue_merge_head(&rig.workspace, 1, &head, proto::PrMergeMethod::Squash)
        .unwrap_err();
    assert!(format!("{refused:#}").contains(refusal), "{refused:#}");
    let learned = hand_off(&rig).expect("learned from the refusal");
    assert_eq!(learned.mode, proto::MergeQueueHandOff::MergeQueue);
    assert!(learned.from_refusal);
    rig.read_pass().await;
    assert_eq!(
        hand_off(&rig).map(|h| h.mode),
        Some(proto::MergeQueueHandOff::MergeQueue),
        "a read that cannot see the rule keeps the lesson"
    );

    rig.unflag("merge-refused");
    rig.daemon
        .merge_queue_merge_head(&rig.workspace, 1, &head, proto::PrMergeMethod::Squash)
        .unwrap();
    assert!(rig.has_flag("queued-1"), "the next landing hands off");
    assert_eq!(rig.entry(1).status, proto::MergeQueueStatus::Watching);
}

#[tokio::test]
async fn a_host_whose_schema_lacks_the_hand_off_fields_keeps_its_reads_and_houston_merges() {
    let _serial = SERIAL.lock().await;
    let rig = Rig::new().await;
    // The base would hand off, but this host's GraphQL schema has no such fields.
    rig.flag("merge-queue", "");
    rig.flag("hand-off-unsupported", "");
    rig.change(1, "one", "one.txt", "one\n");
    rig.enqueue(1, None);
    let access = || -> Vec<String> {
        std::fs::read_to_string(rig.bin.join("access.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    };
    assert_eq!(
        access(),
        ["enlarged", "base"],
        "one retry without the fields"
    );
    let cached = hand_off(&rig).expect("the read still answers");
    assert_eq!(cached.mode, proto::MergeQueueHandOff::Houston);

    let (_, detail) = houston_core::pull_requests::read(
        std::path::Path::new(&rig.workspace),
        Some(1),
        proto::PullRequestLinkSource::Manual,
        None,
    )
    .unwrap();
    let viewer = detail.viewer.expect("permissions read as before");
    assert!(viewer.can_write && viewer.can_update);
    assert_eq!(
        detail.merge_methods,
        [
            proto::PrMergeMethod::Squash,
            proto::PrMergeMethod::Merge,
            proto::PrMergeMethod::Rebase
        ]
    );
    assert_eq!(
        access(),
        ["enlarged", "base", "base"],
        "the host is remembered: the next read skips the enlarged query"
    );

    rig.settings(true, "git --version");
    rig.tick().await;
    assert!(rig.entries().is_empty(), "{:?}", rig.entries());
    assert_eq!(rig.calls("pr merge 1").len(), 1, "Houston merged it");
    assert!(!rig.has_flag("queued-1"), "nothing went to GitHub's queue");
}

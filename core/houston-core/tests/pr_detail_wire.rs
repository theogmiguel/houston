#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use tokio_tungstenite::tungstenite::Message;

// One gh shim, one PATH mutation, and one daemon at a time: the shim answers
// from files this test writes, and the serial lock keeps those files stable.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SHIM: OnceLock<PathBuf> = OnceLock::new();

// gh reports the full 40-character head, so the fixtures do too.
const HEAD_SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const STALE_SHA: &str = "89abcdef0123456789abcdef0123456789abcdef";

const BRANCH_TEMPLATE: &str = r#"{
  "number": 61,
  "url": "https://github.com/owner/repo/pull/61",
  "state": "OPEN",
  "title": "a change",
  "isDraft": false,
  "reviewDecision": "REVIEW_REQUIRED",
  "statusCheckRollup": [
    {"__typename": "CheckRun", "name": "core-checks", "status": "IN_PROGRESS"},
    {"__typename": "CheckRun", "name": "safety-checks", "status": "COMPLETED",
     "conclusion": "SUCCESS", "startedAt": "2026-09-01T12:00:00Z",
     "completedAt": "2026-09-01T12:01:12Z"}
  ],
  "additions": 5,
  "deletions": 2,
  "changedFiles": 3,
  "createdAt": "2026-09-01T12:00:00Z",
  "updatedAt": "2026-09-02T12:00:00Z",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "BLOCKED",
  "baseRefName": "main",
  "headRefName": "feat/x",
  "headRefOid": "__HEAD_SHA__",
  "commits": [{"oid": "a"}, {"oid": "b"}],
  "comments": [{"author": {"login": "theo"}, "body": "looks good"}],
  "reviews": [{"author": {"login": "rev"}, "state": "APPROVED", "body": "lgtm",
               "submittedAt": "2026-09-02T10:00:00Z"}]
}"#;

const CLEAN_TEMPLATE: &str = r#"{
  "number": 61,
  "url": "https://github.com/owner/repo/pull/61",
  "state": "OPEN",
  "title": "a change",
  "isDraft": false,
  "statusCheckRollup": [
    {"__typename": "CheckRun", "name": "safety-checks", "status": "COMPLETED",
     "conclusion": "SUCCESS"}
  ],
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "CLEAN",
  "baseRefName": "main",
  "headRefName": "feat/x",
  "headRefOid": "__HEAD_SHA__",
  "commits": [{"oid": "a"}]
}"#;

fn branch_json() -> String {
    BRANCH_TEMPLATE.replace("__HEAD_SHA__", HEAD_SHA)
}

fn clean_json() -> String {
    CLEAN_TEMPLATE.replace("__HEAD_SHA__", HEAD_SHA)
}

// A pull request with the shapes the GraphQL reads key off: remarks carrying
// node ids, labels, a requested reviewer and an armed auto-merge.
const RICH_TEMPLATE: &str = r#"{
  "number": 61,
  "url": "https://github.com/owner/repo/pull/61",
  "state": "OPEN",
  "title": "a change",
  "body": "what it does",
  "author": {"login": "theo"},
  "isDraft": false,
  "isCrossRepository": false,
  "reviewDecision": "REVIEW_REQUIRED",
  "statusCheckRollup": [
    {"__typename": "CheckRun", "name": "safety-checks", "status": "COMPLETED",
     "conclusion": "SUCCESS"}
  ],
  "additions": 5,
  "deletions": 2,
  "changedFiles": 3,
  "createdAt": "2026-09-01T12:00:00Z",
  "updatedAt": "2026-09-02T12:00:00Z",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "BLOCKED",
  "baseRefName": "main",
  "headRefName": "feat/x",
  "headRefOid": "__HEAD_SHA__",
  "headRepositoryOwner": {"login": "theo"},
  "labels": [{"name": "bug", "color": "d73a4a"}],
  "reviewRequests": [{"login": "octo"}, {"slug": "core"}],
  "autoMergeRequest": {"mergeMethod": "SQUASH"},
  "commits": [{"oid": "a"}, {"oid": "b"}],
  "comments": [{"id": "IC_1", "author": {"login": "theo"}, "body": "looks good",
                "createdAt": "2026-09-02T11:00:00Z"}],
  "reviews": [{"id": "PRR_1", "author": {"login": "rev"}, "state": "APPROVED", "body": "lgtm",
               "submittedAt": "2026-09-02T10:00:00Z"}]
}"#;

fn rich_json(number: u32) -> String {
    RICH_TEMPLATE
        .replace("__HEAD_SHA__", HEAD_SHA)
        .replace("\"number\": 61", &format!("\"number\": {number}"))
        .replace(
            "\"url\": \"https://github.com/owner/repo/pull/61\"",
            &format!("\"url\": \"https://github.com/owner/repo/pull/{number}\""),
        )
}

fn access_json(permission: &str, can_update: bool, did_author: bool) -> String {
    let template = r#"{"data":{"repository":{"viewerPermission":"__PERM__","pullRequest":{"viewerCanUpdate":__UPD__,"viewerDidAuthor":__AUTH__,"viewerCanUpdateBranch":true,"baseRef":{"compare":{"behindBy":2}}}}}}"#;
    template
        .replace("__PERM__", permission)
        .replace("__UPD__", if can_update { "true" } else { "false" })
        .replace("__AUTH__", if did_author { "true" } else { "false" })
}

const THREADS_JSON: &str = r#"{"data":{"repository":{"pullRequest":{
  "id":"PR_kw",
  "reactionGroups":[{"content":"THUMBS_UP","viewerHasReacted":true,"reactors":{"totalCount":3}}],
  "comments":{"nodes":[{"id":"IC_1","reactionGroups":[{"content":"HEART","viewerHasReacted":false,"reactors":{"totalCount":1}}]}]},
  "reviews":{"nodes":[{"id":"PRR_1","reactionGroups":[]}]},
  "reviewRequests":{"nodes":[{"requestedReviewer":{"login":"octo"}},{"requestedReviewer":{"slug":"core"}}]},
  "latestReviews":{"nodes":[{"author":{"login":"rev"}}]},
  "reviewThreads":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[
    {"id":"PRT_1","isResolved":false,"isOutdated":false,"path":"src/a.rs","line":12,
     "comments":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[
       {"id":"PRRC_1","author":{"login":"rev"},"body":"rename this",
        "createdAt":"2026-09-02T10:00:00Z","url":"https://github.com/owner/repo/pull/61#discussion_r1"}]}}]}}}}}"#;

const REVIEWERS_JSON: &str = r#"{"data":{"repository":{
  "assignableUsers":{"pageInfo":{"hasNextPage":false},"nodes":[
    {"login":"theo","name":"Theo"},
    {"login":"octo","name":"Octo"},
    {"login":"mona","name":"Mona"}]},
  "pullRequest":{
    "author":{"login":"theo"},
    "reviewRequests":{"nodes":[
      {"requestedReviewer":{"login":"octo","name":"Octo"}},
      {"requestedReviewer":{"slug":"core","name":"Core"}}]}}}}}"#;

const LABELS_JSON: &str = r#"{"data":{"repository":{
  "labels":{"pageInfo":{"hasNextPage":false},"nodes":[
    {"name":"bug","color":"d73a4a","description":"Something is broken"},
    {"name":"docs","color":"0075ca","description":null},
    {"name":"gone","color":"cccccc","description":null}]},
  "pullRequest":{"labels":{"nodes":[{"name":"bug"},{"name":"deleted"}]}}}}}"#;

fn shim_dir() -> PathBuf {
    SHIM.get_or_init(|| {
        let dir = tempfile::tempdir().expect("shim tempdir").keep();
        let script = format!(
            "#!/bin/sh\n\
             dir=\"{}\"\n\
             printf '%s\\n' \"$*\" >> \"$dir/gh.log\"\n\
             respond() {{\n\
             \ttag=\"$1\"; code=0; found=0\n\
             \tif [ -f \"$dir/$tag.exit\" ]; then code=$(cat \"$dir/$tag.exit\"); found=1; fi\n\
             \tif [ -f \"$dir/$tag.out\" ]; then cat \"$dir/$tag.out\"; found=1; fi\n\
             \tif [ -f \"$dir/$tag.err\" ]; then cat \"$dir/$tag.err\" >&2; found=1; fi\n\
             \tif [ \"$found\" = \"0\" ] && [ -f \"$dir/$tag.json\" ]; then cat \"$dir/$tag.json\"; found=1; fi\n\
             \tif [ \"$found\" = \"0\" ]; then echo \"no scenario for $tag\" >&2; exit 1; fi\n\
             \texit \"$code\"\n\
             }}\n\
             if [ \"$1\" = \"--version\" ]; then exit 0; fi\n\
             if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi\n\
             if [ \"$1 $2\" = \"pr view\" ]; then\n\
             \tif [ -n \"$3\" ] && [ \"$3\" != \"--json\" ]; then f=\"$dir/view-$3.json\"; else f=\"$dir/view-branch.json\"; fi\n\
             \tif [ -f \"$f\" ]; then cat \"$f\"; exit 0; fi\n\
             \tcat \"$dir/view.err\" >&2 2>/dev/null\n\
             \texit 1\n\
             fi\n\
             if [ \"$1 $2\" = \"api graphql\" ]; then\n\
             \tbody=$(cat)\n\
             \tprintf '%s\\n' \"$body\" >> \"$dir/graphql.log\"\n\
             \tkind=generic\n\
             \tcase \"$body\" in\n\
             \t\t*reviewThreads*) kind=threads ;;\n\
             \t\t*viewerPermission*) kind=access ;;\n\
             \t\t*assignableUsers*) kind=reviewers ;;\n\
             \t\t*labels\\(first*) kind=labels ;;\n\
             \t\t*revertPullRequest*) kind=revert ;;\n\
             \t\t*addReaction*|*removeReaction*) kind=reaction ;;\n\
             \t\t*resolveReviewThread*|*unresolveReviewThread*|*addPullRequestReviewThreadReply*) kind=thread ;;\n\
             \t\t*\"node(id: \"*) kind=subject ;;\n\
             \t\t*\"pullRequest(number: \"*) kind=nodeid ;;\n\
             \tesac\n\
             \tif [ -f \"$dir/graphql-$kind.json\" ]; then cat \"$dir/graphql-$kind.json\"; exit 0; fi\n\
             \tif [ -f \"$dir/graphql-$kind.err\" ]; then cat \"$dir/graphql-$kind.err\" >&2; exit 1; fi\n\
             \techo \"no graphql scenario for $kind\" >&2; exit 1\n\
             fi\n\
             if [ \"$1\" = \"api\" ]; then\n\
             \ttag=generic\n\
             \tcase \"$*\" in\n\
             \t\t*\"stacks?pull_request\"*) tag=stack ;;\n\
             \t\t*merge-async*) tag=stack-merge ;;\n\
             \t\t*requested_reviewers*) tag=reviewers ;;\n\
             \t\t*\"pulls/61/reviews\"*) tag=review ;;\n\
             \t\t*update-branch*) tag=update-branch ;;\n\
             \t\t*\"/approve\"*) tag=approve ;;\n\
             \t\t*\"comments/\"*) tag=comment-edit ;;\n\
             \t\t*\"labels/\"*) tag=label-delete ;;\n\
             \t\t*\"labels\"*) tag=labels ;;\n\
             \tesac\n\
             \trespond \"api-$tag\"\n\
             fi\n\
             if [ \"$1 $2\" = \"pr comment\" ]; then respond comment; fi\n\
             if [ \"$1 $2\" = \"pr edit\" ]; then respond edit; fi\n\
             if [ \"$1 $2\" = \"pr ready\" ]; then respond ready; fi\n\
             if [ \"$1 $2\" = \"pr close\" ]; then respond close; fi\n\
             if [ \"$1 $2\" = \"pr reopen\" ]; then respond reopen; fi\n\
             if [ \"$1 $2\" = \"pr merge\" ]; then respond merge; fi\n\
             if [ \"$1 $2\" = \"pr list\" ]; then\n\
             \tif [ -f \"$dir/list.json\" ]; then cat \"$dir/list.json\"; exit 0; fi\n\
             \tcat \"$dir/list.err\" >&2 2>/dev/null\n\
             \texit 1\n\
             fi\n\
             if [ \"$1 $2\" = \"pr diff\" ]; then\n\
             \tif [ -f \"$dir/diff.patch\" ]; then cat \"$dir/diff.patch\"; exit 0; fi\n\
             \tcat \"$dir/diff.err\" >&2 2>/dev/null\n\
             \texit 1\n\
             fi\n\
             if [ \"$1 $2\" = \"run list\" ]; then\n\
             \tif [ -f \"$dir/runs.json\" ]; then cat \"$dir/runs.json\"; exit 0; fi\n\
             \tcat \"$dir/runs.err\" >&2 2>/dev/null\n\
             \texit 1\n\
             fi\n\
             exit 1\n",
            dir.display()
        );
        let path = dir.join("gh");
        std::fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        dir
    })
    .clone()
}

fn reset(dir: &Path) {
    for name in [
        "view-branch.json",
        "view.err",
        "merge.exit",
        "merge.out",
        "merge.err",
        "gh.log",
        "graphql.log",
        "graphql-access.json",
        "graphql-access.err",
        "graphql-threads.json",
        "graphql-threads.err",
        "graphql-reviewers.json",
        "graphql-labels.json",
        "graphql-subject.json",
        "graphql-nodeid.json",
        "graphql-revert.json",
        "graphql-reaction.json",
        "graphql-thread.json",
        "api-review.out",
        "api-review.exit",
        "api-review.err",
        "api-reviewers.out",
        "api-reviewers.exit",
        "api-reviewers.err",
        "api-labels.out",
        "api-labels.exit",
        "api-labels.err",
        "api-label-delete.exit",
        "api-label-delete.err",
        "api-comment-edit.exit",
        "api-comment-edit.err",
        "api-update-branch.exit",
        "api-update-branch.err",
        "api-approve.exit",
        "api-approve.err",
        "api-stack.json",
        "api-stack.err",
        "api-stack.exit",
        "api-stack-merge.out",
        "api-stack-merge.exit",
        "api-stack-merge.err",
        "comment.exit",
        "comment.err",
        "edit.exit",
        "edit.err",
        "ready.exit",
        "ready.err",
        "close.exit",
        "close.err",
        "reopen.exit",
        "reopen.err",
        "list.json",
        "list.err",
        "diff.patch",
        "diff.err",
        "runs.json",
        "runs.err",
    ] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    for n in ["61", "62"] {
        let _ = std::fs::remove_file(dir.join(format!("view-{n}.json")));
    }
}

fn write_scenario(dir: &Path, name: &str, content: &str) {
    std::fs::write(dir.join(name), content).unwrap();
}

fn gh_log(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("gh.log")).unwrap_or_default()
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

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.local"]);
    git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", "init"]);
    git(
        dir,
        &["remote", "add", "origin", "git@github.com:owner/repo.git"],
    );
}

async fn start_daemon_on(db_path: PathBuf) -> (std::net::SocketAddr, Arc<Daemon>) {
    let daemon = Daemon::new(DaemonConfig {
        token: TOKEN.to_string(),
        db_path,
    })
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    (addr, daemon)
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn expect_pr_detail(ws: &mut WsStream) -> proto::ServerMsg {
    loop {
        match next_control(ws).await {
            msg @ proto::ServerMsg::PrDetail { .. } => return msg,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_linked(ws: &mut WsStream) -> (bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrLinked { ok, message, .. } => return (ok, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_merged(ws: &mut WsStream) -> (bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrMerged { ok, message, .. } => return (ok, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_mutation(
    ws: &mut WsStream,
) -> (proto::PrMutationKind, bool, Option<String>, u32) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrMutation {
                kind,
                ok,
                message,
                number,
                ..
            } => return (kind, ok, message, number),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_reviewer_candidates(
    ws: &mut WsStream,
) -> (Vec<proto::PrReviewerCandidate>, bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrReviewerCandidates {
                candidates,
                truncated,
                message,
                ..
            } => return (candidates, truncated, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_label_candidates(
    ws: &mut WsStream,
) -> (Vec<proto::PrLabelCandidate>, bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrLabelCandidates {
                candidates,
                truncated,
                message,
                ..
            } => return (candidates, truncated, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_list(ws: &mut WsStream) -> (Vec<proto::PrListItem>, bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrList {
                items,
                truncated,
                message,
                ..
            } => return (items, truncated, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

async fn expect_pr_diff(ws: &mut WsStream) -> (String, bool, Option<String>) {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::PrDiff {
                patch,
                truncated,
                message,
                ..
            } => return (patch, truncated, message),
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn pr_detail_over_the_wire_reads_the_branch_pull_request() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);
    write_scenario(&shim, "view-branch.json", &branch_json());

    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::PrDetail {
            dir,
            request: 7,
            number: None,
        },
    )
    .await;

    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail {
            request,
            gh,
            link,
            detail,
            linked,
            message,
            ..
        } => {
            assert_eq!(request, 7, "the reply echoes the request id");
            assert_eq!(gh, proto::GhState::Ready);
            assert!(!linked, "a branch pull request is not a manual association");
            assert_eq!(message, None);
            let link = link.expect("a link");
            assert_eq!(link.number, 61);
            assert_eq!(link.source, proto::PullRequestLinkSource::Detected);
            assert_eq!(link.state, proto::PullRequestState::Open);
            let detail = detail.expect("a detail");
            assert_eq!(detail.head_sha, HEAD_SHA);
            assert_eq!(detail.commit_count, 2);
            assert_eq!(detail.checks.len(), 2);
            assert_eq!(detail.checks[0].state, proto::PrCheckState::Running);
            assert_eq!(detail.checks[1].duration_ms, Some(72_000));
            assert_eq!(detail.comments_total, 1);
            assert_eq!(detail.reviews_total, 1);
            let reason = detail.merge_disabled_reason.expect("a gate");
            assert!(
                reason.contains("waiting on 1 check") && reason.contains("core-checks"),
                "running checks outrank the review requirement: {reason}"
            );
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }
}

#[tokio::test]
async fn a_missing_pull_request_is_empty_but_a_failed_read_names_gh() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);

    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    write_scenario(
        &shim,
        "view.err",
        "no pull requests found for branch \"main\"",
    );
    send(
        &mut ws,
        &proto::ClientMsg::PrDetail {
            dir: dir.clone(),
            request: 1,
            number: None,
        },
    )
    .await;
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail {
            link,
            message,
            hint,
            ..
        } => {
            assert!(link.is_none());
            assert_eq!(message, None, "an empty branch is not a failure");
            assert_eq!(hint, None);
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }

    write_scenario(&shim, "view.err", "network is unreachable");
    send(
        &mut ws,
        &proto::ClientMsg::PrDetail {
            dir,
            request: 2,
            number: None,
        },
    )
    .await;
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail { link, message, .. } => {
            assert!(link.is_none());
            let message = message.expect("a read failure must be named");
            assert!(
                message.contains("network is unreachable"),
                "gh's own reason survives: {message}"
            );
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }
}

#[tokio::test]
async fn linking_persists_across_a_daemon_restart_and_unlink_names_it() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);
    write_scenario(&shim, "view-61.json", &branch_json());
    write_scenario(&shim, "view-branch.json", &branch_json());

    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();

    let (addr, daemon) = start_daemon_on(db_path.clone()).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::PrLink {
            dir: dir.clone(),
            number: 61,
            request: 2,
        },
    )
    .await;
    let (ok, message) = expect_pr_linked(&mut ws).await;
    assert!(ok, "link failed: {message:?}");
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail {
            request,
            linked,
            link,
            ..
        } => {
            assert_eq!(
                request, 2,
                "the pushed detail carries the link's request id"
            );
            assert!(linked);
            assert_eq!(link.unwrap().source, proto::PullRequestLinkSource::Manual);
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }
    drop(ws);
    drop(daemon);

    let (addr, _daemon) = start_daemon_on(db_path).await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::PrDetail {
            dir: dir.clone(),
            request: 3,
            number: None,
        },
    )
    .await;
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail { linked, link, .. } => {
            assert!(linked, "the manual association survives the restart");
            assert_eq!(link.unwrap().number, 61);
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }

    send(
        &mut ws,
        &proto::ClientMsg::PrUnlink {
            dir: dir.clone(),
            request: 4,
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::PrUnlinked {
                request,
                number,
                ok,
                message,
                ..
            } => {
                assert_eq!(request, 4);
                assert_eq!(number, Some(61), "the reply names what was removed");
                assert!(ok, "unlink failed: {message:?}");
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail {
            request,
            linked,
            link,
            ..
        } => {
            assert_eq!(request, 4);
            assert!(!linked);
            assert_eq!(
                link.unwrap().source,
                proto::PullRequestLinkSource::Detected,
                "the branch pull request still shows, as auto-detected"
            );
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }
    assert!(
        gh_log(&shim).contains("pr view 61"),
        "the link read the number"
    );
}

#[tokio::test]
async fn bad_link_and_merge_inputs_are_refused_before_gh_acts() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);
    write_scenario(&shim, "view-61.json", &clean_json());

    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::PrLink {
            dir: dir.clone(),
            number: 0,
            request: 5,
        },
    )
    .await;
    let (ok, message) = expect_pr_linked(&mut ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("must be positive"));

    send(
        &mut ws,
        &proto::ClientMsg::PrMerge {
            dir: dir.clone(),
            number: 61,
            method: proto::PrMergeMethod::Merge,
            expected_head_sha: "not-a-sha".into(),
            request: 6,
        },
    )
    .await;
    let (ok, message) = expect_pr_merged(&mut ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("40-character hex"));

    let log = gh_log(&shim);
    assert!(
        !log.contains("pr view 0"),
        "no read for a zero number: {log}"
    );
    assert!(!log.contains("pr merge"), "no merge attempt: {log}");
}

#[tokio::test]
async fn a_stale_head_and_a_running_check_both_refuse_before_gh_merges() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);

    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    write_scenario(&shim, "view-61.json", &clean_json());
    send(
        &mut ws,
        &proto::ClientMsg::PrMerge {
            dir: dir.clone(),
            number: 61,
            method: proto::PrMergeMethod::Squash,
            expected_head_sha: STALE_SHA.into(),
            request: 7,
        },
    )
    .await;
    let (ok, message) = expect_pr_merged(&mut ws).await;
    assert!(!ok);
    let message = message.unwrap();
    assert!(
        message.contains(&format!("head moved from {STALE_SHA} to {HEAD_SHA}")),
        "the moved head is named with both shas: {message}"
    );

    write_scenario(&shim, "view-61.json", &branch_json());
    send(
        &mut ws,
        &proto::ClientMsg::PrMerge {
            dir,
            number: 61,
            method: proto::PrMergeMethod::Squash,
            expected_head_sha: HEAD_SHA.into(),
            request: 8,
        },
    )
    .await;
    let (ok, message) = expect_pr_merged(&mut ws).await;
    assert!(!ok);
    assert!(
        message.unwrap().contains("waiting on 1 check"),
        "a running check refuses the merge server-side"
    );
    assert!(
        !gh_log(&shim).contains("pr merge"),
        "neither refusal reached gh pr merge"
    );
}

#[tokio::test]
async fn a_clean_merge_pins_the_head_and_the_method() {
    let _serial = SERIAL.lock().await;
    let shim = shim_dir();
    reset(&shim);
    write_scenario(&shim, "view-61.json", &clean_json());
    write_scenario(&shim, "merge.exit", "0");

    let state = tempfile::tempdir().unwrap();
    let (addr, _daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    send(
        &mut ws,
        &proto::ClientMsg::PrMerge {
            dir,
            number: 61,
            method: proto::PrMergeMethod::Rebase,
            expected_head_sha: HEAD_SHA.into(),
            request: 9,
        },
    )
    .await;
    let (ok, message) = expect_pr_merged(&mut ws).await;
    assert!(ok, "merge failed: {message:?}");
    match expect_pr_detail(&mut ws).await {
        proto::ServerMsg::PrDetail { request, .. } => assert_eq!(request, 9),
        other => panic!("expected pr_detail, got {other:?}"),
    }

    let log = gh_log(&shim);
    assert!(
        log.contains(&format!(
            "pr merge 61 --match-head-commit {HEAD_SHA} --rebase"
        )),
        "the merge pins the head and the method: {log}"
    );
    assert!(
        !log.contains("--admin") && !log.contains("--auto") && !log.contains("--delete-branch"),
        "the daemon never bypasses or deletes: {log}"
    );
}

// Provider writes and reads beyond the original detail: gated actions, reviews
// with inline drafts, comments, threads, reactions, picks, the listing, the diff.

struct Rig {
    _state: tempfile::TempDir,
    _repo: tempfile::TempDir,
    _daemon: Arc<Daemon>,
    ws: WsStream,
    dir: String,
    shim: PathBuf,
}

async fn rig() -> Rig {
    let shim = shim_dir();
    reset(&shim);
    let state = tempfile::tempdir().unwrap();
    let (addr, daemon) = start_daemon_on(state.path().join("test.db")).await;
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let dir = repo.path().display().to_string();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;
    Rig {
        _state: state,
        _repo: repo,
        _daemon: daemon,
        ws,
        dir,
        shim,
    }
}

fn cross_repo_json() -> String {
    rich_json(61)
        .replace(
            "\"isCrossRepository\": false",
            "\"isCrossRepository\": true",
        )
        .replace(
            "\"headRepositoryOwner\": {\"login\": \"theo\"}",
            "\"headRepositoryOwner\": {\"login\": \"fork\"}",
        )
}

#[tokio::test]
async fn a_ready_action_obeys_githubs_permission_answer() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("READ", false, false),
    );
    write_scenario(&rig.shim, "ready.exit", "0");

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::Ready,
            merge_method: None,
            update_method: None,
            request: 11,
        },
    )
    .await;
    let (kind, ok, message, _number) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Action);
    assert!(!ok, "a read-only account may not mark a pull request ready");
    let message = message.unwrap();
    assert!(
        message.contains("may not update") && message.contains("#61"),
        "the refusal names the missing permission and the pull request: {message}"
    );
    assert!(
        !gh_log(&rig.shim).contains("pr ready"),
        "a refused action must not reach gh"
    );

    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, false),
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::Ready,
            merge_method: None,
            update_method: None,
            request: 12,
        },
    )
    .await;
    let (kind, ok, message, number) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Action);
    assert!(ok, "an allowed action failed: {message:?}");
    assert_eq!(number, 61);
    assert!(
        gh_log(&rig.shim).contains("pr ready 61"),
        "the allowed action reached gh: {}",
        gh_log(&rig.shim)
    );
    match expect_pr_detail(&mut rig.ws).await {
        proto::ServerMsg::PrDetail { request, .. } => {
            assert_eq!(request, 12, "the pushed detail carries the action's id");
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }

    write_scenario(&rig.shim, "api-update-branch.exit", "0");
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::UpdateBranch,
            merge_method: None,
            update_method: Some(proto::PrUpdateMethod::Rebase),
            request: 13,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(ok, "update-branch failed: {message:?}");
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("update-branch") && log.contains("update_method=rebase"),
        "the REST update-branch carries the method: {log}"
    );
}

#[tokio::test]
async fn a_review_carries_its_drafts_and_an_author_may_not_approve() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, true),
    );
    write_scenario(&rig.shim, "api-review.exit", "0");

    let draft = proto::PrReviewDraft {
        path: "src/a.rs".into(),
        line: 12,
        side: proto::PrDiffSide::Right,
        body: "rename this".into(),
    };
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReview {
            dir: rig.dir.clone(),
            number: 61,
            verdict: proto::PrReviewVerdict::Approve,
            body: "lgtm".into(),
            comments: vec![draft.clone()],
            request: 21,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Review);
    assert!(!ok);
    assert!(
        message.unwrap().contains("author's own approval"),
        "an author's approval is refused in GitHub's own terms"
    );
    assert!(
        !gh_log(&rig.shim).contains("pulls/61/reviews"),
        "a refused review must not reach the reviews API"
    );

    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("READ", true, false),
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReview {
            dir: rig.dir.clone(),
            number: 61,
            verdict: proto::PrReviewVerdict::RequestChanges,
            body: "please fix the name".into(),
            comments: vec![draft],
            request: 22,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(ok, "the review failed: {message:?}");
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("--method POST") && log.contains("pulls/61/reviews"),
        "the whole review is one POST: {log}"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReview {
            dir: rig.dir.clone(),
            number: 61,
            verdict: proto::PrReviewVerdict::Comment,
            body: "x".repeat(60_001),
            comments: Vec::new(),
            request: 23,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    let message = message.unwrap();
    assert!(
        message.contains("60001 bytes") && message.contains("60000"),
        "an over-cap body names both numbers: {message}"
    );
}

#[tokio::test]
async fn comments_and_edits_reach_gh_and_their_bodies_are_capped() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "edit.exit", "0");
    write_scenario(&rig.shim, "comment.exit", "0");

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrEdit {
            dir: rig.dir.clone(),
            number: 61,
            title: Some("a better title".into()),
            body: Some("a better body".into()),
            request: 31,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Edit);
    assert!(ok, "the edit failed: {message:?}");
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("pr edit 61 --title a better title --body-file -"),
        "the edit names its fields and keeps the body off argv: {log}"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrComment {
            dir: rig.dir.clone(),
            number: 61,
            body: "a remark".into(),
            request: 32,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Comment);
    assert!(ok, "the comment failed: {message:?}");
    assert!(
        gh_log(&rig.shim).contains("pr comment 61 --body-file -"),
        "the comment body travels over stdin"
    );

    let before = gh_log(&rig.shim).matches("pr comment").count();
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrComment {
            dir: rig.dir.clone(),
            number: 61,
            body: "x".repeat(60_001),
            request: 33,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("60001 bytes"));
    assert_eq!(
        gh_log(&rig.shim).matches("pr comment").count(),
        before,
        "an over-cap comment never reaches gh"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrEdit {
            dir: rig.dir.clone(),
            number: 61,
            title: None,
            body: None,
            request: 34,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("title or a body"));
}

#[tokio::test]
async fn the_detail_carries_threads_reactions_reviewers_and_the_comparison() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-branch.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, false),
    );
    write_scenario(&rig.shim, "graphql-threads.json", THREADS_JSON);

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrDetail {
            dir: rig.dir.clone(),
            request: 41,
            number: None,
        },
    )
    .await;
    match expect_pr_detail(&mut rig.ws).await {
        proto::ServerMsg::PrDetail {
            detail: Some(detail),
            link: Some(link),
            ..
        } => {
            assert_eq!(link.number, 61);
            assert_eq!(detail.labels.len(), 1);
            assert_eq!(detail.labels[0].name, "bug");
            assert_eq!(detail.behind_by, Some(2));
            assert_eq!(detail.auto_merge_enabled, Some(true));
            assert_eq!(detail.auto_merge_method, Some(proto::PrMergeMethod::Squash));
            let viewer = detail.viewer.expect("permissions");
            assert!(viewer.can_write && viewer.can_update && viewer.can_update_branch);
            assert!(!viewer.did_author);
            assert_eq!(detail.threads.len(), 1);
            let thread = &detail.threads[0];
            assert_eq!(thread.id, "PRT_1");
            assert!(!thread.resolved);
            assert_eq!(thread.path.as_deref(), Some("src/a.rs"));
            assert_eq!(thread.line, Some(12));
            assert_eq!(thread.comments.len(), 1);
            assert_eq!(thread.comments[0].author, "rev");
            assert_eq!(thread.comments[0].body, "rename this");
            assert_eq!(detail.threads_message, None);
            assert_eq!(
                detail.comments[0].reactions,
                vec![proto::PrReactionCount {
                    content: proto::PrReaction::Heart,
                    count: 1,
                    reacted: false,
                }],
                "a comment's reactions come from the GraphQL page by node id"
            );
            assert_eq!(
                detail.reactions,
                vec![proto::PrReactionCount {
                    content: proto::PrReaction::ThumbsUp,
                    count: 3,
                    reacted: true,
                }]
            );
            let ids: Vec<(proto::PrReviewerKind, &str)> = detail
                .reviewers
                .iter()
                .map(|r| (r.kind, r.id.as_str()))
                .collect();
            assert!(ids.contains(&(proto::PrReviewerKind::User, "octo")));
            assert!(ids.contains(&(proto::PrReviewerKind::Team, "core")));
            assert!(ids.contains(&(proto::PrReviewerKind::User, "rev")));
        }
        other => panic!("expected an enriched pr_detail, got {other:?}"),
    }
}

#[tokio::test]
async fn a_browsed_number_reads_without_linking_and_a_failed_read_is_named() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-branch.json", &rich_json(61));

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrDetail {
            dir: rig.dir.clone(),
            request: 51,
            number: None,
        },
    )
    .await;
    match expect_pr_detail(&mut rig.ws).await {
        proto::ServerMsg::PrDetail {
            detail: Some(detail),
            ..
        } => {
            assert!(
                detail.viewer.is_none(),
                "an unreadable permission answer is not a permission"
            );
            let message = detail.viewer_message.expect("the failure must be named");
            assert!(
                message.contains("could not read what you may do"),
                "{message}"
            );
            let threads = detail.threads_message.expect("the degraded read is named");
            assert!(
                threads.contains("could not read the review threads"),
                "{threads}"
            );
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }

    write_scenario(&rig.shim, "view-62.json", &rich_json(62));
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrDetail {
            dir: rig.dir.clone(),
            request: 52,
            number: Some(62),
        },
    )
    .await;
    match expect_pr_detail(&mut rig.ws).await {
        proto::ServerMsg::PrDetail {
            link: Some(link),
            linked,
            ..
        } => {
            assert_eq!(link.number, 62);
            assert!(!linked, "viewing a number does not link it");
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrLink {
            dir: rig.dir.clone(),
            number: 62,
            request: 53,
        },
    )
    .await;
    let (ok, message) = expect_pr_linked(&mut rig.ws).await;
    assert!(ok, "the link failed: {message:?}");
    match expect_pr_detail(&mut rig.ws).await {
        proto::ServerMsg::PrDetail { linked, link, .. } => {
            assert!(linked);
            assert_eq!(link.unwrap().number, 62);
        }
        other => panic!("expected pr_detail, got {other:?}"),
    }
}

#[tokio::test]
async fn a_reaction_addresses_the_pull_request_and_refuses_a_foreign_subject() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-nodeid.json",
        r#"{"data":{"repository":{"pullRequest":{"id":"PR_kw"}}}}"#,
    );
    write_scenario(
        &rig.shim,
        "graphql-reaction.json",
        r#"{"data":{"addReaction":{"reaction":{"content":"THUMBS_UP"}}}}"#,
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReaction {
            dir: rig.dir.clone(),
            number: 61,
            subject_id: None,
            content: proto::PrReaction::ThumbsUp,
            reacted: true,
            request: 61,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Reaction);
    assert!(ok, "the reaction failed: {message:?}");
    let graphql = std::fs::read_to_string(rig.shim.join("graphql.log")).unwrap_or_default();
    assert!(
        graphql.contains("addReaction") && graphql.contains("PR_kw"),
        "the mutation addresses the pull request's own node id: {graphql}"
    );

    write_scenario(
        &rig.shim,
        "graphql-subject.json",
        r#"{"data":{"repository":{"pullRequest":{"id":"PR_kw"}},"node":{"id":"IC_other","pullRequest":{"id":"PR_other"}}}}"#,
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReaction {
            dir: rig.dir.clone(),
            number: 61,
            subject_id: Some("IC_other".into()),
            content: proto::PrReaction::Heart,
            reacted: true,
            request: 62,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(
        message.unwrap().contains("does not belong to PR #61"),
        "a foreign subject is refused by name"
    );
}

#[tokio::test]
async fn reviewers_and_labels_carry_current_values_and_their_sets() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, false),
    );
    write_scenario(&rig.shim, "graphql-reviewers.json", REVIEWERS_JSON);
    write_scenario(&rig.shim, "graphql-labels.json", LABELS_JSON);
    write_scenario(&rig.shim, "api-reviewers.exit", "0");
    write_scenario(&rig.shim, "api-labels.exit", "0");
    write_scenario(&rig.shim, "api-label-delete.exit", "0");

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReviewers {
            dir: rig.dir.clone(),
            number: 61,
            request: 71,
        },
    )
    .await;
    let (candidates, truncated, message) = expect_pr_reviewer_candidates(&mut rig.ws).await;
    assert_eq!(message, None);
    assert!(!truncated);
    let octo = candidates
        .iter()
        .find(|c| c.id == "octo")
        .expect("the requested reviewer is a candidate");
    assert!(octo.is_requested);
    let team = candidates
        .iter()
        .find(|c| c.id == "core")
        .expect("a requested team is a candidate");
    assert_eq!(team.kind, proto::PrReviewerKind::Team);
    assert!(team.is_requested);
    let mona = candidates
        .iter()
        .find(|c| c.id == "mona")
        .expect("an assignable user");
    assert!(!mona.is_requested);
    assert!(
        !candidates.iter().any(|c| c.id == "theo"),
        "the author is never offered for their own request"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrReviewerSet {
            dir: rig.dir.clone(),
            number: 61,
            reviewers: vec![proto::PrReviewer {
                id: "octo".into(),
                kind: proto::PrReviewerKind::User,
            }],
            requested: true,
            request: 72,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::ReviewerSet);
    assert!(ok, "the reviewer request failed: {message:?}");
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("--method POST") && log.contains("requested_reviewers"),
        "{log}"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrLabels {
            dir: rig.dir.clone(),
            number: 61,
            request: 73,
        },
    )
    .await;
    let (candidates, truncated, message) = expect_pr_label_candidates(&mut rig.ws).await;
    assert_eq!(message, None);
    assert!(!truncated);
    assert_eq!(
        candidates[0].name, "deleted",
        "an applied label GitHub no longer defines leads"
    );
    assert!(candidates[0].is_applied);
    let bug = candidates.iter().find(|c| c.name == "bug").expect("bug");
    assert!(bug.is_applied);
    assert_eq!(bug.color.as_deref(), Some("d73a4a"));
    assert!(
        !candidates
            .iter()
            .find(|c| c.name == "docs")
            .unwrap()
            .is_applied
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrLabelSet {
            dir: rig.dir.clone(),
            number: 61,
            labels: vec!["bug".into()],
            applied: true,
            request: 74,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::LabelSet);
    assert!(ok, "labelling failed: {message:?}");
    assert!(gh_log(&rig.shim).contains("issues/61/labels"));

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrLabelSet {
            dir: rig.dir.clone(),
            number: 61,
            labels: vec!["bug".into()],
            applied: false,
            request: 75,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(ok, "removing the label failed: {message:?}");
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("--method DELETE") && log.contains("labels/bug"),
        "a removal names the label in the path: {log}"
    );

    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("READ", true, false),
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrLabelSet {
            dir: rig.dir.clone(),
            number: 61,
            labels: vec!["docs".into()],
            applied: true,
            request: 76,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("triage access"));
}

#[tokio::test]
async fn a_listing_pages_by_limit_and_refuses_over_the_cap() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    let rows = r#"[
      {"number": 62, "title": "newer", "url": "https://github.com/owner/repo/pull/62",
       "author": {"login": "theo"}, "headRefName": "feat/y", "baseRefName": "main",
       "state": "OPEN", "isDraft": false, "reviewDecision": "APPROVED", "additions": 1,
       "deletions": 1, "updatedAt": "2026-09-02T00:00:00Z", "labels": [],
       "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS"}]},
      {"number": 61, "title": "older", "url": "https://github.com/owner/repo/pull/61",
       "author": {"login": "rev"}, "headRefName": "feat/x", "baseRefName": "main",
       "state": "MERGED", "isDraft": false, "mergedAt": "2026-09-01T00:00:00Z",
       "additions": 5, "deletions": 2, "updatedAt": "2026-09-01T00:00:00Z",
       "labels": [{"name": "bug", "color": "d73a4a"}]}
    ]"#;
    write_scenario(&rig.shim, "list.json", rows);

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrList {
            dir: rig.dir.clone(),
            state: proto::PrListState::Open,
            involvement: proto::PrListInvolvement::All,
            query: None,
            limit: 1,
            request: 81,
        },
    )
    .await;
    let (items, truncated, message) = expect_pr_list(&mut rig.ws).await;
    assert_eq!(message, None);
    assert_eq!(items.len(), 1, "the page carries exactly its limit");
    assert!(truncated, "one row over the page means more are there");
    assert_eq!(items[0].number, 62);
    assert_eq!(items[0].checks, Some(proto::PrChecks::Passing));
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("sort:updated-desc"),
        "the listing asks for the order the page reads: {log}"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrList {
            dir: rig.dir.clone(),
            state: proto::PrListState::Closed,
            involvement: proto::PrListInvolvement::Authored,
            query: Some("flaky test".into()),
            limit: 25,
            request: 82,
        },
    )
    .await;
    let _ = expect_pr_list(&mut rig.ws).await;
    let log = gh_log(&rig.shim);
    assert!(log.contains("--author @me"), "{log}");
    assert!(log.contains("is:unmerged"), "closed excludes merged: {log}");
    assert!(
        log.contains("flaky test"),
        "the reader's words ride the search: {log}"
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrList {
            dir: rig.dir.clone(),
            state: proto::PrListState::All,
            involvement: proto::PrListInvolvement::Reviewing,
            query: None,
            limit: 101,
            request: 83,
        },
    )
    .await;
    let (items, truncated, message) = expect_pr_list(&mut rig.ws).await;
    assert!(items.is_empty());
    assert!(!truncated);
    let message = message.expect("over the cap must be named");
    assert!(
        message.contains("1..=100") && message.contains("101"),
        "the cap, and the ask, are both named: {message}"
    );
}

#[tokio::test]
async fn the_remote_diff_is_capped_and_marked() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    write_scenario(&rig.shim, "diff.patch", patch);

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrDiff {
            dir: rig.dir.clone(),
            number: 61,
            request: 91,
        },
    )
    .await;
    let (got, truncated, message) = expect_pr_diff(&mut rig.ws).await;
    assert_eq!(message, None);
    assert_eq!(got, patch);
    assert!(!truncated);

    let huge = "x".repeat(600_000);
    write_scenario(&rig.shim, "diff.patch", &huge);
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrDiff {
            dir: rig.dir.clone(),
            number: 61,
            request: 92,
        },
    )
    .await;
    let (got, truncated, message) = expect_pr_diff(&mut rig.ws).await;
    assert_eq!(message, None);
    assert!(truncated, "a patch past the cap says so");
    assert_eq!(got.len(), 512 * 1024);
}

#[tokio::test]
async fn revert_and_workflow_approval_are_composed_safely() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &cross_repo_json());
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, false),
    );
    write_scenario(
        &rig.shim,
        "runs.json",
        r#"[{"databaseId":7,"workflowName":"ci","url":"https://x/run/7"}]"#,
    );
    write_scenario(&rig.shim, "api-approve.exit", "0");

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::ApproveWorkflows,
            merge_method: None,
            update_method: None,
            request: 101,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Action);
    assert!(ok, "approval failed: {message:?}");
    assert!(
        message.unwrap().contains("approved 1 workflow run"),
        "the success names what was approved"
    );
    let log = gh_log(&rig.shim);
    assert!(
        log.contains(&format!("run list --commit {HEAD_SHA}")),
        "approval lists runs on the exact head: {log}"
    );
    assert!(
        log.contains("actions/runs/7/approve"),
        "the listed run is the one approved: {log}"
    );

    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::ApproveWorkflows,
            merge_method: None,
            update_method: None,
            request: 102,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(
        message.unwrap().contains("cross-repository"),
        "a same-repository head has no fork runs to approve"
    );

    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-nodeid.json",
        r#"{"data":{"repository":{"pullRequest":{"id":"PR_kw"}}}}"#,
    );
    write_scenario(
        &rig.shim,
        "graphql-revert.json",
        r#"{"data":{"revertPullRequest":{"revertPullRequest":{"number":63,"url":"https://github.com/owner/repo/pull/63"}}}}"#,
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrAction {
            dir: rig.dir.clone(),
            number: 61,
            action: proto::PrAction::Revert,
            merge_method: None,
            update_method: None,
            request: 103,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(ok, "the revert failed: {message:?}");
    assert!(
        message.unwrap().contains("#63"),
        "the revert names the pull request it opened"
    );
}

#[tokio::test]
async fn a_stack_is_read_and_merged_only_with_the_heads_the_user_saw() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(&rig.shim, "view-61.json", &rich_json(61));
    write_scenario(
        &rig.shim,
        "graphql-access.json",
        &access_json("WRITE", true, false),
    );
    let stack_json = format!(
        r#"[{{"number": 5, "node_id": "ST_1", "html_url": "https://github.com/owner/repo/stacks/5",
        "base": {{"ref": "main"}},
        "pull_requests": [
          {{"number": 61, "title": "a change", "draft": false,
           "head": {{"sha": "{HEAD_SHA}", "ref": "feat/x"}}, "state": "open"}},
          {{"number": 62, "title": "the next one", "draft": false,
           "head": {{"sha": "{HEAD_SHA}", "ref": "feat/y"}}, "state": "open"}}
        ]}}]"#
    );
    write_scenario(&rig.shim, "api-stack.json", &stack_json);
    write_scenario(
        &rig.shim,
        "api-stack-merge.out",
        r#"{"status":"merged","details":{}}"#,
    );

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStack {
            dir: rig.dir.clone(),
            number: 61,
            request: 111,
        },
    )
    .await;
    let stack = loop {
        match next_control(&mut rig.ws).await {
            proto::ServerMsg::PrStack {
                request,
                stack,
                message,
                ..
            } => {
                assert_eq!(request, 111);
                assert_eq!(message, None);
                break stack.expect("a stack");
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    };
    assert_eq!(stack.number, 5);
    assert_eq!(stack.id, "ST_1");
    assert_eq!(stack.base, "main");
    assert_eq!(stack.layers.len(), 2);
    assert_eq!(stack.layers[1].number, 62);
    assert_eq!(stack.layers[1].title.as_deref(), Some("the next one"));

    // A head the user never saw refuses before GitHub is asked to merge.
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStackMerge {
            dir: rig.dir.clone(),
            number: 61,
            stack_number: 5,
            heads: vec![proto::PrStackHead {
                number: 61,
                head_sha: STALE_SHA.into(),
            }],
            merge_method: Some(proto::PrMergeMethod::Squash),
            request: 112,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(
        message.unwrap().contains("changed since it was read"),
        "a stale stack read refuses by name"
    );
    assert!(
        !gh_log(&rig.shim).contains("merge-async"),
        "a refused stack merge never reaches the endpoint"
    );

    // Only the layers a merge of #61 would take are pinned: #62 is above it.
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStackMerge {
            dir: rig.dir.clone(),
            number: 61,
            stack_number: 5,
            heads: vec![
                proto::PrStackHead {
                    number: 61,
                    head_sha: HEAD_SHA.into(),
                },
                proto::PrStackHead {
                    number: 62,
                    head_sha: HEAD_SHA.into(),
                },
            ],
            merge_method: Some(proto::PrMergeMethod::Squash),
            request: 1131,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok, "an extra layer head is not the set this merge takes");
    assert!(message.unwrap().contains("changed since it was read"));

    let heads = vec![proto::PrStackHead {
        number: 61,
        head_sha: HEAD_SHA.into(),
    }];
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStackMerge {
            dir: rig.dir.clone(),
            number: 61,
            stack_number: 5,
            heads: heads.clone(),
            merge_method: Some(proto::PrMergeMethod::Squash),
            request: 113,
        },
    )
    .await;
    let (kind, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert_eq!(kind, proto::PrMutationKind::Action);
    assert!(ok, "the stack merge failed: {message:?}");
    assert!(message.unwrap().contains("stack #5 merged to PR #61"));
    let log = gh_log(&rig.shim);
    assert!(
        log.contains("--method PUT") && log.contains("merge-async"),
        "{log}"
    );
    assert!(
        log.contains(&format!("sha={HEAD_SHA}")) && log.contains("merge_method=squash"),
        "the merge pins the target head and the method: {log}"
    );

    // A stack number that moved is refused, not merged onto another stack.
    write_scenario(
        &rig.shim,
        "api-stack.json",
        &stack_json.replacen("\"number\": 5", "\"number\": 6", 1),
    );
    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStackMerge {
            dir: rig.dir.clone(),
            number: 61,
            stack_number: 5,
            heads,
            merge_method: None,
            request: 114,
        },
    )
    .await;
    let (_, ok, message, _) = expect_pr_mutation(&mut rig.ws).await;
    assert!(!ok);
    assert!(message.unwrap().contains("changed from #5 to #6"));
}

#[tokio::test]
async fn a_host_without_the_stacks_preview_answers_no_stack() {
    let _serial = SERIAL.lock().await;
    let mut rig = rig().await;
    write_scenario(
        &rig.shim,
        "api-stack.err",
        "HTTP 404: Not Found (https://api.github.com/repos/owner/repo/stacks?pull_request=61)",
    );
    write_scenario(&rig.shim, "api-stack.exit", "1");

    send(
        &mut rig.ws,
        &proto::ClientMsg::PrStack {
            dir: rig.dir.clone(),
            number: 61,
            request: 121,
        },
    )
    .await;
    loop {
        match next_control(&mut rig.ws).await {
            proto::ServerMsg::PrStack {
                request,
                stack,
                message,
                ..
            } => {
                assert_eq!(request, 121);
                assert!(stack.is_none());
                assert_eq!(
                    message, None,
                    "a 404 is `not stacked`, not a read failure to show"
                );
                break;
            }
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

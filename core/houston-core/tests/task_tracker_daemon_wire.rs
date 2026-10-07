#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::{connect_and_hello, next_control, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_core::db::{Db, TaskRunWrite, TaskWrite};
use houston_protocol as proto;
use std::os::unix::fs::PermissionsExt;
use tokio_tungstenite::tungstenite::Message;

static PROCESS_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct RestorePath(Option<std::ffi::OsString>);

impl Drop for RestorePath {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            std::env::set_var("PATH", path);
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn tracker_settings(workspace: &str) -> proto::TaskTrackerWorkspaceSettings {
    proto::TaskTrackerWorkspaceSettings {
        workspace: workspace.to_string(),
        provider: proto::TaskTrackerProvider::GithubIssues,
        enabled: true,
        github_repository: Some("fixture-owner/fixture-repo".into()),
        github_label: Some("houston".into()),
        github_assigned_user: None,
        notion_data_source_id: None,
        notion_title_property_id: None,
        notion_description_property_id: None,
        notion_status_property_id: None,
        notion_assignee_property_id: None,
        notion_project_relation_property_id: None,
        notion_assignee_user_id: None,
        notion_active_status_values: Vec::new(),
        notion_projects_data_source_id: None,
        notion_project_title_property_id: None,
        notion_project_description_property_id: None,
        notion_pr_url_property_id: None,
        notion_status_mapping: proto::TaskTrackerStatusMapping {
            todo: None,
            in_progress: None,
            in_review: None,
            done: None,
            canceled: None,
        },
        has_credential: false,
        last_sync_at_ms: None,
        last_error: None,
    }
}

async fn send(ws: &mut common::WsStream, message: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(message).unwrap()))
        .await
        .unwrap();
}

async fn task_snapshot(ws: &mut common::WsStream, workspace: &str) -> Vec<proto::TaskSummary> {
    send(
        ws,
        &proto::ClientMsg::TaskSnapshot {
            scope: workspace.to_string(),
        },
    )
    .await;
    loop {
        match next_control(ws).await {
            proto::ServerMsg::TaskSnapshot { tasks, .. } => return tasks,
            _ => continue,
        }
    }
}

#[tokio::test]
async fn tracker_wire_sync_imports_once_reuses_etag_and_keeps_tasks_after_api_failure() {
    let _env_guard = PROCESS_ENV.lock().await;
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace_dir = tempfile::tempdir().unwrap();
    let git_init = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace_dir.path())
        .status()
        .unwrap();
    assert!(
        git_init.success(),
        "could not initialize temporary Git workspace"
    );
    let workspace = workspace_dir.path().display().to_string();
    daemon.workspace_add(&workspace).unwrap();

    let bin = state.path().join("fake-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let mode_file = state.path().join("gh-mode");
    std::fs::write(&mode_file, "ok").unwrap();
    let call_log = state.path().join("gh-calls");
    let gh = bin.join("gh");
    std::fs::write(
        &gh,
        format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
mode=$(cat '{}')
case "$mode" in
  fail)
    printf 'HTTP/2 503 Service Unavailable\r\ncontent-type: application/json\r\n\r\n{{"message":"fixture tracker unavailable"}}\n'
    ;;
  ok)
    case "$*" in
      *If-None-Match:*fixture-etag*)
        printf 'HTTP/2 304 Not Modified\r\netag: "fixture-etag"\r\n\r\n'
        ;;
      *)
        printf 'HTTP/2 200 OK\r\netag: "fixture-etag"\r\ncontent-type: application/json\r\n\r\n[{{"number":41,"title":"Imported delivery","body":"Remote task body","html_url":"https://github.com/fixture-owner/fixture-repo/issues/41","updated_at":"2026-10-07T00:00:00Z","state":"open","labels":["houston"],"assignee":null,"assignees":[],"milestone":{{"number":7,"title":"Release project","description":"Milestone description","html_url":"https://github.com/fixture-owner/fixture-repo/milestone/7"}},"pull_request":null}}]\n'
        ;;
    esac
    ;;
esac
"#,
            call_log.display(),
            mode_file.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let _restore_path = RestorePath(Some(original_path.clone()));
    std::env::set_var(
        "PATH",
        std::env::join_paths(
            std::iter::once(bin.clone()).chain(std::env::split_paths(&original_path)),
        )
        .unwrap(),
    );

    let mut ws = connect_and_hello(addr, TOKEN).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskTrackerSettingsSet {
            settings: Box::new(tracker_settings(&workspace)),
        },
    )
    .await;
    assert!(matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::TaskTrackerSettings { refusal: None, .. }
    ));

    for _ in 0..2 {
        send(
            &mut ws,
            &proto::ClientMsg::TaskTrackerSyncNow {
                workspace: workspace.clone(),
            },
        )
        .await;
        assert!(matches!(
            next_control(&mut ws).await,
            proto::ServerMsg::TaskTrackerSyncState { error: None, .. }
        ));
    }

    let tasks = task_snapshot(&mut ws, &workspace).await;
    assert_eq!(tasks.len(), 1, "remote issue should import once: {tasks:?}");
    assert_eq!(tasks[0].title, "Imported delivery");
    assert!(
        tasks[0].open_run.is_none(),
        "tracker import must not launch an agent"
    );
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainGet { id: tasks[0].id },
    )
    .await;
    let domain = loop {
        if let proto::ServerMsg::TaskDomainState { domain, .. } = next_control(&mut ws).await {
            break domain;
        }
    };
    assert_eq!(domain.kind, proto::TaskDomainKind::Delivery);

    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectsList {
            workspace: workspace.clone(),
        },
    )
    .await;
    let projects = loop {
        if let proto::ServerMsg::TaskProjectsState { projects, .. } = next_control(&mut ws).await {
            break projects;
        }
    };
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].name, "Release project");
    assert_eq!(
        projects[0].project_external_id.as_deref(),
        Some("github_issues:fixture-owner/fixture-repo:milestone:7")
    );

    let calls = std::fs::read_to_string(&call_log).unwrap();
    assert_eq!(calls.lines().count(), 2);
    assert!(
        calls
            .lines()
            .nth(1)
            .unwrap()
            .contains("If-None-Match: \"fixture-etag\""),
        "second sync did not reuse the saved ETag: {calls}"
    );

    std::fs::write(&mode_file, "fail").unwrap();
    send(
        &mut ws,
        &proto::ClientMsg::TaskTrackerSyncNow {
            workspace: workspace.clone(),
        },
    )
    .await;
    match next_control(&mut ws).await {
        proto::ServerMsg::TaskTrackerSyncState {
            error: Some(error), ..
        } => {
            assert!(error.contains("fixture tracker unavailable"), "{error}");
        }
        other => panic!("API failure should be visible in sync state, got {other:?}"),
    }
    assert_eq!(task_snapshot(&mut ws, &workspace).await.len(), 1);

    std::fs::write(&mode_file, "ok").unwrap();
    send(
        &mut ws,
        &proto::ClientMsg::TaskTrackerSyncNow {
            workspace: workspace.clone(),
        },
    )
    .await;
    assert!(matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::TaskTrackerSyncState { error: None, .. }
    ));
    assert_eq!(task_snapshot(&mut ws, &workspace).await.len(), 1);
    let calls = std::fs::read_to_string(&call_log).unwrap();
    assert!(
        calls
            .lines()
            .nth(3)
            .unwrap()
            .contains("If-None-Match: \"fixture-etag\""),
        "retry did not preserve the prior cursor ETag: {calls}"
    );
}

#[tokio::test]
async fn tracker_loop_keeps_sibling_pull_request_comments_and_links_distinct() {
    let _env_guard = PROCESS_ENV.lock().await;
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let workspace_dir = tempfile::tempdir().unwrap();
    let git_init = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace_dir.path())
        .status()
        .unwrap();
    assert!(
        git_init.success(),
        "could not initialize temporary Git workspace"
    );
    let workspace = workspace_dir.path().display().to_string();
    daemon.workspace_add(&workspace).unwrap();
    daemon
        .task_tracker_settings_set(tracker_settings(&workspace))
        .await
        .unwrap();

    // Integration tests cannot access Daemon::db(), which is crate-private.
    let db = Db::open(&state.path().join("test.db")).unwrap();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let delivery_id = db
        .create_task(&TaskWrite {
            workspace: Some(&workspace),
            title: "Delivery issue 41",
            description: "Source delivery",
            status: proto::TaskStatus::InProgress,
            priority: proto::TaskPriority::None,
            parent_id: None,
            ref_url: None,
            created_by: "test",
            now_ms,
            acceptance: &[],
        })
        .unwrap()
        .id;
    assert!(db
        .save_task_domain(
            delivery_id,
            1,
            false,
            proto::TaskDomainKind::Delivery,
            None,
            now_ms,
        )
        .unwrap());
    db.task_external_link_upsert(&proto::TaskExternalLink {
        task_id: delivery_id,
        provider: proto::TaskTrackerProvider::GithubIssues,
        external_id: "fixture-owner/fixture-repo#41".into(),
        url: "https://github.com/fixture-owner/fixture-repo/issues/41".into(),
        fetched_at_ms: None,
        body_hash: None,
        remote_rev: None,
        synced_at_ms: None,
        source: proto::TaskExternalLinkSource::Source,
        snapshot: proto::TaskTrackerSnapshot {
            base: Default::default(),
            local: Default::default(),
            remote: Default::default(),
            conflicts: vec![],
            revision: 1,
            project_external_id: None,
            project: None,
        },
        sync_state: proto::TaskTrackerSyncState::Current,
    })
    .unwrap();

    let mut slices = Vec::new();
    for (number, pull_url) in [
        (1, "https://github.com/fixture-owner/fixture-repo/pull/9"),
        (2, "https://github.com/fixture-owner/fixture-repo/pull/10"),
    ] {
        let task_id = db
            .create_task(&TaskWrite {
                workspace: Some(&workspace),
                title: &format!("Slice {number}"),
                description: "Sibling slice",
                status: proto::TaskStatus::InProgress,
                priority: proto::TaskPriority::None,
                parent_id: Some(delivery_id),
                ref_url: None,
                created_by: "test",
                now_ms,
                acceptance: &[],
            })
            .unwrap()
            .id;
        assert!(db
            .save_task_domain(
                task_id,
                1,
                false,
                proto::TaskDomainKind::Slice,
                None,
                now_ms,
            )
            .unwrap());
        let task = db.task(task_id).unwrap().unwrap();
        let run = db
            .create_task_run(&TaskRunWrite {
                task_id,
                kind: proto::TaskRunKind::Implementation,
                state: proto::TaskRunState::HandedBack,
                provider: proto::AgentKind::Codex,
                reviewer: None,
                session_id: None,
                delegation_id: None,
                worktree_path: None,
                branch: None,
                base_commit: None,
                initial_revision: task.revision,
                started_at_ms: now_ms,
            })
            .unwrap();
        db.task_run_set_pr_url(run.id, Some(pull_url)).unwrap();
        db.task_run_set_summary(run.id, "Same handback summary")
            .unwrap();
        db.enqueue_task_tracker_action(task_id, "handed_back", task.revision, now_ms)
            .unwrap();
        slices.push((task_id, task.revision, pull_url));
    }
    assert_eq!(
        slices[0].1, slices[1].1,
        "fixture slices need equal revisions"
    );

    let bin = state.path().join("fake-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let comments_file = state.path().join("comments");
    std::fs::write(&comments_file, "").unwrap();
    let gh = bin.join("gh");
    std::fs::write(
        &gh,
        format!(
            r#"#!/bin/sh
case "$*" in
  *'repos/fixture-owner/fixture-repo/issues/41/comments?per_page='*)
    python3 -c 'import json,sys; print("HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n" + json.dumps([{{"body": json.loads(line)}} for line in open(sys.argv[1])]))' '{}'
    ;;
  *'--method POST'*'repos/fixture-owner/fixture-repo/issues/41/comments'*)
    body=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--field" ]; then
        shift
        case "$1" in body=*) body=${{1#body=}} ;; esac
      fi
      shift
    done
    python3 -c 'import json,sys; open(sys.argv[1], "a").write(json.dumps(sys.argv[2]) + "\n")' '{}' "$body"
    printf 'HTTP/2 201 Created\r\ncontent-type: application/json\r\n\r\n{{"number":41,"html_url":"https://github.com/fixture-owner/fixture-repo/issues/41"}}\n'
    ;;
  *'repos/fixture-owner/fixture-repo/issues?'*)
    printf 'HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n[]\n'
    ;;
  *)
    printf 'HTTP/2 500 Unexpected fixture request\r\ncontent-type: application/json\r\n\r\n{{"message":"unexpected fake gh request"}}\n'
    exit 1
    ;;
esac
"#,
            comments_file.display(),
            comments_file.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let _restore_path = RestorePath(Some(original_path.clone()));
    std::env::set_var(
        "PATH",
        std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(&original_path)))
            .unwrap(),
    );

    let tracker_loop = tokio::spawn(daemon.clone().task_tracker_loop());
    let _abort_tracker_loop = AbortOnDrop(tracker_loop);
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            let pending = db.task_tracker_outbox_pending(i64::MAX, 10).unwrap();
            let comments = std::fs::read_to_string(&comments_file).unwrap();
            let pr_comment_count = comments
                .lines()
                .filter_map(|line| serde_json::from_str::<String>(line).ok())
                .filter(|comment| comment.contains(":pr_reference -->"))
                .count();
            if pending.is_empty() && pr_comment_count == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("daemon tracker loop did not deliver both pull request references");

    for (task_id, _, pull_url) in &slices {
        let links = db.task_external_links(*task_id).unwrap();
        assert_eq!(
            links.len(),
            1,
            "slice should have only its PR link: {links:?}"
        );
        assert_eq!(links[0].source, proto::TaskExternalLinkSource::PullRequest);
        assert_eq!(links[0].url, *pull_url);
        assert_ne!(
            links[0].url,
            "https://github.com/fixture-owner/fixture-repo/issues/41"
        );
    }
    let delivery_links = db.task_external_links(delivery_id).unwrap();
    assert_eq!(
        delivery_links.len(),
        1,
        "delivery should retain only its source issue"
    );
    assert_eq!(
        delivery_links[0].source,
        proto::TaskExternalLinkSource::Source
    );
    assert_eq!(
        delivery_links[0].url,
        "https://github.com/fixture-owner/fixture-repo/issues/41"
    );
    let comments = std::fs::read_to_string(&comments_file)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<String>(line).unwrap())
        .collect::<Vec<_>>();
    let namespace = db.task_tracker_database_namespace().unwrap();
    let pr_comments = comments
        .iter()
        .filter(|comment| comment.contains(":pr_reference -->"))
        .collect::<Vec<_>>();
    assert_eq!(
        pr_comments.len(),
        2,
        "both PR comments should persist: {comments:?}"
    );
    for (task_id, revision, pull_url) in &slices {
        let marker = format!(
            "<!-- houston-task:houston-task-{namespace}-{task_id}:{revision}:pr_reference -->"
        );
        assert!(
            pr_comments.iter().any(|comment| comment.contains(&marker)),
            "missing PR reference comment marker {marker}"
        );
        assert!(
            pr_comments.iter().any(|comment| comment.contains(pull_url)),
            "missing PR reference URL {pull_url}"
        );
    }
}

mod common;

use common::{connect_and_hello, start_daemon_with_handle, TOKEN};
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

async fn send(ws: &mut common::WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn task_reply(ws: &mut common::WsStream) -> proto::ServerMsg {
    loop {
        let msg = common::next_control(ws).await;
        if matches!(
            msg,
            proto::ServerMsg::TaskChanged { .. }
                | proto::ServerMsg::TaskDetail { .. }
                | proto::ServerMsg::TaskDomainState { .. }
                | proto::ServerMsg::TaskProjectState { .. }
                | proto::ServerMsg::TaskProjectsState { .. }
                | proto::ServerMsg::TaskProjectChanged { .. }
                | proto::ServerMsg::TaskRefused { .. }
        ) {
            return msg;
        }
    }
}

async fn create(
    ws: &mut common::WsStream,
    workspace: &str,
    title: &str,
    parent_id: Option<i64>,
) -> i64 {
    send(
        ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.to_string()),
            id: None,
            expected_revision: None,
            patch: proto::TaskPatch {
                title: Some(title.to_string()),
                acceptance: Some(vec!["observable outcome exists".into()]),
                parent_id: Some(parent_id),
                ..Default::default()
            },
        },
    )
    .await;
    match task_reply(ws).await {
        proto::ServerMsg::TaskChanged { id, .. } => id,
        other => panic!("expected task creation, got {other:?}"),
    }
}

async fn create_without_acceptance(ws: &mut common::WsStream, workspace: &str) -> i64 {
    send(
        ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.to_string()),
            id: None,
            expected_revision: None,
            patch: proto::TaskPatch {
                title: Some("Unready task".into()),
                acceptance: Some(Vec::new()),
                ..Default::default()
            },
        },
    )
    .await;
    match task_reply(ws).await {
        proto::ServerMsg::TaskChanged { id, .. } => id,
        other => panic!("expected task creation, got {other:?}"),
    }
}

async fn status(ws: &mut common::WsStream, id: i64) -> proto::TaskStatus {
    send(ws, &proto::ClientMsg::TaskGet { id }).await;
    loop {
        if let proto::ServerMsg::TaskDetail { task, .. } = common::next_control(ws).await {
            if task.id == id {
                return task.status;
            }
        }
    }
}

async fn set_status(ws: &mut common::WsStream, workspace: &str, id: i64, next: proto::TaskStatus) {
    send(ws, &proto::ClientMsg::TaskGet { id }).await;
    let task = loop {
        if let proto::ServerMsg::TaskDetail { task, .. } = common::next_control(ws).await {
            if task.id == id {
                break task;
            }
        }
    };
    send(
        ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.to_string()),
            id: Some(id),
            expected_revision: Some(task.revision),
            patch: proto::TaskPatch {
                status: Some(next),
                ..Default::default()
            },
        },
    )
    .await;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::TaskChanged { id: changed, .. } if changed == id => break,
            proto::ServerMsg::TaskRefused { .. } => panic!("status update was refused"),
            _ => {}
        }
    }
}

fn workspace(state: &std::path::Path) -> String {
    let dir = state.join("project");
    std::fs::create_dir_all(&dir).unwrap();
    dir.display().to_string()
}

#[tokio::test]
async fn project_metadata_and_blocked_by_cycles_are_visible_over_wire() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;

    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectSave {
            workspace: workspace.clone(),
            id: None,
            expected_revision: None,
            name: "Houston project".into(),
            external_url: Some(Some("https://tracker.invalid/project/1".into())),
            tracker_description: Some(Some("Imported context; unverified".into())),
            local_decisions: Some(vec!["Keep the daemon local-first".into()]),
        },
    )
    .await;
    let project_id = match task_reply(&mut ws).await {
        proto::ServerMsg::TaskProjectChanged {
            id, revision: 1, ..
        } => id,
        other => panic!("expected the saved Project, got {other:?}"),
    };
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectGet { id: project_id },
    )
    .await;
    let proto::ServerMsg::TaskProjectState {
        project: Some(project),
    } = task_reply(&mut ws).await
    else {
        panic!("expected the saved Project");
    };
    assert_eq!(project.name, "Houston project");
    assert_eq!(
        project.tracker_description.as_deref(),
        Some("Imported context; unverified")
    );
    assert_eq!(project.local_decisions, ["Keep the daemon local-first"]);
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectSave {
            workspace: workspace.clone(),
            id: None,
            expected_revision: None,
            name: "Second initiative".into(),
            external_url: None,
            tracker_description: None,
            local_decisions: Some(Vec::new()),
        },
    )
    .await;
    let second_project_id = match task_reply(&mut ws).await {
        proto::ServerMsg::TaskProjectChanged { id, .. } => id,
        other => panic!("expected second Project, got {other:?}"),
    };
    assert_ne!(project_id, second_project_id);
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectArchive {
            id: project_id,
            archived: true,
            expected_revision: 1,
        },
    )
    .await;
    assert!(matches!(
        task_reply(&mut ws).await,
        proto::ServerMsg::TaskProjectChanged { revision: 2, .. }
    ));
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectsList {
            workspace: workspace.clone(),
        },
    )
    .await;
    let proto::ServerMsg::TaskProjectsState { projects, .. } = task_reply(&mut ws).await else {
        panic!("expected Project list");
    };
    assert_eq!(projects.len(), 2);
    assert!(projects
        .iter()
        .find(|p| p.id == project_id)
        .unwrap()
        .archived_at_ms
        .is_some());
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectArchive {
            id: project_id,
            archived: false,
            expected_revision: 2,
        },
    )
    .await;
    assert!(matches!(
        task_reply(&mut ws).await,
        proto::ServerMsg::TaskProjectChanged { revision: 3, .. }
    ));

    let delivery = create(&mut ws, &workspace, "Delivery", None).await;
    let slice = create(&mut ws, &workspace, "Slice", Some(delivery)).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: delivery,
            expected_revision: 1,
            kind: Some(proto::TaskDomainKind::Delivery),
            project_id: Some(Some(project_id)),
            blocked_by: None,
        },
    )
    .await;
    let _ = task_reply(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: slice,
            expected_revision: 1,
            kind: Some(proto::TaskDomainKind::Slice),
            project_id: Some(Some(project_id)),
            blocked_by: Some(vec![delivery]),
        },
    )
    .await;
    let _ = task_reply(&mut ws).await;
    send(&mut ws, &proto::ClientMsg::TaskDomainGet { id: slice }).await;
    let proto::ServerMsg::TaskDomainState { domain } = task_reply(&mut ws).await else {
        panic!("expected task domain state");
    };
    assert_eq!(domain.kind, proto::TaskDomainKind::Slice);
    assert_eq!(domain.delivery_id, Some(delivery));
    assert_eq!(domain.blocked_by, [delivery]);

    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: delivery,
            expected_revision: 2,
            kind: None,
            project_id: None,
            blocked_by: Some(vec![slice]),
        },
    )
    .await;
    assert!(matches!(
        task_reply(&mut ws).await,
        proto::ServerMsg::TaskRefused { .. }
    ));
}

#[tokio::test]
async fn delivery_rollup_tracks_slice_status_and_ignores_non_slice_children() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskProjectSave {
            workspace: workspace.clone(),
            id: None,
            expected_revision: None,
            name: "Initiative".into(),
            external_url: None,
            tracker_description: None,
            local_decisions: Some(Vec::new()),
        },
    )
    .await;
    let project_id = match task_reply(&mut ws).await {
        proto::ServerMsg::TaskProjectChanged { id, .. } => id,
        other => panic!("expected Project create, got {other:?}"),
    };
    let delivery = create(&mut ws, &workspace, "Delivery", None).await;
    let slice = create(&mut ws, &workspace, "Slice", Some(delivery)).await;
    let ordinary_child = create(&mut ws, &workspace, "Ordinary child", Some(delivery)).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: delivery,
            expected_revision: 1,
            kind: Some(proto::TaskDomainKind::Delivery),
            project_id: Some(Some(project_id)),
            blocked_by: None,
        },
    )
    .await;
    let _ = task_reply(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: slice,
            expected_revision: 1,
            kind: Some(proto::TaskDomainKind::Slice),
            project_id: Some(Some(project_id)),
            blocked_by: None,
        },
    )
    .await;
    let _ = task_reply(&mut ws).await;
    send(&mut ws, &proto::ClientMsg::TaskDomainGet { id: delivery }).await;
    let proto::ServerMsg::TaskDomainState { domain } = task_reply(&mut ws).await else {
        panic!("expected Delivery domain");
    };
    assert_eq!((domain.slice_total, domain.slice_done), (1, 0));
    send(
        &mut ws,
        &proto::ClientMsg::TaskDomainSave {
            id: slice,
            expected_revision: 2,
            kind: None,
            project_id: None,
            blocked_by: Some(vec![ordinary_child]),
        },
    )
    .await;
    let _ = task_reply(&mut ws).await;
    send(&mut ws, &proto::ClientMsg::TaskDomainGet { id: delivery }).await;
    let proto::ServerMsg::TaskDomainState { domain } = task_reply(&mut ws).await else {
        panic!("expected blocked Delivery readiness");
    };
    assert!(domain
        .readiness
        .reasons
        .iter()
        .any(|reason| reason == "delivery has 1 blocked Slice(s)"));

    set_status(&mut ws, &workspace, slice, proto::TaskStatus::Done).await;
    assert_eq!(status(&mut ws, delivery).await, proto::TaskStatus::Done);
    set_status(&mut ws, &workspace, slice, proto::TaskStatus::InProgress).await;
    assert_eq!(
        status(&mut ws, delivery).await,
        proto::TaskStatus::InProgress
    );
    set_status(&mut ws, &workspace, slice, proto::TaskStatus::InReview).await;
    assert_eq!(status(&mut ws, delivery).await, proto::TaskStatus::InReview);
    set_status(&mut ws, &workspace, slice, proto::TaskStatus::Todo).await;
    assert_eq!(status(&mut ws, delivery).await, proto::TaskStatus::Todo);
    assert_eq!(
        status(&mut ws, ordinary_child).await,
        proto::TaskStatus::Backlog
    );

    set_status(&mut ws, &workspace, delivery, proto::TaskStatus::Done).await;
    set_status(&mut ws, &workspace, slice, proto::TaskStatus::InProgress).await;
    assert_eq!(
        status(&mut ws, delivery).await,
        proto::TaskStatus::Done,
        "a user's explicit Delivery status remains authoritative"
    );
}

#[tokio::test]
async fn existing_tasks_without_domain_metadata_use_readiness_without_project_requirement() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let task = create(&mut ws, &workspace, "Existing task", None).await;
    send(&mut ws, &proto::ClientMsg::TaskDomainGet { id: task }).await;
    let proto::ServerMsg::TaskDomainState { domain } = task_reply(&mut ws).await else {
        panic!("expected task domain readiness");
    };
    assert!(
        domain.readiness.ready,
        "existing task with acceptance should not require new Project metadata: {:?}",
        domain.readiness.reasons
    );
    assert_eq!(domain.project_id, None);
}

#[tokio::test]
async fn manual_start_requires_readiness_unless_override_is_explicit() {
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace = workspace(state.path());
    daemon.workspace_add(&workspace).unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let task = create_without_acceptance(&mut ws, &workspace).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskStart {
            workspace: None,
            id: task,
            agent: proto::AgentKind::Custom,
            base: None,
            override_readiness: false,
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { message, .. } = task_reply(&mut ws).await else {
        panic!("an unready task must be refused before launch");
    };
    assert!(message.contains("verifiable acceptance"));

    send(
        &mut ws,
        &proto::ClientMsg::TaskStart {
            workspace: None,
            id: task,
            agent: proto::AgentKind::Custom,
            base: None,
            override_readiness: true,
        },
    )
    .await;
    let proto::ServerMsg::TaskRefused { message, .. } = task_reply(&mut ws).await else {
        panic!("Custom is not a spawnable agent");
    };
    assert!(
        message.contains("provider Custom"),
        "explicit override should bypass readiness only: {message}"
    );
}

#[tokio::test]
async fn plan_submission_is_rejected_without_a_recorded_planning_session() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let response = daemon
        .task_plan_submit(
            0,
            proto::TaskPlanProposal {
                description: "A typed proposal".into(),
                acceptance: vec!["The result is observable".into()],
                pointers: Vec::new(),
                out_of_scope: Vec::new(),
                questions: Vec::new(),
            },
        )
        .unwrap();
    assert!(matches!(response, proto::ServerMsg::TaskRefused { .. }));
}

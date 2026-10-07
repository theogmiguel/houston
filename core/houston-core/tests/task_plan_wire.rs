#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::{connect_and_hello, start_daemon_with_handle, WsStream, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

static PROCESS_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn send(ws: &mut WsStream, message: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(message).unwrap()))
        .await
        .unwrap();
}

async fn create_task(ws: &mut WsStream, workspace: &str, title: &str, acceptance: &[&str]) -> i64 {
    send(
        ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.to_string()),
            id: None,
            expected_revision: None,
            patch: proto::TaskPatch {
                title: Some(title.to_string()),
                description: Some(format!("Description for {title}")),
                acceptance: Some(acceptance.iter().map(|item| item.to_string()).collect()),
                ..Default::default()
            },
        },
    )
    .await;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::TaskChanged { id, .. } => return id,
            proto::ServerMsg::TaskRefused { message, .. } => {
                panic!("task creation refused: {message}")
            }
            _ => {}
        }
    }
}

async fn plan_started(ws: &mut WsStream, task_id: i64) -> u32 {
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::TaskPlanStarted { id, session_id, .. } if id == task_id => {
                return session_id
            }
            proto::ServerMsg::TaskRefused { message, .. } => {
                panic!("planning start refused: {message}")
            }
            _ => {}
        }
    }
}

async fn plan_changed(ws: &mut WsStream, task_id: i64, revision: i64) {
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::TaskPlanChanged {
                id,
                revision: changed,
            } if id == task_id && changed == revision => return,
            proto::ServerMsg::TaskRefused { message, .. } => {
                panic!("plan change refused: {message}")
            }
            _ => {}
        }
    }
}

async fn plan_refused(ws: &mut WsStream) {
    loop {
        if matches!(
            common::next_control(ws).await,
            proto::ServerMsg::TaskRefused { .. }
        ) {
            return;
        }
    }
}

async fn task(ws: &mut WsStream, id: i64) -> proto::Task {
    send(ws, &proto::ClientMsg::TaskGet { id }).await;
    loop {
        if let proto::ServerMsg::TaskDetail { task, .. } = common::next_control(ws).await {
            if task.id == id {
                return task;
            }
        }
    }
}

async fn domain(ws: &mut WsStream, id: i64) -> proto::TaskDomain {
    send(ws, &proto::ClientMsg::TaskDomainGet { id }).await;
    loop {
        match common::next_control(ws).await {
            proto::ServerMsg::TaskDomainState { domain } if domain.task_id == id => return domain,
            proto::ServerMsg::TaskRefused { message, .. } => {
                panic!("task domain query refused: {message}")
            }
            _ => {}
        }
    }
}

async fn request(addr: std::net::SocketAddr, token: &str, method: &str, params: Value) -> Value {
    request_http(addr, token, method, params).await.1
}

async fn request_http(
    addr: std::net::SocketAddr,
    token: &str,
    method: &str,
    params: Value,
) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string();
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\n\
         Accept: application/json, text/event-stream\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let response = String::from_utf8_lossy(&response);
    let (head, body) = response.split_once("\r\n\r\n").expect("HTTP response body");
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        let mut decoded = String::new();
        let mut rest = body;
        while let Some((size, after)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            decoded.push_str(&after[..size]);
            rest = &after[size + 2..];
        }
        decoded
    } else {
        body.to_string()
    };
    let value = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("invalid MCP JSON ({error}): {body}"));
    (status, value)
}

async fn list_tools(addr: std::net::SocketAddr, token: &str) -> Vec<String> {
    let reply = request(addr, token, "tools/list", json!({})).await;
    reply["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("tools/list did not return a tool catalog: {reply}"))
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect()
}

async fn call_tool(addr: std::net::SocketAddr, token: &str, name: &str, arguments: Value) -> Value {
    request(
        addr,
        token,
        "tools/call",
        json!({"name":name,"arguments":arguments}),
    )
    .await["result"]
        .clone()
}

fn provider_shim(home: &Path, provider: &str, argv_path: &Path) {
    let shims = home.join("provider-shims");
    std::fs::create_dir_all(&shims).unwrap();
    let cli = shims.join(provider);
    std::fs::write(
        &cli,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexec sleep 60\n",
            argv_path.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", shims.display()));
    std::env::set_var("HOME", home);
}

async fn wait_for_file(path: &Path) -> String {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(contents) = std::fs::read_to_string(path) {
            return contents;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} was not written",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_planning_settlement(daemon: &Daemon, session_id: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let stopped = daemon
            .list()
            .iter()
            .find(|session| session.id == session_id)
            .is_none_or(|session| session.state == proto::SessionState::Killed);
        if stopped && daemon.task_plan_session(session_id).unwrap().is_none() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "planning session {session_id} did not settle"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn workspace(state: &Path) -> PathBuf {
    let path = state.join("project");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("README.md"), "planning fixture\n").unwrap();
    let path = path.canonicalize().unwrap();
    git(&path, &["init", "-b", "main"]);
    git(&path, &["config", "user.email", "fixture@invalid"]);
    git(&path, &["config", "user.name", "Houston fixture"]);
    git(&path, &["add", "README.md"]);
    git(&path, &["commit", "-m", "fixture baseline"]);
    path
}

fn git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn proposal(question: &str) -> proto::TaskPlanProposal {
    proto::TaskPlanProposal {
        description: "Add bounded task planning and approval".into(),
        acceptance: vec![
            "A submitted proposal is visible on its task".into(),
            "Approval replaces only the task acceptance list".into(),
        ],
        pointers: vec!["core/houston-core/src/daemon/tasks.rs".into()],
        out_of_scope: vec!["Provider credentials".into()],
        questions: if question.is_empty() {
            Vec::new()
        } else {
            vec![question.into()]
        },
    }
}

#[tokio::test]
async fn plan_capability_submission_answer_approval_and_stale_revision_are_wire_enforced() {
    let _env_guard = PROCESS_ENV.lock().await;
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace_path = workspace(state.path());
    let workspace = workspace_path.display().to_string();
    daemon.workspace_add(&workspace).unwrap();

    let home = state.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let argv_path = state.path().join("claude-argv.txt");
    provider_shim(&home, "claude", &argv_path);

    let mut ws = connect_and_hello(addr, TOKEN).await;
    let target = create_task(
        &mut ws,
        &workspace,
        "Target task",
        &["Output has an integration check"],
    )
    .await;
    let unrelated = create_task(
        &mut ws,
        &workspace,
        "Unrelated task",
        &["Unrelated output exists"],
    )
    .await;
    let project = match daemon
        .task_project_save(
            &workspace,
            None,
            None,
            "Shared initiative",
            None,
            Some(Some("The tracker describes an obsolete API".into())),
            Some(vec![
                "Use the repository API verified by the maintainer".into()
            ]),
        )
        .unwrap()
    {
        proto::ServerMsg::TaskProjectChanged { id, .. } => id,
        other => panic!("expected Project creation, got {other:?}"),
    };
    let delivery = create_task(
        &mut ws,
        &workspace,
        "Parent Delivery",
        &["Both Slices ship"],
    )
    .await;
    let delivery_task = task(&mut ws, delivery).await;
    assert!(matches!(
        daemon
            .task_domain_save(
                delivery,
                delivery_task.revision,
                Some(proto::TaskDomainKind::Delivery),
                Some(Some(project)),
                None,
            )
            .unwrap(),
        proto::ServerMsg::TaskChanged { .. }
    ));
    let target_before_parent = task(&mut ws, target).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.clone()),
            id: Some(target),
            expected_revision: Some(target_before_parent.revision),
            patch: proto::TaskPatch {
                parent_id: Some(Some(delivery)),
                ..Default::default()
            },
        },
    )
    .await;
    loop {
        if matches!(common::next_control(&mut ws).await, proto::ServerMsg::TaskChanged { id, .. } if id == target)
        {
            break;
        }
    }
    let target_initial = task(&mut ws, target).await;
    let before_status = git(&workspace_path, &["status", "--porcelain"]);
    let before_branch = git(&workspace_path, &["branch", "--show-current"]);
    let before_branches = git(&workspace_path, &["branch", "--list"]);
    let before_head = git(&workspace_path, &["rev-parse", "HEAD"]);

    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: target,
            expected_revision: target_initial.revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let plan_session = plan_started(&mut ws, target).await;
    assert_eq!(
        domain(&mut ws, target).await.planning_session_id,
        Some(plan_session)
    );
    let argv = wait_for_file(&argv_path).await;
    assert!(
        argv.contains("--permission-mode\nplan") || argv.contains("--permission-mode=plan"),
        "Claude plan-mode flag missing: {argv:?}"
    );
    assert!(
        argv.contains("Shared initiative"),
        "inherited Project missing from Plan brief: {argv:?}"
    );
    assert!(argv.contains("The tracker describes an obsolete API"));
    assert!(argv.contains("Use the repository API verified by the maintainer"));
    assert!(argv.contains("Local Project decisions/corrections take precedence"));
    assert_eq!(
        git(&workspace_path, &["status", "--porcelain"]),
        before_status
    );
    assert_eq!(
        git(&workspace_path, &["branch", "--show-current"]),
        before_branch
    );
    assert_eq!(git(&workspace_path, &["branch", "--list"]), before_branches);
    assert_eq!(git(&workspace_path, &["rev-parse", "HEAD"]), before_head);
    assert_eq!(task(&mut ws, target).await.status, target_initial.status);
    assert!(
        !workspace_path.join(".houston/worktrees").exists(),
        "planning must not create a worktree"
    );

    let plan_token = daemon.mcp_creds.issue(McpScope {
        session_id: plan_session,
        workspace_id: workspace.clone(),
    });
    let offered = list_tools(addr, &plan_token).await;
    assert!(
        offered.iter().any(|tool| tool == "task_plan_submit"),
        "planning pane did not receive its typed submit tool: {offered:?}"
    );
    for mutating in [
        "pane_spawn",
        "task_update",
        "task_domain_update",
        "task_project_save",
    ] {
        assert!(
            !offered.iter().any(|tool| tool == mutating),
            "planning pane exposed {mutating}: {offered:?}"
        );
    }
    let mut oversized = proposal("");
    oversized.acceptance = vec!["x".repeat(proto::TASK_TITLE_MAX + 1)];
    let refused = call_tool(
        addr,
        &plan_token,
        "task_plan_submit",
        serde_json::to_value(oversized).unwrap(),
    )
    .await;
    assert_eq!(refused["isError"], true, "{refused}");
    let refusal_text = refused["content"][0]["text"]
        .as_str()
        .expect("invalid proposal refusal should include MCP error text");
    assert!(
        refusal_text.contains("201 chars")
            && refusal_text.contains("limit of 200 chars in one acceptance item"),
        "{refusal_text}"
    );
    assert!(
        daemon.task_plan_session(plan_session).unwrap().is_some(),
        "an invalid proposal must keep the planning session available for correction"
    );
    let submission = call_tool(
        addr,
        &plan_token,
        "task_plan_submit",
        serde_json::to_value(proposal("Which API version should remain supported?")).unwrap(),
    )
    .await;
    assert_eq!(submission["isError"], false, "{submission}");
    assert_eq!(submission["structuredContent"]["id"], target);
    assert_eq!(submission["structuredContent"]["plan_revision"], 1);
    assert!(daemon.task_plan_session(plan_session).unwrap().is_none());
    assert!(
        daemon.has_task_planning_capability(plan_session).unwrap(),
        "the read-only capability remains recorded after submission"
    );
    wait_for_planning_settlement(&daemon, plan_session).await;
    assert!(
        domain(&mut ws, target).await.planning_session_id.is_none(),
        "submission clears the visible planning pane"
    );
    let (status, after_submit_tools) =
        request_http(addr, &plan_token, "tools/list", json!({})).await;
    assert_eq!(status, 401, "{after_submit_tools}");
    assert_eq!(after_submit_tools["error"], "invalid_mcp_credential");
    let (status, after_submit_mutation) = request_http(
        addr,
        &plan_token,
        "tools/call",
        json!({"name":"task_update","arguments":{"id":target,"expected_revision":target_initial.revision,"status":"done"}}),
    )
    .await;
    assert_eq!(status, 401, "{after_submit_mutation}");
    assert_eq!(after_submit_mutation["error"], "invalid_mcp_credential");

    let outsider = daemon
        .create_session(houston_core::daemon::CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: workspace_path.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), "sleep 60".into()]),
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
        .id;
    let outsider_token = daemon.mcp_creds.issue(McpScope {
        session_id: outsider,
        workspace_id: workspace.clone(),
    });
    let outsider_submit = call_tool(
        addr,
        &outsider_token,
        "task_plan_submit",
        serde_json::to_value(proposal("")).unwrap(),
    )
    .await;
    assert_eq!(
        outsider_submit["isError"], true,
        "unrecorded panes cannot submit plans: {outsider_submit}"
    );
    let unready = call_tool(
        addr,
        &outsider_token,
        "task_create",
        json!({"title":"Unready claim","status":"todo","acceptance":[]}),
    )
    .await;
    assert_eq!(unready["isError"], false, "{unready}");
    let unready_id = unready["structuredContent"]["id"].as_i64().unwrap();
    let claim = call_tool(
        addr,
        &outsider_token,
        "task_claim",
        json!({"id":unready_id}),
    )
    .await;
    assert_eq!(
        claim["isError"], true,
        "the MCP claim path refuses tasks without acceptance: {claim}"
    );
    assert_eq!(
        task(&mut ws, unready_id).await.status,
        proto::TaskStatus::Todo
    );
    for (name, arguments) in [
        (
            "pane_spawn",
            json!({"kind":"claude","prompt":"must not spawn"}),
        ),
        (
            "task_update",
            json!({"id":target,"expected_revision":target_initial.revision,"status":"done"}),
        ),
        (
            "task_domain_update",
            json!({"id":target,"expected_revision":target_initial.revision,"kind":"delivery"}),
        ),
        (
            "task_project_save",
            json!({"name":"Unexpected config change"}),
        ),
    ] {
        let (status, refused) = request_http(
            addr,
            &plan_token,
            "tools/call",
            json!({"name":name,"arguments":arguments}),
        )
        .await;
        assert_eq!(
            status, 401,
            "planning credential must refuse {name}: {refused}"
        );
        assert_eq!(refused["error"], "invalid_mcp_credential");
    }
    assert_eq!(task(&mut ws, target).await.status, target_initial.status);

    let create_done = call_tool(
        addr,
        &outsider_token,
        "task_create",
        json!({"title":"Agent done attempt","status":"done"}),
    )
    .await;
    assert_eq!(
        create_done["isError"], true,
        "MCP task_create cannot mark a task done: {create_done}"
    );
    let created = call_tool(
        addr,
        &outsider_token,
        "task_create",
        json!({"title":"Agent update attempt"}),
    )
    .await;
    assert_eq!(created["isError"], false, "{created}");
    let created_id = created["structuredContent"]["id"].as_i64().unwrap();
    let created_status = task(&mut ws, created_id).await.status;
    let update_done = call_tool(
        addr,
        &outsider_token,
        "task_update",
        json!({"id":created_id,"expected_revision":1,"status":"done"}),
    )
    .await;
    assert_eq!(
        update_done["isError"], true,
        "MCP task_update cannot mark a task done: {update_done}"
    );
    assert_eq!(
        task(&mut ws, created_id).await.status,
        created_status,
        "refused MCP updates do not change status"
    );

    let plan = domain(&mut ws, target)
        .await
        .plan
        .expect("proposal persisted");
    assert_eq!(plan.revision, 1);
    assert_eq!(
        plan.proposal,
        proposal("Which API version should remain supported?")
    );
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanAnswer {
            id: target,
            expected_revision: target_initial.revision,
            question: "Which API version should remain supported?".into(),
            answer: "Keep v2 compatible".into(),
        },
    )
    .await;
    plan_changed(&mut ws, target, 2).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanApprove {
            id: target,
            expected_revision: target_initial.revision,
            plan_revision: 2,
        },
    )
    .await;
    plan_changed(&mut ws, target, 2).await;
    let approved = task(&mut ws, target).await;
    assert_eq!(approved.title, target_initial.title);
    assert_eq!(
        approved.description,
        "Add bounded task planning and approval"
    );
    assert_eq!(approved.status, target_initial.status);
    assert_eq!(approved.revision, target_initial.revision + 1);
    assert_eq!(
        task(&mut ws, unrelated).await.description,
        "Description for Unrelated task"
    );
    let approved_domain = domain(&mut ws, target).await;
    assert_eq!(
        approved_domain.readiness.acceptance_total, 2,
        "approval applies the current plan acceptance items"
    );
    assert_eq!(approved_domain.readiness.unresolved_questions, 0);
    let approved_plan = approved_domain.plan.unwrap();
    assert_eq!(approved_plan.approved_revision, Some(2));
    assert_eq!(
        approved_plan.answers,
        [proto::TaskPlanAnswer {
            question: "Which API version should remain supported?".into(),
            answer: "Keep v2 compatible".into()
        }]
    );

    let stale = create_task(&mut ws, &workspace, "Stale plan", &["A result exists"]).await;
    let stale_initial = task(&mut ws, stale).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: stale,
            expected_revision: stale_initial.revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let stale_session = plan_started(&mut ws, stale).await;
    let stale_token = daemon.mcp_creds.issue(McpScope {
        session_id: stale_session,
        workspace_id: workspace.clone(),
    });
    let stale_submit = call_tool(
        addr,
        &stale_token,
        "task_plan_submit",
        serde_json::to_value(proposal("Question to answer")).unwrap(),
    )
    .await;
    assert_eq!(stale_submit["isError"], false, "{stale_submit}");
    let current = task(&mut ws, stale).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskSave {
            workspace: Some(workspace.clone()),
            id: Some(stale),
            expected_revision: Some(current.revision),
            patch: proto::TaskPatch {
                description: Some("Edited after the proposal".into()),
                ..Default::default()
            },
        },
    )
    .await;
    let edited = loop {
        match common::next_control(&mut ws).await {
            proto::ServerMsg::TaskChanged { id, .. } if id == stale => {
                break task(&mut ws, stale).await
            }
            proto::ServerMsg::TaskRefused { message, .. } => panic!("task edit refused: {message}"),
            _ => {}
        }
    };
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanAnswer {
            id: stale,
            expected_revision: current.revision,
            question: "Question to answer".into(),
            answer: "Answer from stale revision".into(),
        },
    )
    .await;
    plan_refused(&mut ws).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanApprove {
            id: stale,
            expected_revision: current.revision,
            plan_revision: 1,
        },
    )
    .await;
    plan_refused(&mut ws).await;
    let unchanged = task(&mut ws, stale).await;
    assert_eq!(unchanged.revision, edited.revision);
    assert_eq!(unchanged.description, "Edited after the proposal");
    let stale_domain = domain(&mut ws, stale).await;
    assert_eq!(
        stale_domain.readiness.acceptance_total, 1,
        "stale approval leaves current acceptance unchanged"
    );
    let stale_plan = stale_domain.plan.unwrap();
    assert!(stale_plan.answers.is_empty());
    assert_eq!(stale_plan.approved_revision, None);

    let project_stale = create_task(
        &mut ws,
        &workspace,
        "Project stale plan",
        &["The Project decision is respected"],
    )
    .await;
    let project_stale_initial = task(&mut ws, project_stale).await;
    let project_stale_revision = match daemon
        .task_domain_save(
            project_stale,
            project_stale_initial.revision,
            Some(proto::TaskDomainKind::Slice),
            Some(Some(project)),
            None,
        )
        .unwrap()
    {
        proto::ServerMsg::TaskChanged { revision, .. } => revision,
        other => panic!("expected Project assignment, got {other:?}"),
    };
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: project_stale,
            expected_revision: project_stale_revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let project_stale_session = plan_started(&mut ws, project_stale).await;
    let project_stale_token = daemon.mcp_creds.issue(McpScope {
        session_id: project_stale_session,
        workspace_id: workspace.clone(),
    });
    let current_project_data = match daemon.task_project_get(project).unwrap() {
        proto::ServerMsg::TaskProjectState {
            project: Some(project_row),
        } => project_row,
        other => panic!("expected Project state, got {other:?}"),
    };
    assert!(matches!(
        daemon
            .task_project_save(
                &workspace,
                Some(project),
                Some(current_project_data.revision),
                "Shared initiative",
                None,
                None,
                Some(vec!["Changed while planning".into()]),
            )
            .unwrap(),
        proto::ServerMsg::TaskProjectChanged { .. }
    ));
    let changed_project_submit = call_tool(
        addr,
        &project_stale_token,
        "task_plan_submit",
        serde_json::to_value(proposal("")).unwrap(),
    )
    .await;
    assert_eq!(
        changed_project_submit["isError"], true,
        "{changed_project_submit}"
    );
    assert!(
        changed_project_submit.to_string().contains("Project"),
        "stale proposal refusal names Project context: {changed_project_submit}"
    );
    assert!(domain(&mut ws, project_stale).await.plan.is_none());
    daemon.kill(project_stale_session).unwrap();
    wait_for_planning_settlement(&daemon, project_stale_session).await;

    let project_approval = create_task(
        &mut ws,
        &workspace,
        "Project approval plan",
        &["Approval uses current Project decisions"],
    )
    .await;
    let project_approval_task = task(&mut ws, project_approval).await;
    let project_approval_revision = match daemon
        .task_domain_save(
            project_approval,
            project_approval_task.revision,
            Some(proto::TaskDomainKind::Slice),
            Some(Some(project)),
            None,
        )
        .unwrap()
    {
        proto::ServerMsg::TaskChanged { revision, .. } => revision,
        other => panic!("expected Project assignment, got {other:?}"),
    };
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: project_approval,
            expected_revision: project_approval_revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let project_approval_session = plan_started(&mut ws, project_approval).await;
    let project_approval_token = daemon.mcp_creds.issue(McpScope {
        session_id: project_approval_session,
        workspace_id: workspace.clone(),
    });
    let submitted = call_tool(
        addr,
        &project_approval_token,
        "task_plan_submit",
        serde_json::to_value(proposal("")).unwrap(),
    )
    .await;
    assert_eq!(submitted["isError"], false, "{submitted}");
    wait_for_planning_settlement(&daemon, project_approval_session).await;
    let current_project_data = match daemon.task_project_get(project).unwrap() {
        proto::ServerMsg::TaskProjectState {
            project: Some(project_row),
        } => project_row,
        other => panic!("expected Project state, got {other:?}"),
    };
    assert!(matches!(
        daemon
            .task_project_save(
                &workspace,
                Some(project),
                Some(current_project_data.revision),
                "Shared initiative",
                None,
                None,
                Some(vec!["Changed before approval".into()]),
            )
            .unwrap(),
        proto::ServerMsg::TaskProjectChanged { .. }
    ));
    let refused_approval = daemon
        .task_plan_approve(project_approval, project_approval_revision, 1)
        .unwrap();
    assert!(
        format!("{refused_approval:?}").contains("Project context"),
        "stale approval refusal names Project context: {refused_approval:?}"
    );

    let retry_task = create_task(&mut ws, &workspace, "Retry after cancel", &["Retry works"]).await;
    let retry_initial = task(&mut ws, retry_task).await;
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: retry_task,
            expected_revision: retry_initial.revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let cancelled = plan_started(&mut ws, retry_task).await;
    daemon.kill(cancelled).unwrap();
    wait_for_planning_settlement(&daemon, cancelled).await;
    assert!(daemon.task_plan_session(cancelled).unwrap().is_none());
    assert!(daemon.has_task_planning_capability(cancelled).unwrap());
    assert!(
        domain(&mut ws, retry_task)
            .await
            .planning_session_id
            .is_none(),
        "cancelling a plan clears the visible planning pane"
    );
    send(
        &mut ws,
        &proto::ClientMsg::TaskPlanStart {
            id: retry_task,
            expected_revision: retry_initial.revision,
            agent: proto::AgentKind::Claude,
        },
    )
    .await;
    let retried = plan_started(&mut ws, retry_task).await;
    daemon.kill(retried).unwrap();
    let current_project_data = match daemon.task_project_get(project).unwrap() {
        proto::ServerMsg::TaskProjectState {
            project: Some(project_row),
        } => project_row,
        other => panic!("expected Project state, got {other:?}"),
    };
    assert!(matches!(
        daemon
            .task_project_save(
                &workspace,
                Some(project),
                Some(current_project_data.revision),
                "Shared initiative",
                None,
                None,
                Some(vec!["Changed after approval".into()]),
            )
            .unwrap(),
        proto::ServerMsg::TaskProjectChanged { .. }
    ));
    let after_project_edit = domain(&mut ws, target).await;
    assert!(!after_project_edit.readiness.ready);
    assert!(after_project_edit
        .readiness
        .reasons
        .iter()
        .any(|reason| reason.contains("Project context")));
    assert_eq!(after_project_edit.plan.unwrap().approved_revision, None);
    daemon.kill(outsider).unwrap();
}

#[tokio::test]
async fn next_and_queue_skip_higher_priority_unready_task_for_ready_work() {
    let _env_guard = PROCESS_ENV.lock().await;
    let (addr, state, daemon) = start_daemon_with_handle().await;
    let workspace_path = workspace(state.path());
    let workspace = workspace_path.display().to_string();
    daemon.workspace_add(&workspace).unwrap();

    let home = state.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let argv_path = state.path().join("grok-argv.txt");
    provider_shim(&home, "grok", &argv_path);
    daemon.orchestration_set(true).unwrap();
    daemon.set_orchestration_caps(2, 2).unwrap();

    let parent = daemon
        .create_session(houston_core::daemon::CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: workspace_path.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), "sleep 60".into()]),
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
        .id;
    let token = daemon.mcp_creds.issue(McpScope {
        session_id: parent,
        workspace_id: workspace.clone(),
    });

    let unready = call_tool(
        addr,
        &token,
        "task_create",
        json!({
            "title":"Urgent but unready",
            "status":"todo",
            "priority":"urgent",
            "acceptance":[]
        }),
    )
    .await;
    assert_eq!(unready["isError"], false, "{unready}");
    let unready_id = unready["structuredContent"]["id"].as_i64().unwrap();
    let unready_key = unready["structuredContent"]["key"]
        .as_str()
        .unwrap()
        .to_string();

    let ready = call_tool(
        addr,
        &token,
        "task_create",
        json!({
            "title":"Medium priority ready",
            "status":"todo",
            "priority":"medium",
            "acceptance":["The ready task has a verifiable outcome"]
        }),
    )
    .await;
    assert_eq!(ready["isError"], false, "{ready}");
    let ready_id = ready["structuredContent"]["id"].as_i64().unwrap();
    let ready_key = ready["structuredContent"]["key"]
        .as_str()
        .unwrap()
        .to_string();

    let listed = call_tool(addr, &token, "task_list", json!({"ready":true})).await;
    let listed_keys: Vec<&str> = listed["structuredContent"]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["key"].as_str().unwrap())
        .collect();
    assert!(
        listed_keys.contains(&ready_key.as_str()),
        "the actually ready task is listed: {listed}"
    );
    assert!(
        !listed_keys.contains(&unready_key.as_str()),
        "the higher-priority unready task is omitted: {listed}"
    );

    let next = call_tool(addr, &token, "task_next", json!({})).await;
    assert_eq!(next["isError"], false, "{next}");
    assert_eq!(
        next["structuredContent"]["task"]["key"], ready_key,
        "task_next skips the unready priority leader: {next}"
    );

    let queued = daemon
        .task_queue_run(parent, 1, Some(proto::AgentKind::Grok))
        .unwrap();
    let proto::ServerMsg::TaskQueueResult {
        started,
        refused,
        ready_count,
        ..
    } = queued
    else {
        panic!("expected TaskQueueResult, got {queued:?}");
    };
    assert_eq!(
        started,
        vec![ready_key.clone()],
        "the queue starts the ready row instead of selecting then refusing the urgent row"
    );
    assert!(refused.is_empty(), "the queued task was ready: {refused:?}");
    assert_eq!(ready_count, 0, "the only ready task is now running");
    assert_eq!(
        match daemon.task_get(ready_id).unwrap() {
            proto::ServerMsg::TaskDetail { task, .. } => task.status,
            other => panic!("expected ready task details, got {other:?}"),
        },
        proto::TaskStatus::InProgress
    );
    assert_eq!(
        match daemon.task_get(unready_id).unwrap() {
            proto::ServerMsg::TaskDetail { task, .. } => task.status,
            other => panic!("expected unready task details, got {other:?}"),
        },
        proto::TaskStatus::Todo,
        "queue leaves the unready task untouched"
    );
    let _ = wait_for_file(&argv_path).await;
    let run_session: u32 = rusqlite::Connection::open(state.path().join("test.db"))
        .unwrap()
        .query_row(
            "SELECT session_id FROM backlog_task_runs WHERE task_id = ?1",
            [ready_id],
            |row| row.get(0),
        )
        .unwrap();
    daemon.kill(run_session).unwrap();
    daemon.kill(parent).unwrap();
}

#[tokio::test]
async fn reopening_daemon_settles_active_planning_state_and_preserves_retry() {
    let _env_guard = PROCESS_ENV.lock().await;
    let state = tempfile::tempdir().unwrap();
    let db_path = state.path().join("test.db");
    let workspace_path = workspace(state.path());
    let workspace = workspace_path.display().to_string();
    let home = state.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let argv_path = state.path().join("claude-argv.txt");
    provider_shim(&home, "claude", &argv_path);
    let config = || DaemonConfig {
        token: TOKEN.into(),
        db_path: db_path.clone(),
    };
    let daemon = Daemon::new(config()).unwrap();
    daemon.workspace_add(&workspace).unwrap();
    let task_id = match daemon
        .task_save(
            &workspace,
            None,
            None,
            proto::TaskPatch {
                title: Some("Reboot planning".into()),
                acceptance: Some(vec!["Retry remains possible".into()]),
                ..Default::default()
            },
        )
        .unwrap()
    {
        proto::ServerMsg::TaskChanged { id, .. } => id,
        other => panic!("expected task creation, got {other:?}"),
    };
    let task = match daemon.task_get(task_id).unwrap() {
        proto::ServerMsg::TaskDetail { task, .. } => task,
        other => panic!("expected task detail, got {other:?}"),
    };
    let started = daemon
        .task_plan_start(task_id, task.revision, proto::AgentKind::Claude)
        .unwrap();
    let old_session = match started {
        proto::ServerMsg::TaskPlanStarted { session_id, .. } => session_id,
        other => panic!("expected active planning session, got {other:?}"),
    };
    let _ = wait_for_file(&argv_path).await;
    let old_daemon = daemon.clone();
    drop(daemon);

    let reopened = Daemon::new(config()).unwrap();
    assert!(reopened.task_plan_session(old_session).unwrap().is_none());
    assert!(reopened.has_task_planning_capability(old_session).unwrap());
    let state = reopened.task_domain_state(task_id).unwrap();
    assert!(
        matches!(state, proto::ServerMsg::TaskDomainState { domain } if domain.planning_session_id.is_none())
    );
    let retry = reopened
        .task_plan_start(task_id, task.revision, proto::AgentKind::Claude)
        .unwrap();
    let retry_session = match retry {
        proto::ServerMsg::TaskPlanStarted { session_id, .. } => session_id,
        other => panic!("settled planning task should be retryable, got {other:?}"),
    };
    assert!(reopened.kill(retry_session).is_ok());
    assert!(old_daemon.kill(old_session).is_ok());
}

#![cfg(windows)]

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_core::mcp_creds::McpScope;
use houston_protocol as proto;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static FIXTURE: OnceLock<tempfile::TempDir> = OnceLock::new();

fn fixture() -> &'static Path {
    FIXTURE.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let script = "$ErrorActionPreference='Stop'\nif(-not $env:HOUSTON_SESSION){exit 0}\n@{cwd=(Get-Location).Path;session=[int]$env:HOUSTON_SESSION;task=$env:HOUSTON_TASK} | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $env:HOUSTON_WINDOWS_FIXTURE ('pane-'+$env:HOUSTON_SESSION+'.json'))\nWrite-Output 'FIXTURE-READY'\nwhile($true){$line=[Console]::In.ReadLine();if($null -eq $line){Start-Sleep -Milliseconds 50}else{Write-Output $line}}\n";
        std::fs::write(root.path().join("fixture.ps1"), script).unwrap();
        for provider in ["claude", "codex", "agy", "opencode", "cursor-agent", "grok"] {
            std::fs::write(root.path().join(format!("{provider}.cmd")), "@powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fixture.ps1\" %*\r\n").unwrap();
        }
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{};{path}", root.path().display()));
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("CODEX_HOME", home.join(".codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", home.join(".claude"));
        std::env::set_var("HOUSTON_WINDOWS_FIXTURE", root.path());
        root
    }).path()
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = houston_core::spawn::command("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

struct Rig {
    daemon: Arc<Daemon>,
    _state: tempfile::TempDir,
    repo: PathBuf,
    endpoint: String,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
        for session in self.daemon.list() {
            let _ = self.daemon.kill(session.id);
            let _ = self.daemon.close(session.id);
        }
    }
}

impl Rig {
    async fn new() -> Self {
        fixture();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var("HOUSTON_WINDOWS_FIXTURE", state.path());
        let repo = state.path().join("projeto com acentuação");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Fixture"]);
        git(&repo, &["config", "user.email", "fixture@example.invalid"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("README.txt"), "fixture\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "fixture"]);
        let repo = repo.canonicalize().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "windows-wire-fixture".into(),
            db_path: state.path().join("test.db"),
        })
        .unwrap();
        daemon.workspace_add(repo.to_str().unwrap()).unwrap();
        let (address, server) =
            houston_core::server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
                .await
                .unwrap();
        daemon.set_port(address.port());
        daemon.orchestration_set(true).unwrap();
        Self {
            daemon,
            _state: state,
            repo,
            endpoint: format!("http://{address}"),
            server,
        }
    }

    fn parent(&self) -> proto::SessionInfo {
        self.daemon
            .create_session(CreateParams {
                agent: proto::AgentKind::Claude,
                project_dir: self.repo.clone(),
                cmd: Some(vec![
                    "powershell.exe".into(),
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    fixture().join("fixture.ps1").display().to_string(),
                ]),
                cols: 100,
                rows: 30,
                cwd_from: None,
                shell_integration: false,
                auto_approve: true,
                acp: None,
                profile: None,
                prompt: None,
                model: None,
                effort: None,
            })
            .unwrap()
    }

    fn token(&self, parent: u32) -> String {
        self.daemon.mcp_creds.issue(McpScope {
            session_id: parent,
            workspace_id: self.repo.display().to_string(),
        })
    }

    async fn post(&self, token: &str, path: &str, body: Value) -> (u16, Value) {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", self.endpoint))
            .bearer_auth(token)
            .json(&body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap())
    }

    async fn child_cwd(&self, session: u32) -> PathBuf {
        let receipt = self._state.path().join(format!("pane-{session}.json"));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&receipt) {
                if let Ok(value) =
                    serde_json::from_str::<Value>(contents.trim_start_matches('\u{feff}'))
                {
                    if let Ok(cwd) = PathBuf::from(value["cwd"].as_str().unwrap()).canonicalize() {
                        if cwd.starts_with(&self.repo) {
                            return cwd;
                        }
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "child {session} did not publish its ConPTY cwd: receipt={:?}, output={:?}",
                std::fs::read_to_string(&receipt),
                self.daemon
                    .scrollback(session, None)
                    .map(|replay| String::from_utf8_lossy(&replay.data).into_owned())
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    fn task(&self, title: &str) -> i64 {
        let reply = self
            .daemon
            .task_save(
                self.repo.to_str().unwrap(),
                None,
                None,
                proto::TaskPatch {
                    title: Some(title.into()),
                    status: Some(proto::TaskStatus::Todo),
                    status_since_ms: None,
                    acceptance: Some(vec!["Windows check passes".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        let proto::ServerMsg::TaskChanged { id, .. } = reply else {
            panic!("expected TaskChanged, got {reply:?}");
        };
        id
    }
}

#[tokio::test]
async fn tasks_start_stop_and_resume_in_the_same_windows_worktree_for_each_provider() {
    let _guard = SERIAL.lock().await;
    let rig = Rig::new().await;
    for agent in [
        proto::AgentKind::Claude,
        proto::AgentKind::Codex,
        proto::AgentKind::Antigravity,
        proto::AgentKind::Opencode,
        proto::AgentKind::Cursor,
        proto::AgentKind::Grok,
    ] {
        let id = rig.task(&format!("Verify {agent:?}"));
        let reply = rig.daemon.task_start(id, agent, None).unwrap();
        assert!(
            matches!(reply, proto::ServerMsg::TaskChanged { .. }),
            "{reply:?}"
        );
        let first = rig.daemon.task_latest_run(id).unwrap().unwrap();
        assert_eq!(first.state, proto::TaskRunState::Running);
        assert_eq!(first.provider, agent);
        assert_eq!(first.attempt, 1);
        let session = first.session_id.unwrap();
        let cwd = rig.child_cwd(session).await;
        assert_eq!(
            cwd,
            Path::new(first.worktree_path.as_ref().unwrap())
                .canonicalize()
                .unwrap()
        );
        let receipt: Value = serde_json::from_str(
            std::fs::read_to_string(rig._state.path().join(format!("pane-{session}.json")))
                .unwrap()
                .trim_start_matches('\u{feff}'),
        )
        .unwrap();
        assert_eq!(
            receipt["task"],
            rig.daemon.task_key_of(id).unwrap().unwrap()
        );
        let reply = rig
            .daemon
            .task_run_control(first.id, proto::TaskRunAction::Stop)
            .unwrap();
        assert!(
            matches!(reply, proto::ServerMsg::TaskChanged { .. }),
            "{reply:?}"
        );
        assert_eq!(
            rig.daemon.task_latest_run(id).unwrap().unwrap().state,
            proto::TaskRunState::Cancelled
        );
        let reply = rig
            .daemon
            .task_run_control(first.id, proto::TaskRunAction::Resume)
            .unwrap();
        assert!(
            matches!(reply, proto::ServerMsg::TaskChanged { .. }),
            "{reply:?}"
        );
        let resumed = rig.daemon.task_latest_run(id).unwrap().unwrap();
        assert_eq!(resumed.attempt, 2);
        assert_eq!(resumed.branch, first.branch);
        assert_eq!(resumed.worktree_path, first.worktree_path);
        assert_eq!(rig.child_cwd(resumed.session_id.unwrap()).await, cwd);
        rig.daemon
            .task_run_control(resumed.id, proto::TaskRunAction::Stop)
            .unwrap();
    }
}

#[tokio::test]
async fn windows_task_queue_result_and_independent_review_complete_a_task() {
    let _guard = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let workspace = rig.repo.to_str().unwrap();
    rig.daemon
        .tasks_access_set(workspace, proto::TasksAccess::Write)
        .unwrap();
    let id = rig.task("Execute and review");
    let reply = rig
        .daemon
        .task_queue_run(parent.id, 1, Some(proto::AgentKind::Codex))
        .unwrap();
    let proto::ServerMsg::TaskQueueResult {
        started, refused, ..
    } = reply
    else {
        panic!("expected TaskQueueResult, got {reply:?}");
    };
    assert_eq!(started, vec!["HOU-1"]);
    assert!(refused.is_empty(), "{refused:?}");
    let implementation = rig.daemon.task_latest_run(id).unwrap().unwrap();
    let child = implementation.session_id.unwrap();
    rig.child_cwd(child).await;
    rig.daemon
        .orchestrate_submit(
            child,
            json!({"task_result":{"status":"complete","summary":"Windows implementation verified",
            "checks":[{"name":"Windows check passes","passed":true,"evidence":"fixture"}]}})
            .to_string()
            .into(),
        )
        .unwrap();
    rig.daemon.session_kill_checked(child, false).unwrap();
    let proto::ServerMsg::TaskDetail {
        task, acceptance, ..
    } = rig.daemon.task_get(id).unwrap()
    else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.status, proto::TaskStatus::InReview);
    assert!(acceptance[0].checked_at_ms.is_some());
    let reply = rig
        .daemon
        .task_review(
            workspace,
            id,
            parent.id,
            proto::AgentKind::Grok,
            "task_review",
        )
        .unwrap();
    assert!(
        matches!(reply, proto::ServerMsg::TaskChanged { .. }),
        "{reply:?}"
    );
    let review = rig.daemon.task_latest_review_run(id).unwrap().unwrap();
    let reviewer = review.session_id.unwrap();
    assert_ne!(reviewer, child);
    rig.child_cwd(reviewer).await;
    rig.daemon
        .orchestrate_submit(
            reviewer,
            json!({"task_review":{"verdict":"pass","findings":[],
            "checks":[{"name":"Windows check passes","passed":true,"evidence":"fixture"}]}})
            .to_string()
            .into(),
        )
        .unwrap();
    let proto::ServerMsg::TaskDetail {
        task,
        comments,
        runs,
        ..
    } = rig.daemon.task_get(id).unwrap()
    else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.status, proto::TaskStatus::InReview);
    assert_eq!(runs.len(), 2);
    assert!(runs
        .iter()
        .all(|run| run.state == proto::TaskRunState::HandedBack));
    assert!(comments
        .iter()
        .any(|comment| comment.body.contains("Windows implementation verified")));
    assert!(comments
        .iter()
        .any(|comment| comment.body.contains("Review verdict: pass")));
    let reply = rig
        .daemon
        .task_save(
            workspace,
            Some(id),
            Some(task.revision),
            proto::TaskPatch {
                status: Some(proto::TaskStatus::Done),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        matches!(reply, proto::ServerMsg::TaskChanged { .. }),
        "{reply:?}"
    );
    let proto::ServerMsg::TaskDetail { task, .. } = rig.daemon.task_get(id).unwrap() else {
        panic!("expected TaskDetail");
    };
    assert_eq!(task.status, proto::TaskStatus::Done);
}

#[tokio::test]
async fn canonical_workspace_spawns_a_recorded_worktree_over_http_and_mcp() {
    let _guard = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let token = rig.token(parent.id);
    for (slug, mcp) in [("http-child", false), ("mcp-child", true)] {
        let arguments = json!({"kind":"codex", "prompt":"Verify the fixture\nand return a result", "worktree":slug, "reusable":true});
        let session = if mcp {
            let (status, body) = rig.post(&token, "/mcp", json!({"jsonrpc":"2.0", "id":1, "method":"tools/call", "params":{"name":"pane_spawn", "arguments":arguments}})).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(body["result"]["isError"], false, "{body}");
            body["result"]["structuredContent"]["session"]
                .as_u64()
                .unwrap() as u32
        } else {
            let (status, body) = rig.post(&token, "/orchestrate/spawn", arguments).await;
            assert_eq!(status, 200, "{body}");
            body["session_id"].as_u64().unwrap() as u32
        };
        let expected = houston_core::worktrees::spawn_path(&rig.repo, slug)
            .canonicalize()
            .unwrap();
        assert_eq!(rig.child_cwd(session).await, expected);
        let info = rig
            .daemon
            .list()
            .into_iter()
            .find(|pane| pane.id == session)
            .unwrap();
        assert_eq!(info.spawned_by, Some(parent.id));
        assert_eq!(info.worktree.unwrap().branch, format!("houston/{slug}"));
        let db = rusqlite::Connection::open(rig._state.path().join("test.db")).unwrap();
        let recorded: (String, String) = db.query_row("SELECT path, branch FROM managed_worktrees WHERE created_by_session = ?1 AND branch = ?2", rusqlite::params![parent.id, format!("houston/{slug}")], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(Path::new(&recorded.0).canonicalize().unwrap(), expected);
        assert_eq!(recorded.1, format!("houston/{slug}"));
    }
}

#[tokio::test]
async fn failed_provider_preparation_rolls_back_the_tree_and_can_retry_the_same_slug() {
    let _guard = SERIAL.lock().await;
    let rig = Rig::new().await;
    let parent = rig.parent();
    let token = rig.token(parent.id);
    let config = fixture().join("home/.grok/trusted_folders.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "invalid = [").unwrap();
    let ask = json!({"kind":"grok", "prompt":"Verify rollback", "worktree":"retry-child"});
    let (status, error) = rig.post(&token, "/orchestrate/spawn", ask.clone()).await;
    std::fs::write(&config, "").unwrap();
    assert_ne!(status, 200, "{error}");
    assert!(error.to_string().contains("valid TOML"), "{error}");
    assert!(!houston_core::worktrees::spawn_path(&rig.repo, "retry-child").exists());
    assert!(git(&rig.repo, &["branch", "--list", "houston/retry-child"])
        .trim()
        .is_empty());
    assert_eq!(houston_core::worktrees::list(&rig.repo).unwrap().len(), 1);
    let db = rusqlite::Connection::open(rig._state.path().join("test.db")).unwrap();
    let count: u32 = db
        .query_row("SELECT COUNT(*) FROM managed_worktrees", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    let (status, body) = rig.post(&token, "/orchestrate/spawn", ask).await;
    assert_eq!(status, 200, "{body}");
    rig.child_cwd(body["session_id"].as_u64().unwrap() as u32)
        .await;
}

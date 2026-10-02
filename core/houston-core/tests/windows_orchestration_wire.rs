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
        let script = "$ErrorActionPreference='Stop'\n@{cwd=(Get-Location).Path;session=[int]$env:HOUSTON_SESSION} | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $env:HOUSTON_WINDOWS_FIXTURE ('pane-'+$env:HOUSTON_SESSION+'.json'))\nWrite-Output 'FIXTURE-READY'\nwhile($true){$line=[Console]::In.ReadLine();if($null -eq $line){Start-Sleep -Milliseconds 50}else{Write-Output $line}}\n";
        std::fs::write(root.path().join("fixture.ps1"), script).unwrap();
        for provider in ["claude", "codex", "agy", "opencode", "cursor-agent", "grok"] {
            std::fs::write(root.path().join(format!("{provider}.cmd")), "@powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fixture.ps1\" %*\r\n").unwrap();
        }
        let path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{};{path}", root.path().display()));
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
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
        let receipt = fixture().join(format!("pane-{session}.json"));
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
                "child {session} did not publish its ConPTY cwd"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
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

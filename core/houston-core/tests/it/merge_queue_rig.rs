//! The merge queue's test rig: a workspace whose `origin` is a local bare repository at a
//! path naming `github.com/owner/repo`, and `fake_gh` first on `PATH`, so the queue runs
//! against real repositories on Linux and Windows alike.
#![allow(clippy::disallowed_methods)]

use crate::common;

use common::start_daemon_with_handle;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

// Every test points the process-wide PATH at its own fake gh.
pub(crate) static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
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

pub(crate) fn commit(tree: &Path, file: &str, content: &str, message: &str) -> String {
    std::fs::write(tree.join(file), content).unwrap();
    git(tree, &["add", file]);
    git(tree, &["commit", "-q", "-m", message]);
    git(tree, &["rev-parse", "HEAD"])
}

/// A remote path with forward slashes, as a URL is written: the queue reads
/// `owner/name` from the path after `github.com`.
pub(crate) fn slashed(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

/// A pane that lives until the test ends: an agent pane, so it is an owner.
pub(crate) fn agent_pane(daemon: &Arc<Daemon>, dir: &Path) -> u32 {
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

pub(crate) struct Rig {
    pub daemon: Arc<Daemon>,
    pub state: tempfile::TempDir,
    pub workspace: String,
    pub root: PathBuf,
    pub origin: PathBuf,
    pub bin: PathBuf,
    previous_path: Option<std::ffi::OsString>,
}

impl Rig {
    pub(crate) async fn new() -> Self {
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

    pub(crate) fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state.path().join("test.db")).unwrap()
    }

    /// A Houston-managed worktree on `houston/<slug>` with one commit, pushed,
    /// and the pull request gh reports for it.
    pub(crate) fn change(&self, number: u32, slug: &str, file: &str, content: &str) -> PathBuf {
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

    /// Like `change`, on a branch built on `parent` rather than on main.
    pub(crate) fn change_on(
        &self,
        number: u32,
        slug: &str,
        parent: &str,
        file: &str,
        content: &str,
    ) -> PathBuf {
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
                parent,
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
                 VALUES (?1, ?2, ?3, ?4, 'pane_spawn', 0)",
                rusqlite::params![
                    path.display().to_string(),
                    common,
                    branch,
                    format!("origin/{parent}")
                ],
            )
            .unwrap();
        self.pr(number, &branch);
        path
    }

    /// A fixture file beside the fake gh: a switch, or one pull request's state.
    pub(crate) fn flag(&self, name: &str, content: &str) {
        std::fs::write(self.bin.join(name), content).unwrap();
    }

    pub(crate) fn unflag(&self, name: &str) {
        let _ = std::fs::remove_file(self.bin.join(name));
    }

    pub(crate) fn has_flag(&self, name: &str) -> bool {
        self.bin.join(name).exists()
    }

    /// Changes one field of the pull request gh reports.
    pub(crate) fn pr_set(&self, number: u32, key: &str, value: serde_json::Value) {
        let path = self.bin.join(format!("pr-{number}.json"));
        let mut json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        json[key] = value;
        std::fs::write(path, json.to_string()).unwrap();
    }

    pub(crate) fn pr_field(&self, number: u32, key: &str) -> serde_json::Value {
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(self.bin.join(format!("pr-{number}.json"))).unwrap(),
        )
        .unwrap();
        json[key].clone()
    }

    pub(crate) fn enqueue_after(&self, number: u32, depends_on: u32, session: Option<u32>) {
        self.daemon
            .merge_queue_enqueue(
                &self.workspace,
                &number.to_string(),
                Some(depends_on),
                session,
            )
            .unwrap();
    }

    /// GitHub merges `number` on its own, as its merge queue or auto-merge does:
    /// a squash commit on the base with the head's tree.
    pub(crate) fn github_merges(&self, number: u32) {
        let head = self.origin_tip(self.pr_field(number, "headRefName").as_str().unwrap());
        let base = self.pr_field(number, "baseRefName");
        let base = base.as_str().unwrap();
        let parent = self.origin_tip(base);
        let squash = git(
            &self.origin,
            &[
                "-c",
                "user.name=github",
                "-c",
                "user.email=github@example.invalid",
                "commit-tree",
                &format!("{head}^{{tree}}"),
                "-p",
                &parent,
                "-m",
                "merged by GitHub",
            ],
        );
        git(
            &self.origin,
            &["update-ref", &format!("refs/heads/{base}"), &squash],
        );
        self.pr_set(number, "state", "MERGED".into());
        self.pr_set(number, "mergedAt", "2026-10-18T06:40:00Z".into());
        self.unflag(&format!("queued-{number}"));
        self.unflag(&format!("auto-{number}"));
    }

    /// One PR watch tick: the shared reads every queued entry gets.
    pub(crate) async fn read_pass(&self) {
        let daemon = self.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.pr_watch_tick())
            .await
            .unwrap();
    }

    pub(crate) fn snapshot(&self) -> proto::ServerMsg {
        self.daemon.merge_queue_snapshot(&self.workspace).unwrap()
    }

    pub(crate) fn pr(&self, number: u32, branch: &str) {
        let json = format!(
            r#"{{"number":{number},"url":"https://github.com/owner/repo/pull/{number}","state":"OPEN","mergedAt":null,"headRefOid":"0000000000000000000000000000000000000000","title":"Change {number}","author":{{"login":"author"}},"isDraft":false,"baseRefName":"main","headRefName":"{branch}","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[],"comments":[],"reviews":[],"isCrossRepository":false}}"#
        );
        std::fs::write(self.bin.join(format!("pr-{number}.json")), json).unwrap();
    }

    /// Moves `main` in origin with a commit made in the workspace.
    pub(crate) fn advance_base(&self, file: &str, content: &str) -> String {
        let sha = commit(&self.root, file, content, "base moves");
        git(&self.root, &["push", "-q", "origin", "main"]);
        sha
    }

    pub(crate) fn origin_tip(&self, branch: &str) -> String {
        git(
            &self.origin,
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
    }

    pub(crate) fn enqueue(&self, number: u32, session: Option<u32>) {
        self.daemon
            .merge_queue_enqueue(&self.workspace, &number.to_string(), None, session)
            .unwrap();
    }

    pub(crate) fn settings(&self, policy: bool, command: &str) {
        self.daemon
            .merge_queue_settings_set(&self.workspace, policy, command, 30)
            .unwrap();
    }

    pub(crate) fn entries(&self) -> Vec<proto::MergeQueueEntry> {
        self.daemon.merge_queue_entries(&self.workspace).unwrap()
    }

    pub(crate) fn entry(&self, number: u32) -> proto::MergeQueueEntry {
        self.entries()
            .into_iter()
            .find(|e| e.number == number)
            .unwrap_or_else(|| panic!("#{number} is not queued"))
    }

    pub(crate) async fn tick(&self) {
        let daemon = self.daemon.clone();
        tokio::task::spawn_blocking(move || daemon.merge_queue_runner_tick())
            .await
            .unwrap();
    }

    /// The calls gh received, of one kind.
    pub(crate) fn calls(&self, prefix: &str) -> Vec<String> {
        std::fs::read_to_string(self.bin.join("gh.log"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with(prefix))
            .map(str::to_string)
            .collect()
    }

    pub(crate) fn log(&self) -> Vec<proto::MergeQueueLogEntry> {
        match self.daemon.merge_queue_snapshot(&self.workspace).unwrap() {
            proto::ServerMsg::MergeQueue { log, .. } => log,
            other => panic!("not a snapshot: {other:?}"),
        }
    }

    pub(crate) fn inbox(&self, summary_like: &str) -> Vec<(u32, String)> {
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
pub(crate) const NEEDS_BASE: &str = "git cat-file -e HEAD:base.txt";

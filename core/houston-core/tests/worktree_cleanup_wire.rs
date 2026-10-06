#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

mod common;

use common::*;
use futures_util::SinkExt;
use houston_core::daemon::{CreateParams, Daemon};
use houston_protocol as proto;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static FAKE: OnceLock<PathBuf> = OnceLock::new();

const HOUR_MS: i64 = 3_600_000;
const PR: u32 = 7;
/// Every workspace's `origin` is configured with this URL, which an `insteadOf` rewrites
/// to its local bare repository, so the PR's repository matches a real remote.
const REPO_URL: &str = "https://github.com/acme/repo";

/// A fake `gh` first on PATH: `pr view` answers from `pr-<branch, / as ->.json` or says
/// there is no PR, and every call lands in `gh.log`. `GH_FAKE_MISSING` plays an absent
/// gh; `GH_FAKE_SLEEP_MS` holds each `pr view` open.
fn fake_dir() -> PathBuf {
    FAKE.get_or_init(|| {
        let dir = tempfile::tempdir().expect("fake tempdir").keep();
        let script = format!(
            "#!/bin/sh\n\
             dir='{dir}'\n\
             echo \"$*\" >> \"$dir/gh.log\"\n\
             if [ -n \"$GH_FAKE_MISSING\" ]; then exit 127; fi\n\
             if [ \"$1\" = \"--version\" ]; then echo 'gh version 2.0.0'; exit 0; fi\n\
             if [ \"$1 $2\" = \"auth status\" ]; then exit 0; fi\n\
             if [ \"$1 $2\" = \"pr view\" ]; then\n\
             \tif [ -n \"$GH_FAKE_SLEEP_MS\" ]; then sleep $(( GH_FAKE_SLEEP_MS / 1000 )); fi\n\
             \tbranch=$(git branch --show-current | tr '/' '-')\n\
             \tif [ -f \"$dir/pr-$branch.json\" ]; then cat \"$dir/pr-$branch.json\"; exit 0; fi\n\
             \techo 'no pull requests found for branch' >&2\n\
             \texit 1\n\
             fi\n\
             exit 1\n",
            dir = dir.display()
        );
        let path = dir.join("gh");
        std::fs::write(&path, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{path_env}", dir.display()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        dir
    })
    .clone()
}

fn reset_fake() {
    let dir = fake_dir();
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("pr-") || name == "gh.log" {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    std::env::remove_var("GH_FAKE_MISSING");
    std::env::remove_var("GH_FAKE_SLEEP_MS");
}

fn gh_log() -> String {
    std::fs::read_to_string(fake_dir().join("gh.log")).unwrap_or_default()
}

fn git(dir: &Path, args: &[&str]) -> String {
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

fn branch_exists(repo: &Path, branch: &str) -> bool {
    !git(repo, &["branch", "--list", branch]).is_empty()
}

fn set_activity_age(tree: &Path, age_seconds: i64) {
    let timestamp = now_ms() / 1000 - age_seconds;
    for name in ["HEAD", "ORIG_HEAD", "COMMIT_EDITMSG", "logs/HEAD"] {
        let git_path = git(tree, &["rev-parse", "--git-path", name]);
        let path = Path::new(&git_path);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            tree.join(path)
        };
        if path.exists() {
            assert!(Command::new("touch")
                .args(["-d", &format!("@{timestamp}")])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// GitHub's `mergedAt` shape: `YYYY-MM-DDTHH:MM:SSZ`.
fn github_time(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn tree_bytes(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

struct Rig {
    daemon: Arc<Daemon>,
    addr: std::net::SocketAddr,
    state: tempfile::TempDir,
}

struct Ws {
    dir: PathBuf,
    origin: PathBuf,
}

async fn rig() -> Rig {
    fake_dir();
    reset_fake();
    let (addr, state, daemon) = start_daemon_with_handle().await;
    Rig {
        daemon,
        addr,
        state,
    }
}

impl Rig {
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.state.path().join("test.db")).unwrap()
    }

    /// A git workspace with a bare `origin`, registered with the daemon.
    fn workspace(&self, name: &str) -> Ws {
        let origin = self.state.path().join(format!("{name}-origin.git"));
        git(
            self.state.path(),
            &["init", "--bare", "-b", "main", origin.to_str().unwrap()],
        );
        let dir = self.state.path().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t.local"]);
        git(&dir, &["config", "user.name", "t"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-m", "init"]);
        git(&dir, &["remote", "add", "origin", REPO_URL]);
        git(
            &dir,
            &[
                "config",
                &format!("url.{}.insteadOf", origin.display()),
                REPO_URL,
            ],
        );
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
        let dir = dir.canonicalize().unwrap();
        self.daemon
            .workspace_add(&dir.display().to_string())
            .unwrap();
        Ws {
            dir,
            origin: origin.canonicalize().unwrap(),
        }
    }

    /// A worktree on `houston/<slug>` with one pushed commit that `main` does not
    /// contain, as a squash merge leaves it. `record` writes its managed row.
    fn tree(&self, ws: &Ws, slug: &str, record: bool) -> PathBuf {
        let path = ws.dir.join(".houston").join("worktrees").join(slug);
        let branch = format!("houston/{slug}");
        git(
            &ws.dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch,
                path.to_str().unwrap(),
            ],
        );
        std::fs::write(path.join(format!("{slug}.txt")), format!("{slug}\n")).unwrap();
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-q", "-m", slug]);
        git(&path, &["push", "-q", "-u", "origin", &branch]);
        let path = path.canonicalize().unwrap();
        if record {
            self.record(&path, &branch);
        }
        path
    }

    fn record(&self, path: &Path, branch: &str) {
        let common = git(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        self.db()
            .execute(
                "INSERT INTO managed_worktrees
                    (path, repo_common_dir, branch, base_branch, provenance, created_by_session, created_at_ms)
                 VALUES (?1, ?2, ?3, 'main', 'pane_spawn', NULL, ?4)",
                rusqlite::params![path.display().to_string(), common, branch, now_ms()],
            )
            .unwrap();
    }

    fn row_count(&self) -> i64 {
        self.db()
            .query_row("SELECT COUNT(*) FROM managed_worktrees", [], |r| r.get(0))
            .unwrap()
    }

    fn has_row(&self, path: &Path) -> bool {
        self.db()
            .query_row(
                "SELECT COUNT(*) FROM managed_worktrees WHERE path = ?1",
                [path.display().to_string()],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
            == 1
    }

    fn set_cleanup(&self, enabled: bool, grace_hours: u32) {
        self.daemon
            .set_worktree_cleanup(enabled, grace_hours)
            .unwrap();
    }

    async fn ws(&self) -> WsStream {
        let mut ws = connect_and_hello(self.addr, TOKEN).await;
        let _ = next_control(&mut ws).await;
        ws
    }
}

fn pr_json(slug: &str, state: &str, merged_at_ms: Option<i64>, head: &str) {
    let merged = merged_at_ms
        .map(|ms| format!("\"{}\"", github_time(ms)))
        .unwrap_or_else(|| "null".to_string());
    std::fs::write(
        fake_dir().join(format!("pr-houston-{slug}.json")),
        format!(
            "{{\"number\":{PR},\"state\":\"{state}\",\"mergedAt\":{merged},\"headRefOid\":\"{head}\",\"url\":\"{REPO_URL}/pull/{PR}\"}}"
        ),
    )
    .unwrap();
}

/// A PR merged `hours_ago` whose head is the tree's own HEAD.
fn merged(slug: &str, tree: &Path, hours_ago: i64) {
    let head = git(tree, &["rev-parse", "HEAD"]);
    pr_json(slug, "MERGED", Some(now_ms() - hours_ago * HOUR_MS), &head);
}

async fn send(ws: &mut WsStream, msg: &proto::ClientMsg) {
    ws.send(Message::text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

/// The next `WorktreeCleanup` for `dir`, or the error the daemon answered with.
async fn next_cleanup(ws: &mut WsStream, dir: &Path) -> Result<proto::ServerMsg, String> {
    let want = dir.display().to_string();
    loop {
        match tokio::time::timeout(Duration::from_secs(60), next_control(ws))
            .await
            .expect("a cleanup reply")
        {
            msg @ proto::ServerMsg::WorktreeCleanup { .. } => {
                if let proto::ServerMsg::WorktreeCleanup { dir, .. } = &msg {
                    if *dir == want {
                        return Ok(msg);
                    }
                }
            }
            proto::ServerMsg::Error { message, .. } => return Err(message),
            _ => continue,
        }
    }
}

/// One `worktree_cleanup_run`: a check when `paths` is empty, else Clean now for them.
async fn pass(
    r: &Rig,
    ws_dir: &Path,
    paths: Vec<String>,
) -> (Vec<proto::ManagedWorktreeInfo>, Vec<proto::RemovedWorktree>) {
    let mut ws = r.ws().await;
    send(
        &mut ws,
        &proto::ClientMsg::WorktreeCleanupRun {
            dir: ws_dir.display().to_string(),
            paths,
        },
    )
    .await;
    match next_cleanup(&mut ws, ws_dir).await {
        Ok(proto::ServerMsg::WorktreeCleanup {
            entries, removed, ..
        }) => (entries, removed),
        Ok(other) => panic!("unexpected {other:?}"),
        Err(e) => panic!("cleanup pass refused: {e}"),
    }
}

fn removable(entries: &[proto::ManagedWorktreeInfo]) -> Vec<String> {
    entries
        .iter()
        .filter(|e| e.checked_at_ms.is_some() && e.keep.is_none())
        .map(|e| e.path.clone())
        .collect()
}

/// What the dialog does: check, then Clean now for everything the check listed as
/// removable. Returns the second pass's view.
async fn run(
    r: &Rig,
    ws_dir: &Path,
) -> (Vec<proto::ManagedWorktreeInfo>, Vec<proto::RemovedWorktree>) {
    let (entries, removed) = pass(r, ws_dir, Vec::new()).await;
    assert!(removed.is_empty(), "a check removes nothing: {removed:?}");
    let paths = removable(&entries);
    if paths.is_empty() {
        return (entries, removed);
    }
    pass(r, ws_dir, paths).await
}

fn keep_of(entries: &[proto::ManagedWorktreeInfo], path: &Path) -> Option<proto::WorktreeKeep> {
    entries
        .iter()
        .find(|e| e.path == path.display().to_string())
        .unwrap_or_else(|| panic!("{} is not listed: {entries:?}", path.display()))
        .keep
        .clone()
}

#[tokio::test]
async fn clean_now_removes_a_merged_clean_tree_with_its_branch() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "done", true);
    merged("done", &tree, 2);
    let ancestor = Command::new("git")
        .arg("-C")
        .arg(&ws.dir)
        .args(["merge-base", "--is-ancestor", "houston/done", "main"])
        .status()
        .unwrap();
    assert!(
        !ancestor.success(),
        "fixture: the branch is not an ancestor of main, as a squash merge leaves it"
    );

    let (entries, removed) = run(&r, &ws.dir).await;
    assert_eq!(removed.len(), 1, "{removed:?}");
    assert_eq!(removed[0].path, tree.display().to_string());
    assert!(removed[0].bytes.unwrap_or(0) > 0, "{removed:?}");
    assert!(!tree.exists());
    assert!(!branch_exists(&ws.dir, "houston/done"));
    assert!(!r.has_row(&tree));
    assert!(entries.is_empty(), "{entries:?}");

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty() && entries.is_empty());
}

#[tokio::test]
async fn a_tree_behind_its_pr_head_is_removed() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "behind", true);
    let old = git(&tree, &["rev-parse", "HEAD"]);
    for n in 0..2 {
        std::fs::write(tree.join(format!("fix{n}.txt")), "x\n").unwrap();
        git(&tree, &["add", "-A"]);
        git(&tree, &["commit", "-q", "-m", "review fix"]);
    }
    let head = git(&tree, &["rev-parse", "HEAD"]);
    git(&tree, &["push", "-q", "origin", "houston/behind"]);
    git(&tree, &["reset", "-q", "--hard", &old]);
    pr_json("behind", "MERGED", Some(now_ms() - 2 * HOUR_MS), &head);

    let (_, removed) = run(&r, &ws.dir).await;
    assert_eq!(removed.len(), 1, "{removed:?}");
    assert!(!tree.exists());
}

#[tokio::test]
async fn a_dirty_tree_is_kept_with_its_file_count() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "dirty", true);
    merged("dirty", &tree, 2);
    std::fs::write(tree.join("dirty.txt"), "changed\n").unwrap();
    std::fs::write(tree.join("README.md"), "changed\n").unwrap();

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::Dirty { files: 2 })
    );
    assert!(tree.exists());
}

#[tokio::test]
async fn a_commit_outside_the_pr_keeps_the_tree() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "extra", true);
    merged("extra", &tree, 2);
    let pr_head = git(&tree, &["rev-parse", "HEAD"]);
    git(&ws.dir, &["cherry-pick", &pr_head]);
    std::fs::write(tree.join("later.txt"), "x\n").unwrap();
    git(&tree, &["add", "-A"]);
    git(&tree, &["commit", "-q", "-m", "after the merge"]);

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::NotIntegrated)
    );
    assert!(branch_exists(&ws.dir, "houston/extra"));
}

#[tokio::test]
async fn commits_patch_equivalent_to_the_recorded_base_are_integrated() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "equivalent", true);
    let pr_head = git(&tree, &["rev-parse", "HEAD"]);
    std::fs::write(tree.join("later.txt"), "later\n").unwrap();
    git(&tree, &["add", "-A"]);
    git(&tree, &["commit", "-q", "-m", "after the PR head"]);
    let later = git(&tree, &["rev-parse", "HEAD"]);
    git(&ws.dir, &["cherry-pick", &pr_head]);
    git(&ws.dir, &["cherry-pick", &later]);
    pr_json(
        "equivalent",
        "MERGED",
        Some(now_ms() - 2 * HOUR_MS),
        &pr_head,
    );

    let (checked, check_removed) = pass(&r, &ws.dir, Vec::new()).await;
    assert!(check_removed.is_empty());
    assert_eq!(checked[0].base_branch.as_deref(), Some("main"));
    let (entries, removed) = pass(&r, &ws.dir, removable(&checked)).await;
    assert_eq!(removed.len(), 1, "{removed:?}; {entries:?}");
    assert!(!tree.exists());
    assert!(!branch_exists(&ws.dir, "houston/equivalent"));
}

#[tokio::test]
async fn closing_the_worktree_owner_schedules_automatic_cleanup() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let owner = r
        .daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Shell,
            project_dir: ws.dir.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
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
        .unwrap();
    let tree = r.tree(&ws, "owned", true);
    r.db()
        .execute(
            "UPDATE managed_worktrees SET created_by_session = ?1 WHERE path = ?2",
            rusqlite::params![owner.id, tree.display().to_string()],
        )
        .unwrap();
    let head = git(&tree, &["rev-parse", "HEAD"]);
    git(&ws.dir, &["cherry-pick", &head]);
    merged("owned", &tree, 2);

    r.daemon.close(owner.id).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while tree.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closing the owner schedules a cleanup pass");
    assert!(!r.has_row(&tree));
    assert!(!branch_exists(&ws.dir, "houston/owned"));
}

#[tokio::test]
async fn idle_worktree_past_threshold_is_removed_and_keeps_its_branch() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let tree = r.tree(&ws, "idle-auto", true);
    set_activity_age(&tree, 3 * 86_400);
    r.daemon.set_worktree_idle_removal_days(2).unwrap();
    r.set_cleanup(true, 1);

    r.daemon.worktree_cleanup_tick();

    assert!(!tree.exists());
    assert!(branch_exists(&ws.dir, "houston/idle-auto"));
    assert!(!r.has_row(&tree));
}

#[tokio::test]
async fn idle_worktree_past_threshold_is_kept_when_automatic_removal_is_off() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let tree = r.tree(&ws, "idle-off", true);
    set_activity_age(&tree, 3 * 86_400);
    r.daemon.set_worktree_idle_removal_days(2).unwrap();
    r.set_cleanup(false, 1);

    r.daemon.worktree_cleanup_tick();
    let (entries, removed) = pass(&r, &ws.dir, Vec::new()).await;

    assert!(removed.is_empty());
    assert!(tree.exists());
    assert_eq!(entries[0].status, proto::WorktreeStatus::Stale);
    assert!(matches!(
        &entries[0].keep,
        Some(proto::WorktreeKeep::Stale {
            idle_days: 3,
            removal_in_days: 0
        })
    ));
}

#[tokio::test]
async fn idle_worktree_halfway_to_threshold_is_stale_but_not_removed() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let tree = r.tree(&ws, "idle-half", true);
    set_activity_age(&tree, 3 * 86_400);
    r.daemon.set_worktree_idle_removal_days(4).unwrap();
    r.set_cleanup(true, 1);

    r.daemon.worktree_cleanup_tick();
    let (entries, removed) = pass(&r, &ws.dir, Vec::new()).await;

    assert!(removed.is_empty());
    assert!(tree.exists());
    assert_eq!(entries[0].status, proto::WorktreeStatus::Stale);
    assert!(matches!(
        &entries[0].keep,
        Some(proto::WorktreeKeep::Stale {
            idle_days: 3,
            removal_in_days: 1
        })
    ));
}

#[tokio::test]
async fn stale_worktree_can_be_removed_early_while_keeping_its_branch() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let tree = r.tree(&ws, "idle-early", true);
    set_activity_age(&tree, 3 * 86_400);
    r.daemon.set_worktree_idle_removal_days(4).unwrap();

    r.daemon
        .worktree_idle_remove(&ws.dir.display().to_string(), &tree.display().to_string())
        .unwrap();

    assert!(!tree.exists());
    assert!(branch_exists(&ws.dir, "houston/idle-early"));
}

#[tokio::test]
async fn dirty_or_unpushed_worktrees_are_never_stale() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let dirty = r.tree(&ws, "dirty", true);
    let unpushed = r.tree(&ws, "unpushed", true);
    std::fs::write(dirty.join("dirty.txt"), "dirty\n").unwrap();
    std::fs::write(unpushed.join("later.txt"), "later\n").unwrap();
    git(&unpushed, &["add", "-A"]);
    git(&unpushed, &["commit", "-q", "-m", "unpushed"]);
    set_activity_age(&dirty, 3 * 86_400);
    set_activity_age(&unpushed, 3 * 86_400);
    r.daemon.set_worktree_idle_removal_days(2).unwrap();
    r.set_cleanup(false, 1);

    let (entries, removed) = pass(&r, &ws.dir, Vec::new()).await;

    assert!(removed.is_empty());
    assert!(entries
        .iter()
        .all(|entry| entry.status != proto::WorktreeStatus::Stale));
}

#[tokio::test]
async fn idle_removal_days_reject_values_outside_the_documented_range() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    assert_eq!(
        r.daemon.worktree_idle_removal_days(),
        proto::WORKTREE_IDLE_REMOVAL_DAYS_DEFAULT
    );
    assert!(r
        .daemon
        .set_worktree_idle_removal_days(0)
        .unwrap_err()
        .to_string()
        .contains("asked for 0"));
    assert!(r
        .daemon
        .set_worktree_idle_removal_days(366)
        .unwrap_err()
        .to_string()
        .contains("asked for 366"));
    r.daemon.set_worktree_idle_removal_days(1).unwrap();
    r.daemon.set_worktree_idle_removal_days(365).unwrap();
}

#[tokio::test]
async fn a_missing_pr_head_is_fetched_before_the_ancestry_check() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "fetch", true);
    // The PR head exists only at the remote's refs/pull/7/head, built in another clone.
    let other = r.state.path().join("other-clone");
    git(
        r.state.path(),
        &[
            "clone",
            "-q",
            ws.origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.email", "t@t.local"]);
    git(&other, &["config", "user.name", "t"]);
    git(&other, &["checkout", "-q", "houston/fetch"]);
    std::fs::write(other.join("fix.txt"), "x\n").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-q", "-m", "review fix"]);
    let head = git(&other, &["rev-parse", "HEAD"]);
    git(
        &other,
        &["push", "-q", "origin", &format!("HEAD:refs/pull/{PR}/head")],
    );
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&tree)
            .args(["cat-file", "-e", &head])
            .status()
            .map(|s| !s.success())
            .unwrap(),
        "fixture: the PR head is not in the local repository yet"
    );
    pr_json("fetch", "MERGED", Some(now_ms() - 2 * HOUR_MS), &head);

    let (_, removed) = run(&r, &ws.dir).await;
    assert_eq!(removed.len(), 1, "{removed:?}");
}

#[tokio::test]
async fn an_unfetchable_pr_head_keeps_the_tree() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "lost", true);
    pr_json(
        "lost",
        "MERGED",
        Some(now_ms() - 2 * HOUR_MS),
        "0123456789abcdef0123456789abcdef01234567",
    );

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::PrHeadUnavailable { pr: PR })
    );
}

#[tokio::test]
async fn a_tree_with_a_live_pane_inside_is_kept() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "busy", true);
    merged("busy", &tree, 2);
    let sub = tree.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join(".keep"), "").unwrap();
    git(&tree, &["add", "-A"]);
    git(&tree, &["commit", "-q", "-m", "sub"]);
    merged("busy", &tree, 2);
    let pane = r
        .daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: sub.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
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
        .unwrap();

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::InUse { session: pane.id })
    );
}

#[tokio::test]
async fn a_tree_inside_the_grace_period_is_kept_until_its_end() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 24);
    let tree = r.tree(&ws, "fresh", true);
    let merged_at = now_ms() - HOUR_MS;
    let head = git(&tree, &["rev-parse", "HEAD"]);
    pr_json("fresh", "MERGED", Some(merged_at), &head);
    // mergedAt carries whole seconds.
    let merged_at = merged_at - merged_at.rem_euclid(1000);

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::Grace {
            until_ms: merged_at + 86_400_000
        })
    );
}

#[tokio::test]
async fn an_open_closed_or_missing_pr_keeps_the_tree() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let open = r.tree(&ws, "open", true);
    let closed = r.tree(&ws, "closed", true);
    let none = r.tree(&ws, "none", true);
    pr_json("open", "OPEN", None, &git(&open, &["rev-parse", "HEAD"]));
    pr_json(
        "closed",
        "CLOSED",
        None,
        &git(&closed, &["rev-parse", "HEAD"]),
    );

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        keep_of(&entries, &open),
        Some(proto::WorktreeKeep::NotMerged {
            state: "OPEN".into()
        })
    );
    assert_eq!(
        keep_of(&entries, &closed),
        Some(proto::WorktreeKeep::NotMerged {
            state: "CLOSED".into()
        })
    );
    assert_eq!(keep_of(&entries, &none), Some(proto::WorktreeKeep::NoPr));
}

#[tokio::test]
async fn without_gh_a_gone_upstream_is_only_probably_integrated() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let tree = r.tree(&ws, "gone", true);
    git(&ws.origin, &["branch", "-D", "houston/gone"]);
    // The operator's own fetch; Houston never prunes remote-tracking refs itself.
    git(&ws.dir, &["fetch", "-q", "--prune", "origin"]);
    std::env::set_var("GH_FAKE_MISSING", "1");

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::NotIntegrated)
    );
    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert!(tree.exists(), "an enabled pass must not remove it either");
    std::env::remove_var("GH_FAKE_MISSING");
}

#[tokio::test]
async fn without_gh_and_with_an_upstream_the_tree_waits_for_gh() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "waiting", true);
    std::env::set_var("GH_FAKE_MISSING", "1");

    let (entries, _) = run(&r, &ws.dir).await;
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::GhUnavailable {
            gh: proto::GhState::Missing
        })
    );
    std::env::remove_var("GH_FAKE_MISSING");
}

#[tokio::test]
async fn a_failed_remove_keeps_the_branch_and_the_row() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "locked", true);
    merged("locked", &tree, 2);
    git(&ws.dir, &["worktree", "lock", tree.to_str().unwrap()]);

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty());
    match keep_of(&entries, &tree) {
        Some(proto::WorktreeKeep::RemoveFailed { message }) => {
            assert!(!message.is_empty())
        }
        other => panic!("expected RemoveFailed, got {other:?}"),
    }
    assert!(branch_exists(&ws.dir, "houston/locked"));
    assert!(r.has_row(&tree));
}

#[tokio::test]
async fn a_tree_deleted_by_hand_drops_its_row() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "vanished", true);
    std::fs::remove_dir_all(&tree).unwrap();

    let (entries, _) = run(&r, &ws.dir).await;
    assert!(entries.is_empty(), "{entries:?}");
    assert!(!r.has_row(&tree));
    assert!(!git(&ws.dir, &["worktree", "list"]).contains("vanished"));
}

#[tokio::test]
async fn an_unrecorded_tree_is_never_touched() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let tree = r.tree(&ws, "handmade", false);
    merged("handmade", &tree, 2);

    run(&r, &ws.dir).await;
    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert!(tree.exists());
    assert!(branch_exists(&ws.dir, "houston/handmade"));
}

#[tokio::test]
async fn k6_cleanup_claim_is_shared_by_repository_common_directory() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "slow", true);
    merged("slow", &tree, 2);
    std::env::set_var("GH_FAKE_SLEEP_MS", "3000");
    let dir = ws.dir.display().to_string();

    let mut first = r.ws().await;
    send(
        &mut first,
        &proto::ClientMsg::WorktreeCleanupRun {
            dir: dir.clone(),
            paths: vec![tree.display().to_string()],
        },
    )
    .await;
    // Wait until the first pass is inside its `gh pr view`.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !gh_log().contains("pr view") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the first pass never asked gh"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    r.daemon.workspace_add(&tree.display().to_string()).unwrap();
    let second_dir = tree.display().to_string();
    let mut second = r.ws().await;
    send(
        &mut second,
        &proto::ClientMsg::WorktreeCleanupRun {
            dir: second_dir.clone(),
            paths: Vec::new(),
        },
    )
    .await;
    let err = next_cleanup(&mut second, &tree)
        .await
        .expect_err("the second run must be refused");
    assert_eq!(
        err,
        format!("a worktree cleanup pass is already running for {second_dir}")
    );
    next_cleanup(&mut first, &ws.dir).await.unwrap();
    std::env::remove_var("GH_FAKE_SLEEP_MS");
}

#[tokio::test]
async fn cleanup_for_an_unknown_workspace_is_refused() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let stranger = r.state.path().join("not-a-workspace");
    std::fs::create_dir_all(&stranger).unwrap();
    let dir = stranger.display().to_string();
    let mut ws = r.ws().await;

    for msg in [
        proto::ClientMsg::WorktreeCleanupRun {
            dir: dir.clone(),
            paths: Vec::new(),
        },
        proto::ClientMsg::WorktreeCleanupStatus { dir: dir.clone() },
    ] {
        send(&mut ws, &msg).await;
        let err = next_cleanup(&mut ws, &stranger)
            .await
            .expect_err("an unknown workspace is refused");
        assert!(err.contains(&dir), "{err}");
    }
}

#[tokio::test]
async fn the_boot_pass_removes_a_merged_tree_when_enabled() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let tree = r.tree(&ws, "boot", true);
    merged("boot", &tree, 2);

    tokio::spawn(Arc::clone(&r.daemon).worktree_cleanup_loop());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    // The directory goes before the branch, so wait for the row: it is dropped last.
    while r.has_row(&tree) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the first loop pass never removed the tree"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!tree.exists());
    assert!(!branch_exists(&ws.dir, "houston/boot"));
}

#[tokio::test]
async fn with_cleanup_off_the_loop_asks_fetches_and_measures_nothing() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "idle", true);
    merged("idle", &tree, 2);
    let mut client = r.ws().await;

    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert!(gh_log().is_empty(), "no gh call: {}", gh_log());
    send(
        &mut client,
        &proto::ClientMsg::WorktreeCleanupStatus {
            dir: ws.dir.display().to_string(),
        },
    )
    .await;
    let Ok(proto::ServerMsg::WorktreeCleanup { entries, .. }) =
        next_cleanup(&mut client, &ws.dir).await
    else {
        panic!("expected a status reply");
    };
    assert_eq!(entries[0].checked_at_ms, None, "nothing was checked");
    assert_eq!(entries[0].bytes, None, "nothing was measured");
    assert!(tree.exists());
}

#[tokio::test]
async fn without_gh_a_pass_sends_nothing_and_leaves_remote_refs_alone() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let tree = r.tree(&ws, "stale", true);
    git(&ws.origin, &["branch", "-D", "houston/stale"]);
    std::env::set_var("GH_FAKE_MISSING", "1");

    let (entries, _) = pass(&r, &ws.dir, Vec::new()).await;
    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    std::env::remove_var("GH_FAKE_MISSING");
    assert!(
        !git(&ws.dir, &["branch", "-r", "--list", "origin/houston/stale"]).is_empty(),
        "the remote-tracking ref of a branch deleted upstream must not be pruned"
    );
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::GhUnavailable {
            gh: proto::GhState::Missing
        }),
        "without the operator's own fetch the upstream still looks present"
    );
}

#[tokio::test]
async fn with_cleanup_on_the_pass_removes_only_eligible_trees() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let good = r.tree(&ws, "good", true);
    let dirty = r.tree(&ws, "busy", true);
    merged("good", &good, 2);
    merged("busy", &dirty, 2);
    std::fs::write(dirty.join("wip.txt"), "wip\n").unwrap();

    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert!(!good.exists());
    assert!(dirty.exists());
    let mut client = r.ws().await;
    send(
        &mut client,
        &proto::ClientMsg::WorktreeCleanupStatus {
            dir: ws.dir.display().to_string(),
        },
    )
    .await;
    let Ok(proto::ServerMsg::WorktreeCleanup { entries, .. }) =
        next_cleanup(&mut client, &ws.dir).await
    else {
        panic!("expected a status reply");
    };
    assert_eq!(
        keep_of(&entries, &dirty),
        Some(proto::WorktreeKeep::Dirty { files: 1 })
    );
}

fn cleanup_fields(msg: proto::ServerMsg) -> (bool, u32) {
    match msg {
        proto::ServerMsg::HostInfo {
            worktree_cleanup_enabled,
            worktree_cleanup_grace_hours,
            ..
        } => (worktree_cleanup_enabled, worktree_cleanup_grace_hours),
        other => panic!("expected HostInfo, got {other:?}"),
    }
}

async fn next_host_info(ws: &mut WsStream) -> Result<(bool, u32), String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), next_control(ws))
            .await
            .expect("a host_info broadcast")
        {
            msg @ proto::ServerMsg::HostInfo { .. } => return Ok(cleanup_fields(msg)),
            proto::ServerMsg::Error { message, .. } => return Err(message),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn worktree_cleanup_set_is_broadcast_in_host_info() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let mut ws = r.ws().await;

    for hours in [1, 720] {
        send(
            &mut ws,
            &proto::ClientMsg::WorktreeCleanupSet {
                enabled: true,
                grace_hours: hours,
            },
        )
        .await;
        assert_eq!(next_host_info(&mut ws).await.unwrap(), (true, hours));
    }
}

#[tokio::test]
async fn a_grace_outside_1_to_720_is_refused() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    r.set_cleanup(true, 48);
    let mut ws = r.ws().await;

    for hours in [0, 721] {
        send(
            &mut ws,
            &proto::ClientMsg::WorktreeCleanupSet {
                enabled: false,
                grace_hours: hours,
            },
        )
        .await;
        let err = next_host_info(&mut ws)
            .await
            .expect_err("an out-of-range grace is refused");
        assert!(
            err.contains("1..=720")
                && err.contains(&format!("asked for {hours}"))
                && err.contains("48"),
            "{err}"
        );
        assert_eq!(cleanup_fields(r.daemon.host_info()), (true, 48));
    }
}

#[tokio::test]
async fn host_info_defaults_to_off_and_24_hours() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    assert_eq!(cleanup_fields(r.daemon.host_info()), (false, 24));
}

#[tokio::test]
async fn a_pass_broadcasts_kept_rows_without_measuring_each_workspace() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let one = r.workspace("one");
    let two = r.workspace("two");
    r.set_cleanup(true, 1);
    let a = r.tree(&one, "a", true);
    let b = r.tree(&two, "b", true);
    let mut client = r.ws().await;

    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    // The tick has returned, so every broadcast it made is already on the socket.
    let mut seen = Vec::new();
    while let Ok(msg) =
        tokio::time::timeout(Duration::from_millis(500), next_control(&mut client)).await
    {
        if let proto::ServerMsg::WorktreeCleanup { dir, entries, .. } = msg {
            seen.push((dir, entries));
        }
    }
    for (ws, tree) in [(&one, &a), (&two, &b)] {
        let want = ws.dir.display().to_string();
        let mine: Vec<_> = seen.iter().filter(|(dir, _)| *dir == want).collect();
        assert_eq!(
            mine.len(),
            1,
            "exactly one broadcast per workspace: {seen:?}"
        );
        let entries = &mine[0].1;
        let entry = entries
            .iter()
            .find(|e| e.path == tree.display().to_string())
            .unwrap();
        assert_eq!(entry.bytes, None);
        assert_eq!(entry.measured_at_ms, None);
    }
}

#[tokio::test]
async fn status_reads_the_cache_and_reports_unmeasured_as_null() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    let tree = r.tree(&ws, "new", true);
    assert!(tree_bytes(&tree) > 0);
    let mut client = r.ws().await;

    send(
        &mut client,
        &proto::ClientMsg::WorktreeCleanupStatus {
            dir: ws.dir.display().to_string(),
        },
    )
    .await;
    let Ok(proto::ServerMsg::WorktreeCleanup { entries, .. }) =
        next_cleanup(&mut client, &ws.dir).await
    else {
        panic!("expected a status reply");
    };
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].bytes, None);
    assert_eq!(entries[0].checked_at_ms, None);
    assert!(
        gh_log().is_empty(),
        "a status reply calls no gh: {}",
        gh_log()
    );
}

/// Captures the daemon's tracing output for the whole test binary.
static LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();

struct LogWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn logs() -> Arc<Mutex<Vec<u8>>> {
    LOGS.get_or_init(|| {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::clone(&buf);
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || LogWriter(Arc::clone(&writer)))
            .finish();
        tracing::subscriber::set_global_default(subscriber).expect("one subscriber");
        buf
    })
    .clone()
}

#[tokio::test]
async fn a_removal_is_logged_with_path_branch_pr_and_bytes() {
    let _guard = SERIAL.lock().await;
    let logs = logs();
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "logged", true);
    merged("logged", &tree, 2);

    let (_, removed) = run(&r, &ws.dir).await;
    let bytes = removed[0].bytes.unwrap();
    let text = String::from_utf8_lossy(&logs.lock().unwrap()).to_string();
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("INFO") && l.contains(&tree.display().to_string()))
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "exactly one info line names the tree: {text}"
    );
    let line = lines[0];
    assert!(
        line.contains("houston/logged")
            && line.contains(&format!("#{PR}"))
            && line.contains(&bytes.to_string()),
        "{line}"
    );
}

#[tokio::test]
async fn a_pass_calls_gh_once_per_tree() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    for slug in ["x", "y", "z"] {
        let tree = r.tree(&ws, slug, true);
        pr_json(slug, "OPEN", None, &git(&tree, &["rev-parse", "HEAD"]));
    }

    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert_eq!(
        gh_log()
            .lines()
            .filter(|l| l.starts_with("pr view"))
            .count(),
        3
    );
    assert_eq!(r.row_count(), 3);
}

#[tokio::test]
async fn a_tree_switched_to_another_branch_is_kept_with_its_unpushed_work() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(true, 1);
    let tree = r.tree(&ws, "work", true);
    std::fs::write(tree.join("unpushed.txt"), "x\n").unwrap();
    git(&tree, &["add", "-A"]);
    git(&tree, &["commit", "-q", "-m", "never pushed"]);
    let unpushed = git(&tree, &["rev-parse", "HEAD"]);
    // An agent moves the tree to a branch whose own PR has merged.
    git(&tree, &["switch", "-q", "-c", "houston/other", "main"]);
    let head = git(&tree, &["rev-parse", "HEAD"]);
    pr_json("other", "MERGED", Some(now_ms() - 2 * HOUR_MS), &head);

    let (entries, removed) = run(&r, &ws.dir).await;
    let d = Arc::clone(&r.daemon);
    tokio::task::spawn_blocking(move || d.worktree_cleanup_tick())
        .await
        .unwrap();
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::BranchChanged {
            current: Some("houston/other".into())
        })
    );
    assert!(tree.exists());
    assert_eq!(git(&ws.dir, &["rev-parse", "houston/work"]), unpushed);
}

#[tokio::test]
async fn a_loose_ignored_file_keeps_the_tree_and_an_ignored_build_dir_does_not() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "env", true);
    std::fs::write(tree.join(".gitignore"), ".env\ntarget/\n").unwrap();
    git(&tree, &["add", "-A"]);
    git(&tree, &["commit", "-q", "-m", "ignore"]);
    git(&tree, &["push", "-q", "origin", "houston/env"]);
    merged("env", &tree, 2);
    std::fs::write(tree.join(".env"), "TOKEN=local\n").unwrap();
    std::fs::create_dir_all(tree.join("target").join("debug")).unwrap();
    std::fs::write(tree.join("target").join("debug").join("app"), "bin").unwrap();

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::IgnoredFiles { files: 1 })
    );
    assert!(tree.join(".env").exists());

    std::fs::remove_file(tree.join(".env")).unwrap();
    let (_, removed) = run(&r, &ws.dir).await;
    assert_eq!(removed.len(), 1, "build output alone does not keep it");
    assert!(!tree.exists());
}

#[tokio::test]
async fn an_untracked_file_keeps_the_tree_even_when_status_hides_untracked_files() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "hidden", true);
    merged("hidden", &tree, 2);
    git(&ws.dir, &["config", "status.showUntrackedFiles", "no"]);
    std::fs::write(tree.join("notes.txt"), "mine\n").unwrap();

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::Dirty { files: 1 })
    );
    assert!(tree.join("notes.txt").exists());
}

#[tokio::test]
async fn clean_now_removes_only_the_confirmed_paths() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let shown = r.tree(&ws, "shown", true);
    merged("shown", &shown, 2);
    let (entries, _) = pass(&r, &ws.dir, Vec::new()).await;
    assert_eq!(removable(&entries), vec![shown.display().to_string()]);
    // Another tree becomes removable after the operator's dialog was drawn.
    let later = r.tree(&ws, "later", true);
    merged("later", &later, 2);

    let (entries, removed) = pass(&r, &ws.dir, vec![shown.display().to_string()]).await;
    assert_eq!(
        removed.iter().map(|w| w.path.clone()).collect::<Vec<_>>(),
        vec![shown.display().to_string()]
    );
    assert!(later.exists());
    assert_eq!(
        keep_of(&entries, &later),
        None,
        "listed as removable, not removed"
    );
}

#[tokio::test]
async fn the_pr_head_is_fetched_only_from_the_pr_repository() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("ws");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "elsewhere", true);
    // Only an unrelated remote carries a ref with the PR head; the PR's own does not.
    let mirror = r.state.path().join("mirror.git");
    git(
        r.state.path(),
        &[
            "clone",
            "-q",
            "--bare",
            ws.origin.to_str().unwrap(),
            mirror.to_str().unwrap(),
        ],
    );
    let other = r.state.path().join("mirror-clone");
    git(
        r.state.path(),
        &[
            "clone",
            "-q",
            mirror.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.email", "t@t.local"]);
    git(&other, &["config", "user.name", "t"]);
    git(&other, &["checkout", "-q", "houston/elsewhere"]);
    std::fs::write(other.join("fix.txt"), "x\n").unwrap();
    git(&other, &["add", "-A"]);
    git(&other, &["commit", "-q", "-m", "review fix"]);
    let head = git(&other, &["rev-parse", "HEAD"]);
    git(
        &other,
        &["push", "-q", "origin", &format!("HEAD:refs/pull/{PR}/head")],
    );
    git(
        &ws.dir,
        &["remote", "add", "mirror", mirror.to_str().unwrap()],
    );
    pr_json("elsewhere", "MERGED", Some(now_ms() - 2 * HOUR_MS), &head);

    let (entries, removed) = run(&r, &ws.dir).await;
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        keep_of(&entries, &tree),
        Some(proto::WorktreeKeep::PrHeadUnavailable { pr: PR })
    );
    assert!(
        git(&ws.dir, &["branch", "-r", "--list", "mirror/*"]).is_empty(),
        "nothing was fetched from the unrelated remote"
    );
}

#[tokio::test]
async fn k6_kept_tree_preserves_last_measurement() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("kept");
    let tree = r.tree(&ws, "kept", true);
    pr_json("kept", "OPEN", None, &git(&tree, &["rev-parse", "HEAD"]));
    let (entries, _) = pass(&r, &ws.dir, Vec::new()).await;
    assert_eq!(entries[0].bytes, None);
    assert_eq!(entries[0].measured_at_ms, None);
    r.db()
        .execute(
            "UPDATE managed_worktrees SET bytes=123, measured_at_ms=456",
            [],
        )
        .unwrap();
    let (entries, _) = pass(&r, &ws.dir, Vec::new()).await;
    assert_eq!(entries[0].bytes, Some(123));
    assert_eq!(entries[0].measured_at_ms, Some(456));
}

#[tokio::test]
async fn k6_cleanup_rechecks_pane_opened_during_network_lookup() {
    let _guard = SERIAL.lock().await;
    let r = rig().await;
    let ws = r.workspace("racing");
    r.set_cleanup(false, 1);
    let tree = r.tree(&ws, "racing", true);
    merged("racing", &tree, 2);
    std::env::set_var("GH_FAKE_SLEEP_MS", "3000");
    let daemon = Arc::clone(&r.daemon);
    let dir = ws.dir.display().to_string();
    let path = tree.display().to_string();
    let pass = tokio::task::spawn_blocking(move || daemon.worktree_cleanup_run(&dir, vec![path]));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !gh_log().contains("pr view") {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pane = r
        .daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: tree.clone(),
            cmd: Some(vec!["sh".into(), "-c".into(), "exec cat".into()]),
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
        .unwrap();
    pass.await.unwrap().unwrap();
    std::env::remove_var("GH_FAKE_SLEEP_MS");
    assert!(tree.exists());
    if let proto::ServerMsg::WorktreeCleanup { entries, .. } = r
        .daemon
        .worktree_cleanup_status(&ws.dir.display().to_string())
        .unwrap()
    {
        assert_eq!(
            keep_of(&entries, &tree),
            Some(proto::WorktreeKeep::InUse { session: pane.id })
        );
    } else {
        panic!("expected cleanup status");
    }
    r.daemon.close(pane.id).unwrap();
}

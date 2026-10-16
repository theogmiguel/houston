#![cfg(target_os = "linux")]
#![allow(clippy::disallowed_methods)]

use crate::common;

use futures_util::SinkExt;
use houston_core::{hook_drop, pid};
use houston_protocol as proto;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

const CHANNEL: &str = "orphanprobe";
const DEADLINE: Duration = Duration::from_secs(40);

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Identity {
    pid: u32,
    creation: u64,
    boot: String,
    fixture: String,
}

impl Identity {
    fn capture(pid: u32, fixture: &str) -> Self {
        Self {
            pid,
            creation: pid::process_creation_token(pid).expect("owned process creation identity"),
            boot: boot_id(),
            fixture: fixture.into(),
        }
    }

    fn current(&self, fixture: &str) -> bool {
        self.fixture == fixture
            && !self.boot.is_empty()
            && self.boot == boot_id()
            && pid::process_creation_token(self.pid) == Some(self.creation)
    }

    fn kill(&self, fixture: &str) {
        if self.current(fixture) {
            let _ = pid::signal_process_checked_identity(
                self.pid,
                pid::Signal::Kill,
                Some(self.creation),
            );
        }
    }

    fn running(&self, fixture: &str) -> bool {
        self.current(fixture)
            && std::fs::read_to_string(format!("/proc/{}/stat", self.pid)).is_ok_and(|stat| {
                stat[stat.rfind(')').unwrap() + 2..]
                    .split_whitespace()
                    .next()
                    != Some("Z")
            })
    }
}

fn boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap_or_default()
}

fn atomic(path: &Path, bytes: &[u8]) {
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes).unwrap();
    std::fs::rename(temporary, path).unwrap();
}

// Executed only through the private provider shim and its isolated detached fixture.
#[test]
fn orphan_fixture_agent() {
    if std::env::var("ORPHAN_PROBE_CHILD").as_deref() != Ok("1") {
        return;
    }
    let records = PathBuf::from(std::env::var_os("ORPHAN_PROBE_RECORDS").unwrap());
    let fixture = std::env::var("ORPHAN_PROBE_NONCE").unwrap();
    let session: u32 = std::env::var("HOUSTON_SESSION").unwrap().parse().unwrap();
    let detach = std::env::var("ORPHAN_PROBE_DETACH").ok();
    if detach.is_some() && std::env::var_os("ORPHAN_PROBE_DESCENDANT").is_none() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                &common::exact_path(module_path!(), "orphan_fixture_agent"),
                "--nocapture",
                "--test-threads=1",
            ])
            .env("ORPHAN_PROBE_DESCENDANT", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: the private child only starts a new terminal session before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        // This actor must outlive its parent; the outer fixture owns its identity cleanup.
        #[expect(clippy::zombie_processes)]
        let _child = command.spawn().unwrap();
        let deadline = Instant::now() + DEADLINE;
        while !records.join(format!("{session}.owned.json")).exists() {
            assert!(Instant::now() < deadline, "detached actor never registered");
            std::thread::sleep(Duration::from_millis(10));
        }
        // The root keeps the pane live until its PTY hangs up.
        while detach.as_deref() == Some("stay") {
            std::thread::sleep(Duration::from_millis(50));
        }
        return;
    }
    let identity = Identity::capture(std::process::id(), &fixture);
    // Register before ignoring signals, so panic cleanup never misses an immortal actor.
    atomic(
        &records.join(format!("{session}.owned.json")),
        &serde_json::to_vec(&identity).unwrap(),
    );
    // SAFETY: this private subprocess installs only ignored dispositions, no handler pointers.
    unsafe {
        assert_ne!(libc::signal(libc::SIGHUP, libc::SIG_IGN), libc::SIG_ERR);
        assert_ne!(libc::signal(libc::SIGTERM, libc::SIG_IGN), libc::SIG_ERR);
    }
    let arguments = std::fs::read_to_string(records.join(format!("{session}.argv"))).unwrap();
    let arguments: Vec<_> = arguments.lines().collect();
    let native = arguments
        .windows(2)
        .find(|pair| matches!(pair[0], "--resume" | "--session-id"))
        .map(|pair| pair[1])
        .expect("exact assigned or resumed conversation");
    let resumed = arguments.contains(&"--resume");
    let transcript = records.join(format!("{native}.jsonl"));
    std::fs::write(&transcript, b"{}\n").unwrap();
    let drop_dir = records
        .parent()
        .unwrap()
        .join(format!(".houston-{CHANNEL}/hooks/drop"));
    for event in if resumed {
        vec!["SessionStart"]
    } else {
        vec!["SessionStart", "UserPromptSubmit"]
    } {
        hook_drop::write_drop(
            &drop_dir,
            &hook_drop::HookDrop {
                session,
                event: event.into(),
                agent: Some("claude".into()),
                cwd: Some(std::env::current_dir().unwrap().display().to_string()),
                session_id: Some(native.into()),
                transcript_path: Some(transcript.display().to_string()),
                prompt: (!resumed).then(|| "Owned fixture work".into()),
                resume_evidence: Some(hook_drop::ResumeHookEvidence {
                    source: Some(if resumed { "resume" } else { "startup" }.into()),
                    profile_dir: None,
                }),
                ..Default::default()
            },
            hook_drop::now_ms(),
        )
        .unwrap();
    }
    atomic(
        &records.join(format!("{session}.native")),
        native.as_bytes(),
    );
    let mut counter = 0u64;
    loop {
        counter += 1;
        // No PTY reads/writes: detached work can progress after terminal hangup.
        atomic(
            &records.join(format!("{session}.progress")),
            counter.to_string().as_bytes(),
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct Fixture {
    home: tempfile::TempDir,
    records: PathBuf,
    project: PathBuf,
    bin: PathBuf,
    nonce: String,
    children: Vec<(Child, Identity, bool)>,
    daemons: Vec<Identity>,
    detached: bool,
    user_bus: bool,
    root_stays: bool,
}

impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let records = home.path().join("records");
        let project = home.path().join("project");
        let bin = home.path().join("bin");
        for path in [&records, &project, &bin] {
            std::fs::create_dir(path).unwrap();
        }
        for (name, script) in [
            ("claude", format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ORPHAN_PROBE_RECORDS/$HOUSTON_SESSION.argv\"\nexport ORPHAN_PROBE_CHILD=1\nexec \"$ORPHAN_PROBE_BINARY\" --exact {} --nocapture --test-threads=1\n", common::exact_path(module_path!(), "orphan_fixture_agent"))),
            ("shell", "#!/bin/sh\nif [ \"$1\" = -lic ]; then shift; exec /bin/sh -c \"$1\"; fi\nexec /bin/sh \"$@\"\n".to_string()),
        ] {
            let path = bin.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            home,
            records,
            project,
            bin,
            nonce: uuid::Uuid::new_v4().to_string(),
            children: vec![],
            daemons: vec![],
            detached: false,
            user_bus: false,
            root_stays: false,
        }
    }

    fn channel(&self) -> PathBuf {
        self.home.path().join(format!(".houston-{CHANNEL}"))
    }

    fn actor(&self, session: u32) -> Option<Identity> {
        serde_json::from_slice(
            &std::fs::read(self.records.join(format!("{session}.owned.json"))).ok()?,
        )
        .ok()
    }

    async fn start(&mut self, supervised: bool) -> (Discovery, common::WsStream) {
        let executable = if supervised {
            env!("CARGO_BIN_EXE_houston-supervisor")
        } else {
            env!("CARGO_BIN_EXE_houston-core")
        };
        let mut command = common::hermetic_command(executable, self.home.path());
        if self.detached {
            command.env(
                "ORPHAN_PROBE_DETACH",
                if self.root_stays { "stay" } else { "1" },
            );
        }
        if supervised {
            // SAFETY: setsid is async-signal-safe and runs only in the private child.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        } else {
            command.process_group(0);
        }
        command
            .env("HOUSTON_CHANNEL", CHANNEL)
            .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
            .env("SHELL", self.bin.join("shell"))
            // Refuse host user-bus/cgroup access; exercise the supported PTY fallback.
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                if self.user_bus {
                    std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_else(|_| {
                        // SAFETY: geteuid only reads the current fixture user's identity.
                        format!("unix:path=/run/user/{}/bus", unsafe { libc::geteuid() })
                    })
                } else {
                    format!("unix:path={}/absent-bus", self.home.path().display())
                },
            )
            .env("ORPHAN_PROBE_NONCE", &self.nonce)
            .env("ORPHAN_PROBE_RECORDS", &self.records)
            .env("ORPHAN_PROBE_BINARY", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.home.path().join("daemon.log"))
                    .unwrap(),
            );
        if supervised {
            command
                .arg("--channel-dir")
                .arg(self.channel())
                .arg("--daemon")
                .arg(env!("CARGO_BIN_EXE_houston-core"))
                .arg("--")
                .arg("--channel")
                .arg(CHANNEL);
        }
        let child = command.spawn().unwrap();
        let identity = Identity::capture(child.id(), &self.nonce);
        self.children.push((child, identity.clone(), supervised));
        let cfg = poll("new daemon discovery", || {
            let cfg: Discovery =
                serde_json::from_slice(&std::fs::read(self.channel().join("daemon.json")).ok()?)
                    .ok()?;
            if self
                .daemons
                .iter()
                .any(|old| old.pid == cfg.pid && Some(old.creation) == cfg.pid_creation)
            {
                return None;
            }
            if !supervised && cfg.pid != identity.pid {
                return None;
            }
            (pid::process_creation_token(cfg.pid) == cfg.pid_creation && cfg.pid_creation.is_some())
                .then_some(cfg)
        })
        .await;
        self.daemons.push(Identity {
            pid: cfg.pid,
            creation: cfg.pid_creation.unwrap(),
            boot: boot_id(),
            fixture: self.nonce.clone(),
        });
        let mut ws = common::connect_and_hello(
            format!("127.0.0.1:{}", cfg.port).parse().unwrap(),
            &cfg.token,
        )
        .await;
        assert!(matches!(
            common::next_control(&mut ws).await,
            proto::ServerMsg::HelloOk { .. }
        ));
        (cfg, ws)
    }

    fn cleanup(&mut self) {
        // Stop launchers first, then repeat actor receipt scans until no owned worker runs.
        for daemon in &self.daemons {
            daemon.kill(&self.nonce);
        }
        for (_, child, detached) in &self.children {
            // The unreaped launcher anchors its exact private group before discovery too.
            if child.current(&self.nonce) {
                if *detached {
                    // setsid makes this the owned session/group leader; no PTY fd is needed.
                    let _ = pid::terminate_pty_session(child.pid, None, Some(child.creation));
                } else {
                    let _ = pid::signal_owned_process_group(
                        child.pid,
                        Some(child.creation),
                        pid::Signal::Kill,
                    );
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let actors: Vec<Identity> = std::fs::read_dir(&self.records)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".owned.json"))
                .filter_map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok())
                .collect();
            for actor in &actors {
                actor.kill(&self.nonce);
            }
            for (child, _, _) in &mut self.children {
                let _ = child.try_wait();
            }
            if Instant::now() >= deadline {
                break;
            }
            // Scan for late registration even after earlier workers were reaped.
            std::thread::sleep(Duration::from_millis(20));
        }
        for (child, identity, _) in &mut self.children {
            if !identity.running(&self.nonce) {
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(Deserialize)]
struct Discovery {
    pid: u32,
    pid_creation: Option<u64>,
    port: u16,
    token: String,
}

async fn poll<T>(description: &str, mut condition: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        if let Some(value) = condition() {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out: {description}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn sessions(ws: &mut common::WsStream) -> Vec<proto::SessionInfo> {
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionList).unwrap(),
    ))
    .await
    .unwrap();
    loop {
        if let proto::ServerMsg::SessionList { sessions } = common::next_control(ws).await {
            return sessions;
        }
    }
}

async fn probe(supervised: bool) {
    let mut fixture = Fixture::new();
    let (old, mut ws) = fixture.start(supervised).await;
    let request = proto::ClientMsg::SessionCreate {
        request: None,
        agent: proto::AgentKind::Claude,
        project_dir: fixture.project.display().to_string(),
        cmd: None,
        cols: Some(80),
        rows: Some(24),
        cwd_from: None,
        shell_integration: Some(false),
        auto_approve: Some(false),
        acp: None,
        profile: None,
        prompt: None,
        model: None,
        effort: None,
    };
    ws.send(Message::text(serde_json::to_string(&request).unwrap()))
        .await
        .unwrap();
    let pane = common::expect_created(&mut ws).await;
    let actor = poll("registered fixture actor", || fixture.actor(pane.id)).await;
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        if sessions(&mut ws).await.iter().any(|info| {
            info.id == pane.id && info.resumable && info.status == Some(proto::AgentStatus::Working)
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "native turn did not acquire a resume handle"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let native = poll("initial native identity", || {
        std::fs::read_to_string(fixture.records.join(format!("{}.native", pane.id))).ok()
    })
    .await;
    let progress = poll("initial work progress", || {
        std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()
    })
    .await;
    pid::signal_process_checked_identity(old.pid, pid::Signal::Kill, old.pid_creation).unwrap();
    poll("killed daemon stops", || {
        (!fixture.daemons[0].running(&fixture.nonce)).then_some(())
    })
    .await;
    let survived = poll(
        "old actor either progresses or exits after PTY loss",
        || {
            if !actor.running(&fixture.nonce) {
                return Some(false);
            }
            (std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()? != progress)
                .then_some(true)
        },
    )
    .await;
    drop(ws);
    let (_, mut resumed_ws) = fixture.start(supervised).await;
    let restored = sessions(&mut resumed_ws)
        .await
        .into_iter()
        .find(|info| info.session_origin == Some(pane.id))
        .expect("restored or deferred pane");
    let replacement = if restored.state == proto::SessionState::Running {
        Some(poll("replacement actor", || fixture.actor(restored.id)).await)
    } else {
        None
    };
    let resumed_exact = replacement.is_some()
        && poll("replacement conversation identity", || {
            std::fs::read_to_string(fixture.records.join(format!("{}.native", restored.id))).ok()
        })
        .await
            == native;
    let overlap = resumed_exact
        && actor.running(&fixture.nonce)
        && replacement
            .as_ref()
            .is_some_and(|identity| identity.running(&fixture.nonce));
    eprintln!("orphan probe supervised={supervised} survived={survived} resumed_exact={resumed_exact} overlap={overlap}; old={actor:?} new={replacement:?}");
    // The previous root ignores SIGHUP and SIGTERM; reclaim must still stop it first.
    assert!(
        replacement.is_some(),
        "restore was deferred: {:?}",
        restored.resume_notice
    );
    assert!(
        !actor.running(&fixture.nonce),
        "restore left the previous daemon's PTY root running"
    );
    fixture.cleanup();
    assert!(
        !actor.running(&fixture.nonce),
        "fixture cleanup left original worker running"
    );
    assert!(
        !overlap,
        "SIGKILL recovery resumed the exact conversation while its previous owner still ran"
    );
}

#[tokio::test]
async fn supervised_sigkill_never_overlaps_exact_conversation_owners() {
    probe(true).await;
}

#[tokio::test]
async fn direct_sigkill_never_overlaps_exact_conversation_owners() {
    probe(false).await;
}

async fn detached_probe(user_bus: bool) {
    let mut fixture = Fixture::new();
    fixture.detached = true;
    fixture.user_bus = user_bus;
    let (daemon, mut ws) = fixture.start(false).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionCreate {
            request: None,
            agent: proto::AgentKind::Claude,
            project_dir: fixture.project.display().to_string(),
            cmd: None,
            cols: Some(80),
            rows: Some(24),
            cwd_from: None,
            shell_integration: Some(false),
            auto_approve: Some(false),
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let pane = common::expect_created(&mut ws).await;
    let actor = poll("detached actor", || fixture.actor(pane.id)).await;
    let receipt: serde_json::Value =
        rusqlite::Connection::open(fixture.channel().join("houston.db"))
            .unwrap()
            .query_row(
                "SELECT process_identity FROM sessions WHERE id=?1",
                [pane.id],
                |row| row.get::<_, String>(0),
            )
            .map(|body| serde_json::from_str(&body).unwrap())
            .unwrap();
    if user_bus {
        assert_eq!(
            receipt["ownership"]["kind"], "linux_scope",
            "manager fixture must actually contain the workload"
        );
    }
    let root = receipt["pid"].as_u64().unwrap() as u32;
    assert_ne!(
        root, actor.pid,
        "descendant must escape the root PID and PTY session"
    );
    poll("PTY root exited and reaped", || {
        (!Path::new(&format!("/proc/{root}")).exists()).then_some(())
    })
    .await;
    let progress = poll("detached work", || {
        std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()
    })
    .await;
    poll("surviving detached child progresses", || {
        (std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()? != progress)
            .then_some(())
    })
    .await;
    pid::signal_process_checked_identity(daemon.pid, pid::Signal::Kill, daemon.pid_creation)
        .unwrap();
    poll("daemon died", || {
        (!fixture.daemons[0].running(&fixture.nonce)).then_some(())
    })
    .await;
    let daemon_child = &mut fixture.children.last_mut().unwrap().0;
    assert_eq!(daemon_child.id(), daemon.pid);
    // The leader can be a zombie before its last thread releases the channel lock.
    poll("daemon process fully reaped", || {
        daemon_child.try_wait().unwrap()
    })
    .await;
    drop(ws);
    let (_, mut ws) = fixture.start(false).await;
    let restored = sessions(&mut ws)
        .await
        .into_iter()
        .find(|session| session.id == pane.id)
        .unwrap();
    assert!(actor.running(&fixture.nonce));
    assert_eq!(restored.state, proto::SessionState::Exited);
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionRespawn {
            session: pane.id,
            shell_integration: Some(false),
            cwd: None,
            shell: None,
            force: Some(true),
            fresh: Some(false),
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    loop {
        match common::next_control(&mut ws).await {
            proto::ServerMsg::Error { message, .. } => panic!("restart refused: {message}"),
            proto::ServerMsg::SessionCreated { .. } => break,
            _ => {}
        }
    }
    if user_bus {
        assert!(
            !actor.running(&fixture.nonce),
            "restart left a descendant running in the previous scope"
        );
        assert!(scope_emptied(&receipt));
    }
    fixture.cleanup();
    assert!(!actor.running(&fixture.nonce));
}

// Without a scope only the root's process group is reachable; restart is never refused.
#[tokio::test]
async fn exited_root_with_detached_work_restarts_without_a_scope() {
    detached_probe(false).await;
}

fn scope_emptied(receipt: &serde_json::Value) -> bool {
    let cgroup = receipt["ownership"]["cgroup"].as_str().unwrap();
    let events = Path::new("/sys/fs/cgroup")
        .join(cgroup.trim_start_matches('/'))
        .join("cgroup.events");
    std::fs::read_to_string(events).map_or(true, |events| events.contains("populated 0"))
}

#[tokio::test]
async fn contained_crash_restore_stops_escaped_descendants() {
    if !houston_core::session_isolation::manager_available()
        || !Path::new("/run/systemd/system").is_dir()
    {
        eprintln!("SKIPPED: Linux user systemd required for contained crash restore");
        return;
    }
    let mut fixture = Fixture::new();
    fixture.detached = true;
    fixture.user_bus = true;
    fixture.root_stays = true;
    let (daemon, mut ws) = fixture.start(false).await;
    ws.send(Message::text(
        serde_json::to_string(&proto::ClientMsg::SessionCreate {
            request: None,
            agent: proto::AgentKind::Claude,
            project_dir: fixture.project.display().to_string(),
            cmd: None,
            cols: Some(80),
            rows: Some(24),
            cwd_from: None,
            shell_integration: Some(false),
            auto_approve: Some(false),
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
    let pane = common::expect_created(&mut ws).await;
    let actor = poll("escaped actor", || fixture.actor(pane.id)).await;
    let receipt: serde_json::Value =
        rusqlite::Connection::open(fixture.channel().join("houston.db"))
            .unwrap()
            .query_row(
                "SELECT process_identity FROM sessions WHERE id=?1",
                [pane.id],
                |row| row.get::<_, String>(0),
            )
            .map(|body| serde_json::from_str(&body).unwrap())
            .unwrap();
    assert_eq!(receipt["ownership"]["kind"], "linux_scope");
    assert_ne!(receipt["pid"].as_u64().unwrap() as u32, actor.pid);
    let progress = poll("escaped work", || {
        std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()
    })
    .await;
    poll("escaped work progresses", || {
        (std::fs::read(fixture.records.join(format!("{}.progress", pane.id))).ok()? != progress)
            .then_some(())
    })
    .await;
    // No clean shutdown: the daemon dies with the pane live and its scope populated.
    pid::signal_process_checked_identity(daemon.pid, pid::Signal::Kill, daemon.pid_creation)
        .unwrap();
    poll("daemon died", || {
        (!fixture.daemons[0].running(&fixture.nonce)).then_some(())
    })
    .await;
    let daemon_child = &mut fixture.children.last_mut().unwrap().0;
    poll("daemon process fully reaped", || {
        daemon_child.try_wait().unwrap()
    })
    .await;
    drop(ws);
    assert!(
        actor.running(&fixture.nonce) && !scope_emptied(&receipt),
        "the escaped descendant must outlive its daemon for this regression"
    );
    let (_, mut ws) = fixture.start(false).await;
    let restored = sessions(&mut ws)
        .await
        .into_iter()
        .find(|info| info.session_origin == Some(pane.id) && info.id != pane.id)
        .expect("the pane restores automatically");
    assert_eq!(
        restored.state,
        proto::SessionState::Running,
        "{:?}",
        restored.resume_notice
    );
    assert!(!actor.running(&fixture.nonce));
    assert!(scope_emptied(&receipt), "the stale scope must be gone");
    fixture.cleanup();
}

#[tokio::test]
async fn scope_population_is_reclaimed_on_restart_after_root_exit() {
    if !houston_core::session_isolation::manager_available()
        || !Path::new("/run/systemd/system").is_dir()
    {
        eprintln!("SKIPPED: Linux user systemd required for scope population regression");
        return;
    }
    // Unlike the unavailable-manager fixture, this requires a real running user manager.
    detached_probe(true).await;
}

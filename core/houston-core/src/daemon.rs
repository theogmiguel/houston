use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{Error as IoError, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{broadcast, oneshot};

#[cfg(unix)]
use crate::adoption;
use crate::blocks::{BlockTracker, CommandBlock};
use crate::db::Db;
use crate::orchestrate;
use crate::scrollback::{Replay, Scrollback};
use crate::shellint;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const OUTBOUND_CAPACITY: usize = 4096;
const PTY_READ_BUF: usize = 16 * 1024;
const MAX_TITLE_LEN: usize = 40;
const IDLE_POLL_MS: u64 = 50;
const SPAWN_GRACE: Duration = Duration::from_secs(20);

const SWARM_WAKE_SETTLE: Duration = Duration::from_millis(40);
const SWARM_WAKE_LANE_MAX: usize = 16;

fn pty_dump_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| std::env::var_os("TR_DEBUG_PTY_DUMP").map(PathBuf::from))
        .as_deref()
}

#[cfg(unix)]
fn has_child_procs(pid: u32) -> Option<bool> {
    let tasks = std::fs::read_dir(format!("/proc/{pid}/task")).ok()?;
    let mut any_read = false;
    for task in tasks.flatten() {
        if let Ok(list) = std::fs::read_to_string(task.path().join("children")) {
            any_read = true;
            if !list.trim().is_empty() {
                return Some(true);
            }
        }
    }
    any_read.then_some(false)
}

#[cfg(unix)]
fn direct_child_pids(pid: u32) -> Option<Vec<u32>> {
    let tasks = std::fs::read_dir(format!("/proc/{pid}/task")).ok()?;
    let mut any_read = false;
    let mut children = Vec::new();
    for task in tasks.flatten() {
        if let Ok(list) = std::fs::read_to_string(task.path().join("children")) {
            any_read = true;
            children.extend(
                list.split_whitespace()
                    .filter_map(|s| s.parse::<u32>().ok()),
            );
        }
    }
    any_read.then_some(children)
}

#[cfg(target_os = "linux")]
fn child_env_var(root_pid: u32, var: &str) -> Option<String> {
    let needle = format!("{var}=");
    let mut queue = std::collections::VecDeque::from([root_pid]);
    let mut seen = 0u32;
    while let Some(pid) = queue.pop_front() {
        seen += 1;
        if seen > 64 {
            return None;
        }
        if pid != root_pid {
            if let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) {
                for part in env.split(|b| *b == 0) {
                    if let Some(v) = std::str::from_utf8(part)
                        .ok()
                        .and_then(|s| s.strip_prefix(&needle))
                    {
                        if !v.is_empty() {
                            return Some(v.to_string());
                        }
                    }
                }
            }
        }
        if let Some(kids) = direct_child_pids(pid) {
            queue.extend(kids);
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn child_env_var(_root_pid: u32, _var: &str) -> Option<String> {
    None
}

#[cfg(unix)]
fn is_zombie(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    stat.rfind(')')
        .and_then(|paren| stat.get(paren + 1..)?.split_whitespace().next())
        .is_some_and(|state| state == "Z")
}

#[cfg(windows)]
mod win_liveness {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    pub(super) fn scan(pid: u32) -> Option<(bool, Vec<u32>)> {
        // SAFETY: FFI to the Win32 ToolHelp API. `entry.dwSize` is set before the
        // first `Process32FirstW`/`Process32NextW` call, as those functions require;
        // `snap` is checked against `INVALID_HANDLE_VALUE` before use and closed once.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut self_exists = false;
            let mut children = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut listed = Process32FirstW(snap, &mut entry) != 0;
            while listed {
                if entry.th32ProcessID == pid {
                    self_exists = true;
                } else if entry.th32ParentProcessID == pid {
                    children.push(entry.th32ProcessID);
                }
                listed = Process32NextW(snap, &mut entry) != 0;
            }
            let _ = CloseHandle(snap);
            children.sort_unstable();
            children.dedup();
            Some((self_exists, children))
        }
    }
}

#[cfg(windows)]
fn has_child_procs(pid: u32) -> Option<bool> {
    win_liveness::scan(pid).and_then(|(alive, children)| alive.then_some(!children.is_empty()))
}

#[cfg(windows)]
fn direct_child_pids(pid: u32) -> Option<Vec<u32>> {
    win_liveness::scan(pid)
        .filter(|(alive, _)| *alive)
        .map(|(_, children)| children)
}

#[cfg(windows)]
fn is_zombie(_pid: u32) -> bool {
    false
}

// Caps the BFS over procfs so an unusually large descendant tree can't hang a
// liveness check; hitting the cap reports "not running" rather than failing
// closed, biasing an oversized tree toward being reaped over being stuck open.
const MAX_DESCENDANTS_SCANNED: usize = 4096;

fn screen_fingerprint(lines: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for line in lines {
        line.hash(&mut hasher);
    }
    hasher.finish()
}

fn has_running_procs(pid: u32) -> Option<bool> {
    let mut frontier = direct_child_pids(pid)?;
    let mut visited = 0usize;
    while let Some(child) = frontier.pop() {
        if visited >= MAX_DESCENDANTS_SCANNED {
            return Some(false);
        }
        visited += 1;
        if !is_zombie(child) {
            return Some(true);
        }
        if let Some(grandchildren) = direct_child_pids(child) {
            frontier.extend(grandchildren);
        }
    }
    Some(false)
}

#[cfg(test)]
mod process_liveness_tests {
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const SPAWN_SETTLE: Duration = Duration::from_secs(2);

    #[cfg(unix)]
    fn spawn_childless_sleeper() -> std::process::Child {
        let mut c = Command::new("sleep");
        c.arg("5");
        spawn_stdiod(c, "spawn a childless sleep")
    }

    #[cfg(windows)]
    fn spawn_childless_sleeper() -> std::process::Child {
        let mut c = Command::new("ping");
        c.args(["-n", "6", "127.0.0.1"]);
        spawn_stdiod(c, "spawn a childless ping")
    }

    #[cfg(unix)]
    fn spawn_shell_with_live_direct_child() -> std::process::Child {
        let mut c = Command::new("sh");
        c.args(["-c", "sh -c 'sleep 5' & wait"]);
        spawn_stdiod(c, "spawn outer shell")
    }

    #[cfg(windows)]
    fn spawn_shell_with_live_direct_child() -> std::process::Child {
        let mut c = Command::new("cmd");
        c.args(["/C", "cmd /C ping -n 6 127.0.0.1"]);
        spawn_stdiod(c, "spawn outer cmd")
    }

    #[cfg(unix)]
    fn spawn_two_level_tree() -> std::process::Child {
        let mut c = Command::new("sh");
        c.args(["-c", "sh -c 'sh -c \"sleep 5\" & wait' & wait"]);
        spawn_stdiod(c, "spawn outer shell")
    }

    #[cfg(windows)]
    fn spawn_two_level_tree() -> std::process::Child {
        let mut c = Command::new("cmd");
        c.args(["/C", "cmd /C cmd /C ping -n 6 127.0.0.1"]);
        spawn_stdiod(c, "spawn triple-nested cmd")
    }

    #[cfg(unix)]
    fn spawn_fast_exiter() -> std::process::Child {
        Command::new("true").spawn().expect("spawn true")
    }

    #[cfg(windows)]
    fn spawn_fast_exiter() -> std::process::Child {
        Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("spawn cmd /C exit 0")
    }

    fn spawn_stdiod(mut cmd: Command, what: &'static str) -> std::process::Child {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn().expect(what)
    }

    fn wait_until(mut f: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + SPAWN_SETTLE;
        loop {
            if f() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn has_child_procs_sees_a_direct_child_but_not_a_grandchild() {
        let mut child = spawn_shell_with_live_direct_child();
        let pid = child.id();

        assert!(
            wait_until(|| has_child_procs(pid) == Some(true)),
            "the outer shell must show its inner shell as a direct child"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn has_running_procs_finds_a_live_grandchild_a_direct_check_misses() {
        let mut child = spawn_two_level_tree();
        let pid = child.id();

        assert!(
            wait_until(|| has_running_procs(pid) == Some(true)),
            "a live grandchild several levels deep must be found"
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn has_child_procs_and_has_running_procs_agree_on_no_children() {
        let mut child = spawn_childless_sleeper();
        let pid = child.id();

        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(has_child_procs(pid), Some(false));
        assert_eq!(has_running_procs(pid), Some(false));

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn has_child_procs_and_has_running_procs_report_none_for_a_gone_pid() {
        for _ in 0..64 {
            let mut child = spawn_fast_exiter();
            let pid = child.id();
            child.wait().expect("wait for the fast exiter");
            drop(child);

            if has_child_procs(pid).is_none() {
                assert_eq!(has_running_procs(pid), None);
                return;
            }
        }
        if cfg!(windows) && std::env::var_os("CI").is_some() {
            eprintln!("SKIPPED on Windows CI: all 64 reaped pids were recycled before the probe");
            return;
        }
        panic!("no reaped pid stayed unrecycled long enough to probe in 64 attempts");
    }

    #[test]
    fn is_zombie_is_false_for_a_live_process_and_fails_soft_for_a_gone_one() {
        let mut child = spawn_childless_sleeper();
        let pid = child.id();
        assert!(!is_zombie(pid), "a freshly spawned process is not a zombie");
        let _ = child.kill();
        let _ = child.wait();

        assert!(!is_zombie(pid));
    }

    #[cfg(unix)]
    #[test]
    fn has_child_procs_reports_true_for_a_zombie_but_running_procs_does_not() {
        let mut child = Command::new("sh")
            .args(["-c", "sh -c 'exit 0' & exec sleep 5"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a parent that backgrounds a fast-exiting child");
        let pid = child.id();

        let became_zombie = wait_until(|| {
            direct_child_pids(pid)
                .unwrap_or_default()
                .iter()
                .any(|&c| is_zombie(c))
        });
        assert!(
            became_zombie,
            "the backgrounded fast-exiting child must become a zombie before its \
             parent's own `sleep` finishes"
        );

        assert_eq!(has_child_procs(pid), Some(true));
        assert_eq!(has_running_procs(pid), Some(false));

        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(windows)]
fn session_spawn_dir(cwd: &Path) -> (PathBuf, Option<PathBuf>) {
    const RISK_LEN: usize = 230;
    if cwd.as_os_str().len() < RISK_LEN {
        return (cwd.to_path_buf(), None);
    }
    if let Some(short) = short_path_alias(cwd, RISK_LEN) {
        return (short, None);
    }
    let mut ancestor = cwd.to_path_buf();
    while ancestor.as_os_str().len() >= RISK_LEN {
        match ancestor.parent() {
            Some(p) => ancestor = p.to_path_buf(),
            None => break,
        }
    }
    let ancestor = if ancestor.as_os_str().len() < RISK_LEN {
        ancestor
    } else {
        std::env::temp_dir()
    };
    (ancestor, Some(cwd.to_path_buf()))
}

#[cfg(not(windows))]
fn session_spawn_dir(cwd: &Path) -> (PathBuf, Option<PathBuf>) {
    (cwd.to_path_buf(), None)
}

#[cfg(windows)]
fn short_path_alias(p: &Path, max_len: usize) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is null-terminated for the first, buffer-probing call; the
    // second call's `buf` is sized from that call's own returned length before
    // `GetShortPathNameW` writes into it.
    unsafe {
        let need = GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
        if need == 0 || need as usize >= max_len {
            return None;
        }
        let mut buf = vec![0u16; need as usize];
        let written = GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), need);
        if written == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(
            &buf[..written as usize],
        )))
    }
}

const CLI_TITLE_MIN_GAP_MS: u64 = 1000;

#[derive(Clone)]
pub enum Outbound {
    Frame(Arc<Vec<u8>>),
    Control(Arc<String>),
    ControlFor(u64, Arc<String>),
}

pub struct Session {
    info: proto::SessionInfo,
    pid: Option<u32>,
    custom_cmd: Option<Vec<String>>,
    state: Mutex<proto::SessionState>,
    title: Mutex<String>,
    project_dir: Mutex<String>,
    detected: Mutex<Option<proto::AgentKind>>,
    blocks: Option<Mutex<BlockTracker>>,
    shell_token_redactor: Option<Mutex<shellint::TokenRedactor>>,
    raw_output_bytes: AtomicU64,
    shell_token_file: Option<PathBuf>,
    shell: Option<String>,
    osc_cwd: Mutex<Option<PathBuf>>,
    osc52: Mutex<crate::osc52::Osc52Scanner>,
    osc_title: Option<Mutex<crate::osc_title::OscTitleScanner>>,
    cli_title: Mutex<CliTitleState>,
    title_source: Mutex<TitleSource>,
    tags: Mutex<Vec<u32>>,
    acp: Option<Mutex<crate::acp::AcpDecoder>>,
    scrollback: Mutex<Scrollback>,
    ws_attaches: AtomicU32,
    vt: Mutex<Option<crate::vt::Emulator>>,
    vt_refused: AtomicBool,
    last_output: AtomicU64,
    status: Mutex<Option<proto::AgentStatus>>,
    context: Mutex<Option<proto::SessionContext>>,
    removed: AtomicBool,
    backend_exited: AtomicBool,
    hook_cwd: Mutex<Option<String>>,
    hook_last_message: Mutex<Option<String>>,
    geometry: AtomicU32,
    backend: Backend,
    supervisor_wait: Mutex<SupervisorWaitState>,
    park: Arc<ParkState>,
}

#[derive(Default)]
struct ParkState {
    inner: Mutex<ParkInner>,
    cond: std::sync::Condvar,
}

#[derive(Default)]
struct ParkInner {
    #[cfg(unix)]
    reader_tid: Option<u64>,
    requested: bool,
    parked: bool,
    generation: u64,
}

impl ParkState {
    #[cfg(unix)]
    fn request_and_wait(&self, timeout: std::time::Duration) -> bool {
        let mut guard = self.inner.lock().expect("park lock");
        guard.requested = true;
        guard.generation = guard.generation.wrapping_add(1);
        #[cfg(unix)]
        if let Some(tid) = guard.reader_tid {
            // SAFETY: `tid` is this session's own PTY-reader thread, which outlives the
            // session and is never joined or reused; SIGUSR1 has a process-wide noop
            // handler installed below, so a signal that misses its target is harmless.
            unsafe {
                libc::pthread_kill(tid as libc::pthread_t, libc::SIGUSR1);
            }
        }
        if guard.reader_tid.is_none() {
            return true;
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if guard.parked {
                return true;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            let (g, _timed_out) = self
                .cond
                .wait_timeout(guard, deadline - now)
                .expect("park cond wait");
            guard = g;
        }
    }

    fn check_and_wait_if_requested(&self) {
        let mut guard = self.inner.lock().expect("park lock");
        if !guard.requested {
            return;
        }
        let my_generation = guard.generation;
        guard.parked = true;
        self.cond.notify_all();
        while guard.requested && guard.generation == my_generation {
            guard = self.cond.wait(guard).expect("park cond wait");
        }
        guard.parked = false;
    }

    #[cfg(unix)]
    fn resume(&self) {
        let mut guard = self.inner.lock().expect("park lock");
        guard.requested = false;
        guard.generation = guard.generation.wrapping_add(1);
        self.cond.notify_all();
    }

    #[cfg(unix)]
    fn set_reader_tid(&self, tid: libc::pthread_t) {
        self.inner.lock().expect("park lock").reader_tid = Some(tid);
    }
}

#[cfg(unix)]
fn ensure_quiesce_signal_installed() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    // SAFETY: `sigaction` is zeroed and every field the kernel reads (`sa_sigaction`,
    // `sa_mask`, `sa_flags`) is set before the syscall; `call_once` bounds this to one
    // installation, so no other thread observes a partially-initialized struct.
    INSTALLED.call_once(|| unsafe {
        extern "C" fn noop(_: libc::c_int) {}
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = noop as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = 0;
        libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut());
    });
}

#[derive(Default)]
struct SupervisorWaitState {
    eof: bool,
    exit: Option<(Option<i32>, Option<i32>)>,
}

enum Backend {
    Pty {
        writer: Mutex<Option<Box<dyn Write + Send>>>,
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
        killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    },
    Ssh(crate::ssh::SshHandle),
    #[cfg(unix)]
    AdoptedPty(crate::adoption::RawMasterPty),
}

#[derive(Debug)]
pub struct StdinWriteError {
    pub written: Option<usize>,
    pub error: anyhow::Error,
}

impl StdinWriteError {
    pub fn nothing_written(&self) -> bool {
        self.written == Some(0)
    }

    fn nothing(error: anyhow::Error) -> Self {
        Self {
            written: Some(0),
            error,
        }
    }

    fn unknown(error: anyhow::Error) -> Self {
        Self {
            written: None,
            error,
        }
    }
}

impl std::fmt::Display for StdinWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.written {
            Some(0) => write!(f, "{:#} (nothing was written)", self.error),
            Some(n) => write!(f, "{:#} ({n} byte(s) had already been written)", self.error),
            None => write!(
                f,
                "{:#} (this backend cannot say how much was written)",
                self.error
            ),
        }
    }
}

fn write_all_counting(w: &mut dyn Write, data: &[u8]) -> std::result::Result<(), (usize, IoError)> {
    let mut done = 0usize;
    while done < data.len() {
        match w.write(&data[done..]) {
            Ok(0) => {
                return Err((
                    done,
                    IoError::new(
                        std::io::ErrorKind::WriteZero,
                        "the terminal accepted no further bytes",
                    ),
                ))
            }
            Ok(n) => done += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err((done, e)),
        }
    }
    Ok(())
}

impl Backend {
    fn write_stdin(&self, id: u32, data: &[u8]) -> Result<()> {
        self.write_stdin_counting(id, data).map_err(|e| e.error)
    }

    fn write_stdin_counting(
        &self,
        id: u32,
        data: &[u8],
    ) -> std::result::Result<(), StdinWriteError> {
        match self {
            Backend::Pty { writer, .. } => {
                let mut w = writer.lock().expect("writer lock");
                let Some(w) = w.as_mut() else {
                    return Err(StdinWriteError::nothing(anyhow!(
                        "session {id} has no live pty (already killed)"
                    )));
                };
                write_all_counting(w.as_mut(), data).map_err(|(written, e)| StdinWriteError {
                    written: Some(written),
                    error: anyhow::Error::new(e).context(format!("writing stdin to session {id}")),
                })?;
                w.flush().ok();
                Ok(())
            }
            Backend::Ssh(h) => h.write_stdin(data).map_err(|e| {
                StdinWriteError::unknown(e.context(format!("writing stdin to ssh session {id}")))
            }),
            #[cfg(unix)]
            Backend::AdoptedPty(raw) => raw.write_all(data).map_err(|e| {
                StdinWriteError::unknown(
                    e.context(format!("writing stdin to adopted session {id}")),
                )
            }),
        }
    }

    fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(u16, u16)> {
        match self {
            Backend::Pty { master, .. } => {
                let m = master.lock().expect("master lock");
                let Some(m) = m.as_ref() else {
                    bail!("session {id} has no live pty (already killed)");
                };
                m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| anyhow!("resize of session {id} to {cols}x{rows} failed: {e}"))?;
                let actual = m.get_size().map_err(|e| {
                    anyhow!("reading back size of session {id} after resize to {cols}x{rows}: {e}")
                })?;
                Ok((actual.cols, actual.rows))
            }
            Backend::Ssh(h) => {
                h.resize(cols, rows)
                    .with_context(|| format!("resizing ssh session {id}"))?;
                Ok((cols, rows))
            }
            #[cfg(unix)]
            Backend::AdoptedPty(raw) => raw
                .resize(cols, rows)
                .with_context(|| format!("resizing adopted session {id} to {cols}x{rows}")),
        }
    }

    fn release_pty(&self) {
        if let Backend::Pty { writer, master, .. } = self {
            *writer.lock().expect("writer lock") = None;
            *master.lock().expect("master lock") = None;
        }
        #[cfg(unix)]
        if let Backend::AdoptedPty(raw) = self {
            raw.release();
        }
    }

    fn kill(&self, id: u32, pid: Option<u32>) -> Result<()> {
        match self {
            Backend::Pty {
                writer,
                master,
                killer,
            } => {
                let result = {
                    #[cfg(unix)]
                    {
                        let _ = &pid;
                        killer
                            .lock()
                            .expect("killer lock")
                            .as_mut()
                            .map(|k| k.kill())
                            .unwrap_or_else(|| Ok(()))
                    }
                    #[cfg(windows)]
                    {
                        let _ = &killer;
                        match pid.map(|p| {
                            crate::pid::signal_process_checked(p, crate::pid::Signal::Term)
                        }) {
                            Some(Ok(_)) | None => Ok(()),
                            Some(Err(crate::pid::SignalError::Os(e))) => Err(e),
                            Some(Err(crate::pid::SignalError::InvalidPid(e))) => {
                                Err(std::io::Error::other(e.to_string()))
                            }
                        }
                    }
                };
                *writer.lock().expect("writer lock") = None;
                *master.lock().expect("master lock") = None;
                result.with_context(|| format!("killing session {id}"))
            }
            Backend::Ssh(h) => h.kill(),
            #[cfg(unix)]
            Backend::AdoptedPty(raw) => {
                let result = raw.kill();
                raw.release();
                result.with_context(|| format!("killing adopted session {id}"))
            }
        }
    }

    #[cfg(unix)]
    fn adoption_master_fd(&self) -> Option<std::os::fd::RawFd> {
        match self {
            Backend::Pty { master, .. } => master
                .lock()
                .expect("master lock")
                .as_ref()
                .and_then(|m| m.as_raw_fd()),
            Backend::Ssh(_) => None,
            Backend::AdoptedPty(raw) => raw.as_raw_fd(),
        }
    }
}

impl Session {
    fn remove_shell_token_file(&self) {
        let Some(path) = &self.shell_token_file else {
            return;
        };
        if let Err(e) = shellint::remove_token_file(path) {
            tracing::warn!(
                "cleaning shell integration token file {}: {e:#}",
                path.display()
            );
        }
    }

    fn geometry(&self) -> (u16, u16) {
        let packed = self.geometry.load(Ordering::Relaxed);
        ((packed >> 16) as u16, packed as u16)
    }

    fn set_geometry(&self, cols: u16, rows: u16) {
        self.geometry
            .store((u32::from(cols) << 16) | u32::from(rows), Ordering::Relaxed);
        if let Ok(mut vt) = self.vt.lock() {
            if let Some(emulator) = vt.as_mut() {
                emulator.resize(cols, rows);
            }
        }
    }

    fn vt(&self) -> std::sync::MutexGuard<'_, Option<crate::vt::Emulator>> {
        let mut guard = self.vt.lock().expect("vt lock");
        if guard.is_none() && crate::vt::available() && !self.vt_refused.load(Ordering::Relaxed) {
            let (cols, rows) = self.geometry();
            match crate::vt::Emulator::new(cols, rows, crate::vt::VT_HISTORY_BYTES) {
                Ok(emulator) => *guard = Some(emulator),
                Err(e) => {
                    self.vt_refused.store(true, Ordering::Relaxed);
                    tracing::warn!("no terminal emulator for this session: {e}");
                }
            }
        }
        guard
    }

    fn snapshot_info(&self) -> proto::SessionInfo {
        let mut info = self.info.clone();
        info.state = *self.state.lock().expect("state lock");
        info.title = self.title.lock().expect("title lock").clone();
        info.project_dir = self.project_dir.lock().expect("project_dir lock").clone();
        info.detected_agent = *self.detected.lock().expect("detected lock");
        info.status = *self.status.lock().expect("status lock");
        info.context = *self.context.lock().expect("context lock");
        info.tags = self.tags.lock().expect("tags lock").clone();
        info
    }

    fn status_kind(&self) -> proto::AgentKind {
        self.detected
            .lock()
            .expect("detected lock")
            .unwrap_or(self.info.agent)
    }

    fn watched(&self) -> bool {
        self.ws_attaches.load(Ordering::Relaxed) > 0
    }
}

pub struct DaemonConfig {
    pub token: String,
    pub db_path: PathBuf,
}

struct SwarmMailScope {
    reader: crate::scope::MailboxReader,
    watch: Arc<crate::fs_watch::MailWatchState>,
    _watcher: Option<notify::RecommendedWatcher>,
    last_swept: Option<std::time::Instant>,
    warned_unparseable: HashMap<PathBuf, HashSet<std::ffi::OsString>>,
}

#[derive(Debug, Clone, Copy)]
struct DelegationSettleSample {
    fingerprint: u64,
    still_since: u64,
    no_handback_reported: bool,
}

impl DelegationSettleSample {
    fn fresh(fingerprint: u64, now: u64) -> Self {
        Self {
            fingerprint,
            still_since: now,
            no_handback_reported: false,
        }
    }
}

/// A routine run in flight, keyed by routine id. The pane's session is the
/// whole record: a run has no conversation, only its independent run row.
#[derive(Debug, Clone, Copy)]
struct RoutineRun {
    run_id: u32,
    session_id: Option<u32>,
    started_at_ms: i64,
    denied: bool,
}

type RoutinePaneRegistrationHook = Box<dyn Fn(u32) + Send + Sync>;

/// The wire's routine update patch; absent fields stay as they are, and
/// `model`/`effort`/`workspace_id` are three-state (absent unchanged, `null`
/// clears, value sets).
#[derive(Default)]
pub struct RoutinePatch {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub cadence: Option<proto::Cadence>,
    pub enabled: Option<bool>,
    pub workspace_id: Option<Option<String>>,
    pub engine: Option<proto::AgentKind>,
    pub model: Option<Option<String>>,
    pub effort: Option<Option<proto::ChatEffort>>,
    pub permission_mode: Option<proto::ChatPermissionMode>,
    pub isolate: Option<bool>,
}

pub struct Daemon {
    pub token: String,
    pub mcp_creds: crate::mcp_creds::Registry,
    pub mcp_notify: crate::mcp_server::NotifierRegistry,
    pub mcp_tools: crate::mcp_server::ToolRegistry,
    pub browser_relay: Arc<crate::browser_relay::BrowserRelayState>,
    pub voice: crate::voice::runtime::Runtime,
    mcp_progress_tick_ms: AtomicU64,
    handoff_batch_ms: AtomicU64,
    last_inbox_retention: AtomicU64,
    mcp_checks: Mutex<HashMap<String, (String, proto::McpConnectionCheck)>>,
    cli_probes: Mutex<crate::cli_probe::ProbeCache>,
    model_catalog: Arc<crate::model_catalog::ModelCatalog>,
    db: Db,
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    tags: Mutex<BTreeMap<u32, proto::TagInfo>>,
    dead: Mutex<HashMap<u32, proto::SessionInfo>>,
    respawned_as: Mutex<HashMap<u32, u32>>,
    workspace_membership: Mutex<()>,
    state_dir: PathBuf,
    db_path: PathBuf,
    scrollback_dir: PathBuf,
    shellint_dir: Option<PathBuf>,
    ledger_tx: mpsc::Sender<LedgerEntry>,
    recovery: Mutex<Option<proto::RecoverySummary>>,
    handoff_jobs: Mutex<HashMap<u32, HandoffJob>>,
    next_handoff: AtomicU32,
    ssh_prompts: Mutex<HashMap<u32, oneshot::Sender<crate::ssh::HostKeyVerdict>>>,
    known_hosts: PathBuf,
    channel: Option<String>,
    started: Instant,
    swarm_mail: Mutex<HashMap<u64, SwarmMailScope>>,
    swarm_mail_wake: Arc<tokio::sync::Notify>,
    swarm_mail_ladder: Mutex<crate::fs_watch::PollLadder>,
    routine_wake: Arc<tokio::sync::Notify>,
    delegation_wake: Arc<tokio::sync::Notify>,
    idle_tick_counts: [AtomicU64; 2],
    checkpoint_lock: Mutex<()>,
    reap_armed: Mutex<Option<ReapArm>>,
    reap_generation: AtomicU64,
    exit_hook: Mutex<Box<dyn Fn() + Send + Sync>>,
    shutting_down: AtomicBool,
    handing_off: AtomicBool,
    handed_off: AtomicBool,
    #[cfg(target_os = "linux")]
    handoff_reap: Mutex<()>,
    #[cfg(unix)]
    supervisor_writer: Mutex<Option<std::os::unix::net::UnixStream>>,
    #[cfg(unix)]
    listener_fd: Mutex<Option<std::os::fd::RawFd>>,
    #[cfg(unix)]
    lock_fd: Mutex<Option<std::os::fd::RawFd>>,
    server_abort: Mutex<Option<tokio::task::AbortHandle>>,
    #[cfg(unix)]
    server_shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    swarm_activity: Mutex<HashMap<u64, (String, u64)>>,
    operator_ended: Mutex<HashSet<u32>>,
    visibility: Mutex<HashMap<u64, HashSet<u32>>>,
    next_conn_id: AtomicU64,
    frame_taps: Arc<crate::frame_queue::FrameRegistry>,
    swarm_terminal_since: Mutex<HashMap<u64, u64>>,
    swarm_finished_sessions: Mutex<HashSet<u32>>,
    inbox_flush_scheduled: Mutex<HashSet<u32>>,
    composer_occupied: Mutex<HashMap<u32, u64>>,
    paste_confirmations: Mutex<HashMap<u32, (String, u64)>>,
    turn_start_round: Mutex<HashMap<u32, u32>>,
    last_prompt_id: Mutex<HashMap<u32, String>>,
    prompt_awaiting_hook: Mutex<HashSet<u32>>,
    stdin_partial_after: Mutex<HashMap<u32, usize>>,
    inbox_pending_max: AtomicU32,
    inbox_wake: Mutex<HashMap<u32, Arc<tokio::sync::Notify>>>,
    inbox_waiting: Mutex<HashSet<u32>>,
    temporary_cleanup_lock: Mutex<()>,
    swarm_wake_lanes: Mutex<HashMap<u32, WakeLane>>,
    swarm_wake_generation: AtomicU64,
    delegation_settle: Mutex<HashMap<u32, DelegationSettleSample>>,
    subagent_rounds: Mutex<HashMap<u32, orchestrate::SubagentRound>>,
    stop_blocks: Mutex<HashMap<u32, u32>>,
    permission_episodes: Mutex<HashMap<u32, orchestrate::PermissionEpisodes>>,
    antigravity_roots: Mutex<HashMap<u32, String>>,
    routine_runs: Mutex<HashMap<u32, RoutineRun>>,
    routine_settle: Mutex<HashMap<u32, DelegationSettleSample>>,
    routine_pane_cmd_override: Mutex<Option<Vec<String>>>,
    routine_pane_registration_hook_for_test: Mutex<Option<RoutinePaneRegistrationHook>>,
    self_weak: Mutex<std::sync::Weak<Daemon>>,
    hook_state_lock: Mutex<()>,
    hook_drop_states: Mutex<HashMap<PathBuf, crate::hook_drop::DropDirState>>,
    hook_drop_watch: Arc<crate::fs_watch::MailWatchState>,
    _hook_drop_watcher: Mutex<Option<notify::RecommendedWatcher>>,
    port: Mutex<Option<u16>>,
    run_state_started_at: u64,
    run_state_expected_restart: AtomicBool,
    startup_cause: StartupCause,
    safe_mode_flags: SafeModeFlags,
    pub(crate) update_state: Mutex<proto::UpdateState>,
    pub(crate) update_wake: Arc<tokio::sync::Notify>,
    pub(crate) update_check_lock: tokio::sync::Mutex<()>,
    pub(crate) release_cache: tokio::sync::Mutex<crate::updates::ReleaseCache>,
    tx: broadcast::Sender<Outbound>,
}

const SESSION_IDLE_REAP_ENABLED_KEY: &str = "session_idle_reap_enabled";
const SESSION_IDLE_REAP_MINUTES_KEY: &str = "session_idle_reap_minutes";

const SESSION_IDLE_REAP_MINUTES_MAX: u32 = 40_000;

const KEYMAP_OVERRIDES_KEY: &str = "keymap_overrides";
const SKILL_AUTO_PUSH_KEY: &str = "skill_sync_auto_push";

const COMMAND_HISTORY_IGNORE_KEY: &str = "command_history_ignore_globs";

const VOICE_SETTINGS_KEY: &str = "voice_settings";

const VOICE_DOWNLOAD_PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);

fn voice_wants_open(settings: &proto::VoiceSettings, monitoring: bool, capturing: bool) -> bool {
    (settings.enabled && settings.mic_policy == proto::MicPolicy::Persistent)
        || monitoring
        || capturing
}

fn voice_capture_failure(e: &crate::voice::capture::CaptureError) -> proto::VoiceFailure {
    use crate::voice::capture::CaptureError;
    match e {
        CaptureError::TooQuiet { rms, floor } => proto::VoiceFailure::TooQuiet {
            rms: *rms,
            floor: *floor,
        },
        CaptureError::TooShort { secs, floor } => proto::VoiceFailure::TooShort {
            seconds: *secs,
            minimum: *floor,
        },
        CaptureError::StreamDead { device, silent_for } => proto::VoiceFailure::DeviceUnavailable {
            device: format!(
                "{device} (no audio callback for {:.1}s — unplugged?)",
                silent_for.as_secs_f32()
            ),
        },
        CaptureError::NoInputDevice => proto::VoiceFailure::DeviceUnavailable {
            device: "system default (no input device is present)".to_string(),
        },
        CaptureError::DeviceUnavailable { device, reason } => {
            proto::VoiceFailure::DeviceUnavailable {
                device: format!("{device} ({reason})"),
            }
        }
    }
}

const KEYMAP_OVERRIDES_MAX_BINDINGS: usize = 64;
const KEYMAP_OVERRIDES_MAX_CODE_LEN: usize = 64;

struct HandoffJob {
    hidden: u32,
    provider_name: String,
    buffer: Vec<u8>,
    last_activity: Instant,
    prompt_path: PathBuf,
    out_dir: PathBuf,
    eof: bool,
    exit: Option<Option<i32>>,
    fail_reason: Option<String>,
}

// Bounds one handoff job's buffered output so a runaway or silent hidden pane
// can't grow it unbounded; output past the cap is dropped from the buffer, not
// from the live chunks already broadcast.
const HANDOFF_BUFFER_CAP: usize = 2 * 1024 * 1024;

fn handoff_timeout() -> Duration {
    std::env::var("HOUSTON_HANDOFF_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(60))
}

struct LedgerEntry {
    workspace: String,
    session_id: u32,
    shell: String,
    block: CommandBlock,
}

const CLEAN_SHUTDOWN_FILE: &str = "clean-shutdown";

// How long the reap predicate must hold before the daemon actually exits: long
// enough to survive an app upgrade or a crash-and-relaunch, short enough that a
// forgotten daemon doesn't squat a machine for a day.
const REAP_GRACE_MS: u64 = 5 * 60 * 1000;

const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

fn shutdown_drain_timeout() -> Duration {
    std::env::var("HOUSTON_SHUTDOWN_DRAIN_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(SHUTDOWN_DRAIN_TIMEOUT)
}

const SHUTDOWN_DRAIN_POLL_MS: u64 = 20;

struct ReapArm {
    generation: u64,
    deadline_ms: i64,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Debug)]
pub struct ShutdownFailure {
    pub reason: String,
    pub unterminated: Vec<u32>,
}

const RUN_STATE_FILE: &str = "run-state.json";

const RUN_STATE_READ_CAP: u64 = 4096;

const RUN_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunState {
    schema_version: u32,
    started_at: u64,
    last_seen_at: u64,
    session_count: u32,
    swarm_count: u32,
    expected_restart: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StartupCause {
    pub abnormal_exit: bool,
    pub runtime_ms: Option<u64>,
    pub session_count: Option<u32>,
    pub swarm_count: Option<u32>,
    pub expected_restart: bool,
}

impl StartupCause {
    const NO_DETAIL: StartupCause = StartupCause {
        abnormal_exit: false,
        runtime_ms: None,
        session_count: None,
        swarm_count: None,
        expected_restart: false,
    };
}

fn read_run_state_detail(path: &Path) -> Option<RunState> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(
                "reading run-state file {}: {e} — treating detail as unavailable",
                path.display()
            );
            return None;
        }
    };
    if meta.len() > RUN_STATE_READ_CAP {
        tracing::warn!(
            "run-state file {} is {} byte(s), over the {RUN_STATE_READ_CAP}-byte cap (real \
             content is ~135-176 bytes) — skipping, treating detail as unavailable",
            path.display(),
            meta.len()
        );
        return None;
    }
    let raw = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::warn!(
                "reading run-state file {}: {e} — treating detail as unavailable",
                path.display()
            );
            return None;
        }
    };
    let state: RunState = match serde_json::from_slice(&raw) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "parsing run-state file {} ({} byte(s)) as JSON: {e} — treating detail as \
                 unavailable",
                path.display(),
                raw.len()
            );
            return None;
        }
    };
    if state.schema_version != RUN_STATE_SCHEMA_VERSION {
        tracing::warn!(
            "run-state file {} has schema_version {} (this build understands {}) — treating \
             detail as unavailable",
            path.display(),
            state.schema_version,
            RUN_STATE_SCHEMA_VERSION
        );
        return None;
    }
    Some(state)
}

fn read_and_derive_startup_cause(marker_path: &Path, run_state_path: &Path) -> StartupCause {
    let abnormal_exit = !marker_path.exists();
    match read_run_state_detail(run_state_path) {
        Some(state) => StartupCause {
            abnormal_exit,
            runtime_ms: Some(state.last_seen_at.saturating_sub(state.started_at)),
            session_count: Some(state.session_count),
            swarm_count: Some(state.swarm_count),
            expected_restart: state.expected_restart,
        },
        None => StartupCause {
            abnormal_exit,
            ..StartupCause::NO_DETAIL
        },
    }
}

fn remove_file_logged(path: &Path, what: &str) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("removing {what} {}: {e}", path.display());
        }
    }
}

fn count_files_recursive(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0u64;
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            n += count_files_recursive(&path);
        } else {
            n += 1;
        }
    }
    n
}

pub fn build_commit() -> &'static str {
    option_env!("HOUSTON_BUILD_COMMIT").unwrap_or("unknown")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_rfc3339_utc(unix_ms: u64) -> String {
    let total_secs = (unix_ms / 1000) as i64;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

const RESTORE_BUDGET_KEY: &str = "restore_budget";

const MAILBOX_RETENTION_HOURS_KEY: &str = "mailbox_retention_hours";

const ORCHESTRATION_MAX_LIVE_CHILDREN_KEY: &str = "orchestration_max_live_children";

const ORCHESTRATION_MAX_SPAWN_DEPTH_KEY: &str = "orchestration_max_spawn_depth";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SafeModeFlags {
    pub disable_auto_restore: bool,
    pub disable_swarm_autolaunch: bool,
}

impl SafeModeFlags {
    fn resolve(
        safe_mode: Option<&str>,
        disable_auto_restore: Option<&str>,
        disable_swarm_autolaunch: Option<&str>,
    ) -> Self {
        let on = |v: Option<&str>| v == Some("1");
        let safe_mode = on(safe_mode);
        Self {
            disable_auto_restore: safe_mode || on(disable_auto_restore),
            disable_swarm_autolaunch: safe_mode || on(disable_swarm_autolaunch),
        }
    }

    fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        Self::resolve(
            lookup("HOUSTON_SAFE_MODE").as_deref(),
            lookup("HOUSTON_DISABLE_AUTO_RESTORE").as_deref(),
            lookup("HOUSTON_DISABLE_SWARM_AUTOLAUNCH").as_deref(),
        )
    }
}

fn claude_mcp_add_args(server: &proto::McpServer) -> Option<Vec<String>> {
    let mut args: Vec<String> = vec!["add".into()];
    match server.transport {
        proto::McpTransport::Stdio => {
            let command = server.command.as_ref()?;
            args.push("-s".into());
            args.push("user".into());
            for (k, v) in &server.env {
                args.push("-e".into());
                args.push(format!("{k}={v}"));
            }
            args.push(server.name.clone());
            args.push("--".into());
            args.push(command.clone());
            args.extend(server.args.iter().cloned());
        }
        proto::McpTransport::Http | proto::McpTransport::Sse => {
            let url = server.url.as_ref()?;
            args.push("--transport".into());
            args.push(
                match server.transport {
                    proto::McpTransport::Sse => "sse",
                    _ => "http",
                }
                .into(),
            );
            args.push("-s".into());
            args.push("user".into());
            args.push(server.name.clone());
            args.push(url.clone());
            for (k, v) in &server.headers {
                args.push("--header".into());
                args.push(format!("{k}: {v}"));
            }
        }
    }
    Some(args)
}

fn run_claude_mcp(args: &[String]) -> Result<()> {
    let claude = crate::exe_path::resolve("claude").unwrap_or_else(|| PathBuf::from("claude"));
    let out = crate::spawn::command(claude).arg("mcp").args(args).output();
    match out {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            bail!("`claude mcp {}` failed: {detail}", args.join(" "))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            bail!("the `claude` CLI is not on PATH — Claude Code manages its own list here")
        }
        Err(e) => bail!("running `claude mcp {}`: {e}", args.join(" ")),
    }
}

#[cfg(test)]
mod safe_mode_flags_tests {
    use super::*;

    #[test]
    fn no_flags_set_is_all_false() {
        assert_eq!(
            SafeModeFlags::resolve(None, None, None),
            SafeModeFlags::default()
        );
    }

    #[test]
    fn disable_auto_restore_alone_sets_only_itself() {
        let flags = SafeModeFlags::resolve(None, Some("1"), None);
        assert!(flags.disable_auto_restore);
        assert!(!flags.disable_swarm_autolaunch);
    }

    #[test]
    fn disable_swarm_autolaunch_alone_sets_only_itself() {
        let flags = SafeModeFlags::resolve(None, None, Some("1"));
        assert!(flags.disable_swarm_autolaunch);
        assert!(!flags.disable_auto_restore);
    }

    #[test]
    fn safe_mode_turns_every_flag_on() {
        let flags = SafeModeFlags::resolve(Some("1"), None, None);
        assert!(flags.disable_auto_restore);
        assert!(flags.disable_swarm_autolaunch);
    }

    #[test]
    fn only_the_literal_one_arms_a_flag() {
        let flags = SafeModeFlags::resolve(Some("0"), Some("true"), Some("yes"));
        assert_eq!(flags, SafeModeFlags::default());
    }

    #[test]
    fn from_lookup_wires_each_var_to_its_own_field() {
        let auto_restore_only = SafeModeFlags::from_lookup(|name| {
            (name == "HOUSTON_DISABLE_AUTO_RESTORE").then(|| "1".to_string())
        });
        assert!(auto_restore_only.disable_auto_restore);
        assert!(!auto_restore_only.disable_swarm_autolaunch);

        let swarm_autolaunch_only = SafeModeFlags::from_lookup(|name| {
            (name == "HOUSTON_DISABLE_SWARM_AUTOLAUNCH").then(|| "1".to_string())
        });
        assert!(swarm_autolaunch_only.disable_swarm_autolaunch);
        assert!(!swarm_autolaunch_only.disable_auto_restore);

        let safe_mode_only = SafeModeFlags::from_lookup(|name| {
            (name == "HOUSTON_SAFE_MODE").then(|| "1".to_string())
        });
        assert!(safe_mode_only.disable_auto_restore);
        assert!(safe_mode_only.disable_swarm_autolaunch);
    }
}

fn restore_priority(agent: proto::AgentKind) -> u8 {
    match agent {
        proto::AgentKind::Claude => 0,
        proto::AgentKind::Codex => 1,
        proto::AgentKind::Antigravity => 2,
        proto::AgentKind::Opencode => 3,
        proto::AgentKind::Cursor => 4,
        proto::AgentKind::Grok => 5,
        proto::AgentKind::Shell => 6,
        _ => 7,
    }
}

fn spawn_ledger_writer(daemon: &Arc<Daemon>, rx: mpsc::Receiver<LedgerEntry>) {
    let weak = Arc::downgrade(daemon);
    std::thread::Builder::new()
        .name("ledger-writer".into())
        .spawn(move || {
            while let Ok(e) = rx.recv() {
                let Some(daemon) = weak.upgrade() else { break };
                let branch = crate::git::branch(Path::new(&e.block.cwd));
                if daemon.command_history_ignored(&e.block.cmd, &e.block.cwd) {
                    continue;
                }
                if let Err(err) = daemon.db.insert_command(
                    &e.workspace,
                    e.session_id,
                    &e.block.cwd,
                    &e.block.cmd,
                    e.block.exit,
                    &e.shell,
                    branch.as_deref(),
                    e.block.started_at,
                    e.block.ended_at,
                ) {
                    tracing::warn!(
                        "recording command of session {} in the ledger: {err}",
                        e.session_id
                    );
                }
            }
        })
        .expect("spawn ledger writer thread");
}

pub struct CreateParams {
    pub agent: proto::AgentKind,
    pub project_dir: PathBuf,
    pub cmd: Option<Vec<String>>,
    pub cols: u16,
    pub rows: u16,
    pub cwd_from: Option<u32>,
    pub shell_integration: bool,
    pub auto_approve: bool,
    pub acp: Option<String>,
    pub profile: Option<proto::ProfileChoice>,
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum TitleSource {
    Codename,
    Prompt,
    Role,
    Cli,
    User,
}

impl TitleSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Codename => "codename",
            Self::Prompt => "prompt",
            Self::Role => "role",
            Self::Cli => "cli",
            Self::User => "user",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "codename" => Some(Self::Codename),
            "prompt" => Some(Self::Prompt),
            "role" => Some(Self::Role),
            "cli" => Some(Self::Cli),
            "user" => Some(Self::User),
            _ => None,
        }
    }

    fn restored(stored: Option<&str>, title: &str) -> Self {
        if let Some(source) = stored.and_then(Self::parse) {
            return source;
        }
        if crate::pane_name::is_codename(title) {
            return Self::Codename;
        }
        if crate::pane_name::title_from_prompt(title, MAX_TITLE_LEN).as_deref() == Some(title) {
            return Self::Prompt;
        }
        Self::User
    }
}

#[derive(Debug, Default)]
struct CliTitleState {
    last_applied_ms: u64,
    pending: Option<String>,
    flush_scheduled: bool,
}

struct SpawnParams {
    id: u32,
    agent: proto::AgentKind,
    project_dir: PathBuf,
    cwd: PathBuf,
    custom_cmd: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    title: String,
    title_source: TitleSource,
    codename: String,
    tags: Vec<u32>,
    shell_integration: bool,
    hidden: bool,
    shell_override: Option<String>,
    swarm_agent: Option<u64>,
    spawned_by: Option<u32>,
    extra_args: Vec<String>,
    extra_env: Vec<(String, String)>,
    wrap: Option<Vec<String>>,
    acp: Option<String>,
    profile_label: Option<String>,
}

type ProfileSpawnEnv = (Option<(String, String)>, Option<String>);

type ProfileSpawnEnvList = (Vec<(String, String)>, Option<String>);

type AdoptedSessions = Vec<(Arc<Session>, Box<dyn Read + Send>)>;

#[cfg(windows)]
fn conpty_warmup() {
    use std::sync::OnceLock;
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.get().is_some() {
        return;
    }
    let _ = DONE.set(());
    let started = Instant::now();
    let spawned = std::thread::Builder::new()
        .name("conpty-warmup".to_string())
        .spawn(move || {
            const WARMUP_TIMEOUT: Duration = Duration::from_secs(10);

            let pty = native_pty_system();
            let pair = match pty.openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("ConPTY warmup skipped (openpty failed: {e})");
                    return;
                }
            };
            let mut cmd = CommandBuilder::new("cmd");
            cmd.arg("/C");
            cmd.arg("exit");
            let mut child = match pair.slave.spawn_command(cmd) {
                Ok(child) => child,
                Err(e) => {
                    tracing::warn!("ConPTY warmup skipped (spawn failed: {e})");
                    return;
                }
            };
            drop(pair.slave);
            let mut killer = child.clone_killer();
            let deadline = Instant::now() + WARMUP_TIMEOUT;
            let exited = loop {
                match child.try_wait() {
                    Ok(Some(_)) => break true,
                    Ok(None) if Instant::now() >= deadline => break false,
                    Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                    Err(_) => break false,
                }
            };
            if !exited {
                let _ = killer.kill();
            }
            drop(pair.master);
            tracing::info!(
                "ConPTY warmup complete in {:?}{} - first-spawn Defender/dll cost absorbed",
                started.elapsed(),
                if exited {
                    ""
                } else {
                    " (child killed at timeout)"
                }
            );
        });
    if let Err(e) = spawned {
        tracing::warn!("ConPTY warmup skipped (thread spawn failed: {e})");
    }
}

#[cfg(windows)]
fn read_openssh_default_shell() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let subkey: Vec<u16> = "SOFTWARE\\OpenSSH"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value: Vec<u16> = "DefaultShell"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: FFI to the Win32 registry API. The first call passes a null output
    // buffer to size `cb`; the second allocates exactly `cb` bytes before writing,
    // as `RegGetValueW` requires.
    unsafe {
        let mut cb: u32 = 0;
        let status = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut cb,
        );
        if status != 0 || cb == 0 || cb > 4096 {
            return None;
        }
        let mut buf = vec![0u8; cb as usize];
        let status = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut cb,
        );
        if status != 0 {
            return None;
        }
        let wide: Vec<u16> = buf[..cb as usize]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .take_while(|&unit| unit != 0)
            .collect();
        String::from_utf16(&wide)
            .ok()
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
    }
}

#[cfg(windows)]
fn default_shell_ladder(
    shell_override: Option<&str>,
    shell_env: Option<&str>,
    openssh_default_shell: Option<&str>,
    windows_powershell: Option<&str>,
    comspec: Option<&str>,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut ladder: Vec<String> = Vec::new();
    let mut push = |candidate: String| {
        if !candidate.trim().is_empty() && !ladder.contains(&candidate) {
            ladder.push(candidate);
        }
    };
    if let Some(over) = shell_override {
        push(over.to_string());
    }
    if let Some(shell) = shell_env {
        if exists(shell) {
            push(shell.to_string());
        }
    }
    if let Some(reg) = openssh_default_shell {
        if exists(reg) {
            push(reg.to_string());
        }
    }
    if let Some(ps) = windows_powershell {
        if exists(ps) {
            push(ps.to_string());
        }
    }
    match comspec {
        Some(spec) => push(spec.to_string()),
        None => push("cmd.exe".to_string()),
    }
    ladder
}

#[cfg(windows)]
fn windows_default_shell_candidates(shell_override: Option<&str>) -> Vec<String> {
    use std::sync::OnceLock;
    static OPENSSH_DEFAULT_SHELL: OnceLock<Option<String>> = OnceLock::new();
    let openssh = OPENSSH_DEFAULT_SHELL
        .get_or_init(|| {
            let found = read_openssh_default_shell();
            match &found {
                Some(v) => tracing::debug!("OpenSSH DefaultShell rung resolved to {v:?}"),
                None => tracing::debug!(
                    "OpenSSH DefaultShell rung absent (no HKLM\\SOFTWARE\\OpenSSH value)"
                ),
            }
            found
        })
        .clone();
    let shell_env = std::env::var("SHELL").ok();
    let comspec = std::env::var("ComSpec").ok();
    let system_root = std::env::var("SystemRoot")
        .unwrap_or_else(|_| r"C:\Windows".to_string())
        .trim_end_matches('\\')
        .to_string();
    let powershell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    default_shell_ladder(
        shell_override,
        shell_env.as_deref(),
        openssh.as_deref(),
        Some(powershell.as_str()),
        comspec.as_deref(),
        &|candidate| Path::new(candidate).exists(),
    )
}

#[cfg(windows)]
fn resolve_session_shell(shell_override: Option<&str>) -> (String, Vec<String>) {
    let mut ladder = windows_default_shell_candidates(shell_override);
    debug_assert!(!ladder.is_empty(), "the terminal rung guarantees non-empty");
    let first = ladder.remove(0);
    (first, ladder)
}

#[cfg(not(windows))]
fn resolve_session_shell(shell_override: Option<&str>) -> (String, Vec<String>) {
    (
        shell_override
            .map(str::to_string)
            .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "bash".into())),
        Vec::new(),
    )
}

#[cfg(windows)]
fn shell_spawn_error_is_retryable(err: &anyhow::Error) -> bool {
    use std::io::ErrorKind;
    if let Some(io_err) = err.downcast_ref::<std::io::Error>() {
        return matches!(
            io_err.kind(),
            ErrorKind::NotFound | ErrorKind::PermissionDenied
        );
    }
    let text = format!("{err}");
    ["os error 2)", "os error 3)", "os error 5)", "os error 193)"]
        .iter()
        .any(|needle| text.contains(needle))
}

#[cfg(windows)]
fn spawn_with_shell_fallback(
    slave: &dyn portable_pty::SlavePty,
    first_cmd: CommandBuilder,
    fallback_programs: Vec<String>,
    session_id: u32,
) -> Result<Box<dyn portable_pty::Child + Send + Sync>> {
    let first_program = first_cmd
        .get_argv()
        .first()
        .map(|arg| arg.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut tried: Vec<String> = vec![first_program];
    let mut candidates = fallback_programs.into_iter();
    let mut cmd = first_cmd;
    loop {
        match slave.spawn_command(cmd) {
            Ok(child) => return Ok(child),
            Err(err) => {
                let next = if shell_spawn_error_is_retryable(&err) {
                    candidates.next()
                } else {
                    None
                };
                match next {
                    Some(program) => {
                        tracing::warn!(
                            "session {session_id}: shell {:?} failed to spawn ({err:#}); \
                             walking down the default-shell ladder",
                            tried.last().cloned().unwrap_or_default()
                        );
                        tried.push(program.clone());
                        cmd = CommandBuilder::new(&program);
                    }
                    None => {
                        if tried.len() > 1 {
                            bail!(
                                "spawning agent for session {session_id} failed: {err} \
                                 (Tried shells: {})",
                                tried.join(", ")
                            );
                        }
                        bail!("spawning agent for session {session_id} failed: {err}");
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn adopted_emulator(m: &crate::adoption::SessionManifest) -> Option<crate::vt::Emulator> {
    if m.vt_snapshot.is_empty() {
        return None;
    }
    let ours = crate::vt::snapshot_format_version();
    if m.vt_format_version != ours {
        tracing::warn!(
            "session {}: the retiring daemon's snapshot is format v{}, this build reads v{ours}; \
             starting a fresh emulator instead of importing it",
            m.session_id,
            m.vt_format_version
        );
        return None;
    }
    let mut emulator = match crate::vt::Emulator::new(m.cols, m.rows, crate::vt::VT_HISTORY_BYTES) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("session {}: no emulator to adopt into: {e}", m.session_id);
            return None;
        }
    };
    if let Err(e) = emulator.import(&m.vt_snapshot) {
        tracing::warn!(
            "session {}: refusing the adopted snapshot ({} bytes): {e}",
            m.session_id,
            m.vt_snapshot.len()
        );
        return None;
    }
    Some(emulator)
}

pub struct TakenSnapshot {
    pub generation: u32,
    pub output_offset: u64,
    pub format_version: u32,
    pub state: Vec<u8>,
}

/// The binary a retiring daemon hands its channel to: the caller's named
/// candidate (an AppImage cannot reach its sidecar through `current_exe`),
/// else this executable. A bad path refuses before anything is parked.
#[cfg(unix)]
fn handoff_binary(candidate: Option<&str>) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let Some(raw) = candidate else {
        return std::env::current_exe()
            .map_err(|e| format!("resolving this daemon's own binary path: {e}"));
    };
    let candidate = Path::new(raw);
    if !candidate.is_absolute() {
        return Err(format!(
            "handoff candidate {raw:?} is not an absolute path; expected the freshly installed \
             daemon binary's absolute path"
        ));
    }
    let meta = std::fs::metadata(candidate).map_err(|e| {
        format!(
            "handoff candidate {raw:?} cannot be read: {e}; expected the freshly installed \
             daemon binary"
        )
    })?;
    if !meta.is_file() {
        return Err(format!(
            "handoff candidate {raw:?} is not a regular file; expected the freshly installed \
             daemon binary"
        ));
    }
    if meta.permissions().mode() & 0o111 == 0 {
        return Err(format!(
            "handoff candidate {raw:?} is not executable; expected the freshly installed \
             daemon binary"
        ));
    }
    Ok(candidate.to_path_buf())
}

/// Claims `handing_off` for one handoff attempt, so a second caller is refused
/// before it spawns a candidate. Released on every failure via Drop; `retire`
/// keeps it set on success, when this daemon has handed the channel away.
#[cfg(unix)]
struct HandoffClaim<'a>(&'a AtomicBool);

#[cfg(unix)]
impl<'a> HandoffClaim<'a> {
    fn claim(flag: &'a AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                "a handoff is already in progress; the sessions on this channel are being moved \
                 by that one or by the generation it spawned"
                    .to_string()
            })?;
        Ok(HandoffClaim(flag))
    }

    fn retire(self) {
        std::mem::forget(self);
    }
}

#[cfg(unix)]
impl Drop for HandoffClaim<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Daemon {
    pub fn new(cfg: DaemonConfig) -> Result<Arc<Self>> {
        Self::new_inner(cfg, None, None)
    }

    pub fn new_bound(cfg: DaemonConfig, port: u16) -> Result<Arc<Self>> {
        Self::new_inner(cfg, None, Some(port))
    }

    #[doc(hidden)]
    pub fn new_with_safe_mode_flags_for_test(
        cfg: DaemonConfig,
        flags: SafeModeFlags,
    ) -> Result<Arc<Self>> {
        Self::new_inner(cfg, Some(flags), None)
    }

    fn new_inner(
        cfg: DaemonConfig,
        safe_mode_flags_override: Option<SafeModeFlags>,
        bound_port: Option<u16>,
    ) -> Result<Arc<Self>> {
        Self::new_inner_ex(cfg, safe_mode_flags_override, bound_port, None)
    }

    pub fn new_adopting(
        cfg: DaemonConfig,
        port: u16,
        adopted: AdoptedSessions,
    ) -> Result<Arc<Self>> {
        Self::new_inner_ex(cfg, None, Some(port), Some(adopted))
    }

    fn new_inner_ex(
        cfg: DaemonConfig,
        safe_mode_flags_override: Option<SafeModeFlags>,
        bound_port: Option<u16>,
        adopted: Option<AdoptedSessions>,
    ) -> Result<Arc<Self>> {
        let db = Db::open(&cfg.db_path)?;
        let tag_registry: BTreeMap<u32, proto::TagInfo> =
            db.tag_list()?.into_iter().map(|t| (t.id, t)).collect();
        let adopted_ids: HashSet<u32> = adopted
            .as_ref()
            .map(|v| v.iter().map(|(s, _)| s.info.id).collect())
            .unwrap_or_default();
        let mut dead: HashMap<u32, proto::SessionInfo> = HashMap::new();
        if adopted.is_none() {
            for ws in db.list_workspaces().unwrap_or_default() {
                match crate::paths::migrate_legacy_project_dir(Path::new(&ws.path)) {
                    Ok(true) => tracing::info!(
                        "moved {}/{} to {}",
                        ws.path,
                        crate::paths::LEGACY_PROJECT_DIR,
                        crate::paths::PROJECT_DIR
                    ),
                    Ok(false) => {}
                    Err(e) => tracing::warn!("{e:#}"),
                }
            }
            let interrupted = db.mark_live_as_interrupted()?;
            if interrupted > 0 {
                tracing::info!(
                    "marked {interrupted} session(s) from a previous run as interrupted"
                );
            }
            dead = db
                .list_interrupted()?
                .into_iter()
                .map(|i| (i.id, i))
                .collect();
            let mut used: HashSet<String> = dead
                .values()
                .map(|i| i.title.clone())
                .filter(|t| !t.is_empty())
                .collect();
            for info in dead.values_mut() {
                if info.title.is_empty() {
                    let name = crate::pane_name::pick_codename(&used);
                    used.insert(name.clone());
                    if let Err(e) = db.update_session_title_with_source(
                        info.id,
                        &name,
                        Some(TitleSource::Codename.as_str()),
                    ) {
                        tracing::warn!("persisting minted codename for session {}: {e}", info.id);
                    }
                    info.title = name.clone();
                    if info.codename.is_empty() {
                        if let Err(e) = db.update_session_codename(info.id, &name) {
                            tracing::warn!(
                                "persisting minted codename for session {}: {e}",
                                info.id
                            );
                        }
                        info.codename = name;
                    }
                }
            }
            if !dead.is_empty() {
                tracing::info!(
                    "restored {} interrupted session(s) from the previous run",
                    dead.len()
                );
            }
        }
        let next_id = db.next_session_id()?;
        let scrollback_dir = cfg
            .db_path
            .parent()
            .map(|p| p.join("scrollback"))
            .ok_or_else(|| anyhow!("db path {} has no parent dir", cfg.db_path.display()))?;
        std::fs::create_dir_all(&scrollback_dir)
            .with_context(|| format!("creating {}", scrollback_dir.display()))?;
        if let Ok(entries) = std::fs::read_dir(&scrollback_dir) {
            for entry in entries.flatten() {
                let keep = entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u32>().ok())
                    .is_some_and(|id| dead.contains_key(&id) || adopted_ids.contains(&id));
                if !keep {
                    if let Err(e) = std::fs::remove_file(entry.path()) {
                        tracing::warn!("removing stale scrollback {:?}: {e}", entry.path());
                    }
                }
            }
        }
        let state_dir = cfg.db_path.parent().expect("checked above").to_path_buf();
        let shellint_dir = match shellint::materialize(&state_dir) {
            Ok(dir) => Some(dir),
            Err(e) => {
                tracing::warn!("shell integration disabled — materializing rc files: {e}");
                None
            }
        };
        let marker_path = state_dir.join(CLEAN_SHUTDOWN_FILE);
        let run_state_path = state_dir.join(RUN_STATE_FILE);
        let startup_cause = read_and_derive_startup_cause(&marker_path, &run_state_path);
        remove_file_logged(&marker_path, "clean-shutdown marker");

        let safe_mode_flags = safe_mode_flags_override.unwrap_or_else(SafeModeFlags::from_env);
        tracing::info!(
            "safe-mode flags resolved: disable_auto_restore={} disable_swarm_autolaunch={}",
            safe_mode_flags.disable_auto_restore,
            safe_mode_flags.disable_swarm_autolaunch
        );

        let (ledger_tx, ledger_rx) = mpsc::channel();
        let (tx, _) = broadcast::channel(OUTBOUND_CAPACITY);
        let swarm_mail_wake = Arc::new(tokio::sync::Notify::new());
        let daemon = Arc::new(Self {
            token: cfg.token,
            mcp_creds: crate::mcp_creds::Registry::new(),
            mcp_notify: crate::mcp_server::NotifierRegistry::new(),
            mcp_tools: crate::mcp_server::ToolRegistry::with_builtins(),
            mcp_checks: Mutex::new(HashMap::new()),
            cli_probes: Mutex::new(crate::cli_probe::ProbeCache::default()),
            model_catalog: Arc::new(crate::model_catalog::ModelCatalog::new(&state_dir)),
            voice: crate::voice::runtime::Runtime::new(),
            mcp_progress_tick_ms: AtomicU64::new(
                crate::mcp_server::PROGRESS_TICK_DEFAULT.as_millis() as u64,
            ),
            handoff_batch_ms: AtomicU64::new(crate::orchestrate::HANDOFF_BATCH_MS),
            last_inbox_retention: AtomicU64::new(0),
            db,
            next_id: AtomicU32::new(next_id),
            sessions: Mutex::new(HashMap::new()),
            tags: Mutex::new(tag_registry),
            dead: Mutex::new(dead),
            respawned_as: Mutex::new(HashMap::new()),
            workspace_membership: Mutex::new(()),
            state_dir: state_dir.clone(),
            db_path: cfg.db_path.clone(),
            scrollback_dir,
            shellint_dir,
            ledger_tx,
            recovery: Mutex::new(None),
            handoff_jobs: Mutex::new(HashMap::new()),
            next_handoff: AtomicU32::new(1),
            ssh_prompts: Mutex::new(HashMap::new()),
            known_hosts: state_dir.join("known_hosts"),
            channel: crate::paths::channel_of_state_dir(&state_dir),
            started: Instant::now(),
            swarm_mail: Mutex::new(HashMap::new()),
            swarm_mail_wake: Arc::clone(&swarm_mail_wake),
            swarm_mail_ladder: Mutex::new(crate::fs_watch::PollLadder::new()),
            routine_wake: Arc::new(tokio::sync::Notify::new()),
            delegation_wake: Arc::new(tokio::sync::Notify::new()),
            idle_tick_counts: [AtomicU64::new(0), AtomicU64::new(0)],
            checkpoint_lock: Mutex::new(()),
            reap_armed: Mutex::new(None),
            reap_generation: AtomicU64::new(0),
            exit_hook: Mutex::new(Box::new(|| std::process::exit(0))),
            shutting_down: AtomicBool::new(false),
            handing_off: AtomicBool::new(false),
            handed_off: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            handoff_reap: Mutex::new(()),
            #[cfg(unix)]
            supervisor_writer: Mutex::new(None),
            #[cfg(unix)]
            listener_fd: Mutex::new(None),
            #[cfg(unix)]
            lock_fd: Mutex::new(None),
            server_abort: Mutex::new(None),
            #[cfg(unix)]
            server_shutdown: Mutex::new(None),
            swarm_activity: Mutex::new(HashMap::new()),
            operator_ended: Mutex::new(HashSet::new()),
            visibility: Mutex::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
            frame_taps: Arc::new(crate::frame_queue::FrameRegistry::default()),
            swarm_terminal_since: Mutex::new(HashMap::new()),
            swarm_finished_sessions: Mutex::new(HashSet::new()),
            swarm_wake_lanes: Mutex::new(HashMap::new()),
            delegation_settle: Mutex::new(HashMap::new()),
            stdin_partial_after: Mutex::new(HashMap::new()),
            inbox_pending_max: AtomicU32::new(orchestrate::INBOX_PENDING_PER_PANE_MAX),
            inbox_wake: Mutex::new(HashMap::new()),
            inbox_waiting: Mutex::new(HashSet::new()),
            temporary_cleanup_lock: Mutex::new(()),
            inbox_flush_scheduled: Mutex::new(HashSet::new()),
            composer_occupied: Mutex::new(HashMap::new()),
            paste_confirmations: Mutex::new(HashMap::new()),
            turn_start_round: Mutex::new(HashMap::new()),
            last_prompt_id: Mutex::new(HashMap::new()),
            prompt_awaiting_hook: Mutex::new(HashSet::new()),
            swarm_wake_generation: AtomicU64::new(1),
            subagent_rounds: Mutex::new(HashMap::new()),
            stop_blocks: Mutex::new(HashMap::new()),
            permission_episodes: Mutex::new(HashMap::new()),
            antigravity_roots: Mutex::new(HashMap::new()),
            browser_relay: Arc::new(crate::browser_relay::BrowserRelayState::new()),
            routine_runs: Mutex::new(HashMap::new()),
            routine_settle: Mutex::new(HashMap::new()),
            routine_pane_cmd_override: Mutex::new(None),
            routine_pane_registration_hook_for_test: Mutex::new(None),
            self_weak: Mutex::new(std::sync::Weak::new()),
            hook_state_lock: Mutex::new(()),
            port: Mutex::new(bound_port),
            hook_drop_states: Mutex::new(HashMap::new()),
            hook_drop_watch: crate::fs_watch::MailWatchState::new(swarm_mail_wake),
            _hook_drop_watcher: Mutex::new(None),
            update_state: Mutex::new(proto::UpdateState::Unknown),
            update_wake: Arc::new(tokio::sync::Notify::new()),
            update_check_lock: tokio::sync::Mutex::new(()),
            release_cache: tokio::sync::Mutex::new(crate::updates::ReleaseCache::default()),
            run_state_started_at: now_ms(),
            run_state_expected_restart: AtomicBool::new(false),
            startup_cause,
            safe_mode_flags,
            tx,
        });
        spawn_ledger_writer(&daemon, ledger_rx);
        daemon.write_run_state();
        #[cfg(windows)]
        conpty_warmup();
        if adopted.is_none() {
            daemon.close_delegations_lost_to_the_restart();
            daemon.run_restore_policy(startup_cause);
            let live_sessions: Vec<u32> = daemon
                .sessions
                .lock()
                .expect("sessions lock")
                .keys()
                .copied()
                .collect();
            match daemon.db.inbox_recover_after_restart(&live_sessions) {
                Ok(recovery) if recovery != crate::db::InboxRecovery::default() => {
                    tracing::info!("inbox recovery at boot: {recovery:?}");
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("recovering the inbox at boot: {e}"),
            }
            daemon.inbox_retention_pass(crate::hook_drop::now_ms());
        }
        daemon.rebuild_hook_state();
        daemon.hook_drop_boot();
        crate::statusline_sweep::sweep(&daemon.db);
        *daemon.self_weak.lock().expect("self_weak lock") = Arc::downgrade(&daemon);
        daemon.mcp_tools.bind_daemon(&daemon);
        daemon
            .mcp_tools
            .register(Arc::new(crate::mcp_orchestration::OrchestrationTools::new(
                &daemon,
            )));
        daemon
            .mcp_tools
            .register(Arc::new(crate::browser_relay::BrowserRelayTools::new(
                &daemon,
            )));
        if let Some(adopted) = adopted {
            for (session, reader) in adopted {
                let id = session.info.id;
                daemon
                    .sessions
                    .lock()
                    .expect("sessions lock")
                    .insert(id, Arc::clone(&session));
                daemon.spawn_pty_reader_thread(id, &session, reader);
            }
            daemon.write_run_state();
        }
        daemon.reap_reevaluate();
        Ok(daemon)
    }

    fn run_restore_policy(self: &Arc<Self>, cause: StartupCause) {
        use proto::RestoreReason as R;
        let mut candidates: Vec<proto::SessionInfo> = {
            let dead = self.dead.lock().expect("dead lock");
            if dead.is_empty() {
                return;
            }
            dead.values().cloned().collect()
        };
        let defer = |id: u32, reason: proto::RestoreReason| {
            if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
                info.restore_deferred = Some(reason);
            }
        };
        let total = candidates.len() as u32;
        let crashed = cause.abnormal_exit;
        tracing::info!(
            "boot restore: previous-run cause: abnormal_exit={} runtime_ms={:?} \
             session_count={:?} swarm_count={:?} expected_restart={}",
            cause.abnormal_exit,
            cause.runtime_ms,
            cause.session_count,
            cause.swarm_count,
            cause.expected_restart,
        );

        let safe_mode = self.safe_mode_flags.disable_auto_restore;
        if safe_mode || crashed {
            let reason = if safe_mode {
                R::SafeMode
            } else {
                R::PreviousCrash
            };
            for c in &candidates {
                defer(c.id, reason);
            }
            *self.recovery.lock().expect("recovery lock") = Some(proto::RecoverySummary {
                respawned: 0,
                deferred: total,
                crashed,
            });
            tracing::info!(
                "boot restore: deferred all {total} husk(s) ({})",
                if safe_mode {
                    "safe mode"
                } else {
                    "previous crash"
                }
            );
            return;
        }

        candidates.retain(|c| {
            if c.agent == proto::AgentKind::Ssh {
                defer(c.id, R::Ssh);
                false
            } else {
                true
            }
        });

        candidates.retain(|c| {
            let ok = Path::new(&c.cwd).is_dir() || Path::new(&c.project_dir).is_dir();
            if !ok {
                defer(c.id, R::InvalidCwd);
            }
            ok
        });

        candidates.retain(|c| {
            if c.spawned_by.is_none() {
                return true;
            }
            if let Err(e) = self.close(c.id) {
                tracing::warn!(
                    "boot restore: closing orchestrated child {} (parent {:?}), whose mission \
                     cannot survive a restart: {e}",
                    c.id,
                    c.spawned_by,
                );
            }
            false
        });

        candidates.sort_by_key(|c| (restore_priority(c.agent), std::cmp::Reverse(c.id)));

        let budget = self.restore_budget() as usize;
        let mut respawned: u32 = 0;
        let mut broke = false;
        for (i, c) in candidates.iter().enumerate() {
            if broke {
                defer(c.id, R::CircuitBreaker);
                continue;
            }
            if i >= budget {
                defer(c.id, R::Budget);
                continue;
            }
            match self.respawn(c.id, true, None, None, false) {
                Ok(_) => respawned += 1,
                Err(e) => {
                    tracing::warn!(
                        "boot restore: respawning session {} failed, halting auto-restore: {e}",
                        c.id
                    );
                    defer(c.id, R::SpawnFailed);
                    broke = true;
                }
            }
        }
        let deferred = total - respawned;
        *self.recovery.lock().expect("recovery lock") = Some(proto::RecoverySummary {
            respawned,
            deferred,
            crashed: false,
        });
        tracing::info!("boot restore: respawned {respawned}, deferred {deferred}");
    }

    pub fn recovery_summary(&self) -> Option<proto::RecoverySummary> {
        *self.recovery.lock().expect("recovery lock")
    }

    fn scrollback_path(&self, id: u32) -> PathBuf {
        self.scrollback_dir.join(format!("{id}.bin"))
    }

    fn persist_scrollback_result(&self, id: u32) -> Result<()> {
        let session = match self.sessions.lock().expect("sessions lock").get(&id) {
            Some(s) => Arc::clone(s),
            None => return Ok(()),
        };
        let ring = session.scrollback.lock().expect("scrollback lock");
        if ring.bytes_seen() == 0 {
            return Ok(());
        }
        ring.persist(&self.scrollback_path(id))
    }

    fn persist_scrollback(&self, id: u32) {
        if let Err(e) = self.persist_scrollback_result(id) {
            tracing::warn!("persisting scrollback of session {id}: {e}");
        }
    }

    pub fn checkpoint_scrollback(&self) -> Result<()> {
        let _guard = self.checkpoint_lock.lock().expect("checkpoint lock");
        let ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect();
        let mut failed: Vec<(u32, anyhow::Error)> = Vec::new();
        for id in &ids {
            if let Err(e) = self.persist_scrollback_result(*id) {
                tracing::warn!("checkpoint: persisting scrollback of session {id}: {e:#}");
                failed.push((*id, e));
            }
        }
        if failed.is_empty() {
            return Ok(());
        }
        bail!(
            "checkpoint failed for {} of {} session(s): {}",
            failed.len(),
            ids.len(),
            failed
                .iter()
                .map(|(id, e)| format!("{id}: {e}"))
                .collect::<Vec<_>>()
                .join("; ")
        );
    }

    pub fn mark_clean_shutdown(&self) -> Result<()> {
        self.write_file_atomic(&self.marker_path(), b"")
    }

    pub fn persist_all(&self) {
        if let Err(e) = self.checkpoint_scrollback() {
            tracing::warn!("persist_all: checkpoint failed: {e:#}");
        }
        if let Err(e) = self.mark_clean_shutdown() {
            tracing::warn!("persist_all: writing the clean-shutdown marker failed: {e:#}");
        }
    }

    fn reap_grace_ms(&self) -> u64 {
        std::env::var("HOUSTON_REAP_GRACE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(REAP_GRACE_MS)
    }

    fn reap_predicate_holds(&self) -> bool {
        let no_clients = self.visibility.lock().expect("visibility lock").is_empty();
        let no_live_sessions = self.live_session_count() == 0;
        let no_enabled_routines = self.db.enabled_routine_count().unwrap_or_else(|e| {
            tracing::warn!("counting enabled routines for the reap predicate: {e:#}");
            1
        }) == 0;
        no_clients && no_live_sessions && no_enabled_routines
    }

    fn live_session_count(&self) -> usize {
        self.sessions
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|s| s.state.lock().expect("state lock").is_live())
            .count()
    }

    pub fn reap_reevaluate(&self) {
        let holds = self.reap_predicate_holds();
        let mut armed = self.reap_armed.lock().expect("reap armed lock");
        match (armed.take(), holds) {
            (Some(prev), false) => {
                prev.handle.abort();
            }
            (None, true) => {
                let Ok(rt) = tokio::runtime::Handle::try_current() else {
                    return;
                };
                let Some(me) = self.self_weak.lock().expect("self_weak lock").upgrade() else {
                    return;
                };
                let generation = self.reap_generation.fetch_add(1, Ordering::Relaxed) + 1;
                let grace_ms = self.reap_grace_ms();
                let deadline_ms = now_unix_ms() + grace_ms as i64;
                let handle = rt.spawn(async move { me.reap_task(generation, grace_ms).await });
                *armed = Some(ReapArm {
                    generation,
                    deadline_ms,
                    handle,
                });
            }
            (Some(prev), true) => *armed = Some(prev),
            (None, false) => {}
        }
    }

    async fn reap_task(self: Arc<Self>, generation: u64, grace_ms: u64) {
        tokio::time::sleep(Duration::from_millis(grace_ms)).await;
        {
            let armed = self.reap_armed.lock().expect("reap armed lock");
            match armed.as_ref() {
                Some(a) if a.generation == generation => {}
                _ => return,
            }
        }
        if !self.reap_predicate_holds() {
            self.reap_reevaluate();
            return;
        }
        tracing::info!(
            "reap: no client, no live session, no enabled routine for {grace_ms} ms — exiting"
        );
        if let Err(e) = self.checkpoint_scrollback() {
            tracing::warn!("reap: checkpoint failed: {e:#}");
        }
        if let Err(e) = self.mark_clean_shutdown() {
            tracing::warn!("reap: writing the clean-shutdown marker failed: {e:#}");
        }
        self.remove_discovery_files();
        (self.exit_hook.lock().expect("reap exit hook lock"))();
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    pub fn is_handing_off(&self) -> bool {
        self.handing_off.load(Ordering::Acquire)
    }

    pub fn has_handed_off(&self) -> bool {
        self.handed_off.load(Ordering::Acquire)
    }

    pub fn refusing_mutations(&self) -> bool {
        self.is_shutting_down() || self.is_handing_off()
    }

    pub fn reap_status(&self) -> (bool, Option<i64>) {
        let armed = self.reap_armed.lock().expect("reap armed lock");
        match armed.as_ref() {
            Some(a) => (true, Some(a.deadline_ms)),
            None => (false, None),
        }
    }

    #[doc(hidden)]
    pub fn reap_set_exit_hook_for_test(&self, hook: Box<dyn Fn() + Send + Sync>) {
        *self.exit_hook.lock().expect("reap exit hook lock") = hook;
    }

    pub fn manage_status(&self) -> proto::ManageDaemonStatus {
        let live_session_ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .iter()
            .filter(|(_, s)| s.state.lock().expect("state lock").is_live())
            .map(|(id, _)| *id)
            .collect();
        let routines_enabled = self.db.enabled_routine_count().unwrap_or_else(|e| {
            tracing::warn!("counting enabled routines for daemon_status: {e:#}");
            0
        });
        let clients_connected = self.visibility.lock().expect("visibility lock").len() as u32;
        let (armed, deadline_ms) = self.reap_status();
        proto::ManageDaemonStatus {
            manage_version: proto::MANAGE_VERSION,
            protocol_version: proto::PROTOCOL_VERSION,
            build: build_commit().to_string(),
            pid: std::process::id(),
            started_at: format_rfc3339_utc(self.run_state_started_at),
            live_sessions: proto::ManageLiveSessions {
                count: live_session_ids.len() as u32,
                ids: live_session_ids,
            },
            routines_enabled,
            clients_connected,
            handoff: self.handoff_support_summary(),
            reap: proto::ManageReapInfo { armed, deadline_ms },
        }
    }

    fn handoff_support_summary(&self) -> proto::ManageHandoffInfo {
        #[cfg(unix)]
        {
            if !cfg!(target_os = "linux") {
                return proto::ManageHandoffInfo {
                    supported: false,
                    reason: "live handoff is Linux-only; this daemon is not on Linux".to_string(),
                };
            }
            if self
                .supervisor_writer
                .lock()
                .expect("supervisor writer lock")
                .is_none()
            {
                return proto::ManageHandoffInfo {
                    supported: false,
                    reason: "this daemon has no houston-supervisor in front of it".to_string(),
                };
            }
            if self.listener_fd.lock().expect("listener fd lock").is_none()
                || self.lock_fd.lock().expect("lock fd lock").is_none()
            {
                return proto::ManageHandoffInfo {
                    supported: false,
                    reason: "this daemon was not started with a transferable listener/lock"
                        .to_string(),
                };
            }
            let live_ssh: Vec<u32> = self
                .sessions
                .lock()
                .expect("sessions lock")
                .iter()
                .filter(|(_, s)| {
                    matches!(s.backend, Backend::Ssh(_))
                        && s.state.lock().expect("state lock").is_live()
                })
                .map(|(id, _)| *id)
                .collect();
            if !live_ssh.is_empty() {
                return proto::ManageHandoffInfo {
                    supported: false,
                    reason: format!("live SSH session(s) {live_ssh:?} block a PTY-only handoff"),
                };
            }
            proto::ManageHandoffInfo {
                supported: true,
                reason: String::new(),
            }
        }
        #[cfg(not(unix))]
        proto::ManageHandoffInfo {
            supported: false,
            reason: "live handoff is Linux-only; this daemon is not running on Linux".to_string(),
        }
    }

    fn wait_for_sessions_to_end(&self, ids: &[u32], timeout: Duration) -> Vec<u32> {
        let deadline = Instant::now() + timeout;
        let mut remaining: std::collections::HashSet<u32> = ids.iter().copied().collect();
        loop {
            remaining.retain(|id| {
                let sessions = self.sessions.lock().expect("sessions lock");
                match sessions.get(id) {
                    Some(s) => !s.backend_exited.load(Ordering::Acquire),
                    None => false,
                }
            });
            if remaining.is_empty() || Instant::now() >= deadline {
                return remaining.into_iter().collect();
            }
            std::thread::sleep(Duration::from_millis(SHUTDOWN_DRAIN_POLL_MS));
        }
    }

    pub fn manage_shutdown(
        self: &Arc<Self>,
    ) -> Result<proto::ManageDaemonShutdownOk, ShutdownFailure> {
        self.manage_shutdown_inner(false)
    }

    /// `manage_shutdown` for an installer: the gate goes up first, so a session
    /// that raced the installer's own check is a refusal naming it, never a
    /// victim of the stop that makes room for the update.
    pub fn manage_shutdown_if_idle(
        self: &Arc<Self>,
    ) -> Result<proto::ManageDaemonShutdownOk, ShutdownFailure> {
        self.manage_shutdown_inner(true)
    }

    fn manage_shutdown_inner(
        self: &Arc<Self>,
        refuse_if_live: bool,
    ) -> Result<proto::ManageDaemonShutdownOk, ShutdownFailure> {
        self.shutting_down.store(true, Ordering::Release);
        let routines_armed = self.db.enabled_routine_count().unwrap_or_else(|e| {
            tracing::warn!("counting armed routines for the shutdown report: {e:#}");
            0
        });
        let live_ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .iter()
            .filter(|(_, s)| s.state.lock().expect("state lock").is_live())
            .map(|(id, _)| *id)
            .collect();
        if refuse_if_live && !live_ids.is_empty() {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ShutdownFailure {
                reason: format!(
                    "refusing to stop: {} live session(s) are running (ids {:?}); an update must \
                     not kill them, and nothing was stopped",
                    live_ids.len(),
                    live_ids
                ),
                unterminated: live_ids,
            });
        }
        let mut kill_failures = Vec::new();
        for id in &live_ids {
            if let Err(e) = self.kill(*id) {
                tracing::warn!("shutdown: terminating session {id}: {e:#}");
                kill_failures.push((*id, e));
            }
        }
        if !kill_failures.is_empty() {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ShutdownFailure {
                reason: format!(
                    "failed to terminate {} of {} session(s): {}",
                    kill_failures.len(),
                    live_ids.len(),
                    kill_failures
                        .iter()
                        .map(|(id, e)| format!("{id}: {e}"))
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                unterminated: kill_failures.iter().map(|(id, _)| *id).collect(),
            });
        }
        let drain_timeout = shutdown_drain_timeout();
        let unterminated = self.wait_for_sessions_to_end(&live_ids, drain_timeout);
        if !unterminated.is_empty() {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ShutdownFailure {
                reason: format!(
                    "{} of {} session(s) did not confirm exit within {} ms: {:?} (a child \
                     ignoring SIGTERM/SIGHUP, or a still-running process under it)",
                    unterminated.len(),
                    live_ids.len(),
                    drain_timeout.as_millis(),
                    unterminated
                ),
                unterminated,
            });
        }
        if let Err(e) = self.checkpoint_scrollback() {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ShutdownFailure {
                reason: format!("checkpoint failed: {e:#}"),
                unterminated: Vec::new(),
            });
        }
        if let Err(e) = self.mark_clean_shutdown() {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ShutdownFailure {
                reason: format!("writing the clean-shutdown marker failed: {e:#}"),
                unterminated: Vec::new(),
            });
        }
        self.remove_discovery_files();
        Ok(proto::ManageDaemonShutdownOk {
            ok: true,
            stopped_sessions: live_ids.len() as u32,
            disarmed_routines: routines_armed,
        })
    }

    fn remove_discovery_files(&self) {
        let _ = std::fs::remove_file(self.state_dir.join("daemon.json"));
        let supervisor_json = self.state_dir.join("supervisor.json");
        if supervisor_json.exists() {
            let _ = std::fs::remove_file(&supervisor_json);
        }
    }

    pub fn call_exit_hook(&self) {
        (self.exit_hook.lock().expect("reap exit hook lock"))();
    }

    #[cfg(unix)]
    pub fn set_listener_fd(&self, fd: std::os::fd::RawFd) {
        *self.listener_fd.lock().expect("listener fd lock") = Some(fd);
    }

    #[cfg(unix)]
    pub fn set_lock_fd(&self, fd: std::os::fd::RawFd) {
        *self.lock_fd.lock().expect("lock fd lock") = Some(fd);
    }

    pub fn set_server_abort(&self, handle: tokio::task::AbortHandle) {
        *self.server_abort.lock().expect("server abort lock") = Some(handle);
    }

    #[cfg(unix)]
    pub fn set_server_shutdown(&self, tx: tokio::sync::oneshot::Sender<()>) {
        *self.server_shutdown.lock().expect("server shutdown lock") = Some(tx);
    }

    #[cfg(unix)]
    fn stop_serving(&self) {
        if let Some(tx) = self
            .server_shutdown
            .lock()
            .expect("server shutdown lock")
            .take()
        {
            let _ = tx.send(());
            return;
        }
        if let Some(h) = self.server_abort.lock().expect("server abort lock").take() {
            h.abort();
        }
    }

    #[cfg(unix)]
    pub fn set_supervisor_writer(&self, w: std::os::unix::net::UnixStream) {
        *self
            .supervisor_writer
            .lock()
            .expect("supervisor writer lock") = Some(w);
    }

    #[cfg(unix)]
    fn request_spawn_next(&self, daemon_path: &str, args: &[String]) -> std::io::Result<()> {
        let mut guard = self
            .supervisor_writer
            .lock()
            .expect("supervisor writer lock");
        let Some(w) = guard.as_mut() else {
            return Err(std::io::Error::other(
                "no houston-supervisor writer registered",
            ));
        };
        crate::supervisor::write_spawn_next(
            w,
            &crate::supervisor::SpawnNext {
                daemon_path: daemon_path.to_string(),
                args: args.to_vec(),
            },
        )
    }

    #[cfg(unix)]
    fn resume_sessions(&self, ids: &[u32]) {
        let sessions = self.sessions.lock().expect("sessions lock");
        for id in ids {
            if let Some(s) = sessions.get(id) {
                s.park.resume();
            }
        }
    }

    #[cfg(unix)]
    fn commit_record_confirms(&self, expected_generation: u64) -> bool {
        let path = self.state_dir.join("daemon.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return false;
        };
        #[derive(serde::Deserialize)]
        struct Rec {
            generation: Option<u64>,
        }
        match serde_json::from_str::<Rec>(&raw) {
            Ok(rec) => rec.generation == Some(expected_generation),
            Err(_) => false,
        }
    }

    #[cfg(unix)]
    pub fn begin_handoff(
        self: &Arc<Self>,
        candidate_bin: Option<&str>,
    ) -> proto::ManageDaemonHandoffResult {
        match self.begin_handoff_inner(candidate_bin) {
            Ok(ok) => ok,
            Err(reason) => proto::ManageDaemonHandoffResult {
                accepted: false,
                reason: Some(reason),
                generation: None,
                sessions_transferred: None,
            },
        }
    }

    #[cfg(not(unix))]
    pub fn begin_handoff(
        self: &Arc<Self>,
        _candidate_bin: Option<&str>,
    ) -> proto::ManageDaemonHandoffResult {
        proto::ManageDaemonHandoffResult {
            accepted: false,
            reason: Some(
                "live handoff is Linux-only; this daemon is not running on Linux".to_string(),
            ),
            generation: None,
            sessions_transferred: None,
        }
    }

    #[cfg(unix)]
    fn begin_handoff_inner(
        self: &Arc<Self>,
        candidate_bin: Option<&str>,
    ) -> Result<proto::ManageDaemonHandoffResult, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::time::{Duration, Instant};

        if !cfg!(target_os = "linux") {
            return Err(
                "live handoff is Linux-only; this daemon is not running on Linux".to_string(),
            );
        }
        let claim = HandoffClaim::claim(&self.handing_off)?;
        #[cfg(target_os = "linux")]
        let _reap = self.handoff_reap.lock().expect("handoff reap lock");

        let candidate = handoff_binary(candidate_bin)?;

        let live_ssh: Vec<u32> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions
                .iter()
                .filter(|(_, s)| {
                    matches!(s.backend, Backend::Ssh(_))
                        && s.state.lock().expect("state lock").is_live()
                })
                .map(|(id, _)| *id)
                .collect()
        };
        if !live_ssh.is_empty() {
            return Err(format!(
                "live SSH session(s) {live_ssh:?}: a PTY-only handoff cannot carry an SSH \
                 backend — stop them and retry once idle"
            ));
        }

        let Some(listener_fd) = *self.listener_fd.lock().expect("listener fd lock") else {
            return Err(
                "this daemon has no listener fd registered; handoff unavailable".to_string(),
            );
        };
        let Some(lock_fd) = *self.lock_fd.lock().expect("lock fd lock") else {
            return Err("this daemon has no lock fd registered; handoff unavailable".to_string());
        };
        if self
            .supervisor_writer
            .lock()
            .expect("supervisor writer lock")
            .is_none()
        {
            return Err(
                "this daemon has no houston-supervisor in front of it; handoff requires one"
                    .to_string(),
            );
        }

        let socket_path = self
            .state_dir
            .join(format!("adopt-{}.sock", std::process::id()));
        let path_str = socket_path.to_string_lossy().into_owned();
        if path_str.len() >= 100 {
            return Err(format!(
                "adoption socket path is {} bytes, limit is 100 (AF_UNIX sun_path headroom): \
                 {path_str}",
                path_str.len()
            ));
        }
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path)
            .map_err(|e| format!("binding adoption socket {path_str}: {e}"))?;

        self.request_spawn_next(
            &candidate.to_string_lossy(),
            &["--adopt".to_string(), path_str.clone()],
        )
        .map_err(|e| format!("asking houston-supervisor to spawn a candidate: {e}"))?;

        let step_timeout = Duration::from_millis(adoption::HANDOFF_STEP_TIMEOUT_MS);
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("adoption socket: {e}"))?;
        let deadline = Instant::now() + step_timeout;
        let mut accepted = None;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((sock, _)) => {
                    accepted = Some(sock);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&socket_path);
                    return Err(format!("accepting the candidate's connection: {e}"));
                }
            }
        }
        let _ = std::fs::remove_file(&socket_path);
        let Some(mut sock) = accepted else {
            return Err(format!(
                "candidate did not connect within {}ms — houston-supervisor may have failed to \
                 spawn it",
                step_timeout.as_millis()
            ));
        };
        sock.set_nonblocking(false)
            .map_err(|e| format!("adoption socket: {e}"))?;
        sock.set_read_timeout(Some(step_timeout))
            .map_err(|e| format!("adoption socket: {e}"))?;

        let hello_msg: adoption::FromNew =
            adoption::read_frame(&mut sock).map_err(|e| format!("reading candidate hello: {e}"))?;
        let adoption::FromNew::Hello(hello) = hello_msg else {
            return Err("candidate's first message was not a hello".to_string());
        };
        let refuse = |sock: &mut UnixStream, reason: String| -> String {
            let _ = adoption::write_frame(
                sock,
                &adoption::FromOld::Refuse {
                    reason: reason.clone(),
                },
            );
            reason
        };
        if hello.manifest_version != adoption::MANIFEST_VERSION {
            return Err(refuse(
                &mut sock,
                format!(
                    "manifest version mismatch: this daemon speaks {}, candidate speaks {}",
                    adoption::MANIFEST_VERSION,
                    hello.manifest_version
                ),
            ));
        }
        if hello.schema_version != crate::db::SCHEMA_VERSION {
            return Err(refuse(
                &mut sock,
                format!(
                    "schema-changing handoff refused: this daemon is schema {}, candidate is \
                     schema {}",
                    crate::db::SCHEMA_VERSION,
                    hello.schema_version
                ),
            ));
        }
        if hello.platform != "linux" {
            return Err(refuse(
                &mut sock,
                format!("unsupported platform for live handoff: {}", hello.platform),
            ));
        }

        std::thread::sleep(Duration::from_millis(adoption::HANDOFF_MCP_DRAIN_MS));

        let live_ids: Vec<u32> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions
                .iter()
                .filter(|(_, s)| {
                    s.state.lock().expect("state lock").is_live()
                        && !matches!(s.backend, Backend::Ssh(_))
                })
                .map(|(id, _)| *id)
                .collect()
        };

        let mut parked = Vec::new();
        let mut abort_reason = None;
        for id in &live_ids {
            let session = self
                .sessions
                .lock()
                .expect("sessions lock")
                .get(id)
                .cloned();
            let Some(session) = session else { continue };
            if session
                .park
                .request_and_wait(Duration::from_millis(adoption::QUIESCE_PARK_TIMEOUT_MS))
            {
                parked.push(*id);
            } else {
                abort_reason = Some(format!(
                    "session {id} did not quiesce within {}ms",
                    adoption::QUIESCE_PARK_TIMEOUT_MS
                ));
                break;
            }
        }
        if let Some(reason) = abort_reason {
            self.resume_sessions(&parked);
            return Err(refuse(&mut sock, reason));
        }

        if let Err(e) = self.checkpoint_scrollback() {
            self.resume_sessions(&parked);
            return Err(refuse(
                &mut sock,
                format!("checkpoint failed, handoff aborted: {e:#}"),
            ));
        }

        let generation = match std::fs::read_to_string(self.state_dir.join("supervisor.json"))
            .ok()
            .and_then(|raw| crate::supervisor::SupervisorFile::from_json(&raw))
        {
            Some(f) => f.generation,
            None => {
                self.resume_sessions(&parked);
                return Err(refuse(
                    &mut sock,
                    "supervisor.json missing or unreadable after spawn_next".to_string(),
                ));
            }
        };

        let manifest = match self.build_handoff_manifest(generation, &live_ids) {
            Ok(m) => m,
            Err(reason) => {
                self.resume_sessions(&parked);
                return Err(refuse(&mut sock, reason));
            }
        };

        if let Err(e) = adoption::write_frame(&mut sock, &adoption::FromOld::Manifest(manifest)) {
            self.resume_sessions(&parked);
            return Err(format!("sending manifest: {e}"));
        }

        let mut fds: Vec<std::os::fd::RawFd> = Vec::new();
        {
            let sessions = self.sessions.lock().expect("sessions lock");
            for id in &live_ids {
                let Some(fd) = sessions
                    .get(id)
                    .and_then(|s| s.backend.adoption_master_fd())
                else {
                    self.resume_sessions(&parked);
                    return Err(format!("session {id} has no live master fd to transfer"));
                };
                fds.push(fd);
            }
        }
        fds.push(listener_fd);
        fds.push(lock_fd);
        if let Err(e) = adoption::send_fds(sock.as_raw_fd(), &fds) {
            self.resume_sessions(&parked);
            return Err(format!("transferring descriptors: {e}"));
        }

        let prepared: adoption::FromNew = match adoption::read_frame(&mut sock) {
            Ok(msg) => msg,
            Err(e) => {
                self.resume_sessions(&parked);
                return Err(format!("reading candidate's prepared reply: {e}"));
            }
        };
        match prepared {
            adoption::FromNew::Prepared => {}
            adoption::FromNew::PrepareFailed { reason } => {
                self.resume_sessions(&parked);
                return Err(format!("candidate refused to prepare: {reason}"));
            }
            _ => {
                self.resume_sessions(&parked);
                return Err("unexpected candidate reply while awaiting prepared".to_string());
            }
        }

        if let Err(e) = adoption::write_frame(&mut sock, &adoption::FromOld::Commit { generation })
        {
            self.resume_sessions(&parked);
            return Err(format!("sending commit: {e}"));
        }
        let committed = match adoption::read_frame::<_, adoption::FromNew>(&mut sock) {
            Ok(adoption::FromNew::CommitAck) => true,
            _ => self.commit_record_confirms(generation),
        };
        if !committed {
            self.resume_sessions(&parked);
            return Err(
                "candidate did not confirm commit and its daemon.json does not show this \
                 generation; resumed as the owning generation"
                    .to_string(),
            );
        }

        claim.retire();
        self.handed_off.store(true, Ordering::Release);
        self.stop_serving();
        Ok(proto::ManageDaemonHandoffResult {
            accepted: true,
            reason: None,
            generation: Some(generation),
            sessions_transferred: Some(live_ids.len() as u32),
        })
    }

    #[cfg(unix)]
    pub fn session_from_manifest(
        m: &crate::adoption::SessionManifest,
        master_fd: std::os::fd::OwnedFd,
    ) -> Result<(Arc<Session>, Box<dyn Read + Send>)> {
        let (raw, reader_file) =
            crate::adoption::RawMasterPty::from_owned_fd(master_fd, m.pid.map(|p| p as i32))
                .context("reconstructing adopted PTY backend")?;
        Ok((
            Self::adopted_session(m, Backend::AdoptedPty(raw)),
            Box::new(reader_file),
        ))
    }

    #[cfg(unix)]
    fn adopted_session(m: &crate::adoption::SessionManifest, backend: Backend) -> Arc<Session> {
        let info = proto::SessionInfo {
            id: m.session_id,
            agent: m.agent,
            project_dir: m.project_dir.clone(),
            cwd: m.cwd.clone(),
            state: m.state,
            title: m.title.clone(),
            codename: if m.codename.is_empty() {
                m.title.clone()
            } else {
                m.codename.clone()
            },
            detected_agent: None,
            hidden: m.hidden,
            ssh_host: None,
            restore_deferred: None,
            status: m.status,
            context: None,
            swarm_agent: m.swarm_agent,
            spawned_by: None,
            acp: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: m.tags.clone(),
        };
        let vt = adopted_emulator(m);
        Arc::new(Session {
            info: info.clone(),
            pid: m.pid,
            custom_cmd: None,
            state: Mutex::new(m.state),
            title: Mutex::new(m.title.clone()),
            project_dir: Mutex::new(m.project_dir.clone()),
            detected: Mutex::new(None),
            blocks: None,
            shell_token_redactor: None,
            raw_output_bytes: AtomicU64::new(m.output_offset),
            shell_token_file: None,
            shell: None,
            osc_cwd: Mutex::new(None),
            osc52: Mutex::new(crate::osc52::Osc52Scanner::new()),
            osc_title: (m.agent != proto::AgentKind::Shell)
                .then(|| Mutex::new(crate::osc_title::OscTitleScanner::new())),
            cli_title: Mutex::new(CliTitleState::default()),
            title_source: Mutex::new(TitleSource::Codename),
            tags: Mutex::new(m.tags.clone()),
            acp: None,
            scrollback: Mutex::new(Scrollback::new()),
            ws_attaches: AtomicU32::new(0),
            vt: Mutex::new(vt),
            vt_refused: AtomicBool::new(false),
            last_output: AtomicU64::new(0),
            status: Mutex::new(m.status),
            context: Mutex::new(None),
            removed: AtomicBool::new(false),
            backend_exited: AtomicBool::new(false),
            hook_cwd: Mutex::new(m.hook_cwd.clone()),
            hook_last_message: Mutex::new(None),
            geometry: AtomicU32::new((u32::from(m.cols) << 16) | u32::from(m.rows)),
            backend,
            supervisor_wait: Mutex::new(SupervisorWaitState::default()),
            park: Arc::new(ParkState::default()),
        })
    }

    #[cfg(unix)]
    fn build_handoff_manifest(
        &self,
        generation: u64,
        ids: &[u32],
    ) -> Result<adoption::Manifest, String> {
        let fd_count = ids.len() + 2;
        if fd_count > adoption::FD_CAP {
            return Err(format!(
                "handoff would transfer {fd_count} descriptors ({} sessions + listener + \
                 lock), cap is {}",
                ids.len(),
                adoption::FD_CAP
            ));
        }
        let sessions = self.sessions.lock().expect("sessions lock");
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(s) = sessions.get(id) else { continue };
            let (cols, rows) = s.geometry();
            let mcp_cred =
                self.mcp_creds
                    .export_for_session(*id)
                    .map(|(hash, scope, remaining)| adoption::McpCredManifest {
                        hash,
                        workspace_id: scope.workspace_id,
                        remaining_secs: remaining.as_secs(),
                    });
            out.push(adoption::SessionManifest {
                session_id: *id,
                pid: s.pid,
                cols,
                rows,
                output_offset: s.raw_output_bytes.load(Ordering::Acquire),
                state: *s.state.lock().expect("state lock"),
                status: *s.status.lock().expect("status lock"),
                hidden: s.info.hidden,
                project_dir: s.project_dir.lock().expect("project dir lock").clone(),
                cwd: s.info.cwd.clone(),
                title: s.title.lock().expect("title lock").clone(),
                codename: s.info.codename.clone(),
                tags: s.tags.lock().expect("tags lock").clone(),
                agent: s.info.agent,
                swarm_agent: s.info.swarm_agent,
                hook_cwd: s.hook_cwd.lock().expect("hook cwd lock").clone(),
                mcp_cred,
                vt_snapshot: match s.vt().as_mut() {
                    Some(emulator) => emulator
                        .snapshot(crate::vt::VT_HISTORY_ROWS)
                        .unwrap_or_else(|e| {
                            tracing::warn!(
                                "session {id}: no emulator snapshot for the handoff ({e}); the \
                                 candidate will start a fresh emulator for it"
                            );
                            Vec::new()
                        }),
                    None => Vec::new(),
                },
                vt_format_version: crate::vt::snapshot_format_version(),
            });
        }
        drop(sessions);
        let manifest = adoption::Manifest {
            version: adoption::MANIFEST_VERSION,
            generation,
            token: self.token.clone(),
            sessions: out,
        };
        let byte_len = manifest
            .wire_byte_len()
            .map_err(|e| format!("measuring manifest size: {e}"))?;
        if byte_len > adoption::MANIFEST_BYTE_CAP {
            return Err(format!(
                "manifest is {byte_len} bytes for {} session(s), cap is {}",
                ids.len(),
                adoption::MANIFEST_BYTE_CAP
            ));
        }
        Ok(manifest)
    }

    fn remove_persisted_scrollback(&self, id: u32) {
        let path = self.scrollback_path(id);
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::warn!("removing persisted scrollback of session {id}: {e}");
            }
        }
    }

    pub fn startup_cause(&self) -> StartupCause {
        self.startup_cause
    }

    pub fn safe_mode_flags(&self) -> SafeModeFlags {
        self.safe_mode_flags
    }

    fn marker_path(&self) -> PathBuf {
        self.state_dir.join(CLEAN_SHUTDOWN_FILE)
    }

    fn run_state_path(&self) -> PathBuf {
        self.state_dir.join(RUN_STATE_FILE)
    }

    pub fn expect_restart(&self) {
        self.run_state_expected_restart
            .store(true, Ordering::Relaxed);
        self.write_run_state_file(&self.marker_path(), b"");
        self.write_run_state();
    }

    pub fn clear_expected_restart(&self) {
        self.run_state_expected_restart
            .store(false, Ordering::Relaxed);
        remove_file_logged(&self.marker_path(), "clean-shutdown marker");
        self.write_run_state();
    }

    fn write_run_state(&self) {
        let session_count = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|s| !s.info.hidden)
            .count() as u32;
        let state = RunState {
            schema_version: RUN_STATE_SCHEMA_VERSION,
            started_at: self.run_state_started_at,
            last_seen_at: now_ms(),
            session_count,
            swarm_count: {
                match self.db.list_swarms() {
                    Ok(swarms) => swarms
                        .iter()
                        .filter(|s| s.status == proto::SwarmStatus::Active)
                        .count() as u32,
                    Err(e) => {
                        tracing::warn!("counting live swarms for the run-state file: {e}");
                        0
                    }
                }
            },
            expected_restart: self.run_state_expected_restart.load(Ordering::Relaxed),
        };
        match serde_json::to_vec(&state) {
            Ok(json) => self.write_run_state_file(&self.run_state_path(), &json),
            Err(e) => tracing::warn!("serializing run-state file: {e}"),
        }
    }

    #[doc(hidden)]
    pub fn write_run_state_for_test(&self) {
        self.write_run_state();
    }

    fn write_file_atomic(&self, path: &Path, contents: &[u8]) -> Result<()> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = path.with_extension(format!(
            "tr-tmp.{}.{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&tmp, contents).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| {
            format!(
                "renaming {} into place at {}",
                tmp.display(),
                path.display()
            )
        })?;
        Ok(())
    }

    fn write_run_state_file(&self, path: &Path, contents: &[u8]) {
        if let Err(e) = self.write_file_atomic(path, contents) {
            tracing::warn!("{e:#}");
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Outbound> {
        self.tx.subscribe()
    }

    pub fn frame_taps(&self) -> &Arc<crate::frame_queue::FrameRegistry> {
        &self.frame_taps
    }

    pub fn observe(&self) -> crate::frame_queue::Observer {
        crate::frame_queue::Observer::new(self.subscribe(), Arc::clone(&self.frame_taps))
    }

    /// For the sibling modules that own a slice of daemon behaviour and need the
    /// settings table; the field stays private so nothing outside the crate reaches it.
    pub(crate) fn db(&self) -> &Db {
        &self.db
    }

    pub fn broadcast_control(&self, msg: &proto::ServerMsg) {
        let json = serde_json::to_string(msg).expect("ServerMsg serializes");
        let _ = self.tx.send(Outbound::Control(Arc::new(json)));
    }

    pub fn send_control_to(&self, conn_id: u64, msg: &proto::ServerMsg) {
        let json = serde_json::to_string(msg).expect("ServerMsg serializes");
        let _ = self.tx.send(Outbound::ControlFor(conn_id, Arc::new(json)));
    }

    /// A panel-created worktree under the daemon's own state dir, beside task
    /// worktrees: branch `houston/<slug>` off `base`, so it cannot collide with
    /// a task's directory.
    pub fn git_worktree_create(
        &self,
        repo: &std::path::Path,
        name: &str,
        base: Option<&str>,
    ) -> anyhow::Result<crate::worktrees::Worktree> {
        let project = repo
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        let dest = crate::worktrees::default_path(&self.state_dir, &project, name);
        crate::worktrees::create_named(repo, name, base, &dest)
    }

    fn broadcast_live_children(&self, parent: u32) {
        self.broadcast_child_counts(parent);
        self.mcp_notify.tools_changed_for_session(parent);
    }

    fn broadcast_child_counts(&self, parent: u32) {
        let (live_children, children_waiting) = self.child_counts_of(parent);
        self.broadcast_control(&proto::ServerMsg::LiveChildrenChanged {
            session: parent,
            live_children,
            children_waiting,
        });
    }

    fn child_counts_of(&self, parent: u32) -> (u32, u32) {
        let live = self.live_children_of(parent);
        let waiting = live
            .iter()
            .filter(|child| {
                self.delegation_of(**child).is_some_and(|row| {
                    row.stalled
                        || orchestrate::DelegationState::parse(&row.state)
                            == Some(orchestrate::DelegationState::NeedsInput)
                })
            })
            .count() as u32;
        (live.len() as u32, waiting)
    }

    fn broadcast_delegation(&self, child: u32) {
        let Some(row) = self.delegation_of(child) else {
            return;
        };
        let parent = row.parent_session;
        let pending = self.pending_handback(parent, child);
        let owed = self.inbox_owed(parent, child);
        let capability = self.capability_note_of(child);
        let hold = (owed.owed > 0)
            .then(|| self.paste_hold_reason(parent))
            .flatten();
        let delegation = orchestrate::delegation_info(
            row,
            self.turn_end_source_of(child),
            pending,
            owed,
            capability,
            hold,
        );
        self.broadcast_control(&proto::ServerMsg::DelegationChanged {
            session: child,
            delegation,
        });
        self.broadcast_child_counts(parent);
    }

    pub fn hook_launcher(&self) -> Option<std::path::PathBuf> {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("hook launcher: cannot resolve own exe path: {e}");
                return None;
            }
        };
        match crate::claude_hooks::point_launcher(&self.state_dir, &exe) {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::warn!(
                    "hook launcher: pointing {} at {}: {e} — falling back to baking the binary path",
                    crate::claude_hooks::launcher_path(&self.state_dir).display(),
                    exe.display()
                );
                None
            }
        }
    }

    fn hook_install_context(&self) -> Option<(String, String)> {
        let exe = match std::env::current_exe() {
            Ok(p) => p.display().to_string(),
            Err(e) => {
                tracing::warn!("agent-status hooks: cannot resolve own exe path: {e}");
                return None;
            }
        };
        let exe = match self.hook_launcher() {
            Some(p) => p.display().to_string(),
            None => exe,
        };
        Some((
            exe,
            crate::claude_hooks::sentinel_for(self.channel.as_deref()),
        ))
    }

    pub fn install_workspace_hooks(&self, path: &str) {
        if !Path::new(path).is_dir() || !self.hook_consent(proto::AgentKind::Claude) {
            return;
        }
        let Some((exe, sentinel)) = self.hook_install_context() else {
            return;
        };
        self.install_workspace_hooks_with(path, &exe, &sentinel);
    }

    fn install_workspace_hooks_with(&self, path: &str, exe: &str, sentinel: &str) {
        let dir = Path::new(path);
        if !dir.is_dir() {
            return;
        }
        if !self.hook_consent(proto::AgentKind::Claude) {
            return;
        }
        let settings = crate::claude_hooks::settings_path(dir);
        match crate::claude_hooks::install(&settings, exe, sentinel) {
            Ok(install) => {
                if let Err(e) = self.db.record_workspace_hooks(
                    path,
                    install.created_file,
                    install.created_hooks,
                ) {
                    tracing::warn!("recording hook ownership for {path}: {e}");
                }
            }
            Err(e) => tracing::warn!("installing Claude hooks in {path}: {e}"),
        }
    }

    pub fn uninstall_workspace_hooks(&self, path: &str) {
        let ownership = match self.db.workspace_hooks_ownership(path) {
            Ok(Some(o)) => o,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("reading hook ownership for {path}: {e}");
                return;
            }
        };
        let settings = crate::claude_hooks::settings_path(Path::new(path));
        let sentinel = crate::claude_hooks::sentinel_for(self.channel.as_deref());
        if let Err(e) = crate::claude_hooks::remove(&settings, ownership.0, ownership.1, &sentinel)
        {
            tracing::warn!("removing Claude hooks in {path}: {e}");
        }
        if let Err(e) = self.db.delete_workspace_hooks(path) {
            tracing::warn!("clearing hook ownership for {path}: {e}");
        }
    }

    pub fn mcp_state(&self) -> proto::ServerMsg {
        let source = self.mcp_source();
        let tools = match crate::agent_hooks::ConfigHome::from_env() {
            Ok(home) => crate::mcp::read_tools(&home),
            Err(e) => crate::mcp::MCP_TOOLS
                .iter()
                .map(|tool| proto::McpToolState {
                    tool: *tool,
                    path: String::new(),
                    detected: false,
                    servers: Vec::new(),
                    error: Some(format!("{e:#}")),
                })
                .collect(),
        };
        let checks = self.mcp_checks_snapshot(&source);
        proto::ServerMsg::McpState {
            source,
            source_path: crate::mcp::source_path(&self.state_dir)
                .display()
                .to_string(),
            tools,
            results: Vec::new(),
            checks,
        }
    }

    fn mcp_checks_snapshot(
        &self,
        source: &[proto::McpServer],
    ) -> Vec<(String, proto::McpConnectionCheck)> {
        self.mcp_checks
            .lock()
            .expect("mcp_checks poisoned")
            .iter()
            .filter(|(name, (fingerprint, _))| {
                source
                    .iter()
                    .any(|s| &s.name == *name && &s.fingerprint == fingerprint)
            })
            .map(|(name, (_, check))| (name.clone(), check.clone()))
            .collect()
    }

    fn mcp_source(&self) -> Vec<proto::McpServer> {
        match crate::mcp::read_source(&self.state_dir) {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("reading Houston's MCP list: {e:#}");
                Vec::new()
            }
        }
    }

    pub fn mcp_sync(&self, only: Option<proto::AgentKind>) -> proto::ServerMsg {
        let source = self.mcp_source();
        let mut results = Vec::new();
        let home = crate::agent_hooks::ConfigHome::from_env();
        for tool in crate::mcp::MCP_TOOLS {
            if only.is_some_and(|t| t != tool) {
                continue;
            }
            let scoped: Vec<proto::McpServer> = source
                .iter()
                .filter(|s| s.destinations.is_empty() || s.destinations.contains(&tool))
                .cloned()
                .collect();
            let wanted: Vec<String> = scoped.iter().map(|s| s.name.clone()).collect();
            let slug = crate::agent_hooks::provider_slug(tool);
            let owned = self.db.mcp_managed_names(slug).unwrap_or_default();
            let outcome = match (&home, tool) {
                (Err(e), _) => Err(anyhow!("{e:#}")),
                (Ok(_), proto::AgentKind::Claude) => self.mcp_sync_claude(&scoped, &owned),
                (Ok(home), _) => {
                    crate::mcp::sync_tool(tool, home, &scoped, &owned, &self.hook_sentinel())
                }
            };
            match outcome {
                Ok(out) => {
                    let skipped_names: Vec<&str> = out
                        .skipped
                        .iter()
                        .filter_map(|s| s.split(':').next())
                        .collect();
                    let owned_now: Vec<String> = wanted
                        .iter()
                        .filter(|n| !skipped_names.contains(&n.as_str()))
                        .cloned()
                        .collect();
                    if let Err(e) = self.db.set_mcp_managed(slug, &owned_now) {
                        tracing::warn!("recording MCP ownership for {slug}: {e}");
                    }
                    results.push(proto::McpSyncResult {
                        tool,
                        written: out.written,
                        removed: out.removed,
                        skipped: out.skipped,
                        error: None,
                    });
                }
                Err(e) => results.push(proto::McpSyncResult {
                    tool,
                    written: 0,
                    removed: 0,
                    skipped: Vec::new(),
                    error: Some(format!("{e:#}")),
                }),
            }
        }
        match self.mcp_state() {
            proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                checks,
                ..
            } => proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                results,
                checks,
            },
            other => other,
        }
    }

    fn mcp_sync_claude(
        &self,
        source: &[proto::McpServer],
        owned: &[String],
    ) -> Result<crate::mcp::SyncOutcome> {
        let mut out = crate::mcp::SyncOutcome {
            written: 0,
            removed: 0,
            skipped: Vec::new(),
        };
        let wanted: Vec<&str> = source.iter().map(|s| s.name.as_str()).collect();
        for name in owned {
            if wanted.contains(&name.as_str()) {
                continue;
            }
            match run_claude_mcp(&["remove".into(), name.clone(), "-s".into(), "user".into()]) {
                Ok(()) => out.removed += 1,
                Err(e) => out.skipped.push(format!("{name}: {e}")),
            }
        }
        for server in source {
            match claude_mcp_add_args(server) {
                Some(args) => match run_claude_mcp(&args) {
                    Ok(()) => out.written += 1,
                    Err(e) => out.skipped.push(format!("{}: {e}", server.name)),
                },
                None => out.skipped.push(format!(
                    "{}: no command or url to give `claude mcp add`",
                    server.name
                )),
            }
        }
        Ok(out)
    }

    pub fn mcp_import(&self, tool: proto::AgentKind) -> proto::ServerMsg {
        let home = match crate::agent_hooks::ConfigHome::from_env() {
            Ok(h) => h,
            Err(e) => return self.mcp_error_state(tool, format!("{e:#}")),
        };
        let column = crate::mcp::read_tool(tool, &home);
        if let Some(e) = column.error {
            return self.mcp_error_state(tool, e);
        }
        let mut source = self.mcp_source();
        let mut added = 0usize;
        for server in column.servers {
            if source.iter().any(|s| s.name == server.name) {
                continue;
            }
            source.push(server);
            added += 1;
        }
        source.sort_by(|a, b| a.name.cmp(&b.name));
        if let Err(e) = crate::mcp::write_source(&self.state_dir, &source) {
            return self.mcp_error_state(tool, format!("{e:#}"));
        }
        match self.mcp_state() {
            proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                checks,
                ..
            } => proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                results: vec![proto::McpSyncResult {
                    tool,
                    written: added,
                    removed: 0,
                    skipped: Vec::new(),
                    error: None,
                }],
                checks,
            },
            other => other,
        }
    }

    pub fn mcp_set_enabled(&self, name: &str, enabled: bool) -> proto::ServerMsg {
        let mut source = self.mcp_source();
        let mut found = false;
        for server in source.iter_mut() {
            if server.name == name {
                server.enabled = enabled;
                server.fingerprint = crate::mcp::fingerprint(server);
                found = true;
            }
        }
        if !found {
            return self.mcp_error_state(
                proto::AgentKind::Custom,
                format!("no server named {name:?} in Houston's list"),
            );
        }
        if let Err(e) = crate::mcp::write_source(&self.state_dir, &source) {
            return self.mcp_error_state(proto::AgentKind::Custom, format!("{e:#}"));
        }
        self.mcp_state()
    }

    pub fn mcp_server_upsert(
        &self,
        previous_name: Option<&str>,
        mut server: proto::McpServer,
    ) -> proto::ServerMsg {
        if server.name.trim().is_empty() {
            return self.mcp_error_state(
                proto::AgentKind::Custom,
                "a server needs a name".to_string(),
            );
        }
        server.env.sort();
        server.headers.sort();
        server.fingerprint = crate::mcp::fingerprint(&server);

        let mut source = self.mcp_source();
        let renaming_from = previous_name.filter(|p| *p != server.name);
        if let Some(prev) = renaming_from {
            if source.iter().any(|s| s.name == server.name) {
                return self.mcp_error_state(
                    proto::AgentKind::Custom,
                    format!(
                        "{:?} is already the name of another server in your list",
                        server.name
                    ),
                );
            }
            source.retain(|s| s.name != prev);
            self.mcp_checks
                .lock()
                .expect("mcp_checks poisoned")
                .remove(prev);
        }
        match source.iter_mut().find(|s| s.name == server.name) {
            Some(existing) => *existing = server,
            None => source.push(server),
        }
        source.sort_by(|a, b| a.name.cmp(&b.name));
        if let Err(e) = crate::mcp::write_source(&self.state_dir, &source) {
            return self.mcp_error_state(proto::AgentKind::Custom, format!("{e:#}"));
        }
        self.mcp_state()
    }

    pub fn mcp_server_remove(&self, name: &str) -> proto::ServerMsg {
        let mut source = self.mcp_source();
        let before = source.len();
        source.retain(|s| s.name != name);
        if source.len() == before {
            return self.mcp_error_state(
                proto::AgentKind::Custom,
                format!("no server named {name:?} in your list"),
            );
        }
        if let Err(e) = crate::mcp::write_source(&self.state_dir, &source) {
            return self.mcp_error_state(proto::AgentKind::Custom, format!("{e:#}"));
        }
        self.mcp_checks
            .lock()
            .expect("mcp_checks poisoned")
            .remove(name);
        self.mcp_state()
    }

    pub fn mcp_test(self: &Arc<Self>, name: String) {
        let Some(server) = self.mcp_source().into_iter().find(|s| s.name == name) else {
            return;
        };
        let fingerprint = server.fingerprint.clone();
        self.mcp_checks.lock().expect("mcp_checks poisoned").insert(
            name.clone(),
            (fingerprint.clone(), proto::McpConnectionCheck::Checking),
        );
        self.broadcast_control(&self.mcp_state());

        let me = self.clone();
        tokio::spawn(async move {
            let result = crate::mcp_check::test(&server).await;
            let mut checks = me.mcp_checks.lock().expect("mcp_checks poisoned");
            if checks.get(&name).is_some_and(|(fp, _)| *fp == fingerprint) {
                checks.insert(name.clone(), (fingerprint, result));
            }
            drop(checks);
            me.broadcast_control(&me.mcp_state());
        });
    }

    fn mcp_error_state(&self, tool: proto::AgentKind, message: String) -> proto::ServerMsg {
        match self.mcp_state() {
            proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                checks,
                ..
            } => proto::ServerMsg::McpState {
                source,
                source_path,
                tools,
                results: vec![proto::McpSyncResult {
                    tool,
                    written: 0,
                    removed: 0,
                    skipped: Vec::new(),
                    error: Some(message),
                }],
                checks,
            },
            other => other,
        }
    }

    fn agent_profile_slug(agent: proto::AgentKind) -> Result<&'static str> {
        match agent {
            proto::AgentKind::Claude => Ok("claude"),
            proto::AgentKind::Codex => Ok("codex"),
            other => bail!(
                "agent profiles only cover claude/codex (CLAUDE_CONFIG_DIR/CODEX_HOME); \
                 got {other:?}"
            ),
        }
    }

    pub fn agent_profile_state(&self) -> proto::ServerMsg {
        let mut profiles = Vec::new();
        let mut active = Vec::new();
        for (agent, slug) in [
            (proto::AgentKind::Claude, "claude"),
            (proto::AgentKind::Codex, "codex"),
        ] {
            match self.db.list_agent_profiles(slug) {
                Ok(rows) => profiles.extend(rows.into_iter().map(|r| proto::AgentProfile {
                    id: r.id,
                    agent,
                    name: r.name,
                    config_dir: r.config_dir,
                })),
                Err(e) => tracing::warn!("listing {slug} agent profiles: {e:#}"),
            }
            match self.db.active_agent_profile(slug) {
                Ok(Some(row)) => active.push(proto::AgentProfileActive { agent, id: row.id }),
                Ok(None) => {}
                Err(e) => tracing::warn!("reading active {slug} profile: {e:#}"),
            }
        }
        proto::ServerMsg::AgentProfileState { profiles, active }
    }

    pub fn agent_profile_upsert(
        &self,
        id: Option<u32>,
        agent: proto::AgentKind,
        name: &str,
        config_dir: &str,
    ) -> Result<proto::ServerMsg> {
        let slug = Self::agent_profile_slug(agent)?;
        self.db.upsert_agent_profile(id, slug, name, config_dir)?;
        Ok(self.agent_profile_state())
    }

    pub fn agent_profile_delete(&self, id: u32) -> Result<proto::ServerMsg> {
        let slug = self
            .db
            .agent_profile_agent(id)?
            .ok_or_else(|| anyhow!("no agent profile with id {id}"))?;
        self.db.delete_agent_profile(id, &slug)?;
        Ok(self.agent_profile_state())
    }

    pub fn agent_profile_set_active(
        &self,
        agent: proto::AgentKind,
        id: Option<u32>,
    ) -> Result<proto::ServerMsg> {
        let slug = Self::agent_profile_slug(agent)?;
        self.db.set_active_agent_profile(slug, id)?;
        Ok(self.agent_profile_state())
    }

    fn active_agent_profile_env(&self, agent: proto::AgentKind) -> Option<(String, String)> {
        let slug = Self::agent_profile_slug(agent).ok()?;
        match self.db.active_agent_profile(slug) {
            Ok(Some(row)) => Some((
                Self::agent_profile_env_var(agent),
                self.expand_profile_dir(slug, row.config_dir),
            )),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!("reading active {slug} profile at spawn time: {e:#}");
                None
            }
        }
    }

    fn agent_profile_env_var(agent: proto::AgentKind) -> String {
        match agent {
            proto::AgentKind::Claude => "CLAUDE_CONFIG_DIR",
            proto::AgentKind::Codex => "CODEX_HOME",
            _ => unreachable!("agent_profile_slug already restricted to claude/codex"),
        }
        .to_string()
    }

    fn expand_profile_dir(&self, slug: &str, raw: String) -> String {
        match self.hook_config_home() {
            Ok(home) => crate::agent_accounts::expand_tilde(&raw, &home.home)
                .to_string_lossy()
                .into_owned(),
            Err(e) => {
                tracing::warn!(
                    "resolving HOME to expand {slug} profile config_dir {raw:?}: {e:#} — \
                     exporting it unexpanded"
                );
                raw
            }
        }
    }

    fn resolve_spawn_profile(
        &self,
        agent: proto::AgentKind,
        choice: Option<&proto::ProfileChoice>,
    ) -> Result<ProfileSpawnEnv> {
        match choice {
            None => {
                let env = self.active_agent_profile_env(agent);
                let label = env.as_ref().and_then(|_| {
                    let slug = Self::agent_profile_slug(agent).ok()?;
                    self.db
                        .active_agent_profile(slug)
                        .ok()
                        .flatten()
                        .map(|r| r.name)
                });
                Ok((env, label))
            }
            Some(proto::ProfileChoice::Default) => Ok((None, None)),
            Some(proto::ProfileChoice::Profile { id }) => {
                let slug = Self::agent_profile_slug(agent)?;
                let mut rows = self.db.list_agent_profiles(slug)?;
                match rows.iter().position(|r| r.id == *id) {
                    Some(idx) => {
                        let row = rows.swap_remove(idx);
                        Ok((
                            Some((
                                Self::agent_profile_env_var(agent),
                                self.expand_profile_dir(slug, row.config_dir),
                            )),
                            Some(row.name),
                        ))
                    }
                    None => {
                        let known: Vec<String> = rows.into_iter().map(|r| r.name).collect();
                        bail!(
                            "no {slug} agent profile with id {id} (known profiles: [{}])",
                            if known.is_empty() {
                                "none saved".to_string()
                            } else {
                                known.join(", ")
                            }
                        );
                    }
                }
            }
        }
    }

    pub fn routine_runs_in_flight(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .keys()
            .copied()
            .collect();
        ids.sort_unstable();
        ids
    }

    fn routine_row_to_wire(row: crate::db::RoutineRow) -> proto::Routine {
        proto::Routine {
            id: row.id,
            name: row.name,
            prompt: row.prompt,
            cadence: row.cadence,
            enabled: row.enabled,
            workspace_id: row.workspace_id,
            engine: row.engine,
            model: row.model,
            effort: row.effort,
            next_run_at_ms: row.next_run_at_ms,
            last_run_at_ms: row.last_run_at_ms,
            last_run_session_id: row.last_run_session_id,
            last_error: row.last_error,
            permission_mode: row.permission_mode,
            isolate: row.isolate,
            last_outcome: row.last_outcome,
            revision: row.revision,
        }
    }

    pub fn routine_runs_list(&self, routine_id: Option<u32>) -> proto::ServerMsg {
        let runs = self
            .db
            .list_routine_runs(routine_id, proto::ROUTINE_RUNS_PAGE)
            .unwrap_or_else(|e| {
                tracing::warn!("listing routine runs: {e:#}");
                Vec::new()
            })
            .into_iter()
            .map(Self::routine_run_to_wire)
            .collect();
        proto::ServerMsg::RoutineRuns { runs }
    }

    fn routine_run_to_wire(row: crate::db::RoutineRunRow) -> proto::RoutineRun {
        proto::RoutineRun {
            id: row.id,
            routine_id: row.routine_id,
            trigger: row.trigger,
            status: row.status,
            session_id: row.session_id,
            error: row.error,
            started_at_ms: row.started_at_ms,
            ended_at_ms: row.ended_at_ms,
        }
    }

    fn routine_refused(
        id: Option<u32>,
        kind: proto::RoutineErrorKind,
        limit: Option<(u32, u32)>,
    ) -> proto::ServerMsg {
        proto::ServerMsg::RoutineRefused {
            id,
            kind,
            limit: limit.map(|(l, _)| l),
            requested: limit.map(|(_, r)| r),
        }
    }

    pub fn routine_list(&self) -> proto::ServerMsg {
        let routines = self
            .db
            .list_routines()
            .unwrap_or_else(|e| {
                tracing::warn!("listing routines: {e:#}");
                Vec::new()
            })
            .into_iter()
            .map(Self::routine_row_to_wire)
            .collect();
        proto::ServerMsg::Routines {
            routines,
            running: self.routine_runs_in_flight(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn routine_create_for_test(
        &self,
        name: &str,
        prompt: &str,
        cadence: proto::Cadence,
        workspace_id: Option<String>,
        engine: proto::AgentKind,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
    ) -> Result<proto::ServerMsg> {
        self.routine_create(
            name,
            prompt,
            cadence,
            workspace_id,
            engine,
            permission_mode,
            isolate,
        )
    }

    /// The wire entry. `engine` is mandatory: it is the record's own, and a
    /// fire never reads execution settings off anything else.
    #[allow(clippy::too_many_arguments)]
    pub fn routine_create_full(
        &self,
        name: &str,
        prompt: &str,
        cadence: proto::Cadence,
        workspace_id: Option<String>,
        engine: Option<proto::AgentKind>,
        model: Option<String>,
        effort: Option<proto::ChatEffort>,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
    ) -> Result<proto::ServerMsg> {
        let Some(engine) = engine else {
            bail!(
                "a routine needs its own engine: pass engine (one of claude, codex, \
                 antigravity, opencode, cursor, grok)"
            );
        };
        self.routine_create_impl(
            name,
            prompt,
            cadence,
            workspace_id,
            engine,
            model,
            effort,
            permission_mode,
            isolate,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn routine_create(
        &self,
        name: &str,
        prompt: &str,
        cadence: proto::Cadence,
        workspace_id: Option<String>,
        engine: proto::AgentKind,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
    ) -> Result<proto::ServerMsg> {
        self.routine_create_impl(
            name,
            prompt,
            cadence,
            workspace_id,
            engine,
            None,
            None,
            permission_mode,
            isolate,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn routine_create_impl(
        &self,
        name: &str,
        prompt: &str,
        cadence: proto::Cadence,
        workspace_id: Option<String>,
        engine: proto::AgentKind,
        model: Option<String>,
        effort: Option<proto::ChatEffort>,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
        enabled: bool,
    ) -> Result<proto::ServerMsg> {
        use crate::routines;
        let name = routines::validate_name(name)?;
        routines::validate_prompt(prompt)?;
        routines::validate_cadence(&cadence)?;
        let permission_mode = permission_mode.unwrap_or(proto::ChatPermissionMode::AcceptEdits);
        let isolate = isolate.unwrap_or(false);
        Self::check_run_isolation(permission_mode, isolate, workspace_id.as_deref())?;
        Self::check_routine_launch(engine, model.as_deref(), effort, permission_mode)?;
        if let Err(hit) = routines::check_total_count(self.db.routine_total_count()?) {
            return Ok(Self::routine_refused(
                None,
                proto::RoutineErrorKind::Limit,
                Some(hit),
            ));
        }
        let folded = routines::fold_name(name);
        if self.db.routine_name_taken(&folded, None)? {
            return Ok(Self::routine_refused(
                None,
                proto::RoutineErrorKind::DuplicateName,
                None,
            ));
        }
        let revision = routines::revision(
            name,
            prompt,
            &cadence,
            enabled,
            workspace_id.as_deref(),
            engine,
            model.as_deref(),
            effort,
            permission_mode,
            isolate,
        );
        let cadence_json = serde_json::to_string(&cadence)?;
        let engine_slug = crate::db::wire_name(&engine)?;
        let effort_slug = effort.map(|e| crate::db::wire_name(&e)).transpose()?;
        let permission_slug = crate::db::wire_name(&permission_mode)?;
        self.db.create_routine(&crate::db::RoutineWrite {
            name,
            name_folded: &folded,
            prompt,
            cadence_json: &cadence_json,
            enabled,
            workspace_id: workspace_id.as_deref(),
            engine: &engine_slug,
            model: model.as_deref(),
            effort: effort_slug.as_deref(),
            next_run_at_ms: routines::next_run_at_ms(&cadence, now_unix_ms()),
            permission_mode: &permission_slug,
            isolate,
            revision: &revision,
        })?;
        self.routine_wake.notify_one();
        self.reap_reevaluate();
        Ok(self.routine_list())
    }

    fn check_run_isolation(
        permission_mode: proto::ChatPermissionMode,
        isolate: bool,
        workspace_id: Option<&str>,
    ) -> Result<()> {
        if isolate {
            let Some(dir) = workspace_id else {
                bail!(
                    "this routine asks to run in an isolated worktree but has no workspace \
                     directory; set one, or turn isolation off"
                );
            };
            if !crate::git::is_git_repo(std::path::Path::new(dir)) {
                bail!(
                    "this routine asks to run in an isolated worktree, but {dir} is not a git \
                     repository; a worktree needs one, so turn isolation off or point the \
                     routine at a repo"
                );
            }
        }
        if permission_mode == proto::ChatPermissionMode::BypassPermissions && !isolate {
            bail!(
                "full access is only offered on an isolated routine: a run that never asks must \
                 not land in the tree you are editing. Turn isolation on, or use accept edits"
            );
        }
        Ok(())
    }

    fn check_routine_launch(
        engine: proto::AgentKind,
        model: Option<&str>,
        effort: Option<proto::ChatEffort>,
        permission_mode: proto::ChatPermissionMode,
    ) -> Result<()> {
        crate::launch::routine_argv(engine, model, effort, permission_mode).map(|_| ())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn routine_update_for_test(
        &self,
        id: u32,
        expected_revision: &str,
        name: Option<String>,
        prompt: Option<String>,
        cadence: Option<proto::Cadence>,
        enabled: Option<bool>,
        workspace_id: Option<Option<String>>,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
    ) -> Result<proto::ServerMsg> {
        self.routine_update(
            id,
            expected_revision,
            name,
            prompt,
            cadence,
            enabled,
            workspace_id,
            permission_mode,
            isolate,
        )
    }

    /// The wire entry: every absent field stays as it is; `model`/`effort`
    /// are three-state (absent unchanged, `null` clears, value sets).
    pub fn routine_update_full(
        &self,
        id: u32,
        expected_revision: &str,
        patch: RoutinePatch,
    ) -> Result<proto::ServerMsg> {
        use crate::routines;
        let RoutinePatch {
            name,
            prompt,
            cadence,
            enabled,
            workspace_id,
            engine,
            model,
            effort,
            permission_mode,
            isolate,
        } = patch;
        let Some(row) = self.db.routine(id)? else {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::NotFound,
                None,
            ));
        };
        if row.revision != expected_revision {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::Conflict,
                None,
            ));
        }
        let name = match name {
            Some(n) => routines::validate_name(&n)?.to_string(),
            None => row.name,
        };
        let prompt = match prompt {
            Some(p) => {
                routines::validate_prompt(&p)?;
                p
            }
            None => row.prompt,
        };
        let cadence_changed = cadence.is_some();
        let cadence = match cadence {
            Some(c) => {
                routines::validate_cadence(&c)?;
                c
            }
            None => row.cadence,
        };
        let enabled = enabled.unwrap_or(row.enabled);
        let re_enabled = enabled && !row.enabled;
        let workspace_id = match workspace_id {
            Some(next) => next,
            None => row.workspace_id,
        };
        let engine = engine.unwrap_or(row.engine);
        let model = match model {
            Some(next) => next,
            None => row.model,
        };
        let effort = match effort {
            Some(next) => next,
            None => row.effort,
        };
        let permission_mode = permission_mode.unwrap_or(row.permission_mode);
        let isolate = isolate.unwrap_or(row.isolate);
        Self::check_run_isolation(permission_mode, isolate, workspace_id.as_deref())?;
        Self::check_routine_launch(engine, model.as_deref(), effort, permission_mode)?;
        let folded = routines::fold_name(&name);
        if folded != row.name_folded && self.db.routine_name_taken(&folded, Some(id))? {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::DuplicateName,
                None,
            ));
        }
        let next_run_at_ms = if cadence_changed || re_enabled {
            routines::next_run_at_ms(&cadence, now_unix_ms())
        } else {
            row.next_run_at_ms
        };
        let revision = routines::revision(
            &name,
            &prompt,
            &cadence,
            enabled,
            workspace_id.as_deref(),
            engine,
            model.as_deref(),
            effort,
            permission_mode,
            isolate,
        );
        let cadence_json = serde_json::to_string(&cadence)?;
        let engine_slug = crate::db::wire_name(&engine)?;
        let effort_slug = effort.map(|e| crate::db::wire_name(&e)).transpose()?;
        let permission_slug = crate::db::wire_name(&permission_mode)?;
        let found = self.db.update_routine(
            id,
            &crate::db::RoutineWrite {
                name: &name,
                name_folded: &folded,
                prompt: &prompt,
                cadence_json: &cadence_json,
                enabled,
                workspace_id: workspace_id.as_deref(),
                engine: &engine_slug,
                model: model.as_deref(),
                effort: effort_slug.as_deref(),
                next_run_at_ms,
                permission_mode: &permission_slug,
                isolate,
                revision: &revision,
            },
        )?;
        if !found {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::NotFound,
                None,
            ));
        }
        self.routine_wake.notify_one();
        self.reap_reevaluate();
        Ok(self.routine_list())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn routine_update(
        &self,
        id: u32,
        expected_revision: &str,
        name: Option<String>,
        prompt: Option<String>,
        cadence: Option<proto::Cadence>,
        enabled: Option<bool>,
        workspace_id: Option<Option<String>>,
        permission_mode: Option<proto::ChatPermissionMode>,
        isolate: Option<bool>,
    ) -> Result<proto::ServerMsg> {
        self.routine_update_full(
            id,
            expected_revision,
            RoutinePatch {
                name,
                prompt,
                cadence,
                enabled,
                workspace_id,
                permission_mode,
                isolate,
                ..RoutinePatch::default()
            },
        )
    }

    pub fn routine_delete(&self, id: u32, expected_revision: &str) -> Result<proto::ServerMsg> {
        let Some(row) = self.db.routine(id)? else {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::NotFound,
                None,
            ));
        };
        if row.revision != expected_revision {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::Conflict,
                None,
            ));
        }
        if !self.db.delete_routine(id)? {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::NotFound,
                None,
            ));
        }
        self.routine_wake.notify_one();
        self.reap_reevaluate();
        Ok(self.routine_list())
    }

    /// Test-only override for a routine run's argv: a fixture process stands in
    /// for the real CLI.
    pub fn set_routine_pane_cmd_for_test(&self, cmd: Vec<String>) {
        *self
            .routine_pane_cmd_override
            .lock()
            .expect("routine pane cmd lock") = Some(cmd);
    }

    #[doc(hidden)]
    pub fn set_routine_pane_registration_hook_for_test(
        &self,
        hook: Option<RoutinePaneRegistrationHook>,
    ) {
        *self
            .routine_pane_registration_hook_for_test
            .lock()
            .expect("routine pane registration hook lock") = hook;
    }

    /// The scheduler's entry point. `id` absent from the queue is loud (Err);
    /// everything a run can refuse is a recorded run, not an error.
    pub fn routine_fire(self: &Arc<Self>, id: u32) -> Result<()> {
        self.routine_fire_with_trigger(id, proto::RoutineTrigger::Schedule)
    }

    /// Run now: exactly the scheduler's path, with the trigger written down.
    pub fn routine_run_now(self: &Arc<Self>, id: u32) -> Result<proto::ServerMsg> {
        let in_flight = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .contains_key(&id);
        if in_flight {
            return Ok(Self::routine_refused(
                Some(id),
                proto::RoutineErrorKind::AlreadyRunning,
                None,
            ));
        }
        self.routine_fire_with_trigger(id, proto::RoutineTrigger::Manual)?;
        Ok(self.routine_list())
    }

    fn routine_fire_with_trigger(
        self: &Arc<Self>,
        id: u32,
        trigger: proto::RoutineTrigger,
    ) -> Result<()> {
        let Some(row) = self.db.routine(id)? else {
            bail!("no routine with id {id} to fire");
        };
        let now = now_unix_ms();
        let next = crate::routines::next_run_at_ms(&row.cadence, now);
        let Some(dir) = row.workspace_id.clone() else {
            return self.refuse_routine_run(
                &row,
                trigger,
                now,
                next,
                format!(
                    "{:?} has no working directory; a run has to start in a real directory \
                     and Houston will not pick one — set one on the routine",
                    row.name
                ),
            );
        };
        let mut run_dir = None;
        if row.isolate {
            match self.routine_worktree(&row, Path::new(&dir), now) {
                Ok(dir) => run_dir = Some(dir),
                Err(e) => {
                    return self.refuse_routine_run(
                        &row,
                        trigger,
                        now,
                        next,
                        format!(
                            "{:?} runs isolated, and its worktree of {dir} could not be made: {e}",
                            row.name
                        ),
                    )
                }
            }
        }
        self.routine_fire_in_pane(&row, trigger, now, next, run_dir)
    }

    /// A run that never started still leaves an independent, visible record.
    fn refuse_routine_run(
        self: &Arc<Self>,
        row: &crate::db::RoutineRow,
        trigger: proto::RoutineTrigger,
        now: i64,
        next: i64,
        error: String,
    ) -> Result<()> {
        let run_id = self.record_run_start(row, trigger, None, now, next)?;
        self.settle_run(
            run_id,
            row.id,
            proto::RoutineOutcome::EngineRefused,
            Some(error),
        );
        Ok(())
    }

    /// Open the independent run record and advance the routine's clock in the
    /// same move: every path in — scheduled, manual, refused — goes through
    /// this, so a run is never only a message.
    fn record_run_start(
        &self,
        row: &crate::db::RoutineRow,
        trigger: proto::RoutineTrigger,
        session_id: Option<u32>,
        now: i64,
        next: i64,
    ) -> Result<u32> {
        let run_id = self.db.create_routine_run(row.id, trigger, now)?;
        self.db
            .record_routine_run_start(row.id, session_id, now, next)?;
        self.broadcast_routine_run(run_id);
        Ok(run_id)
    }

    fn broadcast_routine_run(&self, run_id: u32) {
        match self.db.routine_run(run_id) {
            Ok(Some(run)) => self.broadcast_control(&proto::ServerMsg::RoutineRunEvent {
                run: Self::routine_run_to_wire(run),
            }),
            Ok(None) => tracing::warn!("routine run {run_id} vanished before it could be read"),
            Err(e) => tracing::warn!("reading routine run {run_id} to broadcast it: {e:#}"),
        }
    }

    /// Close a run row and write the routine's own summary, always together.
    fn settle_run(
        &self,
        run_id: u32,
        routine_id: u32,
        outcome: proto::RoutineOutcome,
        error: Option<String>,
    ) {
        let status = proto::RoutineRunStatus::from(outcome);
        let error = error.map(|mut e| {
            if e.chars().count() > proto::ROUTINE_LAST_ERROR_MAX {
                e = e
                    .chars()
                    .take(proto::ROUTINE_LAST_ERROR_MAX)
                    .collect::<String>();
            }
            e
        });
        if let Err(e) = self
            .db
            .finish_routine_run(run_id, status, error.as_deref(), now_unix_ms())
        {
            tracing::warn!("closing routine {routine_id}'s run {run_id}: {e:#}");
        }
        self.broadcast_routine_run(run_id);
        self.settle_routine_run(routine_id, outcome, error);
    }

    fn routine_worktree(
        &self,
        row: &crate::db::RoutineRow,
        base: &Path,
        now: i64,
    ) -> Result<PathBuf> {
        if !crate::git::is_git_repo(base) {
            bail!(
                "{} is not a git repository, and an isolated run needs one to branch from",
                base.display()
            );
        }
        let dest = self
            .state_dir
            .join("routines")
            .join(row.id.to_string())
            .join(now.to_string());
        crate::git::worktree_add(base, &dest)
    }

    fn routine_fire_in_pane(
        self: &Arc<Self>,
        row: &crate::db::RoutineRow,
        trigger: proto::RoutineTrigger,
        now: i64,
        next: i64,
        run_dir: Option<PathBuf>,
    ) -> Result<()> {
        let dir = match run_dir {
            Some(d) => d.to_string_lossy().into_owned(),
            None => row
                .workspace_id
                .clone()
                .expect("the caller refused a routine with no directory at all"),
        };
        let run_id = self.record_run_start(row, trigger, None, now, next)?;
        let cmd_override = self
            .routine_pane_cmd_override
            .lock()
            .expect("routine pane cmd lock")
            .clone();
        let (cmd, approval) = match cmd_override {
            Some(cmd) => {
                let approval = match row.permission_mode {
                    proto::ChatPermissionMode::AcceptEdits => crate::launch::ApprovalMode::Auto,
                    proto::ChatPermissionMode::BypassPermissions => {
                        crate::launch::ApprovalMode::Bypass
                    }
                };
                (cmd, approval)
            }
            None => match crate::launch::routine_argv(
                row.engine,
                row.model.as_deref(),
                row.effort,
                row.permission_mode,
            ) {
                Ok(values) => values,
                Err(e) => {
                    self.settle_run(
                        run_id,
                        row.id,
                        proto::RoutineOutcome::EngineRefused,
                        Some(format!("{e:#}")),
                    );
                    return Ok(());
                }
            },
        };
        let spawned = self.create_session(CreateParams {
            agent: row.engine,
            project_dir: PathBuf::from(&dir),
            cmd: Some(cmd),
            cols: 120,
            rows: 32,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: Some(row.prompt.clone()),
        });
        let session = match spawned {
            Ok(info) => info,
            Err(e) => {
                self.settle_run(
                    run_id,
                    row.id,
                    proto::RoutineOutcome::EngineRefused,
                    Some(format!("{e:#}")),
                );
                return Ok(());
            }
        };
        self.record_approval_mode(session.id, approval);
        if let Err(e) = self.db.set_routine_run_session(run_id, session.id) {
            tracing::warn!("recording routine {}'s pane session: {e:#}", row.id);
        }
        self.db
            .record_routine_run_start(row.id, Some(session.id), now, next)?;
        self.broadcast_routine_run(run_id);
        if let Some(hook) = self
            .routine_pane_registration_hook_for_test
            .lock()
            .expect("routine pane registration hook lock")
            .as_ref()
        {
            hook(session.id);
        }
        self.routine_runs.lock().expect("routine run lock").insert(
            row.id,
            RoutineRun {
                run_id,
                session_id: Some(session.id),
                started_at_ms: now,
                denied: false,
            },
        );
        if self.routine_pane_is_done(session.id) {
            self.report_routine_pane_run(session.id, orchestrate::TurnEndSource::QuietSettle);
        }
        self.broadcast_control(&self.routine_list());
        Ok(())
    }

    fn routine_pane_is_done(&self, session: u32) -> bool {
        let Some(session) = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&session)
            .cloned()
        else {
            return true;
        };
        session.removed.load(Ordering::Acquire)
            || session.backend_exited.load(Ordering::Acquire)
            || !session.state.lock().expect("state lock").is_live()
    }

    fn advance_routine_pane_run(
        self: &Arc<Self>,
        session: u32,
        ev: crate::agent_events::AgentEvent,
    ) {
        if !matches!(ev, crate::agent_events::AgentEvent::TurnEnded) {
            return;
        }
        self.report_routine_pane_run(session, orchestrate::TurnEndSource::StopHook);
    }

    /// A run has no conversation: its pane ending is the whole record. The
    /// independent `RoutineRun` row carries the outcome.
    fn report_routine_pane_run(
        self: &Arc<Self>,
        session: u32,
        _source: orchestrate::TurnEndSource,
    ) {
        let found = {
            let mut runs = self.routine_runs.lock().expect("routine run lock");
            let Some(routine_id) = runs
                .iter()
                .find(|(_, run)| run.session_id == Some(session))
                .map(|(id, _)| *id)
            else {
                return;
            };
            runs.remove(&routine_id).map(|run| (routine_id, run))
        };
        let Some((routine_id, run)) = found else {
            return;
        };
        let outcome = if run.denied {
            proto::RoutineOutcome::Denied
        } else {
            proto::RoutineOutcome::Ok
        };
        self.settle_run(run.run_id, routine_id, outcome, None);
    }

    fn routine_pane_exited(self: &Arc<Self>, session: u32) {
        self.report_routine_pane_run(session, orchestrate::TurnEndSource::QuietSettle);
    }

    #[doc(hidden)]
    pub fn routine_pane_exited_for_test(self: &Arc<Self>, session: u32) {
        self.routine_pane_exited(session);
    }

    #[doc(hidden)]
    pub fn routine_settle_tick_at(self: &Arc<Self>, now: u64) {
        let runs: Vec<(u32, RoutineRun)> = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .iter()
            .filter(|(_, run)| run.session_id.is_some())
            .map(|(id, run)| (*id, *run))
            .collect();
        for (_, run) in runs {
            let session = run.session_id.expect("filtered to pane runs");
            let Ok(s) = self.get(session) else { continue };
            if orchestrate::turn_end_source(s.info.agent, s.acp.is_some())
                != orchestrate::TurnEndSource::QuietSettle
            {
                continue;
            }
            let busy = match s.pid {
                Some(pid) => has_running_procs(pid).unwrap_or(true),
                None => true,
            };
            let fingerprint = screen_fingerprint(
                &self.session_screen(&s, orchestrate::DELEGATION_SETTLE_TAIL_LINES),
            );
            let sample = {
                let mut samples = self.routine_settle.lock().expect("routine settle lock");
                let entry = samples
                    .entry(session)
                    .or_insert(DelegationSettleSample::fresh(fingerprint, now));
                if entry.fingerprint != fingerprint || busy {
                    *entry = DelegationSettleSample::fresh(fingerprint, now);
                }
                *entry
            };
            if busy
                || now.saturating_sub(sample.still_since) < orchestrate::DELEGATION_SETTLE_QUIET_MS
            {
                continue;
            }
            self.routine_settle
                .lock()
                .expect("routine settle lock")
                .remove(&session);
            self.report_routine_pane_run(session, orchestrate::TurnEndSource::QuietSettle);
        }
    }

    pub async fn routine_fire_loop(self: Arc<Self>) {
        loop {
            self.idle_tick_counts[0].fetch_add(1, Ordering::Relaxed);
            self.routine_tick();
            match self.routine_next_wake_at(now_unix_ms()) {
                Some(delay) => {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {},
                        _ = self.routine_wake.notified() => {},
                    }
                }
                None => self.routine_wake.notified().await,
            }
        }
    }

    #[doc(hidden)]
    pub fn routine_next_wake_at(&self, now_ms: i64) -> Option<Duration> {
        let next_run_at_ms = self.db.next_enabled_routine_run_at().unwrap_or_else(|e| {
            tracing::warn!("reading the next enabled routine's run time: {e:#}");
            None
        });
        let settling = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .values()
            .any(|run| run.session_id.is_some());
        let settle_deadline_ms = settling.then_some(now_ms + proto::ROUTINE_TICK_MS as i64);
        let deadline_ms = match (next_run_at_ms, settle_deadline_ms) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }?;
        let delay_ms = match (deadline_ms - now_ms).max(0) {
            0 => proto::ROUTINE_TICK_MS as i64,
            positive => positive,
        };
        Some(Duration::from_millis(delay_ms as u64))
    }

    pub fn routine_tick(self: &Arc<Self>) {
        self.routine_tick_at(now_unix_ms());
        self.routine_settle_tick_at(self.started.elapsed().as_millis() as u64);
    }

    #[doc(hidden)]
    pub fn routine_tick_at(self: &Arc<Self>, now_ms: i64) {
        if self.refusing_mutations() {
            self.stop_routine_runs_past_the_cap(now_ms);
            return;
        }
        self.stop_routine_runs_past_the_cap(now_ms);
        let due = match self.db.routines_due(now_ms) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("looking for due routines: {e:#}");
                return;
            }
        };
        for row in due {
            let running = self.routine_runs.lock().expect("routine run lock");
            if running.contains_key(&row.id) {
                continue;
            }
            if running.len() >= proto::ROUTINE_RUNS_CONCURRENT {
                tracing::info!(
                    "routine {} ({:?}) is due but waiting for a slot ({} of {} running)",
                    row.id,
                    row.name,
                    running.len(),
                    proto::ROUTINE_RUNS_CONCURRENT
                );
                continue;
            }
            drop(running);
            if let Err(e) = self.routine_fire(row.id) {
                tracing::warn!("firing routine {} ({:?}): {e:#}", row.id, row.name);
            }
        }
    }

    fn stop_routine_runs_past_the_cap(self: &Arc<Self>, now_ms: i64) {
        let over: Vec<(u32, RoutineRun)> = self
            .routine_runs
            .lock()
            .expect("routine run lock")
            .iter()
            .filter(|(_, run)| {
                now_ms.saturating_sub(run.started_at_ms) >= proto::ROUTINE_RUN_MAX_MS as i64
            })
            .map(|(id, run)| (*id, *run))
            .collect();
        for (routine_id, run) in over {
            let ran_for = now_ms.saturating_sub(run.started_at_ms);
            let Some(run) = ({
                let mut running = self.routine_runs.lock().expect("routine run lock");
                if running
                    .get(&routine_id)
                    .is_some_and(|current| current.run_id == run.run_id)
                {
                    running.remove(&routine_id)
                } else {
                    None
                }
            }) else {
                continue;
            };
            if let Some(session) = run.session_id {
                if let Err(e) = self.kill(session) {
                    tracing::warn!("stopping routine {routine_id}'s pane {session}: {e:#}");
                }
            }
            self.settle_run(
                run.run_id,
                routine_id,
                proto::RoutineOutcome::KilledAtCap,
                Some(format!(
                    "stopped after {}s: one unattended run may last {}s (ROUTINE_RUN_MAX_MS)",
                    ran_for / 1000,
                    proto::ROUTINE_RUN_MAX_MS / 1000
                )),
            );
        }
    }

    /// Write the routine's own summary of its newest run; the run row itself
    /// was closed by `settle_run`.
    fn settle_routine_run(
        &self,
        routine_id: u32,
        outcome: proto::RoutineOutcome,
        error: Option<String>,
    ) {
        let error = error.map(|e| {
            let mut e = e;
            if e.chars().count() > proto::ROUTINE_LAST_ERROR_MAX {
                e = e
                    .chars()
                    .take(proto::ROUTINE_LAST_ERROR_MAX)
                    .collect::<String>();
            }
            e
        });
        if let Err(e) = self
            .db
            .record_routine_run_end(routine_id, outcome, error.as_deref())
        {
            tracing::warn!("recording routine {routine_id}'s outcome: {e:#}");
        }
        self.broadcast_control(&self.routine_list());
    }

    pub fn skill_sync_state(&self) -> proto::ServerMsg {
        let home = crate::agent_hooks::ConfigHome::from_env();
        if let Ok(home) = &home {
            if self.skill_auto_push_enabled() {
                self.do_skill_push(home, None, None);
            }
        }
        let tools = match &home {
            Ok(home) => crate::skill_sync::read_tools(home),
            Err(e) => crate::skill_sync::SKILL_TOOLS
                .iter()
                .map(|tool| proto::SkillToolState {
                    tool: *tool,
                    path: String::new(),
                    detected: false,
                    inherits_claude: crate::skill_sync::inherits_claude_skills(*tool),
                    skills: Vec::new(),
                    error: Some(format!("{e:#}")),
                })
                .collect(),
        };
        proto::ServerMsg::SkillSync {
            tools,
            pushes: self.skill_pushes_ledger(),
            auto_push_enabled: self.skill_auto_push_enabled(),
        }
    }

    fn skill_tool_from_slug(slug: &str) -> Option<proto::AgentKind> {
        crate::skill_sync::SKILL_TOOLS
            .into_iter()
            .find(|t| crate::agent_hooks::provider_slug(*t) == slug)
    }

    fn skill_pushes_ledger(&self) -> Vec<proto::SkillPushRecord> {
        match self.db.list_skill_pushes() {
            Ok(rows) => rows
                .into_iter()
                .filter_map(|r| {
                    let tool = Self::skill_tool_from_slug(&r.tool)?;
                    Some(proto::SkillPushRecord {
                        tool,
                        skill: r.skill,
                        path: r.path,
                        pushed_at: r.pushed_at,
                        had_existing: r.backup_content.is_some(),
                    })
                })
                .collect(),
            Err(e) => {
                tracing::warn!("reading skill push ledger: {e}");
                Vec::new()
            }
        }
    }

    pub fn skill_auto_push_enabled(&self) -> bool {
        match self.db.get_setting(SKILL_AUTO_PUSH_KEY) {
            Ok(Some(v)) => v == "1",
            Ok(None) => false,
            Err(e) => {
                tracing::warn!("reading skill auto-push setting: {e} — assuming off");
                false
            }
        }
    }

    pub fn skill_auto_push_set(&self, enabled: bool) -> proto::ServerMsg {
        if let Err(e) = self
            .db
            .set_setting(SKILL_AUTO_PUSH_KEY, if enabled { "1" } else { "0" })
        {
            tracing::warn!("writing skill auto-push setting: {e}");
        }
        self.skill_sync_state()
    }

    fn do_skill_push(
        &self,
        home: &crate::agent_hooks::ConfigHome,
        tool_filter: Option<proto::AgentKind>,
        skill_filter: Option<&str>,
    ) {
        let canonical = crate::skill_sync::canonical_skills(home);
        if canonical.is_empty() {
            return;
        }
        let now: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        for tool in crate::skill_sync::SKILL_TOOLS {
            if tool == proto::AgentKind::Claude {
                continue;
            }
            if tool_filter.is_some_and(|t| t != tool) {
                continue;
            }
            let outcome = crate::skill_sync::push_tool(tool, home, &canonical, skill_filter);
            let slug = crate::agent_hooks::provider_slug(tool);
            for pushed in outcome.written {
                if let Err(e) = self.db.record_skill_push(
                    slug,
                    &pushed.name,
                    &pushed.path,
                    &pushed.digest,
                    pushed.backup.as_deref(),
                    now,
                ) {
                    tracing::warn!("recording skill push for {tool:?}/{}: {e}", pushed.name);
                }
            }
            for reason in outcome.skipped {
                tracing::warn!("skill push skipped ({tool:?}): {reason}");
            }
        }
    }

    pub fn skill_push(
        &self,
        tool: Option<proto::AgentKind>,
        skill: Option<String>,
    ) -> proto::ServerMsg {
        match crate::agent_hooks::ConfigHome::from_env() {
            Ok(home) => self.do_skill_push(&home, tool, skill.as_deref()),
            Err(e) => tracing::warn!("skill push: resolving config home: {e:#}"),
        }
        self.skill_sync_state()
    }

    pub fn skill_push_undo(&self, tool: proto::AgentKind, skill: String) -> proto::ServerMsg {
        let slug = crate::agent_hooks::provider_slug(tool);
        match (
            crate::agent_hooks::ConfigHome::from_env(),
            self.db.skill_push(slug, &skill),
        ) {
            (Ok(home), Ok(Some(row))) => {
                match crate::skill_sync::undo_push(
                    tool,
                    &home,
                    &skill,
                    row.backup_content.as_deref(),
                ) {
                    Ok(()) => {
                        if let Err(e) = self.db.delete_skill_push(slug, &skill) {
                            tracing::warn!("clearing skill push record for {tool:?}/{skill}: {e}");
                        }
                    }
                    Err(e) => tracing::warn!("undoing skill push for {tool:?}/{skill}: {e}"),
                }
            }
            (Ok(_), Ok(None)) => {
                tracing::warn!("skill push undo: no recorded push for {tool:?}/{skill}")
            }
            (Err(e), _) => tracing::warn!("skill push undo: resolving config home: {e:#}"),
            (_, Err(e)) => tracing::warn!("skill push undo: reading push record: {e}"),
        }
        self.skill_sync_state()
    }

    fn hook_consent_key(provider: proto::AgentKind) -> String {
        format!(
            "hooks.provider.{}",
            crate::agent_hooks::provider_slug(provider)
        )
    }

    pub fn hook_consent(&self, provider: proto::AgentKind) -> bool {
        let default = provider == proto::AgentKind::Claude;
        match self.db.get_setting(&Self::hook_consent_key(provider)) {
            Ok(Some(v)) => v == "on",
            Ok(None) => default,
            Err(e) => {
                tracing::warn!("reading hook consent for {provider:?}: {e} — assuming {default}");
                default
            }
        }
    }

    fn set_hook_consent(&self, provider: proto::AgentKind, enabled: bool) -> Result<()> {
        self.db.set_setting(
            &Self::hook_consent_key(provider),
            if enabled { "on" } else { "off" },
        )
    }

    fn hook_config_home(&self) -> Result<crate::agent_hooks::ConfigHome> {
        crate::agent_hooks::ConfigHome::from_env()
    }

    fn hook_sentinel(&self) -> String {
        crate::claude_hooks::sentinel_for(self.channel.as_deref())
    }

    fn claude_hooks_installed(&self) -> bool {
        match self.db.list_workspaces() {
            Ok(ws) => ws
                .iter()
                .any(|w| matches!(self.db.workspace_hooks_ownership(&w.path), Ok(Some(_)))),
            Err(e) => {
                tracing::warn!("listing workspaces for hook state: {e}");
                false
            }
        }
    }

    pub fn agent_hooks_state(&self) -> Vec<proto::AgentHookState> {
        self.agent_hooks_state_with_error(None)
    }

    pub fn agent_hooks_state_rescanned(&self) -> Vec<proto::AgentHookState> {
        self.cli_probes.lock().expect("cli probe cache").clear();
        self.agent_hooks_state()
    }

    fn cli_presence(&self, provider: proto::AgentKind) -> crate::cli_probe::CliPresence {
        match crate::cli_probe::binary_name(provider) {
            Some(binary) => self.cli_probes.lock().expect("cli probe cache").get(binary),
            None => crate::cli_probe::CliPresence::default(),
        }
    }

    fn agent_hooks_state_with_error(
        &self,
        failed: Option<(proto::AgentKind, String)>,
    ) -> Vec<proto::AgentHookState> {
        let home = self.hook_config_home();
        let sentinel = self.hook_sentinel();
        let mut rows = Vec::with_capacity(1 + crate::agent_hooks::PROVIDERS.len());
        let claude_cli = self.cli_presence(proto::AgentKind::Claude);
        rows.push(proto::AgentHookState {
            provider: proto::AgentKind::Claude,
            path: ".claude/settings.local.json".to_string(),
            scope: proto::AgentHookScope::Workspace,
            enabled: self.hook_consent(proto::AgentKind::Claude),
            installed: self.claude_hooks_installed(),
            error: None,
            present: claude_cli.present,
            version: claude_cli.version,
            trust: None,
        });
        for provider in crate::agent_hooks::PROVIDERS {
            let (path, installed, mut error) = match &home {
                Ok(home) => (
                    crate::agent_hooks::config_path(provider, home)
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                    crate::agent_hooks::is_installed(provider, home, &sentinel),
                    None,
                ),
                Err(e) => (String::new(), false, Some(format!("{e:#}"))),
            };
            if let Some((kind, message)) = &failed {
                if *kind == provider {
                    error = Some(message.clone());
                }
            }
            let cli = self.cli_presence(provider);
            let trust = match (&home, provider) {
                (Ok(home), proto::AgentKind::Codex) => {
                    Some(match crate::agent_hooks::codex_trust_status(home) {
                        crate::agent_hooks::CodexHookTrust::NoConfig => proto::HookTrust::NoConfig,
                        crate::agent_hooks::CodexHookTrust::NotConfirmed => {
                            proto::HookTrust::NotConfirmed
                        }
                        crate::agent_hooks::CodexHookTrust::SomeTrusted => {
                            proto::HookTrust::SomeTrusted
                        }
                    })
                }
                _ => None,
            };
            rows.push(proto::AgentHookState {
                provider,
                path,
                scope: proto::AgentHookScope::Global,
                enabled: self.hook_consent(provider),
                installed,
                error,
                present: cli.present,
                version: cli.version,
                trust,
            });
        }
        rows
    }

    pub fn agent_hooks_set(
        &self,
        provider: proto::AgentKind,
        enabled: bool,
    ) -> Vec<proto::AgentHookState> {
        let outcome = self.apply_hook_consent(provider, enabled);
        match outcome {
            Ok(()) => {
                if let Err(e) = self.set_hook_consent(provider, enabled) {
                    return self.agent_hooks_state_with_error(Some((
                        provider,
                        format!("the hook was applied but the setting did not persist: {e:#}"),
                    )));
                }
                self.agent_hooks_state()
            }
            Err(e) => self.agent_hooks_state_with_error(Some((provider, format!("{e:#}")))),
        }
    }

    fn apply_hook_consent(&self, provider: proto::AgentKind, enabled: bool) -> Result<()> {
        if provider == proto::AgentKind::Claude {
            if enabled {
                self.set_hook_consent(provider, true)?;
                self.install_all_workspace_hooks();
            } else {
                for w in self.db.list_workspaces()? {
                    self.uninstall_workspace_hooks(&w.path);
                }
            }
            return Ok(());
        }
        let home = self.hook_config_home()?;
        let sentinel = self.hook_sentinel();
        if enabled {
            let launcher = crate::claude_hooks::launcher_path(&self.state_dir);
            crate::agent_hooks::install(provider, &home, &launcher, &sentinel)?;
        } else {
            crate::agent_hooks::uninstall(provider, &home, &sentinel)?;
        }
        Ok(())
    }

    pub fn install_consented_agent_hooks(&self) {
        let Ok(home) = self.hook_config_home() else {
            return;
        };
        let sentinel = self.hook_sentinel();
        let launcher = crate::claude_hooks::launcher_path(&self.state_dir);
        for provider in crate::agent_hooks::PROVIDERS {
            if !self.hook_consent(provider) {
                continue;
            }
            if let Err(e) = crate::agent_hooks::install(provider, &home, &launcher, &sentinel) {
                tracing::warn!("refreshing {provider:?} hooks: {e:#}");
            }
        }
    }

    pub fn sweep_legacy_hooks(&self) {
        crate::legacy_hook_sweep::sweep(&self.db);
    }

    pub fn install_all_workspace_hooks(&self) {
        if !self.hook_consent(proto::AgentKind::Claude) {
            return;
        }
        let Some((exe, sentinel)) = self.hook_install_context() else {
            return;
        };
        match self.db.list_workspaces() {
            Ok(ws) => {
                for w in ws {
                    self.install_workspace_hooks_with(&w.path, &exe, &sentinel);
                }
            }
            Err(e) => tracing::warn!("agent-status hooks: listing workspaces: {e}"),
        }
    }

    fn replace_live_status(
        &self,
        id: u32,
        expected: Option<proto::AgentStatus>,
        status: proto::AgentStatus,
    ) -> bool {
        let changed = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(session) => {
                    let state = session.state.lock().expect("state lock");
                    let mut current = session.status.lock().expect("status lock");
                    if !state.is_live() || *current != expected {
                        false
                    } else {
                        *current = Some(status);
                        true
                    }
                }
                None => false,
            }
        };
        if changed {
            self.broadcast_control(&proto::ServerMsg::AgentStatus {
                session: id,
                status,
            });
            if orchestrate::settled(status) {
                if let Some(this) = self.self_arc() {
                    this.drain_pending_inbox(id);
                }
            }
        }
        changed
    }

    fn expire_spawn_grace(&self, id: u32) {
        self.replace_live_status(
            id,
            Some(proto::AgentStatus::Spawning),
            proto::AgentStatus::Unavailable,
        );
    }

    #[doc(hidden)]
    pub fn expire_spawn_grace_for_test(&self, id: u32) {
        self.expire_spawn_grace(id);
    }

    fn set_context(&self, id: u32, context: proto::SessionContext) {
        let changed = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(s) => {
                    let mut cur = s.context.lock().expect("context lock");
                    if *cur == Some(context) {
                        false
                    } else {
                        *cur = Some(context);
                        true
                    }
                }
                None => false,
            }
        };
        if changed {
            self.broadcast_control(&proto::ServerMsg::SessionContext {
                session: id,
                context: Some(context),
            });
        }
    }

    fn set_context_working(&self, id: u32) {
        let next = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(s) => {
                    let mut cur = s.context.lock().expect("context lock");
                    let mut next = cur.unwrap_or_else(proto::SessionContext::unknown);
                    next.state = proto::ContextState::Working;
                    *cur = Some(next);
                    Some(next)
                }
                None => None,
            }
        };
        if let Some(context) = next {
            self.broadcast_control(&proto::ServerMsg::SessionContext {
                session: id,
                context: Some(context),
            });
        }
    }

    pub async fn refresh_model_catalog(&self, force: bool) {
        let catalog = Arc::clone(&self.model_catalog);
        let enabled = self.update_policy().check;
        let _ = tokio::task::spawn_blocking(move || catalog.load(enabled, force && enabled)).await;
    }

    /// The provider owns the transcript path and usage schema. Catalog limits
    /// are only a fallback when the CLI does not report its effective window.
    fn note_context_from_hook(
        &self,
        id: u32,
        provider: proto::AgentKind,
        d: &crate::hook_drop::HookDrop,
    ) {
        if !matches!(provider, proto::AgentKind::Claude | proto::AgentKind::Codex) {
            return;
        }
        match crate::agent_events::AgentEvent::from_provider(provider, &d.event) {
            Some(crate::agent_events::AgentEvent::PromptSubmitted) => self.set_context_working(id),
            Some(crate::agent_events::AgentEvent::TurnEnded) => {
                let reading = d.transcript_path.as_deref().and_then(|p| {
                    let path = std::path::Path::new(p);
                    match provider {
                        proto::AgentKind::Claude => {
                            crate::context_window::read_claude_context(path)
                        }
                        proto::AgentKind::Codex => crate::context_window::read_codex_context(path),
                        _ => None,
                    }
                });
                let Some(reading) = reading else {
                    self.set_context(id, proto::SessionContext::unknown());
                    return;
                };
                let window = reading.reported_window.or_else(|| {
                    (provider == proto::AgentKind::Claude)
                        .then(|| self.model_catalog.window(&reading.model))
                        .flatten()
                });
                let used = window.map_or(reading.used_tokens, |w| reading.used_tokens.min(w));
                let state = if reading.reset {
                    proto::ContextState::Reset
                } else if crate::context_window::near_limit(used, window) {
                    proto::ContextState::NearLimit
                } else {
                    proto::ContextState::Idle
                };
                let context = proto::SessionContext {
                    used_tokens: used,
                    window_tokens: window,
                    used_percent: window.map(|w| crate::context_window::percent_used(used, w)),
                    state,
                    source: if window.is_some() && reading.reported_window.is_none() {
                        proto::ContextSource::Derived
                    } else {
                        proto::ContextSource::Reported
                    },
                    as_of_ms: crate::hook_drop::now_ms() as i64,
                };
                self.set_context(id, context);
            }
            _ => {}
        }
    }

    fn self_arc(&self) -> Option<Arc<Daemon>> {
        let weak = self.self_weak.lock().expect("self_weak lock").clone();
        weak.upgrade()
    }

    pub fn channel(&self) -> Option<&str> {
        self.channel.as_deref()
    }

    pub fn handle_hook(
        self: &Arc<Self>,
        id: u32,
        event: &str,
        cwd: Option<&str>,
    ) -> crate::hook_drop::DropVerdict {
        self.handle_hook_from(id, proto::AgentKind::Claude, event, cwd)
    }

    pub fn handle_hook_from(
        self: &Arc<Self>,
        id: u32,
        provider: proto::AgentKind,
        event: &str,
        cwd: Option<&str>,
    ) -> crate::hook_drop::DropVerdict {
        self.handle_hook_from_with(id, provider, event, cwd, event == "Notification")
    }

    fn handle_hook_from_with(
        self: &Arc<Self>,
        id: u32,
        provider: proto::AgentKind,
        event: &str,
        cwd: Option<&str>,
        ambiguous_idle_notification: bool,
    ) -> crate::hook_drop::DropVerdict {
        if !self.note_hook_seen(id, event, cwd) {
            return crate::hook_drop::DropVerdict::NoSession;
        }
        match crate::agent_events::AgentEvent::from_provider(provider, event) {
            Some(ev) => self.apply_agent_event(id, event, ev, ambiguous_idle_notification, true),
            None => tracing::debug!("ignoring unknown hook event {event:?} for session {id}"),
        }
        self.swarm_mirror_hook(id, event);
        crate::hook_drop::DropVerdict::Applied
    }

    fn note_hook_seen(&self, id: u32, event: &str, cwd: Option<&str>) -> bool {
        let sessions = self.sessions.lock().expect("sessions lock");
        let Some(s) = sessions.get(&id) else {
            return false;
        };
        let mut hook_cwd = s.hook_cwd.lock().expect("hook_cwd lock");
        if let Some(cwd) = cwd {
            if Path::new(cwd).is_absolute() {
                *hook_cwd = Some(cwd.to_string());
            } else {
                tracing::warn!(
                    "hook {event} for session {id}: ignoring cwd {cwd:?} — expected an absolute workspace path"
                );
            }
        }
        true
    }

    fn apply_agent_event(
        self: &Arc<Self>,
        id: u32,
        event: &str,
        ev: crate::agent_events::AgentEvent,
        ambiguous_idle_notification: bool,
        deliver_delegation: bool,
    ) {
        let changed = {
            let sessions = self.sessions.lock().expect("sessions lock");
            let Some(session) = sessions.get(&id) else {
                return;
            };
            let state = session.state.lock().expect("state lock");
            if !state.is_live() {
                tracing::debug!(
                    "ignoring {event:?} for session {id}: the pane is no longer running"
                );
                return;
            }
            let mut current = session.status.lock().expect("status lock");
            if !ev.applies(*current, ambiguous_idle_notification) {
                tracing::debug!(
                    "ignoring ambiguous {event:?} for session {id}: already Idle, not a mid-turn block"
                );
                return;
            }
            if *current == Some(ev.status()) {
                false
            } else {
                *current = Some(ev.status());
                true
            }
        };
        if changed {
            self.broadcast_control(&proto::ServerMsg::AgentStatus {
                session: id,
                status: ev.status(),
            });
            if orchestrate::settled(ev.status()) {
                self.drain_pending_inbox(id);
            }
        } else {
            tracing::debug!(
                "session {id}: {event:?} keeps status {:?}; applying its lifecycle effects",
                ev.status()
            );
        }
        if deliver_delegation {
            self.advance_delegation(id, ev);
        }
        if changed {
            self.advance_routine_pane_run(id, ev);
            if let Some(kind) = ev.notice(event) {
                self.broadcast_control(&proto::ServerMsg::AgentNotice { session: id, kind });
            }
        }
    }

    pub fn last_hook_cwd(&self, id: u32) -> Option<String> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(&id)?
            .hook_cwd
            .lock()
            .expect("hook_cwd lock")
            .clone()
    }

    pub fn last_hook_message(&self, id: u32) -> Option<String> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(&id)?
            .hook_last_message
            .lock()
            .expect("hook_last_message lock")
            .clone()
    }

    fn note_hook_last_message(
        &self,
        id: u32,
        ev: Option<crate::agent_events::AgentEvent>,
        last_message: Option<&str>,
    ) {
        let sessions = self.sessions.lock().expect("sessions lock");
        let Some(s) = sessions.get(&id) else {
            return;
        };
        if ev == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            *s.hook_last_message.lock().expect("hook_last_message lock") = None;
        }
        if let Some(msg) = last_message.map(str::trim).filter(|m| !m.is_empty()) {
            *s.hook_last_message.lock().expect("hook_last_message lock") = Some(msg.to_string());
        }
    }

    pub fn list(&self) -> Vec<proto::SessionInfo> {
        let mut out: Vec<proto::SessionInfo> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|s| !s.info.hidden)
            .map(|s| s.snapshot_info())
            .collect();
        out.extend(self.dead.lock().expect("dead lock").values().cloned());
        for info in out.iter_mut() {
            if !info.hidden {
                let (live, waiting) = self.child_counts_of(info.id);
                info.live_children = live;
                info.children_waiting = waiting;
                info.delegation = self.delegation_of(info.id).map(|row| {
                    let pending = self.pending_handback(row.parent_session, info.id);
                    let owed = self.inbox_owed(row.parent_session, info.id);
                    let capability = self.capability_note_of(info.id);
                    let hold = (owed.owed > 0)
                        .then(|| self.paste_hold_reason(row.parent_session))
                        .flatten();
                    orchestrate::delegation_info(
                        row,
                        self.turn_end_source_of(info.id),
                        pending,
                        owed,
                        capability,
                        hold,
                    )
                });
                info.inbox_unread = self.db.inbox_pending_count(info.id).unwrap_or_else(|e| {
                    tracing::warn!("reading inbox_unread for session {}: {e}", info.id);
                    0
                });
            }
        }
        out.sort_by_key(|s| s.id);
        out
    }

    pub fn workspace_add(&self, path: &str) -> Result<Vec<proto::Workspace>> {
        let p = Path::new(path);
        if !p.is_dir() {
            bail!("workspace path does not exist or is not a directory: {path}");
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        self.db.add_workspace(path, &name)?;
        self.install_workspace_hooks(path);
        self.db.list_workspaces()
    }

    pub fn workspace_list(&self) -> Result<Vec<proto::Workspace>> {
        self.db.list_workspaces()
    }

    pub fn workspace_rename(&self, path: &str, name: &str) -> Result<Vec<proto::Workspace>> {
        let name = name.trim();
        let len = name.chars().count();
        if name.is_empty() || len > MAX_TITLE_LEN {
            bail!(
                "invalid workspace name {name:?}: expected non-empty and \u{2264} {MAX_TITLE_LEN} chars, got {len}"
            );
        }
        self.db.rename_workspace(path, name)?;
        self.workspace_list()
    }

    pub fn workspace_remove(self: &Arc<Self>, path: &str) -> Result<Vec<proto::Workspace>> {
        let _membership = self
            .workspace_membership
            .lock()
            .expect("workspace_membership lock");
        let known = self.workspace_list()?;
        if !known.iter().any(|w| w.path == path) {
            bail!("unknown workspace path: {path}");
        }

        let rooted_swarms: Vec<(u64, String)> = self
            .db
            .list_swarms()?
            .into_iter()
            .filter(|s| s.root_dir == path)
            .map(|s| (s.id, s.name))
            .collect();
        for (swarm_id, swarm_name) in rooted_swarms {
            tracing::info!(
                "workspace {path} removed with swarm {swarm_id} ({swarm_name:?}) still rooted \
                 there -- tearing the swarm down as a side effect of the workspace removal"
            );
            if let Err(e) = self.db.swarm_remove(swarm_id) {
                tracing::warn!(
                    "tearing down swarm {swarm_id} ({swarm_name:?}) while removing workspace \
                     {path}: {e}"
                );
            }
        }

        let live_ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .filter(|s| *s.project_dir.lock().expect("project_dir lock") == path)
            .map(|s| s.info.id)
            .collect();
        for id in &live_ids {
            if let Err(e) = self.kill(*id) {
                tracing::warn!("killing session {id} while removing workspace {path}: {e}");
            }
        }

        let dead_ids: Vec<u32> = self
            .dead
            .lock()
            .expect("dead lock")
            .values()
            .filter(|i| i.project_dir == path)
            .map(|i| i.id)
            .collect();
        for id in live_ids.into_iter().chain(dead_ids) {
            self.close(id)?;
        }

        self.uninstall_workspace_hooks(path);
        self.db.remove_workspace(path)?;
        self.workspace_list()
    }

    fn next_codename(&self) -> String {
        let mut used: HashSet<String> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .values()
            .map(|s| s.title.lock().expect("title lock").clone())
            .collect();
        used.extend(
            self.dead
                .lock()
                .expect("dead lock")
                .values()
                .map(|i| i.title.clone()),
        );
        crate::pane_name::pick_codename(&used)
    }

    pub fn create_session(self: &Arc<Self>, p: CreateParams) -> Result<proto::SessionInfo> {
        if self.refusing_mutations() {
            bail!("refused: daemon is shutting down");
        }
        if !p.project_dir.is_dir() {
            bail!(
                "project_dir does not exist or is not a directory: {}",
                p.project_dir.display()
            );
        }
        let cwd = p
            .cwd_from
            .and_then(|src| self.live_cwd(src))
            .unwrap_or_else(|| p.project_dir.clone());
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let title = self.next_codename();
        let prompt = p.prompt.as_deref().unwrap_or("");
        let extra_args = if !prompt.trim().is_empty() {
            let prompts_dir = init_prompts_dir(&p.project_dir)?;
            let (args, prompt_file) = crate::launch::launch_args(
                p.agent,
                p.auto_approve,
                false,
                None,
                prompt,
                Some(&prompts_dir),
                "session",
            )?;
            if let Some((path, contents)) = prompt_file {
                std::fs::write(&path, contents)
                    .with_context(|| format!("writing prompt file {}", path.display()))?;
            }
            args
        } else if p.auto_approve {
            match crate::launch::auto_approve_args(p.agent) {
                Some(args) => args,
                None => bail!(
                    "agent {:?} has no approval-bypass flag, so auto_approve cannot be honoured \
                     (expected claude, codex, antigravity, opencode, cursor or grok)",
                    p.agent
                ),
            }
        } else {
            Vec::new()
        };
        if let Some(slug) = p.acp.as_deref() {
            let known = crate::acp::find_known_acp_agent(slug).ok_or_else(|| {
                anyhow!(
                    "unknown ACP agent slug {slug:?} (expected one of [{}])",
                    crate::acp::KNOWN_ACP_AGENTS
                        .iter()
                        .map(|a| a.slug)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
            if p.cmd.is_some() {
                bail!(
                    "acp={slug:?} and an explicit cmd cannot both be given: the ACP roster \
                     row already names the argv ({:?})",
                    known.argv
                );
            }
        }
        let (profile_env, profile_label) =
            self.resolve_spawn_profile(p.agent, p.profile.as_ref())?;
        let extra_env = profile_env.into_iter().collect::<Vec<_>>();
        let approval = if p.auto_approve {
            crate::launch::ApprovalMode::Bypass
        } else {
            crate::launch::ApprovalMode::Default
        };
        let info = self.spawn_session(SpawnParams {
            id,
            agent: p.agent,
            project_dir: p.project_dir,
            cwd,
            custom_cmd: p.cmd,
            cols: p.cols,
            rows: p.rows,
            title: title.clone(),
            title_source: TitleSource::Codename,
            codename: title,
            shell_integration: p.shell_integration,
            hidden: false,
            shell_override: None,
            swarm_agent: None,
            spawned_by: None,
            extra_args,
            extra_env,
            wrap: None,
            acp: p.acp,
            profile_label,
            tags: Vec::new(),
        })?;
        self.record_approval_mode(info.id, approval);
        Ok(info)
    }

    fn record_approval_mode(&self, id: u32, mode: crate::launch::ApprovalMode) {
        if let Err(e) = self.db.session_set_approval_mode(id, mode.as_str()) {
            tracing::warn!(
                "recording approval mode {} for session {id}: {e}",
                mode.as_str()
            );
        }
    }

    fn approval_mode_of(&self, id: u32) -> crate::launch::ApprovalMode {
        self.db
            .session_approval_mode(id)
            .ok()
            .flatten()
            .and_then(|m| crate::launch::ApprovalMode::parse(&m))
            .unwrap_or(crate::launch::ApprovalMode::Default)
    }

    pub fn name_pane_from_prompt(&self, id: u32, prompt: &str) -> Option<String> {
        let name = crate::pane_name::title_from_prompt(prompt, MAX_TITLE_LEN)?;
        let mut used: HashSet<String> = HashSet::new();
        let mut still_codename = false;
        {
            let sessions = self.sessions.lock().expect("sessions lock");
            for (sid, s) in sessions.iter() {
                let title = s.title.lock().expect("title lock").clone();
                if *sid == id {
                    still_codename =
                        *s.title_source.lock().expect("title source lock") == TitleSource::Codename;
                } else {
                    used.insert(title);
                }
            }
        }
        if !still_codename {
            return None;
        }
        used.extend(
            self.dead
                .lock()
                .expect("dead lock")
                .values()
                .map(|i| i.title.clone()),
        );
        let applied = crate::pane_name::unique(&name, &used);
        match self.rename_with_source(id, &applied, TitleSource::Prompt) {
            Ok(()) => {
                tracing::info!("pane {id} named from its first prompt: {applied:?}");
                Some(applied)
            }
            Err(e) => {
                tracing::warn!("naming pane {id} from its first prompt ({applied:?}): {e:#}");
                None
            }
        }
    }

    fn name_pane_from_cli_title(self: &Arc<Self>, id: u32, session: &Arc<Session>, raw: &str) {
        let app = format!("{:?}", session.info.agent);
        let Some(name) = crate::osc_title::sanitize(raw, Some(&app), MAX_TITLE_LEN) else {
            return;
        };
        let current = session.title.lock().expect("title lock").clone();
        let now = self.started.elapsed().as_millis() as u64;
        let mut state = session.cli_title.lock().expect("cli title state lock");
        let inside_floor = state.last_applied_ms != 0
            && now.saturating_sub(state.last_applied_ms) < CLI_TITLE_MIN_GAP_MS;
        if !inside_floor {
            if current == name {
                return;
            }
            state.last_applied_ms = now.max(1);
            drop(state);
            self.apply_cli_title(id, &name);
            return;
        }

        state.pending = (current != name).then_some(name);
        if state.pending.is_none() || state.flush_scheduled {
            return;
        }
        state.flush_scheduled = true;
        let delay = CLI_TITLE_MIN_GAP_MS - now.saturating_sub(state.last_applied_ms);
        drop(state);

        let daemon = Arc::clone(self);
        if let Err(e) = std::thread::Builder::new()
            .name(format!("cli-title-{id}"))
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(delay));
                daemon.flush_cli_title(id);
            })
        {
            if let Some(session) = self.sessions.lock().expect("sessions lock").get(&id) {
                session
                    .cli_title
                    .lock()
                    .expect("cli title state lock")
                    .flush_scheduled = false;
            }
            tracing::warn!("scheduling pane {id}'s pending CLI title: {e}");
        }
    }

    fn flush_cli_title(self: &Arc<Self>, id: u32) {
        loop {
            let Some(session) = self
                .sessions
                .lock()
                .expect("sessions lock")
                .get(&id)
                .cloned()
            else {
                return;
            };
            let now = self.started.elapsed().as_millis() as u64;
            let mut state = session.cli_title.lock().expect("cli title state lock");
            let elapsed = now.saturating_sub(state.last_applied_ms);
            if elapsed < CLI_TITLE_MIN_GAP_MS {
                let delay = CLI_TITLE_MIN_GAP_MS - elapsed;
                drop(state);
                std::thread::sleep(Duration::from_millis(delay));
                continue;
            }
            let Some(name) = state.pending.take() else {
                state.flush_scheduled = false;
                return;
            };
            state.last_applied_ms = now.max(1);
            drop(state);
            self.apply_cli_title(id, &name);

            let mut state = session.cli_title.lock().expect("cli title state lock");
            if state.pending.is_none() {
                state.flush_scheduled = false;
                return;
            }
        }
    }

    fn apply_cli_title(&self, id: u32, name: &str) {
        if let Err(e) = self.rename_with_source(id, name, TitleSource::Cli) {
            tracing::warn!("naming pane {id} from its CLI's window title ({name:?}): {e:#}");
        }
    }

    fn live_cwd(&self, id: u32) -> Option<PathBuf> {
        let (pid, osc, recorded) = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(s) => (
                    s.pid,
                    s.osc_cwd.lock().expect("osc_cwd lock").clone(),
                    PathBuf::from(&s.info.cwd),
                ),
                None => {
                    let dead = self.dead.lock().expect("dead lock");
                    let info = dead.get(&id)?;
                    (None, None, PathBuf::from(&info.cwd))
                }
            }
        };
        if let Some(dir) = osc {
            if dir.is_dir() {
                return Some(dir);
            }
        }
        if let Some(pid) = pid {
            if let Ok(dir) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
                if dir.is_dir() {
                    return Some(dir);
                }
            }
        }
        recorded.is_dir().then_some(recorded)
    }

    pub fn session_cwd(&self, id: u32) -> Result<String> {
        let hidden = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&id)
            .map(|s| s.info.hidden);
        if hidden == Some(true) {
            bail!("unknown session id {id} (expected an active or restored session)");
        }
        if let Some(dir) = self.live_cwd(id) {
            return Ok(dir.display().to_string());
        }
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            return Ok(s.info.cwd.clone());
        }
        if let Some(info) = self.dead.lock().expect("dead lock").get(&id) {
            return Ok(info.cwd.clone());
        }
        bail!("unknown session id {id} (expected an active or restored session)")
    }

    pub fn respawn(
        self: &Arc<Self>,
        old_id: u32,
        shell_integration: bool,
        cwd_override: Option<PathBuf>,
        shell_override: Option<String>,
        force: bool,
    ) -> Result<proto::SessionInfo> {
        if let Some(dir) = &cwd_override {
            if !dir.is_dir() {
                bail!(
                    "cwd override does not exist or is not a directory: {}",
                    dir.display()
                );
            }
        }
        if shell_override.is_some() {
            let kind_refusal = {
                let sessions = self.sessions.lock().expect("sessions lock");
                if let Some(old) = sessions.get(&old_id) {
                    (old.info.agent != proto::AgentKind::Shell).then_some(old.info.agent)
                } else {
                    self.dead
                        .lock()
                        .expect("dead lock")
                        .get(&old_id)
                        .map(|info| info.agent)
                }
            };
            if let Some(agent) = kind_refusal {
                bail!(
                    "reopen-with-shell only applies to shell sessions; session {old_id} is {agent:?}"
                );
            }
        }
        if let Some(shell) = &shell_override {
            let path = Path::new(shell);
            if !path.is_absolute() || !path.is_file() {
                bail!("shell override is not an absolute path to an existing binary: {shell}");
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(path)
                    .with_context(|| format!("reading shell override {shell}"))?
                    .permissions()
                    .mode();
                if mode & 0o111 == 0 {
                    bail!("shell override is not executable (mode {mode:o}): {shell}");
                }
            }
        }
        if let Some(a) = self.db.swarm_agent_by_session(old_id)? {
            bail!(
                "session {old_id} belongs to swarm agent {} of swarm {}; swarm agents resume \
                 through the swarm's own resume path, not respawn",
                a.id,
                a.swarm
            );
        }
        let from_live = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&old_id)
            .cloned();
        #[allow(clippy::type_complexity)]
        let (
            agent,
            project_dir,
            cwd,
            custom_cmd,
            title,
            title_source,
            codename,
            spawned_by,
            acp,
            profile_label,
            old_tags,
            was_dead,
        ) = if let Some(old) = from_live {
            let state = *old.state.lock().expect("state lock");
            if state.is_live() {
                if shell_override.is_some() {
                    if old.info.agent != proto::AgentKind::Shell {
                        bail!(
                            "reopen-with-shell only applies to shell sessions; session {old_id} is {:?}",
                            old.info.agent
                        );
                    }
                    self.kill(old_id)?;
                } else if force {
                    self.kill(old_id)?;
                } else {
                    bail!(
                    "session {old_id} is still running (state {state:?}); kill it before respawning \
                     (or set force to restart it)"
                );
                }
            }
            (
                old.info.agent,
                old.project_dir.lock().expect("project_dir lock").clone(),
                old.info.cwd.clone(),
                old.custom_cmd.clone(),
                old.title.lock().expect("title lock").clone(),
                *old.title_source.lock().expect("title source lock"),
                old.info.codename.clone(),
                old.info.spawned_by,
                old.info.acp.clone(),
                old.info.profile_label.clone(),
                old.tags.lock().expect("tags lock").clone(),
                false,
            )
        } else if let Some(info) = self.dead.lock().expect("dead lock").get(&old_id).cloned() {
            let stored_title_source = self.db.session_title_source(old_id)?;
            if let Some(source) = stored_title_source
                .as_deref()
                .filter(|source| TitleSource::parse(source).is_none())
            {
                tracing::warn!(
                    "session {old_id} has unknown title_source {source:?} \
                     (expected codename, prompt, role, cli or user); applying the legacy fallback"
                );
            }
            (
                info.agent,
                info.project_dir,
                info.cwd,
                None,
                info.title.clone(),
                TitleSource::restored(stored_title_source.as_deref(), &info.title),
                if info.codename.is_empty() {
                    info.title.clone()
                } else {
                    info.codename.clone()
                },
                info.spawned_by,
                info.acp.clone(),
                info.profile_label.clone(),
                info.tags.clone(),
                true,
            )
        } else {
            bail!("unknown session id {old_id} (expected an active or restored session)");
        };
        if shell_override.is_some() && agent != proto::AgentKind::Shell {
            bail!(
                "reopen-with-shell only applies to shell sessions; session {old_id} is {agent:?}"
            );
        }

        if let Some(parent) = spawned_by {
            bail!(
                "refused: session {old_id} was spawned by session {parent} with a mission that \
                 does not survive its process (nothing resumes) — \
                 respawning it would silently start a bare CLI with no mission; spawn a \
                 fresh child instead"
            );
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cwd = Self::respawn_cwd(cwd_override, &cwd, &project_dir);
        let spawned = self.spawn_session(SpawnParams {
            id,
            agent,
            project_dir: PathBuf::from(&project_dir),
            cwd,
            custom_cmd,
            cols: 80,
            rows: 24,
            title,
            title_source,
            codename,
            shell_integration,
            hidden: false,
            shell_override,
            swarm_agent: None,
            spawned_by,
            extra_args: Vec::new(),
            extra_env: Vec::new(),
            wrap: None,
            acp,
            profile_label,
            tags: old_tags,
        })?;

        if was_dead {
            self.dead.lock().expect("dead lock").remove(&old_id);
            if let Err(e) = self.db.mark_closed(old_id) {
                tracing::warn!("marking respawned session {old_id} closed: {e}");
            }
        } else {
            if let Some(old) = self.sessions.lock().expect("sessions lock").remove(&old_id) {
                old.remove_shell_token_file();
                old.removed.store(true, Ordering::Release);
            }
            self.write_run_state();
        }
        self.remove_persisted_scrollback(old_id);
        self.respawned_as
            .lock()
            .expect("respawned_as lock")
            .insert(old_id, spawned.id);
        self.broadcast_control(&proto::ServerMsg::SessionRemoved { session: old_id });
        if let Some(parent) = spawned.spawned_by {
            self.broadcast_live_children(parent);
        }
        Ok(spawned)
    }

    fn flush_shell_token_redactor(self: &Arc<Self>, id: u32, session: &Arc<Session>) {
        let Some(filter) = &session.shell_token_redactor else {
            return;
        };
        let tail = filter.lock().expect("shell token redactor lock").finish();
        if !tail.is_empty() {
            self.process_chunk(id, session, &tail);
        }
    }

    fn process_chunk(self: &Arc<Self>, id: u32, session: &Arc<Session>, chunk: &[u8]) -> bool {
        if session.removed.load(Ordering::Acquire) {
            return false;
        }
        let raw_chunk = chunk;
        let raw_offset = session
            .raw_output_bytes
            .fetch_add(raw_chunk.len() as u64, Ordering::Relaxed);
        let redacted;
        let chunk = if let Some(filter) = &session.shell_token_redactor {
            redacted = filter
                .lock()
                .expect("shell token redactor lock")
                .feed(raw_chunk);
            redacted.as_ref()
        } else {
            raw_chunk
        };
        if let Some(dir) = pty_dump_dir() {
            if !chunk.is_empty() {
                use std::io::Write as _;
                let p = dir.join(format!("session-{id}.bin"));
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(p)
                {
                    let _ = f.write_all(chunk);
                }
            }
        }
        let (offset, replies) = {
            let mut ring = session.scrollback.lock().expect("scrollback lock");
            let offset = ring.push(chunk);
            let replies = match session.vt().as_mut() {
                Some(emulator) => emulator.feed(chunk),
                None => Vec::new(),
            };
            (offset, replies)
        };
        session
            .last_output
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
        if !session.watched() {
            self.answer_terminal_queries(id, session, &replies);
        }
        if session.info.hidden {
            self.handoff_output(id, chunk);
            return true;
        }
        if let Some(tracker) = &session.blocks {
            let outcome = tracker
                .lock()
                .expect("blocks lock")
                .feed(raw_chunk, raw_offset);
            if let Some(cwd) = outcome.cwd {
                *session.osc_cwd.lock().expect("osc_cwd lock") = Some(PathBuf::from(cwd));
            }
            for block in outcome.completed {
                let entry = LedgerEntry {
                    workspace: session
                        .project_dir
                        .lock()
                        .expect("project_dir lock")
                        .clone(),
                    session_id: id,
                    shell: session.shell.clone().unwrap_or_else(|| "shell".into()),
                    block,
                };
                if self.ledger_tx.send(entry).is_err() {
                    tracing::warn!("ledger writer gone; dropping command record");
                }
            }
        }
        for text in session.osc52.lock().expect("osc52 lock").feed(chunk) {
            self.broadcast_control(&proto::ServerMsg::ClipboardSet { session: id, text });
        }
        if let Some(scanner) = &session.osc_title {
            let raw = scanner.lock().expect("osc title lock").feed(chunk);
            if let Some(raw) = raw {
                self.name_pane_from_cli_title(id, session, &raw);
            }
        }
        if let Some(kind) = crate::agents::scan(chunk) {
            self.mark_detected(id, session, kind);
        }
        if let Some(agent_id) = session.info.swarm_agent {
            self.swarm_activity_tick(id, agent_id, chunk);
        }
        if session.acp.is_some() {
            self.acp_tick(id, session, chunk);
        }
        let frame = Arc::new(proto::encode_output_frame(id, offset, chunk));
        self.frame_taps.offer(id, offset, chunk.len(), &frame);
        true
    }

    fn answer_terminal_queries(&self, id: u32, session: &Session, replies: &[u8]) {
        if replies.is_empty() {
            return;
        }
        if let Err(e) = session.backend.write_stdin(id, replies) {
            tracing::debug!("session {id}: answering a terminal query failed: {e}");
        }
    }

    fn mark_detected(&self, id: u32, session: &Session, kind: proto::AgentKind) {
        let changed = {
            let mut cur = session.detected.lock().expect("detected lock");
            if *cur == Some(kind) {
                false
            } else {
                *cur = Some(kind);
                true
            }
        };
        let still_present = self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&id);
        if changed && still_present {
            if let Err(e) = self.db.update_session_detected(id, kind) {
                tracing::warn!("persisting detected agent of session {id}: {e}");
            }
            self.broadcast_control(&proto::ServerMsg::AgentDetected {
                session: id,
                agent: kind,
            });
        }
    }

    pub fn respawn_cwd(
        cwd_override: Option<PathBuf>,
        session_cwd: &str,
        project_dir: &str,
    ) -> PathBuf {
        let cwd = cwd_override.unwrap_or_else(|| PathBuf::from(session_cwd));
        if cwd.is_dir() {
            cwd
        } else {
            PathBuf::from(project_dir)
        }
    }

    fn spawn_pty_reader_thread(
        self: &Arc<Self>,
        id: u32,
        session: &Arc<Session>,
        reader: Box<dyn Read + Send>,
    ) {
        #[cfg(unix)]
        ensure_quiesce_signal_installed();
        let daemon = Arc::clone(self);
        let reader_session = Arc::clone(session);
        std::thread::Builder::new()
            .name(format!("pty-read-{id}"))
            .spawn(move || {
                #[cfg(unix)]
                // SAFETY: `pthread_self` takes no arguments and has no preconditions.
                reader_session
                    .park
                    .set_reader_tid(unsafe { libc::pthread_self() });
                let mut reader = reader;
                let mut buf = vec![0u8; PTY_READ_BUF];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                        Ok(n) if !daemon.process_chunk(id, &reader_session, &buf[..n]) => break,
                        Ok(_) => {}
                    }
                    reader_session.park.check_and_wait_if_requested();
                }
                daemon.flush_shell_token_redactor(id, &reader_session);
                let is_hidden = daemon
                    .sessions
                    .lock()
                    .expect("sessions lock")
                    .get(&id)
                    .is_some_and(|s| s.info.hidden);
                if is_hidden {
                    daemon.handoff_eof(id);
                } else {
                    daemon.persist_scrollback(id);
                    daemon.note_backend_eof_for_supervisor(id);
                }
            })
            .expect("spawn pty reader thread");
    }

    fn spawn_session(self: &Arc<Self>, p: SpawnParams) -> Result<proto::SessionInfo> {
        let SpawnParams {
            id,
            agent,
            project_dir,
            cwd,
            custom_cmd,
            cols,
            rows,
            title,
            title_source,
            codename,
            tags: p_tags,
            shell_integration,
            hidden,
            shell_override,
            swarm_agent,
            spawned_by,
            extra_args,
            extra_env,
            wrap,
            acp,
            profile_label,
        } = p;
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow!("openpty failed: {e}"))?;

        let (spawn_dir, relocate_to) = session_spawn_dir(&cwd);
        #[cfg(unix)]
        let _ = &spawn_dir;

        let mut injected_shell: Option<String> = None;
        let mut shellint_token: Option<String> = None;
        let mut shellint_token_file: Option<shellint::TokenFileGuard> = None;
        let mut cmd = if agent == proto::AgentKind::Shell {
            let (shell, _ladder_rest) = resolve_session_shell(shell_override.as_deref());
            let mut c = CommandBuilder::new(&shell);
            if let Some(real) = &relocate_to {
                let exe = Path::new(&shell)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                let real_str = real.display().to_string();
                if exe == "powershell.exe" || exe == "pwsh.exe" || exe == "pwsh" {
                    c.args([
                        "-NoExit",
                        "-Command",
                        &format!(
                            "Set-Location -LiteralPath '{}'",
                            real_str.replace('\'', "''")
                        ),
                    ]);
                } else if exe == "cmd.exe" || exe == "cmd" {
                    c.args(["/K", "cd", "/d", &real_str]);
                } else {
                    bail!(
                        "project dir {} exceeds what CreateProcessW can start a process in and \
                         shell {exe} has no bootstrap entry to cd into it; supported shells for \
                         over-long project dirs are powershell/pwsh/cmd",
                        real.display()
                    );
                }
            }
            if shell_integration && !shellint::env_disabled() {
                if let Some(dir) = self.shellint_dir.as_deref() {
                    if shellint::shell_kind(&shell) != shellint::ShellKind::Other {
                        let token = shellint::mint_token();
                        let token_file = shellint::create_token_file(dir, id, &token)?;
                        let inj = shellint::injection(dir, &shell, token_file.path())
                            .expect("supported shell has an injection");
                        for arg in &inj.args {
                            c.arg(arg);
                        }
                        for (k, v) in &inj.env {
                            c.env(k, v);
                        }
                        injected_shell = Path::new(&shell)
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned());
                        shellint_token = Some(token);
                        shellint_token_file = Some(token_file);
                    }
                }
            }
            c
        } else {
            let (program, base_args): (String, Vec<String>) = match (&agent, &custom_cmd) {
                _ if acp.is_some() => {
                    let slug = acp.as_deref().expect("acp is Some in this arm");
                    let known = crate::acp::find_known_acp_agent(slug).ok_or_else(|| {
                        anyhow!(
                            "unknown ACP agent slug {slug:?} on session {id} (expected one of \
                             [{}])",
                            crate::acp::KNOWN_ACP_AGENTS
                                .iter()
                                .map(|a| a.slug)
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    })?;
                    (
                        known.argv[0].to_string(),
                        known.argv[1..].iter().map(|a| (*a).to_string()).collect(),
                    )
                }
                (_, Some(argv)) if !argv.is_empty() => (argv[0].clone(), argv[1..].to_vec()),
                (proto::AgentKind::Claude, _) => ("claude".to_string(), Vec::new()),
                (proto::AgentKind::Codex, _) => ("codex".to_string(), Vec::new()),
                (proto::AgentKind::Antigravity, _) => ("agy".to_string(), Vec::new()),
                (proto::AgentKind::Opencode, _) => ("opencode".to_string(), Vec::new()),
                (proto::AgentKind::Cursor, _) => ("cursor-agent".to_string(), Vec::new()),
                (proto::AgentKind::Grok, _) => ("grok".to_string(), Vec::new()),
                (proto::AgentKind::Custom, _) => {
                    bail!("agent \"custom\" requires a non-empty cmd argv")
                }
                (proto::AgentKind::Ssh, _) => {
                    bail!("ssh sessions open via ssh_connect, not session_create/respawn")
                }
                (other, _) => {
                    bail!(
                        "agent {other:?} is identity-only (banner detection) — spawn a shell and run the CLI"
                    )
                }
            };
            let program: std::path::PathBuf = crate::exe_path::resolve(&program)
                .unwrap_or_else(|| std::path::PathBuf::from(&program));
            let mut c = match &wrap {
                Some(w) => {
                    let mut c = CommandBuilder::new(&w[0]);
                    c.args(&w[1..]);
                    c.arg(&program);
                    c
                }
                None => CommandBuilder::new(&program),
            };
            c.args(&base_args);
            c
        };
        if let Some(real) = &relocate_to {
            if agent != proto::AgentKind::Shell {
                bail!(
                    "project dir {} exceeds what CreateProcessW can start a process in, and \
                     agent {agent:?} has no bootstrap entry to cd into it; open a shell there \
                     first",
                    real.display()
                );
            }
        }
        for a in &extra_args {
            cmd.arg(a);
        }
        let mcp = self.mint_mcp_launch(id, agent, &project_dir);
        for a in &mcp.args {
            cmd.arg(a);
        }
        for (k, v) in &mcp.env {
            cmd.env(k, v);
        }
        #[cfg(windows)]
        cmd.cwd(&spawn_dir);
        #[cfg(unix)]
        cmd.cwd(&cwd);
        #[cfg(windows)]
        {
            let term_inherited = std::env::var_os("TERM").is_some_and(|v| !v.is_empty());
            if !term_inherited {
                cmd.env("TERM", "xterm-256color");
            }
        }
        #[cfg(not(windows))]
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // A launcher may disable its own log colours; each pane is a new colour-capable terminal.
        cmd.env_remove("NO_COLOR");
        for (k, v) in &extra_env {
            cmd.env(k, v);
        }
        if !hidden && agent != proto::AgentKind::Ssh {
            match init_orchestration_scope(&project_dir) {
                Ok((_, bin_dir)) => {
                    let base = extra_env
                        .iter()
                        .find(|(k, _)| k == "PATH")
                        .map(|(_, v)| v.clone())
                        .or_else(|| std::env::var("PATH").ok())
                        .filter(|p| !p.is_empty());
                    cmd.env("PATH", path_with(&bin_dir, base.as_deref()));
                }
                Err(e) => tracing::warn!(
                    "scaffolding the orchestration bin dir for session {id} in {}: {e:#}",
                    project_dir.display()
                ),
            }
        }
        cmd.env("HOUSTON_SESSION", id.to_string());
        if let Some(channel) = &self.channel {
            cmd.env(crate::paths::CHANNEL_ENV, channel);
        }
        cmd.env("TR_SESSION", id.to_string());
        #[cfg(windows)]
        let shell_spawn_fallbacks = if agent == proto::AgentKind::Shell && injected_shell.is_none()
        {
            let mut ladder = windows_default_shell_candidates(shell_override.as_deref());
            ladder.remove(0);
            ladder
        } else {
            Vec::new()
        };
        #[cfg(windows)]
        let mut child = spawn_with_shell_fallback(&*pair.slave, cmd, shell_spawn_fallbacks, id)?;
        #[cfg(not(windows))]
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("spawning agent for session {id} failed: {e}"))?;
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("cloning PTY reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("taking PTY writer: {e}"))?;

        let reports_status = acp.is_some() || crate::agent_events::has_event_mapping(agent);
        let initial_status = (!hidden && reports_status).then_some(proto::AgentStatus::Spawning);
        let info = proto::SessionInfo {
            id,
            agent,
            project_dir: project_dir.display().to_string(),
            cwd: cwd.display().to_string(),
            state: proto::SessionState::Running,
            title: title.clone(),
            codename: codename.clone(),
            detected_agent: None,
            hidden,
            ssh_host: None,
            restore_deferred: None,
            status: initial_status,
            context: None,
            swarm_agent,
            spawned_by,
            acp: acp.clone(),
            live_children: 0,
            profile_label,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: p_tags.clone(),
        };

        let session = Arc::new(Session {
            info: info.clone(),
            pid,
            custom_cmd,
            state: Mutex::new(proto::SessionState::Running),
            title: Mutex::new(title),
            project_dir: Mutex::new(project_dir.display().to_string()),
            detected: Mutex::new(None),
            blocks: shellint_token
                .as_ref()
                .map(|token| Mutex::new(BlockTracker::new(token.clone()))),
            shell_token_redactor: shellint_token
                .as_deref()
                .map(shellint::TokenRedactor::new)
                .map(Mutex::new),
            raw_output_bytes: AtomicU64::new(0),
            shell_token_file: shellint_token_file
                .as_ref()
                .map(|file| file.path().to_path_buf()),
            shell: injected_shell,
            osc_cwd: Mutex::new(None),
            osc52: Mutex::new(crate::osc52::Osc52Scanner::new()),
            osc_title: (agent != proto::AgentKind::Shell)
                .then(|| Mutex::new(crate::osc_title::OscTitleScanner::new())),
            cli_title: Mutex::new(CliTitleState::default()),
            title_source: Mutex::new(title_source),
            tags: Mutex::new(p_tags),
            acp: acp
                .as_ref()
                .map(|_| Mutex::new(crate::acp::AcpDecoder::new())),
            scrollback: Mutex::new(Scrollback::new()),
            ws_attaches: AtomicU32::new(0),
            vt: Mutex::new(None),
            vt_refused: AtomicBool::new(false),
            last_output: AtomicU64::new(self.started.elapsed().as_millis() as u64),
            status: Mutex::new(initial_status),
            context: Mutex::new(None),
            removed: AtomicBool::new(false),
            backend_exited: AtomicBool::new(false),
            hook_cwd: Mutex::new(None),
            hook_last_message: Mutex::new(None),
            geometry: AtomicU32::new((u32::from(cols) << 16) | u32::from(rows)),
            backend: Backend::Pty {
                writer: Mutex::new(Some(writer)),
                master: Mutex::new(Some(pair.master)),
                killer: Mutex::new(Some(killer)),
            },
            supervisor_wait: Mutex::new(SupervisorWaitState::default()),
            park: Arc::new(ParkState::default()),
        });
        self.sessions
            .lock()
            .expect("sessions lock")
            .insert(id, Arc::clone(&session));
        self.write_run_state();
        self.reap_reevaluate();
        if !hidden {
            self.db
                .insert_session_with_title_source(&info, Some(title_source.as_str()))?;
            self.broadcast_control(&proto::ServerMsg::SessionCreated { info: info.clone() });
        }

        self.spawn_pty_reader_thread(id, &session, reader);

        let daemon = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("pty-wait-{id}"))
            .spawn(move || {
                #[cfg(target_os = "linux")]
                let _reap = {
                    if let Some(pid) = pid {
                        use nix::sys::wait::{waitid, Id, WaitPidFlag};
                        // Observe exit without consuming it: a committed handoff leaves
                        // the zombie for the supervisor to reap and report to its new owner.
                        while let Err(nix::errno::Errno::EINTR) = waitid(
                            Id::Pid(nix::unistd::Pid::from_raw(pid as i32)),
                            WaitPidFlag::WEXITED | WaitPidFlag::WNOWAIT,
                        ) {}
                    }
                    let guard = daemon.handoff_reap.lock().expect("handoff reap lock");
                    if daemon.has_handed_off() {
                        return;
                    }
                    guard
                };
                let status = child.wait();
                if let Some(s) = daemon.sessions.lock().expect("sessions lock").get(&id) {
                    s.backend.release_pty();
                }
                let exit_code = status.as_ref().ok().map(|s| s.exit_code() as i32);
                if hidden {
                    daemon.handoff_exit(id, exit_code);
                    return;
                }
                let parent = daemon.parent_of(id);
                let state = daemon.finish_session(id, exit_code);
                daemon.broadcast_control(&proto::ServerMsg::SessionState {
                    session: id,
                    state,
                    exit_code,
                });
                if let Some(parent) = parent {
                    daemon.broadcast_live_children(parent);
                }
                daemon.delegation_child_exited(id);
                daemon.routine_pane_exited(id);
            })
            .expect("spawn pty wait thread");

        if initial_status == Some(proto::AgentStatus::Spawning) {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let daemon = Arc::clone(self);
                handle.spawn(async move {
                    tokio::time::sleep(SPAWN_GRACE).await;
                    daemon.expire_spawn_grace(id);
                });
            }
        }

        if let Some(token_file) = shellint_token_file {
            token_file.disarm();
        }

        Ok(info)
    }

    fn finish_session(self: &Arc<Self>, id: u32, exit_code: Option<i32>) -> proto::SessionState {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        if let Some(session) = self.sessions.lock().expect("sessions lock").get(&id) {
            session.remove_shell_token_file();
            if session.removed.load(Ordering::Acquire) {
                // Temporary cleanup marks the session before closing its durable row. Do not let
                // a concurrent PTY/supervisor completion overwrite that closed state with exited.
                return proto::SessionState::Exited;
            }
        }
        let (final_state, session_missing) = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(s) => {
                    let mut st = s.state.lock().expect("state lock");
                    if *st != proto::SessionState::Killed {
                        *st = proto::SessionState::Exited;
                    }
                    s.backend_exited.store(true, Ordering::Release);
                    (*st, false)
                }
                None => (proto::SessionState::Exited, true),
            }
        };
        let persist_state = if session_missing {
            match self.db.session_is_closed(id) {
                Ok(closed) => !closed,
                Err(e) => {
                    tracing::warn!("checking whether removed session {id} was durably closed: {e}");
                    true
                }
            }
        } else {
            true
        };
        if persist_state {
            if let Err(e) = self.db.update_session_state(id, final_state, exit_code) {
                tracing::error!("persisting final state of session {id}: {e}");
            }
        }
        self.mcp_creds.revoke_session(id);
        self.mcp_notify.close_session(id);
        self.swarm_session_finished(id, final_state, exit_code);
        self.reap_reevaluate();
        final_state
    }

    // A session finishes only once BOTH PTY EOF and the supervisor-reported exit
    // status are known; whichever of this call and `supervisor_child_exited` sees
    // the second half of the pair is the one that actually calls `finish_from_supervisor`.
    fn note_backend_eof_for_supervisor(self: &Arc<Self>, id: u32) {
        let Some(session) = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&id)
            .cloned()
        else {
            return;
        };
        let paired_exit = {
            let mut w = session
                .supervisor_wait
                .lock()
                .expect("supervisor wait lock");
            w.eof = true;
            w.exit
        };
        if let Some((code, _signal)) = paired_exit {
            self.finish_from_supervisor(id, code);
        }
    }

    pub fn supervisor_child_exited(self: &Arc<Self>, report: crate::supervisor::ExitReport) {
        let pid = report.pid as u32;
        let found = self
            .sessions
            .lock()
            .expect("sessions lock")
            .iter()
            .find(|(_, s)| s.pid == Some(pid))
            .map(|(id, s)| (*id, Arc::clone(s)));
        let Some((id, session)) = found else {
            tracing::debug!("supervisor reported exit for pid {pid} with no matching live session");
            return;
        };
        if session.backend_exited.load(Ordering::Acquire) {
            return;
        }
        let paired_eof = {
            let mut w = session
                .supervisor_wait
                .lock()
                .expect("supervisor wait lock");
            w.exit = Some((report.code, report.signal));
            w.eof
        };
        if paired_eof {
            self.finish_from_supervisor(id, report.code);
        }
    }

    fn finish_from_supervisor(self: &Arc<Self>, id: u32, exit_code: Option<i32>) {
        let Some(session) = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&id)
            .cloned()
        else {
            return;
        };
        // `compare_exchange` is the exactly-once gate: this path is reachable from
        // two call sites, and the ordinary `child.wait()` path also sets this flag
        // (in `finish_session`), so a session must never be finished twice.
        if session
            .backend_exited
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let parent = self.parent_of(id);
        let state = self.finish_session(id, exit_code);
        self.broadcast_control(&proto::ServerMsg::SessionState {
            session: id,
            state,
            exit_code,
        });
        if let Some(parent) = parent {
            self.broadcast_live_children(parent);
        }
        self.delegation_child_exited(id);
        self.routine_pane_exited(id);
    }

    pub fn ssh_connect(
        self: &Arc<Self>,
        request: u32,
        params: crate::ssh::SshParams,
        profile: Option<String>,
    ) {
        // Redundant with `/ws`'s own shutdown refusal, but kept here too: this is the
        // daemon-side entry point any caller other than `/ws` would also reach.
        if self.refusing_mutations() {
            self.broadcast_control(&proto::ServerMsg::Error {
                message: "refused: daemon is shutting down".to_string(),
                context: Some(format!("ssh_connect request {request}")),
            });
            return;
        }
        let daemon = Arc::clone(self);
        tokio::spawn(async move { daemon.run_ssh_connect(request, params, profile).await });
    }

    async fn run_ssh_connect(
        self: &Arc<Self>,
        request: u32,
        params: crate::ssh::SshParams,
        profile: Option<String>,
    ) {
        let (prompt_tx, mut prompt_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::ssh::HostKeyPrompt>();
        let relay = {
            let daemon = Arc::clone(self);
            tokio::spawn(async move {
                while let Some(p) = prompt_rx.recv().await {
                    daemon
                        .ssh_prompts
                        .lock()
                        .expect("ssh_prompts lock")
                        .insert(request, p.reply);
                    daemon.broadcast_control(&proto::ServerMsg::SshHostKey {
                        request,
                        host: p.host,
                        port: p.port,
                        algorithm: p.algorithm,
                        fingerprint: p.fingerprint,
                        randomart: p.randomart,
                        changed: p.changed,
                        previous_fingerprint: p.previous_fingerprint,
                    });
                }
            })
        };

        let display = params.display();
        let result = crate::ssh::connect(&params, self.known_hosts.clone(), prompt_tx).await;
        relay.abort();
        self.ssh_prompts
            .lock()
            .expect("ssh_prompts lock")
            .remove(&request);

        let (handle, connected) = match result {
            Ok(pair) => pair,
            Err(e) => {
                self.broadcast_control(&proto::ServerMsg::Error {
                    message: format!("ssh connect to {display} failed: {e}"),
                    context: Some(format!("ssh_connect request {request}")),
                });
                return;
            }
        };

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let title = self.next_codename();
        let info = proto::SessionInfo {
            id,
            agent: proto::AgentKind::Ssh,
            project_dir: display.clone(),
            cwd: display.clone(),
            state: proto::SessionState::Running,
            title: title.clone(),
            codename: title.clone(),
            detected_agent: None,
            hidden: false,
            ssh_host: Some(display),
            restore_deferred: None,
            status: None,
            context: None,
            swarm_agent: None,
            spawned_by: None,
            acp: None,
            live_children: 0,
            profile_label: None,
            children_waiting: 0,
            delegation: None,
            inbox_unread: 0,
            tags: Vec::new(),
        };
        let session = Arc::new(Session {
            info: info.clone(),
            pid: None,
            custom_cmd: None,
            state: Mutex::new(proto::SessionState::Running),
            title: Mutex::new(title),
            project_dir: Mutex::new(info.project_dir.clone()),
            detected: Mutex::new(None),
            blocks: None,
            shell_token_redactor: None,
            raw_output_bytes: AtomicU64::new(0),
            shell_token_file: None,
            shell: None,
            osc_cwd: Mutex::new(None),
            osc_title: None,
            cli_title: Mutex::new(CliTitleState::default()),
            title_source: Mutex::new(TitleSource::Codename),
            tags: Mutex::new(Vec::new()),
            osc52: Mutex::new(crate::osc52::Osc52Scanner::new()),
            acp: None,
            scrollback: Mutex::new(Scrollback::new()),
            ws_attaches: AtomicU32::new(0),
            vt: Mutex::new(None),
            vt_refused: AtomicBool::new(false),
            last_output: AtomicU64::new(self.started.elapsed().as_millis() as u64),
            status: Mutex::new(None),
            context: Mutex::new(None),
            removed: AtomicBool::new(false),
            backend_exited: AtomicBool::new(false),
            hook_cwd: Mutex::new(None),
            hook_last_message: Mutex::new(None),
            geometry: AtomicU32::new((u32::from(params.cols) << 16) | u32::from(params.rows)),
            backend: Backend::Ssh(handle),
            supervisor_wait: Mutex::new(SupervisorWaitState::default()),
            park: Arc::new(ParkState::default()),
        });
        self.sessions
            .lock()
            .expect("sessions lock")
            .insert(id, Arc::clone(&session));
        self.write_run_state();
        self.reap_reevaluate();
        if let Err(e) = self
            .db
            .insert_session_with_title_source(&info, Some(TitleSource::Codename.as_str()))
        {
            tracing::error!("persisting ssh session {id}: {e}");
        }
        self.broadcast_control(&proto::ServerMsg::SessionCreated { info });

        if let Some(name) = profile.as_deref() {
            if let Err(e) = self.db.touch_ssh_profile(name) {
                tracing::warn!("stamping ssh profile {name:?} as used: {e}");
            }
            match self.db.list_ssh_profiles() {
                Ok(profiles) => {
                    if let Some(p) = profiles.into_iter().find(|p| p.name == name) {
                        for line in crate::ssh::post_connect_lines(&p) {
                            if let Err(e) = self.write_stdin(id, line.as_bytes()) {
                                tracing::warn!(
                                    "ssh profile {name:?} post-connect line failed on session \
                                     {id}: {e}"
                                );
                                break;
                            }
                        }
                    }
                }
                Err(e) => tracing::warn!("reading ssh profile {name:?} after connect: {e}"),
            }
        }

        let daemon = Arc::clone(self);
        let outcome = crate::ssh::run(connected, |chunk| {
            daemon.process_chunk(id, &session, chunk);
        })
        .await;
        self.persist_scrollback(id);
        let state = self.finish_session(id, outcome.exit_code);
        self.broadcast_control(&proto::ServerMsg::SessionState {
            session: id,
            state,
            exit_code: outcome.exit_code,
        });
        self.delegation_child_exited(id);
        self.routine_pane_exited(id);
    }

    pub fn ssh_host_key_answer(&self, request: u32, accept: bool) -> Result<()> {
        let tx = self
            .ssh_prompts
            .lock()
            .expect("ssh_prompts lock")
            .remove(&request);
        match tx {
            Some(tx) => {
                let verdict = if accept {
                    crate::ssh::HostKeyVerdict::Accept
                } else {
                    crate::ssh::HostKeyVerdict::Reject
                };
                let _ = tx.send(verdict);
                Ok(())
            }
            None => bail!("no pending ssh host-key prompt for request {request}"),
        }
    }

    pub fn ssh_upload_terminal_file(
        self: &Arc<Self>,
        request: u32,
        session: u32,
        local_path: String,
        remote_name: Option<String>,
    ) -> Result<()> {
        let path = std::path::PathBuf::from(&local_path);
        let name = crate::ssh::upload_remote_name(&path, remote_name.as_deref())?;
        if !path.is_file() {
            bail!(
                "{} is not a readable file to upload (expected a path to an existing regular \
                 file)",
                path.display()
            );
        }
        let s = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&session)
            .cloned()
            .ok_or_else(|| anyhow!("no session {session} to upload to"))?;
        let rx = match &s.backend {
            Backend::Ssh(h) => h.upload(path.clone(), name)?,
            _ => bail!(
                "session {session} is a local session ({:?}), not an SSH session — \
                 there is no remote host to upload to",
                s.info.agent
            ),
        };
        let daemon = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = match rx.await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    daemon.broadcast_control(&proto::ServerMsg::Error {
                        message: format!("uploading {} failed: {e}", path.display()),
                        context: Some(format!("ssh_upload_terminal_file request {request}")),
                    });
                    return;
                }
                Err(_) => {
                    daemon.broadcast_control(&proto::ServerMsg::Error {
                        message: format!(
                            "uploading {} failed: the ssh session ended before the upload \
                             finished",
                            path.display()
                        ),
                        context: Some(format!("ssh_upload_terminal_file request {request}")),
                    });
                    return;
                }
            };
            daemon.broadcast_control(&proto::ServerMsg::SshUploadDone {
                request,
                session,
                remote_path: outcome.remote_path,
                bytes: outcome.bytes,
            });
        });
        Ok(())
    }

    pub fn ssh_profile_save(&self, profile: &proto::SshProfile) -> Result<Vec<proto::SshProfile>> {
        self.db.save_ssh_profile(profile)?;
        self.ssh_profiles()
    }

    pub fn ssh_profile_delete(&self, name: &str) -> Result<Vec<proto::SshProfile>> {
        if let Err(e) = crate::ssh_credentials::delete(name) {
            tracing::error!(
                "deleting the stored credential for ssh profile {name:?} failed; \
                 the profile is being removed anyway and a keychain entry may remain: {e}"
            );
        }
        self.db.delete_ssh_profile(name)?;
        self.ssh_profiles()
    }

    pub fn ssh_profiles(&self) -> Result<Vec<proto::SshProfile>> {
        let mut profiles = self.db.list_ssh_profiles()?;
        for p in &mut profiles {
            p.has_credential = crate::ssh_credentials::has_credential(&p.name);
        }
        Ok(profiles)
    }

    pub fn ssh_credential_set(
        &self,
        profile: &str,
        password: crate::ssh_credentials::Secret,
    ) -> Result<Vec<proto::SshProfile>> {
        crate::ssh_credentials::store(profile, &password)?;
        self.ssh_profiles()
    }

    pub fn ssh_credential_clear(&self, profile: &str) -> Result<Vec<proto::SshProfile>> {
        crate::ssh_credentials::delete(profile)?;
        self.ssh_profiles()
    }

    pub fn ssh_config_hosts(&self) -> Result<Vec<proto::SshConfigHost>> {
        let Some(path) = crate::ssh_config::default_path() else {
            return Ok(Vec::new());
        };
        let blocks = crate::ssh_config::load(&path)?;
        Ok(blocks
            .iter()
            .filter_map(|b| {
                let alias = b.literal_alias()?;
                Some(proto::SshConfigHost {
                    alias: alias.to_string(),
                    hostname: b
                        .config
                        .hostname
                        .clone()
                        .unwrap_or_else(|| alias.to_string()),
                    user: b.config.user.clone(),
                    port: b.config.port,
                    identity_file: b.config.identity_file.clone(),
                })
            })
            .collect())
    }

    pub fn keymap_overrides(&self) -> proto::KeymapOverrides {
        match self.db.get_setting(KEYMAP_OVERRIDES_KEY) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_else(|e| {
                tracing::warn!("corrupt {KEYMAP_OVERRIDES_KEY} blob, discarding overrides: {e}");
                proto::KeymapOverrides::default()
            }),
            _ => proto::KeymapOverrides::default(),
        }
    }

    pub fn keymap_overrides_set(&self, overrides: &proto::KeymapOverrides) -> Result<()> {
        anyhow::ensure!(
            overrides.bindings.len() <= KEYMAP_OVERRIDES_MAX_BINDINGS,
            "keymap_overrides has {} bindings (expected <= {})",
            overrides.bindings.len(),
            KEYMAP_OVERRIDES_MAX_BINDINGS
        );
        for (id, chord) in &overrides.bindings {
            anyhow::ensure!(
                chord.code.len() <= KEYMAP_OVERRIDES_MAX_CODE_LEN,
                "keymap_overrides[{id}].code {:?} is {} bytes (expected <= {})",
                chord.code,
                chord.code.len(),
                KEYMAP_OVERRIDES_MAX_CODE_LEN
            );
        }
        self.db
            .set_setting(KEYMAP_OVERRIDES_KEY, &serde_json::to_string(overrides)?)
    }

    fn swarm_mail_tick(self: &Arc<Self>) -> Duration {
        let (drop_applied, drop_listed_ok) = self.hook_drop_tick(crate::hook_drop::Pass::Steady);

        let swarms = match self.db.list_swarms() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "swarm mail tick: listing swarms: {e} — the plan/events GC sweep is skipped \
                     this round; the hook drop pass above already ran and applied {drop_applied} \
                     file(s)"
                );
                return self.swarm_mail_error_delay(drop_applied, drop_listed_ok);
            }
        };

        let mut live_ids = HashSet::new();
        let found_total = drop_applied;
        let mut mail = self.swarm_mail.lock().expect("swarm_mail lock");

        for info in &swarms {
            let layout = crate::scope::ScopeLayout::new(Path::new(&info.root_dir), info.id);
            if !layout.scope.is_dir() {
                continue;
            }
            live_ids.insert(info.id);

            let scope_state = mail.entry(info.id).or_insert_with(|| {
                let watch = crate::fs_watch::MailWatchState::new(Arc::clone(&self.swarm_mail_wake));
                let watcher = crate::fs_watch::start_watcher(&layout.scope, Arc::clone(&watch));
                SwarmMailScope {
                    reader: crate::scope::MailboxReader::new(),
                    watch,
                    _watcher: watcher,
                    last_swept: None,
                    warned_unparseable: HashMap::new(),
                }
            });

            scope_state.reader.poll(&layout.transcript);

            let now = Instant::now();
            let sweep_due = scope_state
                .last_swept
                .map(|t| {
                    now.duration_since(t)
                        >= Duration::from_millis(Self::SWARM_MAIL_GC_SWEEP_INTERVAL_MS)
                })
                .unwrap_or(true);
            if sweep_due {
                self.swarm_mail_sweep(info.id, &layout, scope_state);
                scope_state.last_swept = Some(now);
            }
        }

        mail.retain(|id, _| live_ids.contains(id));
        let watcher_healthy = Self::swarm_mail_any_watcher_healthy(&mail, swarms.is_empty());
        drop(mail);

        let watcher_healthy = watcher_healthy && self.hook_drop_watch.healthy() && drop_listed_ok;

        let mut ladder = self
            .swarm_mail_ladder
            .lock()
            .expect("swarm_mail_ladder lock");
        ladder.record_poll(found_total);
        let view_active = self.tx.receiver_count() > 0;
        ladder.next_delay(watcher_healthy, view_active)
    }

    #[cfg(test)]
    const SWARM_MAIL_GC_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;

    fn swarm_mail_gc_retention_ms(&self) -> u64 {
        self.mailbox_retention_hours() as u64 * 60 * 60 * 1000
    }

    const SWARM_MAIL_GC_SWEEP_INTERVAL_MS: u64 =
        crate::fs_watch::PollLadder::WATCHER_OK_INACTIVE_MS;

    // A zero margin would already be safe (a row's `applied_at` is always >= its
    // event file's own timestamp), but one sweep interval absorbs the clock slack
    // between a file becoming GC-eligible and a sweep actually deleting it.
    const SWARM_PLAN_APPLIED_PRUNE_MARGIN_MS: u64 = Self::SWARM_MAIL_GC_SWEEP_INTERVAL_MS;

    fn swarm_mail_sweep(
        self: &Arc<Self>,
        swarm: u64,
        layout: &crate::scope::ScopeLayout,
        scope_state: &mut SwarmMailScope,
    ) {
        if !scope_state.reader.last_listing_ok(&layout.transcript) {
            tracing::warn!(
                "swarm mail sweep: swarm {swarm} skipping — the transcript/ directory listing \
                 this round was not actually observed; acting on a stale listing risks deleting \
                 an undelivered message"
            );
            return;
        }
        let plan_listing: Vec<std::ffi::OsString> = match std::fs::read_dir(&layout.plan_events) {
            Ok(rd) => rd
                .filter_map(|e| e.ok().map(|e| e.file_name()))
                .filter(|n| crate::scope::is_json_filename(n))
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                tracing::warn!(
                    "swarm mail sweep: swarm {swarm} skipping — listing plan/events/ failed: {e}"
                );
                return;
            }
        };

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let retention_ms = self.swarm_mail_gc_retention_ms();
        let cutoff_ms = now_ms.saturating_sub(retention_ms);

        let transcript_listing: Vec<std::ffi::OsString> =
            scope_state.reader.last_listing(&layout.transcript).to_vec();

        let transcript_candidates = Self::listing_stems(&transcript_listing);
        let plan_candidates = Self::listing_stems(&plan_listing);

        let ingested = match self
            .db
            .swarm_mail_ingested_wire_ids(swarm, &transcript_candidates)
        {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("swarm mail sweep: swarm {swarm} listing ingested ids: {e}");
                return;
            }
        };
        let applied = match self
            .db
            .swarm_plan_applied_event_ids(swarm, &plan_candidates)
        {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("swarm mail sweep: swarm {swarm} listing applied event ids: {e}");
                return;
            }
        };

        let (t_removed, t_bytes) = Self::gc_sweep_dir(
            swarm,
            &layout.transcript,
            "transcript/",
            &transcript_listing,
            &ingested,
            cutoff_ms,
            scope_state
                .warned_unparseable
                .entry(layout.transcript.clone())
                .or_default(),
        );

        let (p_removed, p_bytes) = Self::gc_sweep_dir(
            swarm,
            &layout.plan_events,
            "plan/events/",
            &plan_listing,
            &applied,
            cutoff_ms,
            scope_state
                .warned_unparseable
                .entry(layout.plan_events.clone())
                .or_default(),
        );

        if t_removed > 0 || p_removed > 0 {
            tracing::info!(
                "swarm mail sweep: swarm {swarm} reclaimed {t_removed} file(s)/{t_bytes} byte(s) \
                 from transcript/ and {p_removed} file(s)/{p_bytes} byte(s) from plan/events/ \
                 (retention bound {retention_ms} ms)"
            );
        }

        let now_secs = (now_ms / 1000) as i64;
        let table_cutoff_secs =
            now_secs - ((retention_ms + Self::SWARM_PLAN_APPLIED_PRUNE_MARGIN_MS) / 1000) as i64;
        if let Err(e) = self
            .db
            .swarm_plan_events_applied_prune(swarm, table_cutoff_secs)
        {
            tracing::warn!("swarm mail sweep: swarm {swarm} pruning applied-events table: {e}");
        }
    }

    fn listing_stems(listing: &[std::ffi::OsString]) -> Vec<String> {
        listing
            .iter()
            .filter_map(|n| n.to_str()?.strip_suffix(".json").map(str::to_string))
            .collect()
    }

    fn gc_sweep_dir(
        swarm: u64,
        dir: &Path,
        dir_label: &str,
        listing: &[std::ffi::OsString],
        durable_ids: &HashSet<String>,
        cutoff_ms: u64,
        warned_unparseable: &mut HashSet<std::ffi::OsString>,
    ) -> (u64, u64) {
        let present: HashSet<&std::ffi::OsStr> = listing.iter().map(|n| n.as_os_str()).collect();
        warned_unparseable.retain(|n| present.contains(n.as_os_str()));

        let mut removed = 0u64;
        let mut bytes = 0u64;
        for name in listing {
            let Some(name_str) = name.to_str() else {
                if warned_unparseable.insert(name.clone()) {
                    tracing::warn!(
                        "swarm mail sweep: swarm {swarm}'s {dir_label} has a filename that is \
                         not valid UTF-8, keeping it: {:?}",
                        dir.join(name)
                    );
                }
                continue;
            };
            let Some(stem) = name_str.strip_suffix(".json") else {
                continue;
            };
            let Some(ms) = crate::scope::parse_mailbox_id_ms(stem) else {
                if warned_unparseable.insert(name.clone()) {
                    tracing::warn!(
                        "swarm mail sweep: swarm {swarm}'s {dir_label} has a file whose name \
                         doesn't parse as `<13-digit-ms>-<8-hex-digit>`, keeping it: {:?}",
                        dir.join(name)
                    );
                }
                continue;
            };
            if ms >= cutoff_ms {
                continue;
            }
            // Inverted from what it looks like: a file is deletable only once its id is
            // already durably recorded elsewhere (ingested/applied in the DB) — the file
            // is a spent copy at that point, not the sole record of an undelivered message.
            if !durable_ids.contains(stem) {
                continue;
            }
            let path = dir.join(name);
            let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    removed += 1;
                    bytes += len;
                }
                Err(e) => {
                    tracing::warn!(
                        "swarm mail sweep: swarm {swarm} removing {}: {e}",
                        path.display()
                    );
                }
            }
        }
        (removed, bytes)
    }

    fn swarm_mail_error_delay(&self, drop_applied: usize, drop_listed_ok: bool) -> Duration {
        let watcher_healthy = Self::swarm_mail_any_watcher_healthy(
            &self.swarm_mail.lock().expect("swarm_mail lock"),
            false,
        ) && drop_listed_ok
            && self.hook_drop_watch.healthy();
        let view_active = self.tx.receiver_count() > 0;
        let mut ladder = self
            .swarm_mail_ladder
            .lock()
            .expect("swarm_mail_ladder lock");
        if drop_applied > 0 {
            ladder.record_poll(drop_applied);
        }
        ladder.next_delay(watcher_healthy, view_active)
    }

    fn swarm_mail_any_watcher_healthy(
        mail: &HashMap<u64, SwarmMailScope>,
        no_swarms: bool,
    ) -> bool {
        no_swarms || (!mail.is_empty() && mail.values().all(|s| s.watch.healthy()))
    }

    #[cfg(test)]
    fn test_scope_with_watch(healthy: bool) -> SwarmMailScope {
        let wake = std::sync::Arc::new(tokio::sync::Notify::new());
        let watch = crate::fs_watch::MailWatchState::new(wake);
        if healthy {
            let dir = tempfile::tempdir().expect("tempdir");
            let watcher = crate::fs_watch::start_watcher(dir.path(), Arc::clone(&watch));
            assert!(
                watcher.is_some(),
                "start_watcher must succeed on a scratch dir"
            );
            std::mem::forget(dir);
        }
        SwarmMailScope {
            reader: crate::scope::MailboxReader::new(),
            watch,
            _watcher: None,
            last_swept: None,
            warned_unparseable: HashMap::new(),
        }
    }

    pub async fn swarm_mail_loop(self: Arc<Self>) {
        loop {
            let me = Arc::clone(&self);
            let delay = tokio::task::spawn_blocking(move || me.swarm_mail_tick())
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!("swarm mail tick panicked: {e}");
                    self.swarm_mail_error_delay(0, true)
                });
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = self.swarm_mail_wake.notified() => {},
            }
        }
    }

    #[doc(hidden)]
    pub fn swarm_mail_tick_for_test(self: &Arc<Self>) -> Duration {
        self.swarm_mail_tick()
    }

    pub fn session_cwds(&self, ids: &[u32]) -> Vec<proto::SessionCwdEntry> {
        ids.iter()
            .map(|&id| proto::SessionCwdEntry {
                session: id,
                cwd: self.session_cwd(id).ok(),
            })
            .collect()
    }

    pub fn session_running_procs(&self, ids: &[u32]) -> Vec<proto::SessionProcsEntry> {
        let pids: Vec<Option<u32>> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            ids.iter()
                .map(|id| {
                    sessions
                        .get(id)
                        .filter(|s| !s.info.hidden)
                        .filter(|s| s.state.lock().expect("state lock").is_live())
                        .and_then(|s| s.pid)
                })
                .collect()
        };
        ids.iter()
            .zip(pids)
            .map(|(&id, pid)| proto::SessionProcsEntry {
                session: id,
                has_procs: pid.and_then(has_child_procs),
                has_running_procs: pid.and_then(has_running_procs),
            })
            .collect()
    }

    pub fn wait_for_idle(
        self: &Arc<Self>,
        request: u32,
        id: u32,
        timeout_ms: Option<u64>,
        quiet_ms: Option<u64>,
    ) -> Result<()> {
        let timeout = timeout_ms.unwrap_or(10_000).min(120_000);
        let quiet = quiet_ms.unwrap_or(500).min(30_000);
        let session = {
            let sessions = self.sessions.lock().expect("sessions lock");
            match sessions.get(&id) {
                Some(s) if s.info.hidden => {
                    bail!("unknown session id {id} (expected an active or restored session)")
                }
                Some(s) => Some(Arc::clone(s)),
                None if self.dead.lock().expect("dead lock").contains_key(&id) => None,
                None => bail!("unknown session id {id} (expected an active or restored session)"),
            }
        };
        let daemon = Arc::clone(self);
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
            let idle = loop {
                let live = match &session {
                    None => break true,
                    Some(s) => s.state.lock().expect("state lock").is_live(),
                };
                if !live {
                    break true;
                }
                let last = session
                    .as_ref()
                    .expect("checked above")
                    .last_output
                    .load(Ordering::Relaxed);
                let now = daemon.started.elapsed().as_millis() as u64;
                if now.saturating_sub(last) >= quiet {
                    break true;
                }
                if tokio::time::Instant::now() >= deadline {
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(IDLE_POLL_MS)).await;
            };
            daemon.broadcast_control(&proto::ServerMsg::Idle {
                request,
                session: id,
                idle,
            });
        });
        Ok(())
    }

    pub fn write_stdin(&self, id: u32, data: &[u8]) -> Result<()> {
        self.write_stdin_counting(id, data).map_err(|e| e.error)
    }

    pub fn write_stdin_counting(
        &self,
        id: u32,
        data: &[u8],
    ) -> std::result::Result<(), StdinWriteError> {
        if self.dead.lock().expect("dead lock").contains_key(&id) {
            return Err(StdinWriteError::nothing(anyhow!(
                "session {id} is not running (restored after a daemon restart) — respawn it"
            )));
        }
        let session = self.get(id).map_err(StdinWriteError::nothing)?;
        if let Some(cap) = self
            .stdin_partial_after
            .lock()
            .expect("stdin partial lock")
            .remove(&id)
        {
            let head = cap.min(data.len());
            let _ = session.backend.write_stdin(id, &data[..head]);
            return Err(StdinWriteError {
                written: Some(head),
                error: anyhow!("injected partial write for session {id}"),
            });
        }
        session.backend.write_stdin_counting(id, data)
    }

    #[doc(hidden)]
    pub fn fail_next_stdin_write_after_for_test(&self, session: u32, after_bytes: usize) {
        self.stdin_partial_after
            .lock()
            .expect("stdin partial lock")
            .insert(session, after_bytes);
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(u16, u16)> {
        if self.dead.lock().expect("dead lock").contains_key(&id) {
            return Ok((cols, rows));
        }
        let session = self.get(id)?;
        let applied = session.backend.resize(id, cols, rows)?;
        session.set_geometry(applied.0, applied.1);
        Ok(applied)
    }

    pub fn kill(&self, id: u32) -> Result<()> {
        let session = self.get(id)?;
        session.remove_shell_token_file();
        self.operator_ended
            .lock()
            .expect("operator_ended lock")
            .insert(id);
        self.cancel_delegation(id);
        *session.state.lock().expect("state lock") = proto::SessionState::Killed;
        let result = session.backend.kill(id, session.pid);
        self.reap_reevaluate();
        result
    }

    pub fn scrollback(&self, id: u32, replay_bytes: Option<u64>) -> Result<Replay> {
        if self.dead.lock().expect("dead lock").contains_key(&id) {
            let path = self.scrollback_path(id);
            match Scrollback::load(&path) {
                Ok(ring) => return Ok(ring.replay(replay_bytes)),
                Err(e) => {
                    if path.exists() {
                        tracing::warn!("loading persisted scrollback of session {id}: {e}");
                    }
                    return Ok(Replay {
                        data: Vec::new(),
                        generation: 1,
                        replayed_bytes: 0,
                        bytes_seen: 0,
                    });
                }
            }
        }
        let session = self.get(id)?;
        let replay = session
            .scrollback
            .lock()
            .expect("scrollback lock")
            .replay(replay_bytes);
        Ok(replay)
    }

    pub fn attach_snapshot(&self, id: u32) -> Result<TakenSnapshot> {
        let session = self.get(id)?;
        let ring = session.scrollback.lock().expect("scrollback lock");
        let output_offset = ring.bytes_seen();
        let generation = ring.generation();
        let mut vt = session.vt();
        let emulator = vt.as_mut().ok_or_else(|| {
            anyhow!(
                "session {id} has no terminal emulator (this build: {}), so it can only be \
                 attached to with a byte replay",
                if crate::vt::available() {
                    "the library refused one"
                } else {
                    "built without libghostty-vt"
                }
            )
        })?;
        let state = emulator.snapshot(crate::vt::VT_HISTORY_ROWS)?;
        Ok(TakenSnapshot {
            generation,
            output_offset,
            format_version: crate::vt::snapshot_format_version(),
            state,
        })
    }

    pub fn ws_attach(&self, id: u32) {
        if let Some(session) = self.sessions.lock().expect("sessions lock").get(&id) {
            session.ws_attaches.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn ws_detach(&self, id: u32) {
        if let Some(session) = self.sessions.lock().expect("sessions lock").get(&id) {
            let _ = session
                .ws_attaches
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1));
        }
    }

    pub fn close(&self, id: u32) -> Result<()> {
        self.operator_ended
            .lock()
            .expect("operator_ended lock")
            .insert(id);
        self.cancel_delegation(id);
        let removed = self.sessions.lock().expect("sessions lock").remove(&id);
        if let Some(session) = removed {
            session.remove_shell_token_file();
            session.removed.store(true, Ordering::Release);
            self.write_run_state();
            if session.state.lock().expect("state lock").is_live() {
                let _ = session.backend.kill(id, session.pid);
            }
            self.remove_persisted_scrollback(id);
            self.frame_taps.forget_session(id);
            self.broadcast_control(&proto::ServerMsg::SessionRemoved { session: id });
            if let Some(parent) = session.info.spawned_by {
                self.broadcast_live_children(parent);
            }
            self.reap_reevaluate();
            return Ok(());
        }
        if self.dead.lock().expect("dead lock").remove(&id).is_some() {
            self.db.mark_closed(id)?;
            self.remove_persisted_scrollback(id);
            self.broadcast_control(&proto::ServerMsg::SessionRemoved { session: id });
            return Ok(());
        }
        bail!("unknown session id {id} (expected an active or restored session)")
    }

    pub fn rename(&self, id: u32, title: &str) -> Result<()> {
        self.rename_with_source(id, title, TitleSource::User)
    }

    fn rename_with_source(&self, id: u32, title: &str, source: TitleSource) -> Result<()> {
        let title = title.trim();
        let len = title.chars().count();
        if title.is_empty() || len > MAX_TITLE_LEN {
            bail!(
                "invalid session title {title:?}: expected non-empty and \u{2264} {MAX_TITLE_LEN} chars, got {len}"
            );
        }
        let known = self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&id)
            || self.dead.lock().expect("dead lock").contains_key(&id);
        if !known {
            bail!("unknown session id {id} (expected an active or restored session)");
        }
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            let mut current = s.title_source.lock().expect("title source lock");
            if source < *current {
                return Ok(());
            }
            self.db
                .update_session_title_with_source(id, title, Some(source.as_str()))?;
            *current = source;
            *s.title.lock().expect("title lock") = title.to_string();
        } else if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
            self.db
                .update_session_title_with_source(id, title, Some(source.as_str()))?;
            info.title = title.to_string();
        }
        self.broadcast_control(&proto::ServerMsg::SessionRenamed {
            session: id,
            title: title.to_string(),
        });
        Ok(())
    }

    pub fn tag_list(&self) -> Vec<proto::TagInfo> {
        self.tags
            .lock()
            .expect("tags lock")
            .values()
            .cloned()
            .collect()
    }

    fn validate_tag_fields(name: &str, color: &str) -> Result<(String, String)> {
        let name = name.trim();
        let len = name.chars().count();
        if name.is_empty() || len > proto::MAX_TAG_NAME_LEN {
            bail!(
                "invalid tag name {name:?}: expected non-empty and \u{2264} {} chars, got {len}",
                proto::MAX_TAG_NAME_LEN
            );
        }
        if !proto::TAG_PALETTE.contains(&color) {
            bail!(
                "invalid tag color {color:?}: expected one of TAG_PALETTE's {} colors (see the \
                 generated DEFAULTS.ts for the list)",
                proto::TAG_PALETTE.len()
            );
        }
        Ok((name.to_string(), color.to_string()))
    }

    pub fn tag_create(&self, name: &str, color: &str) -> Result<()> {
        let (name, color) = Self::validate_tag_fields(name, color)?;
        let tag = self.db.tag_create(&name, &color)?;
        self.tags.lock().expect("tags lock").insert(tag.id, tag);
        self.broadcast_tag_list();
        Ok(())
    }

    pub fn tag_update(&self, id: u32, name: &str, color: &str) -> Result<()> {
        let (name, color) = Self::validate_tag_fields(name, color)?;
        if !self.tags.lock().expect("tags lock").contains_key(&id) {
            bail!("unknown tag id {id} (expected a tag in the registry)");
        }
        self.db.tag_update(id, &name, &color)?;
        if let Some(tag) = self.tags.lock().expect("tags lock").get_mut(&id) {
            tag.name = name;
            tag.color = color;
        }
        self.broadcast_tag_list();
        Ok(())
    }

    pub fn tag_delete(&self, id: u32) -> Result<()> {
        if !self.tags.lock().expect("tags lock").contains_key(&id) {
            bail!("unknown tag id {id} (expected a tag in the registry)");
        }
        let changed = self.db.tag_delete(id)?;
        self.tags.lock().expect("tags lock").remove(&id);
        self.broadcast_control(&proto::ServerMsg::TagDeleted { tag: id });
        self.broadcast_tag_list();
        for session in changed {
            if let Some(s) = self.sessions.lock().expect("sessions lock").get(&session) {
                s.tags.lock().expect("tags lock").retain(|t| *t != id);
            } else if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&session) {
                info.tags.retain(|t| *t != id);
            }
            let tags = self.session_tags_of(session);
            self.broadcast_control(&proto::ServerMsg::SessionTagsSet { session, tags });
        }
        Ok(())
    }

    pub fn set_session_tags(&self, id: u32, tags: Vec<u32>) -> Result<()> {
        if tags.len() > proto::MAX_TAGS_PER_SESSION {
            bail!(
                "refused: {} tags on session {id} exceeds the {} per-session cap \
                 (MAX_TAGS_PER_SESSION)",
                tags.len(),
                proto::MAX_TAGS_PER_SESSION
            );
        }
        let mut seen = HashSet::new();
        for t in &tags {
            if !seen.insert(*t) {
                bail!(
                    "refused: tag {t} appears twice in session {id}'s set (expected distinct ids)"
                );
            }
        }
        {
            let registry = self.tags.lock().expect("tags lock");
            for t in &tags {
                if !registry.contains_key(t) {
                    bail!(
                        "refused: unknown tag id {t} in session {id}'s set (expected a tag in the registry)"
                    );
                }
            }
        }
        let known = self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&id)
            || self.dead.lock().expect("dead lock").contains_key(&id);
        if !known {
            bail!("unknown session id {id} (expected an active or restored session)");
        }
        self.db.set_session_tags(id, &tags)?;
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            *s.tags.lock().expect("tags lock") = tags.clone();
        } else if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
            info.tags = tags.clone();
        }
        self.broadcast_control(&proto::ServerMsg::SessionTagsSet { session: id, tags });
        Ok(())
    }

    fn session_tags_of(&self, id: u32) -> Vec<u32> {
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            s.tags.lock().expect("tags lock").clone()
        } else if let Some(info) = self.dead.lock().expect("dead lock").get(&id) {
            info.tags.clone()
        } else {
            Vec::new()
        }
    }

    fn broadcast_tag_list(&self) {
        self.broadcast_control(&proto::ServerMsg::TagList {
            tags: self.tag_list(),
        });
    }

    pub fn reparent_session(&self, id: u32, new_dir: &Path) -> Result<()> {
        let _membership = self
            .workspace_membership
            .lock()
            .expect("workspace_membership lock");
        if !new_dir.is_dir() {
            bail!(
                "reparent target does not exist or is not a directory: {}",
                new_dir.display()
            );
        }
        if let Some(a) = self.db.swarm_agent_by_session(id)? {
            bail!(
                "session {id} belongs to swarm agent {} of swarm {}; a swarm agent's \
                 project_dir must equal its swarm's root_dir (workspace_remove's two sweeps \
                 depend on this), so it cannot be reparented independently of the swarm",
                a.id,
                a.swarm
            );
        }
        let new_dir_str = new_dir.display().to_string();
        let known = self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&id)
            || self.dead.lock().expect("dead lock").contains_key(&id);
        if !known {
            bail!("unknown session id {id} (expected an active or restored session)");
        }
        self.db.update_session_project_dir(id, &new_dir_str)?;
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            *s.project_dir.lock().expect("project_dir lock") = new_dir_str.clone();
        } else if let Some(info) = self.dead.lock().expect("dead lock").get_mut(&id) {
            info.project_dir = new_dir_str.clone();
        }
        self.broadcast_control(&proto::ServerMsg::SessionReparented {
            session: id,
            project_dir: new_dir_str,
        });
        Ok(())
    }

    fn handoff_source(
        &self,
        id: u32,
    ) -> Result<(proto::SessionInfo, Option<Scrollback>, Vec<CommandBlock>)> {
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            if s.info.hidden {
                bail!("session {id} is internal and cannot be a handoff source");
            }
            let info = s.snapshot_info();
            let ring = s.scrollback.lock().expect("scrollback lock").clone();
            let blocks = s
                .blocks
                .as_ref()
                .map(|b| b.lock().expect("blocks lock").blocks())
                .unwrap_or_default();
            return Ok((info, Some(ring), blocks));
        }
        if let Some(info) = self.dead.lock().expect("dead lock").get(&id) {
            let ring = Scrollback::load(&self.scrollback_path(id)).ok();
            return Ok((info.clone(), ring, Vec::new()));
        }
        bail!("unknown session id {id} (expected an active or restored session)")
    }

    pub fn handoff_generate(
        self: &Arc<Self>,
        source: u32,
        provider: proto::AgentKind,
        cmd_override: Option<Vec<String>>,
    ) -> Result<u32> {
        let (info, ring, blocks) = self.handoff_source(source)?;

        let cwd = self
            .live_cwd(source)
            .filter(|d| d.is_dir())
            .unwrap_or_else(|| PathBuf::from(&info.project_dir));
        let tr_dir = cwd.join(crate::paths::PROJECT_DIR);
        std::fs::create_dir_all(&tr_dir)
            .with_context(|| format!("creating {}", tr_dir.display()))?;

        let activity = if !blocks.is_empty() {
            match &ring {
                Some(r) => crate::handoff::curate_blocks(&blocks, |a, b| r.slice(a, b)),
                None => crate::handoff::curate_blocks(&blocks, |_, _| (Vec::new(), true)),
            }
        } else {
            let tail = ring
                .as_ref()
                .map(|r| r.replay(Some(crate::handoff::FALLBACK_TAIL_BYTES)).data)
                .unwrap_or_default();
            if tail.is_empty() {
                "### (no terminal output available — daemon restarted and no scrollback was persisted)\n".to_string()
            } else {
                crate::handoff::fallback_tail(&tail)
            }
        };

        let facts = crate::handoff::Facts {
            codename: info.title.clone(),
            agent: info
                .detected_agent
                .map(|a| format!("{a:?}").to_lowercase())
                .unwrap_or_else(|| format!("{:?}", info.agent).to_lowercase()),
            cwd: cwd.display().to_string(),
            branch: crate::git::branch(&cwd),
            platform: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
            age_secs: self.db.session_created_at(source).map(|t| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs().saturating_sub(t))
                    .unwrap_or(0)
            }),
        };
        let prompt = crate::handoff::build_prompt(&facts, &activity);

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let prompt_path = tr_dir.join(format!("handoff-prompt-{ts}.md"));
        std::fs::write(&prompt_path, &prompt)
            .with_context(|| format!("writing {}", prompt_path.display()))?;

        let path_arg = prompt_path.display().to_string();
        #[cfg(unix)]
        let (argv, provider_name): (Vec<String>, String) = match (provider, cmd_override) {
            (proto::AgentKind::Custom, Some(mut cmd)) if !cmd.is_empty() => {
                cmd.push(path_arg);
                (cmd, "custom".into())
            }
            (proto::AgentKind::Custom, _) => {
                let _ = std::fs::remove_file(&prompt_path);
                bail!("handoff provider \"custom\" requires a non-empty cmd argv (test fixtures)")
            }
            (proto::AgentKind::Claude, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" --print < "$1""#.into(),
                    "claude".into(),
                    path_arg,
                ],
                "claude".into(),
            ),
            (proto::AgentKind::Codex, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" exec - < "$1""#.into(),
                    "codex".into(),
                    path_arg,
                ],
                "codex".into(),
            ),
            (proto::AgentKind::Antigravity, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" -p "Read the file at $1 and follow the instructions in it exactly."#
                        .into(),
                    "agy".into(),
                    path_arg,
                ],
                "antigravity".into(),
            ),
            (proto::AgentKind::Opencode, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" run "$(cat "$1")""#.into(),
                    "opencode".into(),
                    path_arg,
                ],
                "opencode".into(),
            ),
            (proto::AgentKind::Cursor, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" -p "$(cat "$1")""#.into(),
                    "cursor-agent".into(),
                    path_arg,
                ],
                "cursor".into(),
            ),
            (proto::AgentKind::Grok, _) => (
                vec![
                    "sh".into(),
                    "-c".into(),
                    r#"exec "$0" -p "$(cat "$1")""#.into(),
                    "grok".into(),
                    path_arg,
                ],
                "grok".into(),
            ),
            (other, _) => {
                let _ = std::fs::remove_file(&prompt_path);
                bail!(
                    "{other:?} cannot generate a handoff; pick claude, codex, antigravity, opencode, \
                     cursor or grok"
                )
            }
        };
        #[cfg(windows)]
        let (argv, provider_name): (Vec<String>, String) = {
            let read_the_file = |path: &str| {
                format!("Read the file at {path} and follow the instructions in it exactly.")
            };
            match (provider, cmd_override) {
                (proto::AgentKind::Custom, Some(mut cmd)) if !cmd.is_empty() => {
                    cmd.push(path_arg);
                    (cmd, "custom".into())
                }
                (proto::AgentKind::Custom, _) => {
                    let _ = std::fs::remove_file(&prompt_path);
                    bail!(
                        "handoff provider \"custom\" requires a non-empty cmd argv (test fixtures)"
                    )
                }
                (proto::AgentKind::Claude, _) => (
                    vec!["claude".into(), "--print".into(), read_the_file(&path_arg)],
                    "claude".into(),
                ),
                (proto::AgentKind::Codex, _) => (
                    vec!["codex".into(), "exec".into(), read_the_file(&path_arg)],
                    "codex".into(),
                ),
                (proto::AgentKind::Antigravity, _) => (
                    vec!["agy".into(), "-p".into(), read_the_file(&path_arg)],
                    "antigravity".into(),
                ),
                (proto::AgentKind::Opencode, _) => (
                    vec!["opencode".into(), "run".into(), read_the_file(&path_arg)],
                    "opencode".into(),
                ),
                (proto::AgentKind::Cursor, _) => (
                    vec!["cursor-agent".into(), "-p".into(), read_the_file(&path_arg)],
                    "cursor".into(),
                ),
                (proto::AgentKind::Grok, _) => (
                    vec!["grok".into(), "-p".into(), read_the_file(&path_arg)],
                    "grok".into(),
                ),
                (other, _) => {
                    let _ = std::fs::remove_file(&prompt_path);
                    bail!(
                        "{other:?} cannot generate a handoff; pick claude, codex, antigravity, opencode, \
                         cursor or grok"
                    )
                }
            }
        };

        let hidden_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = self.next_handoff.fetch_add(1, Ordering::Relaxed);
        self.handoff_jobs.lock().expect("handoff lock").insert(
            request,
            HandoffJob {
                hidden: hidden_id,
                provider_name: provider_name.clone(),
                buffer: Vec::new(),
                last_activity: Instant::now(),
                prompt_path: prompt_path.clone(),
                out_dir: tr_dir.join("handoffs"),
                eof: false,
                exit: None,
                fail_reason: None,
            },
        );
        let spawned = self.spawn_session(SpawnParams {
            id: hidden_id,
            agent: proto::AgentKind::Custom,
            project_dir: info.project_dir.clone().into(),
            cwd: cwd.clone(),
            custom_cmd: Some(argv),
            cols: 200,
            rows: 50,
            title: format!("handoff-{provider_name}"),
            title_source: TitleSource::Codename,
            codename: format!("handoff-{provider_name}"),
            shell_integration: false,
            hidden: true,
            shell_override: None,
            swarm_agent: None,
            spawned_by: None,
            extra_args: Vec::new(),
            extra_env: Vec::new(),
            wrap: None,
            acp: None,
            profile_label: None,
            tags: Vec::new(),
        });
        if let Err(e) = spawned {
            self.handoff_jobs
                .lock()
                .expect("handoff lock")
                .remove(&request);
            let _ = std::fs::remove_file(&prompt_path);
            return Err(e.context(format!("spawning the {provider_name} generator")));
        }

        self.broadcast_control(&proto::ServerMsg::HandoffStarted {
            request,
            session: source,
            provider,
        });

        let weak = Arc::downgrade(self);
        let timeout = handoff_timeout();
        std::thread::Builder::new()
            .name(format!("handoff-watch-{request}"))
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500.min(timeout.as_millis() as u64)));
                let Some(daemon) = weak.upgrade() else { return };
                let hidden = {
                    let mut jobs = daemon.handoff_jobs.lock().expect("handoff lock");
                    let Some(job) = jobs.get_mut(&request) else {
                        return;
                    };
                    if job.last_activity.elapsed() < timeout {
                        continue;
                    }
                    if job.fail_reason.is_none() {
                        job.fail_reason = Some(format!(
                            "no output from {} for {}s — is it installed and authenticated?",
                            job.provider_name,
                            timeout.as_secs()
                        ));
                    }
                    job.hidden
                };
                let _ = daemon.kill(hidden);
                return;
            })
            .expect("spawn handoff watchdog");

        Ok(request)
    }

    fn handoff_output(&self, hidden_id: u32, chunk: &[u8]) {
        let mut jobs = self.handoff_jobs.lock().expect("handoff lock");
        let Some((request, job)) = jobs.iter_mut().find(|(_, j)| j.hidden == hidden_id) else {
            return;
        };
        let request = *request;
        job.last_activity = Instant::now();
        if job.buffer.len() + chunk.len() <= HANDOFF_BUFFER_CAP {
            job.buffer.extend_from_slice(chunk);
        }
        drop(jobs);
        let text = crate::agents::strip_ansi(&String::from_utf8_lossy(chunk));
        if !text.is_empty() {
            self.broadcast_control(&proto::ServerMsg::HandoffChunk { request, text });
        }
    }

    fn handoff_eof(&self, hidden_id: u32) {
        let mut jobs = self.handoff_jobs.lock().expect("handoff lock");
        if let Some((&request, job)) = jobs.iter_mut().find(|(_, j)| j.hidden == hidden_id) {
            job.eof = true;
            if job.exit.is_some() {
                let job = jobs.remove(&request).expect("job present");
                drop(jobs);
                self.handoff_finish(request, job);
            }
        }
    }

    fn handoff_exit(&self, hidden_id: u32, exit_code: Option<i32>) {
        let mut jobs = self.handoff_jobs.lock().expect("handoff lock");
        if let Some((&request, job)) = jobs.iter_mut().find(|(_, j)| j.hidden == hidden_id) {
            job.exit = Some(exit_code);
            if job.eof {
                let job = jobs.remove(&request).expect("job present");
                drop(jobs);
                self.handoff_finish(request, job);
            }
        }
    }

    fn handoff_finish(&self, request: u32, job: HandoffJob) {
        self.sessions
            .lock()
            .expect("sessions lock")
            .remove(&job.hidden);
        let _ = std::fs::remove_file(&job.prompt_path);

        let exit = job.exit.flatten();
        if let Some(reason) = job.fail_reason {
            self.broadcast_control(&proto::ServerMsg::HandoffError {
                request,
                message: reason,
            });
            return;
        }
        if exit != Some(0) {
            let tail = crate::agents::strip_ansi(&String::from_utf8_lossy(&job.buffer));
            let tail: String = tail
                .chars()
                .rev()
                .take(400)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            self.broadcast_control(&proto::ServerMsg::HandoffError {
                request,
                message: format!(
                    "{} exited with {:?}: …{}",
                    job.provider_name,
                    exit,
                    tail.trim()
                ),
            });
            return;
        }

        let markdown = crate::handoff::extract_markdown(&String::from_utf8_lossy(&job.buffer));
        if markdown.is_empty() {
            self.broadcast_control(&proto::ServerMsg::HandoffError {
                request,
                message: format!("{} produced no output", job.provider_name),
            });
            return;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let saved_path = job.out_dir.join(format!("{ts}.md"));
        let saved = std::fs::create_dir_all(&job.out_dir)
            .and_then(|_| std::fs::write(&saved_path, &markdown));
        let saved_path = match saved {
            Ok(()) => saved_path.display().to_string(),
            Err(e) => {
                tracing::warn!("persisting handoff to {}: {e}", saved_path.display());
                String::new()
            }
        };
        self.broadcast_control(&proto::ServerMsg::HandoffDone {
            request,
            markdown,
            saved_path,
        });
    }

    pub fn handoff_cancel(self: &Arc<Self>, request: u32) -> Result<()> {
        let hidden = {
            let mut jobs = self.handoff_jobs.lock().expect("handoff lock");
            let Some(job) = jobs.get_mut(&request) else {
                bail!("unknown handoff request {request} (already finished?)");
            };
            job.fail_reason = Some("handoff canceled".into());
            job.hidden
        };
        let pid = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&hidden)
            .and_then(|s| s.pid);
        let Some(pid) = pid else {
            return self.kill(hidden);
        };
        let _ = crate::pid::signal_process(pid, crate::pid::Signal::Int);
        let daemon = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = daemon.kill(hidden);
        });
        Ok(())
    }

    pub fn command_blocks(&self, id: u32) -> Vec<CommandBlock> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(&id)
            .and_then(|s| {
                s.blocks
                    .as_ref()
                    .map(|b| b.lock().expect("blocks lock").blocks())
            })
            .unwrap_or_default()
    }

    pub fn history_clear(&self, workspace: Option<&str>) -> Result<usize> {
        self.db.clear_command_history(workspace)
    }

    pub fn history_count(&self) -> Result<u32> {
        self.db.command_history_count(None).map(|n| n as u32)
    }

    fn get(&self, id: u32) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .expect("sessions lock")
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown session id {id} (expected an active session)"))
    }
}

#[cfg(test)]
mod watcher_healthy_tests {
    use super::*;

    #[test]
    fn zero_swarms_reports_healthy_slow_rung() {
        let mail: HashMap<u64, SwarmMailScope> = HashMap::new();
        assert!(
            Daemon::swarm_mail_any_watcher_healthy(&mail, true),
            "no swarms at all must read as healthy (slow WATCHER_OK_* rungs), \
             not as an unhealthy watcher"
        );
    }

    #[test]
    fn swarm_present_unhealthy_watcher_reports_unhealthy_fast_rung() {
        let mut mail: HashMap<u64, SwarmMailScope> = HashMap::new();
        mail.insert(1, Daemon::test_scope_with_watch(false));
        assert!(
            !Daemon::swarm_mail_any_watcher_healthy(&mail, false),
            "a swarm whose watcher hasn't attached yet must still read as \
             unhealthy (fast WATCHER_DEAD_* rungs) — item 9's fix, unchanged"
        );
    }

    #[test]
    fn swarm_present_healthy_watcher_reports_healthy() {
        let mut mail: HashMap<u64, SwarmMailScope> = HashMap::new();
        mail.insert(1, Daemon::test_scope_with_watch(true));
        assert!(Daemon::swarm_mail_any_watcher_healthy(&mail, false));
    }

    #[test]
    fn swarm_mid_provisioning_with_empty_mail_reports_unhealthy_fast_rung() {
        let mail: HashMap<u64, SwarmMailScope> = HashMap::new();
        assert!(
            !Daemon::swarm_mail_any_watcher_healthy(&mail, false),
            "a swarm whose scope dir hasn't landed in `mail` yet must read as \
             unhealthy (fast rungs), not vacuously healthy from an empty map"
        );
    }
}

impl Daemon {
    pub fn set_port(&self, port: u16) {
        *self.port.lock().expect("port lock") = Some(port);
    }

    pub fn mint_mcp_launch(
        &self,
        id: u32,
        agent: proto::AgentKind,
        project_dir: &std::path::Path,
    ) -> crate::mcp_launch::Launch {
        let Some(port) = *self.port.lock().expect("port lock") else {
            return crate::mcp_launch::Launch::default();
        };
        let endpoint = crate::mcp_launch::endpoint(port);
        if crate::mcp_launch::launch_for(agent, &endpoint, "").is_empty() {
            return crate::mcp_launch::Launch::default();
        }
        let token = self.mcp_creds.issue(crate::mcp_creds::McpScope {
            session_id: id,
            workspace_id: project_dir.to_string_lossy().into_owned(),
        });
        crate::mcp_launch::launch_for(agent, &endpoint, &token)
    }

    pub fn bound_port(&self) -> Option<u16> {
        *self.port.lock().expect("port lock")
    }

    fn list_swarms_publishing_registry(&self) -> Result<Vec<proto::SwarmInfo>> {
        let _serial = self.hook_state_lock.lock().expect("hook state lock");
        let swarms = self.db.list_swarms()?;
        self.publish_scope_registry(&swarms);
        Ok(swarms)
    }

    fn publish_scope_registry(&self, swarms: &[proto::SwarmInfo]) {
        let scopes: Vec<crate::hook_state::ScopeEntry> = swarms
            .iter()
            .filter(|s| match s.status {
                proto::SwarmStatus::Idle | proto::SwarmStatus::Active => true,
                proto::SwarmStatus::Completed | proto::SwarmStatus::Error => false,
            })
            .map(|s| {
                let work_root = s.root_dir.clone();
                crate::hook_state::ScopeEntry {
                    swarm: s.id,
                    scope: crate::scope::scope_dir(Path::new(&work_root), s.id)
                        .display()
                        .to_string(),
                    work_root,
                    root_dir: s.root_dir.clone(),
                }
            })
            .collect();
        if let Err(e) = crate::hook_state::write_scopes(&self.state_dir, &scopes) {
            tracing::warn!(
                "publishing the swarm scope registry to {}: {e:#}",
                crate::hook_state::scopes_path(&self.state_dir).display()
            );
        }
    }

    fn hook_drop_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![crate::hook_drop::drop_dir(&self.state_dir)];
        match self.db.list_swarms() {
            Ok(swarms) => {
                for info in &swarms {
                    let scope = crate::scope::scope_dir(Path::new(&info.root_dir), info.id);
                    if scope.is_dir() {
                        dirs.push(crate::hook_drop::drop_dir(&scope));
                    }
                }
            }
            Err(e) => tracing::warn!(
                "hook drop pass: listing swarms for their drop dirs: {e} — \
                 this round covers the channel dir only, not \"there are no swarms\""
            ),
        }
        dirs
    }

    fn notification_is_a_block(kind: &str) -> bool {
        matches!(kind, "permission_prompt" | "agent_needs_input") || kind.starts_with("elicitation")
    }

    fn apply_hook_drop(
        self: &Arc<Self>,
        d: &crate::hook_drop::HookDrop,
    ) -> crate::hook_drop::DropVerdict {
        let provider = match d.agent.as_deref() {
            None => proto::AgentKind::Claude,
            Some(slug) => match crate::agent_hooks::provider_from_slug(slug) {
                Ok(kind) => kind,
                Err(e) => {
                    tracing::warn!("hook drop for session {}: {e:#}", d.session);
                    return crate::hook_drop::DropVerdict::Applied;
                }
            },
        };
        let session = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&d.session)
            .cloned();
        if let Some(session) = session {
            self.mark_detected(d.session, &session, provider);
        }
        self.note_hook_last_message(
            d.session,
            crate::agent_events::AgentEvent::from_provider(provider, &d.event),
            d.last_message.as_deref(),
        );
        if let Some(verdict) = self.correlate_hook_drop(d, provider) {
            return verdict;
        }
        if let Some(prompt) = d.prompt.as_deref() {
            if !d.internal_prompt {
                self.name_pane_from_prompt(d.session, prompt);
            }
        }
        if d.internal_prompt {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return crate::hook_drop::DropVerdict::NoSession;
            }
            if let Some(ev) = crate::agent_events::AgentEvent::from_provider(provider, &d.event) {
                let ambiguous = d.event == "Notification" && d.notification_type.is_none();
                self.apply_agent_event(d.session, &d.event, ev, ambiguous, false);
            }
            self.swarm_mirror_hook(d.session, &d.event);
            return crate::hook_drop::DropVerdict::Applied;
        }
        let ambiguous = d.event == "Notification" && d.notification_type.is_none();
        let verdict =
            self.handle_hook_from_with(d.session, provider, &d.event, d.cwd.as_deref(), ambiguous);
        self.note_context_from_hook(d.session, provider, d);
        verdict
    }

    fn correlate_hook_drop(
        self: &Arc<Self>,
        d: &crate::hook_drop::HookDrop,
        provider: proto::AgentKind,
    ) -> Option<crate::hook_drop::DropVerdict> {
        let ev = crate::agent_events::AgentEvent::from_provider(provider, &d.event);
        let correlates = matches!(provider, proto::AgentKind::Claude | proto::AgentKind::Codex);
        let now = crate::hook_drop::now_ms();

        if ev == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            if let Some(prompt_id) = d.prompt_id.as_deref() {
                let repeated = {
                    let mut last = self.last_prompt_id.lock().expect("last prompt id lock");
                    let repeated = last.get(&d.session).is_some_and(|prev| prev == prompt_id);
                    if !repeated {
                        last.insert(d.session, prompt_id.to_string());
                    }
                    repeated
                };
                if repeated {
                    if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                        return Some(crate::hook_drop::DropVerdict::NoSession);
                    }
                    tracing::debug!(
                        "session {}: UserPromptSubmit for prompt {prompt_id} arrived again — the \
                         same prompt delivered twice, not a new request",
                        d.session
                    );
                    return Some(crate::hook_drop::DropVerdict::Applied);
                }
            }
        }

        if provider == proto::AgentKind::Antigravity {
            if let Some(verdict) = self.correlate_antigravity_drop(d, now) {
                return Some(verdict);
            }
        }

        let opencode_input_kind = match d.event.as_str() {
            "permission.asked" | "permission.updated" | "permission.replied" => {
                Some("OpenCode permission")
            }
            "question.asked"
            | "question.replied"
            | "question.rejected"
            | "question.v2.asked"
            | "question.v2.replied"
            | "question.v2.rejected" => Some("OpenCode question"),
            _ => None,
        };
        if provider == proto::AgentKind::Opencode {
            if let Some(kind) = opencode_input_kind {
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                let opens = matches!(
                    d.event.as_str(),
                    "permission.asked"
                        | "permission.updated"
                        | "question.asked"
                        | "question.v2.asked"
                );
                if opens {
                    let mut episodes = self.permission_episodes.lock().expect("episodes lock");
                    episodes.entry(d.session).or_default().open(
                        d.request_id.as_deref(),
                        None,
                        kind,
                        d.reason.clone(),
                        now,
                    );
                    drop(episodes);
                    self.apply_agent_event(
                        d.session,
                        &d.event,
                        crate::agent_events::AgentEvent::NeedsInput,
                        false,
                        true,
                    );
                } else {
                    let resumed = self.resolve_permission_episodes(
                        d.session,
                        &orchestrate::EpisodeEnd::PostToolUse {
                            tool_use_id: d.request_id.clone(),
                            prompt_id: d.prompt_id.clone(),
                            tool_name: Some(kind.to_string()),
                            tool_input_fingerprint: None,
                        },
                    );
                    if resumed {
                        self.apply_agent_event(
                            d.session,
                            &d.event,
                            crate::agent_events::AgentEvent::InputResolved,
                            false,
                            true,
                        );
                    }
                }
                return Some(crate::hook_drop::DropVerdict::Applied);
            }

            if matches!(d.event.as_str(), "session.idle" | "session.error") {
                self.resolve_permission_episodes(d.session, &orchestrate::EpisodeEnd::TurnEnded);
            } else if d.event == "message.updated" {
                self.resolve_permission_episodes(
                    d.session,
                    &orchestrate::EpisodeEnd::PromptSubmitted,
                );
            } else if d.event == "session.status"
                && self
                    .permission_episodes
                    .lock()
                    .expect("episodes lock")
                    .get(&d.session)
                    .is_some_and(|episodes| episodes.open_count() > 0)
            {
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                tracing::debug!(
                    "session {}: OpenCode remains blocked despite a busy status",
                    d.session
                );
                return Some(crate::hook_drop::DropVerdict::Applied);
            }
        }

        if ev == Some(crate::agent_events::AgentEvent::TurnEnded) && d.stop_continued {
            let blocks = self.note_continued_stop(d.session);
            tracing::debug!(
                "session {}: the stop hook continued the turn end (block {blocks} of {})",
                d.session,
                orchestrate::STOP_BLOCKS_PER_TURN_MAX
            );
        } else if matches!(
            ev,
            Some(crate::agent_events::AgentEvent::PromptSubmitted)
                | Some(crate::agent_events::AgentEvent::TurnEnded)
        ) {
            self.clear_stop_blocks(d.session);
        }

        if correlates && matches!(d.event.as_str(), "SubagentStart" | "SubagentStop") {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            self.feed_subagent_evidence(d, now);
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if correlates && d.event == "PreToolUse" {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let blocks = match provider {
                proto::AgentKind::Claude => d
                    .tool_name
                    .as_deref()
                    .is_some_and(|name| Self::CLAUDE_INTERACTIVE_TOOLS.contains(&name)),
                proto::AgentKind::Codex => d.tool_name.as_deref() == Some("request_user_input"),
                _ => false,
            };
            if !blocks {
                tracing::debug!(
                    "session {}: {provider:?} PreToolUse for {:?} is not interactive",
                    d.session,
                    d.tool_name
                );
                return Some(crate::hook_drop::DropVerdict::Applied);
            }
            let mut episodes = self.permission_episodes.lock().expect("episodes lock");
            episodes
                .entry(d.session)
                .or_default()
                .open_with_fingerprint(
                    d.tool_use_id.as_deref().or(d.request_id.as_deref()),
                    d.prompt_id.as_deref(),
                    d.tool_name.as_deref().unwrap_or("unnamed tool"),
                    d.reason.clone(),
                    d.tool_input_fingerprint.clone(),
                    now,
                );
            drop(episodes);
            self.apply_agent_event(
                d.session,
                &d.event,
                crate::agent_events::AgentEvent::NeedsInput,
                false,
                true,
            );
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if correlates && matches!(d.event.as_str(), "PostToolUse" | "PostToolUseFailure") {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let resumed = self.resolve_permission_episodes(
                d.session,
                &orchestrate::EpisodeEnd::PostToolUse {
                    tool_use_id: d.tool_use_id.clone(),
                    prompt_id: d.prompt_id.clone(),
                    tool_name: d.tool_name.clone(),
                    tool_input_fingerprint: d.tool_input_fingerprint.clone(),
                },
            );
            if resumed {
                self.apply_agent_event(
                    d.session,
                    &d.event,
                    crate::agent_events::AgentEvent::InputResolved,
                    false,
                    true,
                );
            }
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if ev == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            self.clear_composer_occupied(d.session);
            self.confirm_paste_from_prompt(d.session, d.prompt.as_deref());
        }

        if correlates && ev == Some(crate::agent_events::AgentEvent::PromptSubmitted) {
            let mut reopened = false;
            let mut rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
            let round = rounds.entry(d.session).or_default();
            if d.internal_prompt {
                match d.task_id.as_deref() {
                    Some(task) => {
                        let out = round.on_internal_prompt(task);
                        reopened = out.reopened;
                        if out.reopened {
                            tracing::warn!(
                                "session {}: a sub-agent notification for {task} arrived after \
                                 its turn end was taken at face value",
                                d.session
                            );
                        }
                    }
                    None => tracing::debug!(
                        "session {}: an internal prompt with no <task-id>",
                        d.session
                    ),
                }
            } else {
                round.on_external_prompt();
            }
            drop(rounds);
            if reopened {
                self.correct_provisional_release(
                    d.session,
                    orchestrate::LateEvidence::Notification,
                );
            }
            self.resolve_permission_episodes(d.session, &orchestrate::EpisodeEnd::PromptSubmitted);
            return None;
        }

        if correlates && ev == Some(crate::agent_events::AgentEvent::TurnEnded) {
            if d.stop_hook_active {
                tracing::debug!(
                    "session {}: {} follows a stop a hook blocked",
                    d.session,
                    d.event
                );
            }
            let held: Option<String> = {
                let mut rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
                let round = rounds.entry(d.session).or_default();
                if d.stop_continued {
                    Some("the helper continued this stop".to_string())
                } else {
                    match round.on_turn_ended(now) {
                        orchestrate::RoundVerdict::HoldsOpen { in_flight, owed } => Some(format!(
                            "{in_flight} sub-agent(s) in flight, {owed} notification(s) owed"
                        )),
                        orchestrate::RoundVerdict::Closes(_) => None,
                    }
                }
            };
            if let Some(why) = held {
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                tracing::debug!(
                    "session {}: holding {} — {why}; the pane has not finished",
                    d.session,
                    d.event
                );
                return Some(crate::hook_drop::DropVerdict::Applied);
            }
            self.resolve_permission_episodes(d.session, &orchestrate::EpisodeEnd::TurnEnded);
            return None;
        }

        if correlates && ev == Some(crate::agent_events::AgentEvent::TurnInterrupted) {
            self.resolve_permission_episodes(d.session, &orchestrate::EpisodeEnd::TurnEnded);
            return None;
        }

        if correlates && d.event == "PermissionRequest" {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let mut episodes = self.permission_episodes.lock().expect("episodes lock");
            episodes
                .entry(d.session)
                .or_default()
                .open_with_fingerprint(
                    d.tool_use_id.as_deref().or(d.request_id.as_deref()),
                    d.prompt_id.as_deref(),
                    d.tool_name
                        .as_deref()
                        .or(d.reason.as_deref())
                        .unwrap_or("unnamed tool"),
                    d.reason.clone(),
                    d.tool_input_fingerprint.clone(),
                    now,
                );
            drop(episodes);
            self.apply_agent_event(
                d.session,
                &d.event,
                crate::agent_events::AgentEvent::NeedsInput,
                false,
                true,
            );
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if correlates && d.event == "PermissionDenied" {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let resumed = self.resolve_permission_episodes(
                d.session,
                &orchestrate::EpisodeEnd::PostToolUse {
                    tool_use_id: d.tool_use_id.clone().or_else(|| d.request_id.clone()),
                    prompt_id: d.prompt_id.clone(),
                    tool_name: d.tool_name.clone(),
                    tool_input_fingerprint: d.tool_input_fingerprint.clone(),
                },
            );
            if resumed {
                self.apply_agent_event(
                    d.session,
                    &d.event,
                    crate::agent_events::AgentEvent::InputResolved,
                    false,
                    true,
                );
            }
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if correlates && d.event == "Elicitation" {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let mut episodes = self.permission_episodes.lock().expect("episodes lock");
            episodes.entry(d.session).or_default().open(
                d.request_id.as_deref(),
                d.prompt_id.as_deref(),
                "Claude elicitation",
                d.reason.clone(),
                now,
            );
            drop(episodes);
            self.apply_agent_event(
                d.session,
                &d.event,
                crate::agent_events::AgentEvent::NeedsInput,
                false,
                true,
            );
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if correlates && d.event == "ElicitationResult" {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            let resumed = self.resolve_permission_episodes(
                d.session,
                &orchestrate::EpisodeEnd::PostToolUse {
                    tool_use_id: d.request_id.clone(),
                    prompt_id: d.prompt_id.clone(),
                    tool_name: Some("Claude elicitation".to_string()),
                    tool_input_fingerprint: None,
                },
            );
            if resumed {
                self.apply_agent_event(
                    d.session,
                    &d.event,
                    crate::agent_events::AgentEvent::InputResolved,
                    false,
                    true,
                );
            }
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if ev == Some(crate::agent_events::AgentEvent::NeedsInput) && d.event == "Notification" {
            if let Some(kind) = d.notification_type.as_deref() {
                if !Self::notification_is_a_block(kind) {
                    tracing::debug!(
                        "session {}: notification {kind:?} is not a block",
                        d.session
                    );
                    if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                        return Some(crate::hook_drop::DropVerdict::NoSession);
                    }
                    return Some(crate::hook_drop::DropVerdict::Applied);
                }
            }
            let mut episodes = self.permission_episodes.lock().expect("episodes lock");
            let attached = match episodes.get_mut(&d.session) {
                Some(eps) => eps.attach_notification(d.reason.clone()),
                None => false,
            };
            if attached {
                drop(episodes);
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                return Some(crate::hook_drop::DropVerdict::Applied);
            } else {
                tracing::debug!(
                    "session {}: a blocking notification with no permission episode open",
                    d.session
                );
            }
            return None;
        }

        None
    }

    const CLAUDE_INTERACTIVE_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

    const ANTIGRAVITY_BLOCKING_TOOLS: [&str; 3] =
        ["ask_question", "ask_permission", "ask_custom_permission"];

    fn correlate_antigravity_drop(
        self: &Arc<Self>,
        d: &crate::hook_drop::HookDrop,
        now: u64,
    ) -> Option<crate::hook_drop::DropVerdict> {
        if let Some(id) = d.session_id.as_deref() {
            let mut roots = self
                .antigravity_roots
                .lock()
                .expect("antigravity roots lock");
            let root = roots
                .entry(d.session)
                .or_insert_with(|| {
                    if d.event != "SessionStart" {
                        tracing::debug!(
                            "session {}: pinning Antigravity's root conversationId from {} — \
                             its SessionStart drop never arrived first",
                            d.session,
                            d.event
                        );
                    }
                    id.to_string()
                })
                .clone();
            drop(roots);
            if root != id {
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                tracing::debug!(
                    "session {}: {} for sub-agent conversationId {id} (root {root}) — \
                     correlation, not a status",
                    d.session,
                    d.event
                );
                return Some(crate::hook_drop::DropVerdict::Applied);
            }
        }

        if d.event == "Stop" && d.stop_continued {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            tracing::debug!(
                "session {}: Stop was continued by the hook helper — the turn goes on",
                d.session
            );
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if d.event == "Stop" && d.fully_idle == Some(false) {
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            tracing::debug!(
                "session {}: Stop with fullyIdle=false — parked on invoke_subagent, not a \
                 turn end",
                d.session
            );
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        if d.event == "PreToolUse" {
            let blocks = d
                .tool_name
                .as_deref()
                .is_some_and(|t| Self::ANTIGRAVITY_BLOCKING_TOOLS.contains(&t));
            if !blocks {
                if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                    return Some(crate::hook_drop::DropVerdict::NoSession);
                }
                tracing::debug!(
                    "session {}: PreToolUse for {:?} is a tool call, not a block",
                    d.session,
                    d.tool_name
                );
                return Some(crate::hook_drop::DropVerdict::Applied);
            }
            let mut episodes = self.permission_episodes.lock().expect("episodes lock");
            episodes.entry(d.session).or_default().open(
                d.tool_use_id.as_deref(),
                None,
                d.tool_name.as_deref().unwrap_or("unnamed tool"),
                d.reason.clone(),
                now,
            );
            return None;
        }

        if d.event == "PostToolUse" {
            let resumed = self.resolve_permission_episodes(
                d.session,
                &orchestrate::EpisodeEnd::PostToolUse {
                    tool_use_id: d.tool_use_id.clone(),
                    prompt_id: d.prompt_id.clone(),
                    tool_name: d.tool_name.clone(),
                    tool_input_fingerprint: d.tool_input_fingerprint.clone(),
                },
            );
            if !self.note_hook_seen(d.session, &d.event, d.cwd.as_deref()) {
                return Some(crate::hook_drop::DropVerdict::NoSession);
            }
            if resumed {
                self.apply_agent_event(
                    d.session,
                    &d.event,
                    crate::agent_events::AgentEvent::InputResolved,
                    false,
                    true,
                );
            }
            return Some(crate::hook_drop::DropVerdict::Applied);
        }

        None
    }

    fn confirm_paste_from_prompt(&self, session: u32, prompt: Option<&str>) {
        let Some(prompt) = prompt else { return };
        let Some((delivery_id, written_at)) = self
            .paste_confirmations
            .lock()
            .expect("paste confirmations lock")
            .remove(&session)
        else {
            return;
        };
        let age = now_ms().saturating_sub(written_at);
        if age >= orchestrate::PASTE_CONFIRM_MS {
            tracing::debug!(
                "session {session}: delivery {delivery_id} was written {age} ms ago, past the \
                 {} ms confirmation window",
                orchestrate::PASTE_CONFIRM_MS
            );
            return;
        }
        let head = prompt.lines().next().unwrap_or("");
        if !head.contains(&delivery_id) {
            tracing::debug!(
                "session {session}: a prompt that is not delivery {delivery_id} — unconfirmed \
                 is not failed; the door says what sent is worth"
            );
            return;
        }
        match self.db.inbox_confirm(&delivery_id, now_ms()) {
            Ok(0) => tracing::debug!(
                "session {session}: nothing left to confirm for delivery {delivery_id}"
            ),
            Ok(n) => tracing::debug!(
                "session {session}: delivery {delivery_id} confirmed by its own prompt hook \
                 ({n} row(s))"
            ),
            Err(e) => tracing::warn!("confirming delivery {delivery_id}: {e}"),
        }
    }

    fn feed_subagent_evidence(self: &Arc<Self>, d: &crate::hook_drop::HookDrop, now: u64) {
        let Some(agent_id) = d.agent_id.as_deref() else {
            tracing::debug!(
                "session {}: {} with no agent_id — nothing to correlate",
                d.session,
                d.event
            );
            return;
        };
        let mut rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
        let round = rounds.entry(d.session).or_default();
        if let Some(delegation_round) = self.delegation_round_of(d.session) {
            round.set_round(delegation_round as u64);
        }
        let evidence = if d.event == "SubagentStart" {
            orchestrate::LateEvidence::SubagentStart
        } else {
            orchestrate::LateEvidence::SubagentStop
        };
        let reopened = if d.event == "SubagentStart" {
            round.on_subagent_start(agent_id, now)
        } else {
            let lists_self_running = d.pending_task_ids.iter().any(|id| id == agent_id);
            let out = round.on_subagent_stop(agent_id, lists_self_running, now);
            if out.unknown_id {
                tracing::debug!(
                    "session {}: SubagentStop for {agent_id}, whose start was never seen",
                    d.session
                );
            }
            out.reopened
        };
        drop(rounds);
        if reopened {
            tracing::warn!(
                "session {}: {} for {agent_id} arrived after the turn end that closed its \
                 round was taken at face value",
                d.session,
                d.event
            );
            self.correct_provisional_release(d.session, evidence);
        }
    }

    fn resolve_permission_episodes(&self, session: u32, end: &orchestrate::EpisodeEnd) -> bool {
        let mut episodes = self.permission_episodes.lock().expect("episodes lock");
        if let Some(eps) = episodes.get_mut(&session) {
            let resolved = eps.resolve_on(end);
            let cleared = !resolved.is_empty() && eps.open_count() == 0;
            if cleared {
                episodes.remove(&session);
            }
            return cleared;
        }
        false
    }

    fn subagent_expiry_pass(self: &Arc<Self>, now: u64) {
        let live: HashSet<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect();
        let mut release = Vec::new();
        let mut stalls: Vec<(u32, orchestrate::Expired)> = Vec::new();
        {
            let mut rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
            rounds.retain(|id, _| live.contains(id));
            for (id, round) in rounds.iter_mut() {
                for gone in round.expire(now) {
                    tracing::warn!(
                        "session {id}: giving up on sub-agent {} after {} ms — no {} arrived",
                        gone.id,
                        gone.age_ms,
                        match gone.from {
                            orchestrate::ExpiredFrom::InFlight => "SubagentStop",
                            orchestrate::ExpiredFrom::Owed => "task notification",
                        }
                    );
                    stalls.push((*id, gone));
                }
                if round.take_withheld_release(now) {
                    release.push(*id);
                }
            }
            rounds.retain(|_, round| !round.collect(now));
        }
        for (child, gone) in stalls {
            self.stall_row_for_expired(child, &gone);
        }
        for id in release {
            tracing::warn!(
                "session {id}: releasing the turn end its sub-agent round withheld — the \
                 evidence it was waiting for never arrived"
            );
            self.apply_agent_event(
                id,
                "Stop",
                crate::agent_events::AgentEvent::TurnEnded,
                false,
                true,
            );
        }
        let mut episodes = self.permission_episodes.lock().expect("episodes lock");
        episodes.retain(|id, _| live.contains(id));
        drop(episodes);
        self.antigravity_roots
            .lock()
            .expect("antigravity roots lock")
            .retain(|id, _| live.contains(id));
        self.stop_blocks
            .lock()
            .expect("stop blocks lock")
            .retain(|id, _| live.contains(id));
        self.composer_occupied
            .lock()
            .expect("composer lock")
            .retain(|id, _| live.contains(id));
        self.paste_confirmations
            .lock()
            .expect("paste confirmations lock")
            .retain(|id, _| live.contains(id));
        self.turn_start_round
            .lock()
            .expect("turn start round lock")
            .retain(|id, _| live.contains(id));
        self.last_prompt_id
            .lock()
            .expect("last prompt id lock")
            .retain(|id, _| live.contains(id));
        self.prompt_awaiting_hook
            .lock()
            .expect("prompt awaiting hook lock")
            .retain(|id| live.contains(id));
    }

    fn stall_row_for_expired(self: &Arc<Self>, child: u32, gone: &orchestrate::Expired) {
        let row = match self.db.delegation_for_child(child) {
            Ok(Some(row)) => row,
            _ => return,
        };
        let (noun, limit) = match gone.from {
            orchestrate::ExpiredFrom::InFlight => {
                ("SubagentStop", orchestrate::SUBAGENT_INFLIGHT_MAX_MS)
            }
            orchestrate::ExpiredFrom::Owed => {
                ("task notification", orchestrate::OWED_NOTIFICATION_MAX_MS)
            }
        };
        let summary = format!(
            "sub-agent {} gave no {noun} in {} ms (limit {limit})",
            gone.id, gone.age_ms
        );
        let body = format!(
            "sub-agent {} gave no {noun} in {} ms (limit {limit}); child session {child}",
            gone.id, gone.age_ms
        );
        let workspace = self.current_workspace(child).unwrap_or_default();
        if let Err(e) = self.inbox_write(
            row.parent_session,
            &workspace,
            Some(child),
            Some(row.round),
            orchestrate::InboxKind::Stalled,
            &summary,
            &body,
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!(
                "stalling child {child} for parent {}: {e}",
                row.parent_session
            );
        }
    }

    fn inbox_retention_pass(self: &Arc<Self>, now: u64) {
        let last = self.last_inbox_retention.load(Ordering::Relaxed);
        if now.saturating_sub(last) < orchestrate::INBOX_RETENTION_SWEEP_MS {
            return;
        }
        self.last_inbox_retention.store(now, Ordering::Relaxed);
        let retention_ms = orchestrate::INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        match self.db.inbox_prune_expired(now, retention_ms) {
            Ok(0) => {}
            Ok(n) => tracing::info!(
                "pruned {n} inbox row(s) older than {} days",
                orchestrate::INBOX_RETENTION_DAYS
            ),
            Err(e) => tracing::warn!("pruning the inbox retention: {e}"),
        }
    }

    #[doc(hidden)]
    pub fn subagent_round_closed_by_for_test(
        &self,
        session: u32,
    ) -> Option<orchestrate::RoundClose> {
        self.subagent_rounds
            .lock()
            .expect("subagent rounds lock")
            .get(&session)
            .and_then(|r| r.closed_by())
    }

    #[doc(hidden)]
    pub fn subagent_expiry_tick_at(self: &Arc<Self>, now: u64) {
        self.subagent_expiry_pass(now);
    }

    fn hook_drop_tick(self: &Arc<Self>, pass: crate::hook_drop::Pass) -> (usize, bool) {
        if self.refusing_mutations() {
            return (0, true);
        }
        let dirs = self.hook_drop_dirs();
        let mut states = self.hook_drop_states.lock().expect("hook_drop_states lock");
        states.retain(|dir, _| dirs.contains(dir));
        let now = crate::hook_drop::now_ms();
        let (mut applied, mut all_listed) = (0usize, true);
        for dir in &dirs {
            let state = states.entry(dir.clone()).or_default();
            let out =
                crate::hook_drop::run_pass(dir, state, now, pass, |d| self.apply_hook_drop(d));
            applied += out.applied;
            all_listed &= out.listed_ok;
            if out.collected > 0 {
                tracing::info!(
                    "hook drop {pass:?} pass: collected {} file(s) older than {}s from {}",
                    out.collected,
                    crate::hook_drop::MAX_AGE_MS / 1000,
                    dir.display()
                );
            }
        }
        drop(states);
        self.subagent_expiry_pass(now);
        self.inbox_retention_pass(now);
        (applied, all_listed)
    }

    fn hook_drop_boot(self: &Arc<Self>) {
        let dir = crate::hook_drop::drop_dir(&self.state_dir);
        if let Err(e) = crate::hook_drop::ensure_drop_dir(&dir) {
            tracing::warn!("creating the hook drop directory {}: {e:#}", dir.display());
        }
        let watcher = crate::fs_watch::start_watcher(&dir, Arc::clone(&self.hook_drop_watch));
        *self
            ._hook_drop_watcher
            .lock()
            .expect("hook_drop_watcher lock") = watcher;
        self.hook_drop_tick(crate::hook_drop::Pass::Seed);
    }

    #[doc(hidden)]
    pub fn hook_drop_tick_for_test(self: &Arc<Self>) -> usize {
        self.hook_drop_tick(crate::hook_drop::Pass::Steady).0
    }

    #[doc(hidden)]
    pub fn hook_drop_boot_for_test(self: &Arc<Self>) {
        self.hook_drop_boot();
    }

    pub fn mcp_progress_tick(&self) -> Duration {
        Duration::from_millis(self.mcp_progress_tick_ms.load(Ordering::Relaxed))
    }

    #[doc(hidden)]
    pub fn set_mcp_progress_tick_for_test(&self, tick: Duration) {
        self.mcp_progress_tick_ms
            .store(tick.as_millis() as u64, Ordering::Relaxed);
    }

    fn rebuild_hook_state(&self) {
        if let Err(e) = self.list_swarms_publishing_registry() {
            tracing::warn!("listing swarms for the boot scope-registry rebuild: {e}");
        }
    }

    pub fn command_history_ignored(&self, cmd: &str, cwd: &str) -> bool {
        let globs = self.command_history_ignore_globs();
        if globs.is_empty() {
            return false;
        }
        crate::sanitize::matches_ignored(cmd, &globs)
            || crate::sanitize::matches_ignored(cwd, &globs)
    }

    pub fn command_history_ignore_globs(&self) -> Vec<String> {
        match self.db.get_setting(COMMAND_HISTORY_IGNORE_KEY) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_else(|e| {
                tracing::warn!(
                    "corrupt {COMMAND_HISTORY_IGNORE_KEY} blob, discarding ignore globs: {e}"
                );
                Vec::new()
            }),
            _ => Vec::new(),
        }
    }

    pub fn set_command_history_ignore_globs(&self, globs: &[String]) -> Result<Vec<String>> {
        anyhow::ensure!(
            globs.len() <= proto::COMMAND_HISTORY_IGNORE_GLOBS_MAX as usize,
            "command-history ignore list cap is {} pattern(s) — asked to store {} (currently \
             {})",
            proto::COMMAND_HISTORY_IGNORE_GLOBS_MAX,
            globs.len(),
            self.command_history_ignore_globs().len()
        );
        if let Some(oversize) = globs
            .iter()
            .find(|g| g.len() > proto::COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX as usize)
        {
            bail!(
                "ignore-glob pattern is {} byte(s), over the {}-byte cap: {:?}",
                oversize.len(),
                proto::COMMAND_HISTORY_IGNORE_GLOB_LEN_MAX,
                oversize.chars().take(60).collect::<String>()
            );
        }
        self.db
            .set_setting(COMMAND_HISTORY_IGNORE_KEY, &serde_json::to_string(globs)?)?;
        Ok(self.command_history_ignore_globs())
    }

    pub fn restore_budget(&self) -> u32 {
        if let Ok(v) = std::env::var("HOUSTON_RESTORE_BUDGET") {
            if let Ok(n) = v.parse() {
                return n;
            }
        }
        match self.db.get_setting(RESTORE_BUDGET_KEY) {
            Ok(Some(v)) => v.parse().unwrap_or(proto::RESTORE_BUDGET_DEFAULT),
            _ => proto::RESTORE_BUDGET_DEFAULT,
        }
    }

    pub fn set_restore_budget(&self, budget: u32) -> Result<u32> {
        if budget > proto::RESTORE_BUDGET_MAX {
            bail!(
                "restore budget must be at most {} (asked for {budget}; currently {})",
                proto::RESTORE_BUDGET_MAX,
                self.restore_budget()
            );
        }
        self.db
            .set_setting(RESTORE_BUDGET_KEY, &budget.to_string())?;
        Ok(budget)
    }

    pub fn mailbox_retention_hours(&self) -> u32 {
        match self.db.get_setting(MAILBOX_RETENTION_HOURS_KEY) {
            Ok(Some(v)) => v.parse().unwrap_or(proto::MAILBOX_RETENTION_HOURS_DEFAULT),
            _ => proto::MAILBOX_RETENTION_HOURS_DEFAULT,
        }
    }

    pub fn set_mailbox_retention_hours(&self, hours: u32) -> Result<u32> {
        if hours == 0 || hours > proto::MAILBOX_RETENTION_HOURS_MAX {
            bail!(
                "mailbox retention must be 1..={} hours (asked for {hours}; currently {})",
                proto::MAILBOX_RETENTION_HOURS_MAX,
                self.mailbox_retention_hours()
            );
        }
        self.db
            .set_setting(MAILBOX_RETENTION_HOURS_KEY, &hours.to_string())?;
        Ok(hours)
    }

    pub fn orchestration_max_live_children(&self) -> u32 {
        match self.db.get_setting(ORCHESTRATION_MAX_LIVE_CHILDREN_KEY) {
            Ok(Some(v)) => v.parse().unwrap_or(orchestrate::MAX_LIVE_CHILDREN),
            _ => orchestrate::MAX_LIVE_CHILDREN,
        }
    }

    pub fn orchestration_max_spawn_depth(&self) -> u32 {
        match self.db.get_setting(ORCHESTRATION_MAX_SPAWN_DEPTH_KEY) {
            Ok(Some(v)) => v.parse().unwrap_or(orchestrate::MAX_SPAWN_DEPTH),
            _ => orchestrate::MAX_SPAWN_DEPTH,
        }
    }

    pub fn set_orchestration_caps(
        &self,
        max_live_children: u32,
        max_spawn_depth: u32,
    ) -> Result<()> {
        if max_live_children == 0 || max_live_children > proto::ORCHESTRATION_CAP_MAX {
            bail!(
                "max child panes per agent must be 1..={} (asked for {max_live_children}; \
                 currently {})",
                proto::ORCHESTRATION_CAP_MAX,
                self.orchestration_max_live_children()
            );
        }
        if max_spawn_depth == 0 || max_spawn_depth > proto::ORCHESTRATION_CAP_MAX {
            bail!(
                "max nesting depth must be 1..={} (asked for {max_spawn_depth}; currently {})",
                proto::ORCHESTRATION_CAP_MAX,
                self.orchestration_max_spawn_depth()
            );
        }
        self.db.set_setting(
            ORCHESTRATION_MAX_LIVE_CHILDREN_KEY,
            &max_live_children.to_string(),
        )?;
        self.db.set_setting(
            ORCHESTRATION_MAX_SPAWN_DEPTH_KEY,
            &max_spawn_depth.to_string(),
        )?;
        self.mcp_notify.tools_changed_everywhere();
        Ok(())
    }

    pub fn host_info(&self) -> proto::ServerMsg {
        let live_session_ids: Vec<u32> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .keys()
            .copied()
            .collect();
        let live_sessions = live_session_ids.len() as u32;
        let orchestration_depth_in_use = live_session_ids
            .iter()
            .map(|&id| self.spawn_depth_of(id))
            .max()
            .unwrap_or(0);
        let restore_deferred = self
            .dead
            .lock()
            .expect("dead lock")
            .values()
            .filter(|s| s.restore_deferred == Some(proto::RestoreReason::Budget))
            .count() as u32;
        let session_db_bytes = std::fs::metadata(&self.db_path)
            .map(|m| m.len())
            .unwrap_or(0);
        proto::ServerMsg::HostInfo {
            channel: self.channel().unwrap_or("release").to_string(),
            state_dir: self.state_dir.display().to_string(),
            pid: std::process::id(),
            port: self.port.lock().expect("port lock").unwrap_or(0),
            protocol_version: proto::PROTOCOL_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            build_commit: build_commit().to_string(),
            uptime_ms: self.started.elapsed().as_millis() as u64,
            live_sessions,
            restore_budget: self.restore_budget(),
            restore_deferred,
            orchestration_depth_in_use,
            orchestration_max_depth: self.orchestration_max_spawn_depth(),
            mailbox_files_on_disk: self.mailbox_file_count(),
            mailbox_retention_hours: self.mailbox_retention_hours(),
            command_history_ignore_glob_count: self.command_history_ignore_globs().len() as u32,
            session_db_bytes,
        }
    }

    pub fn usage_summary(
        &self,
        since_ms: i64,
        until_ms: i64,
        refresh_pricing: bool,
    ) -> Result<proto::ServerMsg> {
        if until_ms <= since_ms {
            bail!(
                "{} empty window: asked for [{since_ms}, {until_ms}) ms, \
                 which needs until_ms > since_ms",
                proto::USAGE_WINDOW_REFUSED
            );
        }
        let span_ms = until_ms - since_ms;
        let max_ms = i64::from(proto::USAGE_MAX_WINDOW_DAYS) * 24 * 60 * 60 * 1_000;
        if span_ms > max_ms {
            bail!(
                "{} asked for {:.1} days ({span_ms} ms), \
                 limit is {} days ({max_ms} ms)",
                proto::USAGE_WINDOW_REFUSED,
                span_ms as f64 / 86_400_000.0,
                proto::USAGE_MAX_WINDOW_DAYS
            );
        }

        let outcome = crate::usage::scan(&crate::usage::ScanRequest {
            since_ms,
            until_ms,
            catalog: self
                .model_catalog
                .load(self.update_policy().check, refresh_pricing),
            state_dir: self.state_dir.clone(),
            sources: self.usage_sources(),
        });
        tracing::debug!(
            "usage scan: {} buckets from {} source(s) in {}ms \
             ({} duplicate record(s) dropped, {} outside the window)",
            outcome.buckets.len(),
            outcome.sources.len(),
            outcome.scan_duration_ms,
            outcome.duplicates_dropped,
            outcome.out_of_window
        );

        Ok(proto::ServerMsg::UsageSummary {
            since_ms,
            until_ms,
            read_at_ms: crate::usage::time::now_ms(),
            buckets: outcome.buckets,
            sources: outcome.sources,
            pricing: outcome.pricing,
            untracked_agents: crate::usage::untracked_agents(),
            scan_duration_ms: outcome.scan_duration_ms,
        })
    }

    fn usage_sources(&self) -> Vec<crate::usage::SourceSpec> {
        let home = crate::home_dir::home_dir();
        let mut sources = Vec::new();

        for provider in proto::UsageProvider::ALL {
            if let Some(home) = home.as_deref() {
                sources.push(crate::usage::SourceSpec {
                    provider,
                    root: crate::usage::default_root(provider, home),
                    profile_name: None,
                });
            }
            let slug = match provider {
                proto::UsageProvider::Claude => "claude",
                proto::UsageProvider::Codex => "codex",
            };
            match self.db.list_agent_profiles(slug) {
                Ok(rows) => {
                    for row in rows {
                        let config_dir = match home.as_deref() {
                            Some(home) => {
                                crate::agent_accounts::expand_tilde(&row.config_dir, home)
                            }
                            None => std::path::PathBuf::from(&row.config_dir),
                        };
                        sources.push(crate::usage::SourceSpec {
                            provider,
                            root: crate::usage::root_under_config_dir(provider, &config_dir),
                            profile_name: Some(row.name),
                        });
                    }
                }
                Err(e) => {
                    tracing::warn!("listing {slug} profiles for the usage scan: {e:#}");
                }
            }
        }
        sources
    }

    fn mailbox_file_count(&self) -> u64 {
        let swarms = match self.db.list_swarms() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("host_info: listing swarms for mailbox file count: {e}");
                return 0;
            }
        };
        let mut total = 0u64;
        for info in &swarms {
            let layout = crate::scope::ScopeLayout::new(Path::new(&info.root_dir), info.id);
            if !layout.scope.is_dir() {
                continue;
            }
            total += count_files_recursive(&layout.scope.join("inbox"));
            total += count_files_recursive(&layout.transcript);
            total += count_files_recursive(&layout.nudges);
            total += count_files_recursive(&layout.plan_events);
            total += count_files_recursive(&layout.hook_drop);
        }
        total
    }

    pub fn any_live_conn(&self) -> Option<u64> {
        self.visibility
            .lock()
            .expect("visibility lock")
            .keys()
            .next()
            .copied()
    }

    pub fn conn_register(&self) -> u64 {
        let id = self.next_conn_id.fetch_add(1, Ordering::Relaxed);
        self.visibility
            .lock()
            .expect("visibility lock")
            .insert(id, HashSet::new());
        self.reap_reevaluate();
        id
    }

    pub fn conn_forget(&self, conn: u64) {
        let remaining = {
            let mut map = self.visibility.lock().expect("visibility lock");
            map.remove(&conn);
            map.len()
        };
        self.voice_release_monitor(conn);
        self.browser_relay.fail_all_pending();
        if remaining == 0 {
            if let Err(e) = self.checkpoint_scrollback() {
                tracing::warn!("checkpoint on last client detach: {e:#}");
            }
        }
        self.reap_reevaluate();
    }

    pub fn conn_set_visibility(&self, conn: u64, session: u32, visible: bool) {
        let mut map = self.visibility.lock().expect("visibility lock");
        let Some(set) = map.get_mut(&conn) else {
            return;
        };
        if visible {
            set.remove(&session);
        } else {
            set.insert(session);
        }
    }

    pub fn session_hidden_everywhere(&self, session: u32) -> bool {
        let map = self.visibility.lock().expect("visibility lock");
        !map.is_empty() && map.values().all(|hidden| hidden.contains(&session))
    }

    fn session_reap_sweep(self: &Arc<Self>) {
        let policy = self.session_policy();
        if !policy.idle_reap_enabled {
            return;
        }
        let idle_ms = policy.idle_reap_minutes as u64 * 60 * 1000;
        let now_ms = self.started.elapsed().as_millis() as u64;
        for id in self.session_reap_candidates(idle_ms, now_ms) {
            tracing::info!(
                "idle reap: closing session {id} (idle > {} min, hidden on every connection)",
                policy.idle_reap_minutes
            );
            if let Err(e) = self.close(id) {
                tracing::warn!("idle reap: closing session {id} failed: {e}");
            }
        }
    }

    #[doc(hidden)]
    pub fn session_reap_sweep_for_test(self: &Arc<Self>) {
        self.session_reap_sweep();
    }

    #[doc(hidden)]
    pub fn session_reap_candidates(&self, idle_ms: u64, now_ms: u64) -> Vec<u32> {
        let sessions: Vec<(u32, Arc<Session>)> = {
            let map = self.sessions.lock().expect("sessions lock");
            map.iter().map(|(id, s)| (*id, Arc::clone(s))).collect()
        };
        let mut out = Vec::new();
        for (id, session) in sessions {
            if session.info.hidden || session.info.swarm_agent.is_some() {
                continue;
            }
            if !matches!(
                session.info.agent,
                proto::AgentKind::Claude | proto::AgentKind::Codex | proto::AgentKind::Antigravity
            ) {
                continue;
            }
            if !session.state.lock().expect("state lock").is_live() {
                continue;
            }
            let last = session.last_output.load(Ordering::Relaxed);
            if now_ms.saturating_sub(last) < idle_ms {
                continue;
            }
            let busy = match session.pid {
                Some(pid) => has_child_procs(pid).unwrap_or(true),
                None => true,
            };
            if busy {
                continue;
            }
            let status = *session.status.lock().expect("status lock");
            if matches!(
                status,
                Some(proto::AgentStatus::Working)
                    | Some(proto::AgentStatus::NeedsInput)
                    | Some(proto::AgentStatus::Spawning)
                    | Some(proto::AgentStatus::Unavailable)
            ) {
                continue;
            }
            if !self.session_hidden_everywhere(id) {
                continue;
            }
            out.push(id);
        }
        out
    }

    pub fn voice_settings(&self) -> proto::VoiceSettings {
        match self.db.get_setting(VOICE_SETTINGS_KEY) {
            Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
            _ => proto::VoiceSettings::default(),
        }
    }

    pub fn voice_models_dir(&self) -> PathBuf {
        self.state_dir.join("models")
    }

    pub fn voice_model_state(&self, model_id: &str) -> proto::VoiceModelState {
        let spec = crate::voice::models::find(model_id);
        let on_disk = crate::voice::models::status(&self.voice_models_dir(), model_id);
        let status = match (self.voice.download_state(model_id), on_disk) {
            (Some(crate::voice::runtime::DownloadState::InFlight { progress }), _) => {
                proto::VoiceModelStatus::Downloading { progress }
            }
            (_, crate::voice::models::ModelStatus::Downloaded { size_bytes }) => {
                proto::VoiceModelStatus::Downloaded { size_bytes }
            }
            (Some(crate::voice::runtime::DownloadState::Failed { reason }), _) => {
                proto::VoiceModelStatus::Failed { reason }
            }
            _ if spec.is_none() => proto::VoiceModelStatus::Failed {
                reason: format!(
                    "unknown model id {model_id:?}; this build's catalog has: {}",
                    crate::voice::models::CATALOG
                        .iter()
                        .map(|m| m.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },
            _ => proto::VoiceModelStatus::NotDownloaded,
        };
        proto::VoiceModelState {
            id: model_id.to_string(),
            display_name: spec
                .map(|s| s.display_name.to_string())
                .unwrap_or_else(|| model_id.to_string()),
            size_bytes: spec.map(|s| s.size_bytes).unwrap_or(0),
            status,
            cooldown_remaining_ms: self
                .voice
                .models
                .cooldown_remaining(&self.voice_models_dir(), model_id)
                .map(|d| d.as_millis() as u64),
        }
    }

    pub fn voice_model_states(&self) -> Vec<proto::VoiceModelState> {
        crate::voice::models::CATALOG
            .iter()
            .map(|spec| self.voice_model_state(spec.id))
            .collect()
    }

    pub fn voice_settings_reply(&self) -> proto::ServerMsg {
        proto::ServerMsg::VoiceSettings {
            settings: self.voice_settings(),
            cloud_key_present: crate::voice::cloud::has_key(),
            keyring_error: crate::voice::cloud::keyring_error(),
            models: self.voice_model_states(),
        }
    }

    pub fn voice_settings_set(&self, settings: &proto::VoiceSettings) -> Result<()> {
        self.db
            .set_setting(VOICE_SETTINGS_KEY, &serde_json::to_string(settings)?)?;
        self.voice_apply_mic_policy(settings);
        Ok(())
    }

    fn voice_apply_mic_policy(&self, settings: &proto::VoiceSettings) {
        let capturing = self.voice.listening_for();
        let want_open = voice_wants_open(settings, self.voice.is_monitoring(), capturing.is_some());
        if !want_open {
            self.voice.close();
            return;
        }
        if !settings.enabled {
            if capturing.is_some() {
                self.broadcast_voice_state(proto::VoiceState::Error {
                    failure: proto::VoiceFailure::Engine {
                        message: "dictation was turned off while recording — the audio was \
                                  discarded, nothing was transcribed"
                            .to_string(),
                    },
                });
            }
            self.voice.close();
            return;
        }
        if let Err(e) = self.voice.ensure_open(settings.input_device.as_deref()) {
            tracing::warn!("voice: opening the input device failed: {e}");
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: voice_capture_failure(&e),
            });
        }
    }

    fn broadcast_voice_state(&self, state: proto::VoiceState) {
        self.broadcast_control(&proto::ServerMsg::VoiceState { state });
    }

    pub fn voice_level_monitor(self: &Arc<Self>, conn: u64, enabled: bool) {
        let transition = self.voice.set_monitor(conn, enabled);
        if transition == crate::voice::runtime::MonitorTransition::Unchanged {
            return;
        }
        self.voice_apply_mic_policy(&self.voice_settings());
        if transition == crate::voice::runtime::MonitorTransition::Stopped {
            return;
        }
        let daemon = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(Duration::from_millis(proto::VOICE_LEVEL_INTERVAL_MS));
            while daemon.voice.is_monitoring() {
                tick.tick().await;
                daemon.broadcast_control(&proto::ServerMsg::VoiceLevel {
                    rms: daemon.voice.level().unwrap_or(0.0),
                });
            }
        });
    }

    pub fn voice_release_monitor(&self, conn: u64) {
        if self.voice.release_monitor(conn) == crate::voice::runtime::MonitorTransition::Stopped {
            self.voice_apply_mic_policy(&self.voice_settings());
        }
    }

    pub fn voice_devices(&self) -> Vec<proto::VoiceDevice> {
        match crate::voice::capture::list_devices() {
            Ok(devices) => devices
                .into_iter()
                .map(|d| proto::VoiceDevice {
                    id: d.id,
                    label: d.label,
                    is_default: d.is_default,
                })
                .collect(),
            Err(e) => {
                tracing::warn!("voice: enumerating input devices failed: {e}");
                self.broadcast_voice_state(proto::VoiceState::Error {
                    failure: voice_capture_failure(&e),
                });
                Vec::new()
            }
        }
    }

    fn voice_session_alive(&self, session: u32) -> bool {
        self.sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&session)
    }

    fn voice_start_refusal(
        &self,
        settings: &proto::VoiceSettings,
        session: u32,
    ) -> Option<proto::VoiceFailure> {
        if !settings.enabled {
            return Some(proto::VoiceFailure::Engine {
                message: "dictation is off — turn it on in Settings → Voice".to_string(),
            });
        }
        if !self.voice_session_alive(session) {
            return Some(proto::VoiceFailure::TargetGone { session });
        }
        match &settings.engine {
            proto::VoiceEngine::Local { model_id } => {
                if !matches!(
                    crate::voice::models::status(&self.voice_models_dir(), model_id),
                    crate::voice::models::ModelStatus::Downloaded { .. }
                ) {
                    return Some(proto::VoiceFailure::NoModel {
                        model_id: model_id.clone(),
                    });
                }
            }
            proto::VoiceEngine::Cloud { provider } => {
                match crate::voice::cloud::key_availability() {
                    crate::voice::cloud::KeyAvailability::Present => {}
                    crate::voice::cloud::KeyAvailability::Absent => {
                        return Some(proto::VoiceFailure::MissingKey {
                            provider: *provider,
                        });
                    }
                    crate::voice::cloud::KeyAvailability::Unreadable(why) => {
                        return Some(proto::VoiceFailure::Engine {
                            message: format!(
                                "the OS keychain did not answer, so a stored Groq API key could \
                                 not be read: {why}. This is not the same as having no key — \
                                 unlock your login keyring and try again, or switch back to the \
                                 local engine in Settings → Voice"
                            ),
                        });
                    }
                }
            }
        }
        None
    }

    pub fn voice_start(&self, session: u32) {
        let settings = self.voice_settings();
        if let Some(failure) = self.voice_start_refusal(&settings, session) {
            self.broadcast_voice_state(proto::VoiceState::Error { failure });
            return;
        }
        if let Err(e) = self.voice.ensure_open(settings.input_device.as_deref()) {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: voice_capture_failure(&e),
            });
            return;
        }
        if let Err(e) = self.voice.arm(session) {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: voice_capture_failure(&e),
            });
            return;
        }
        self.broadcast_voice_state(proto::VoiceState::Listening { session });
    }

    pub async fn voice_stop(self: &Arc<Self>, session: u32) {
        let settings = self.voice_settings();
        if self.voice.listening_for().is_none() {
            self.broadcast_voice_state(proto::VoiceState::Idle);
            return;
        }
        let (target, captured) = match self.voice.disarm() {
            Ok(v) => v,
            Err(e) => {
                self.broadcast_voice_state(proto::VoiceState::Error {
                    failure: voice_capture_failure(&e),
                });
                return;
            }
        };
        if settings.mic_policy == proto::MicPolicy::OnKeypress {
            self.voice.close();
        }
        let Some(target) = target else {
            self.broadcast_voice_state(proto::VoiceState::Idle);
            return;
        };
        if target != session {
            tracing::warn!(
                started_for = target,
                stopped_for = session,
                "voice: stop names a different pane than start did; honoring the start target"
            );
        }
        self.broadcast_voice_state(proto::VoiceState::Transcribing { session: target });

        if let Err(e) = &captured.health {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: voice_capture_failure(e),
            });
            return;
        }
        if let Err(e) = crate::voice::capture::gate(
            &captured.samples,
            crate::voice::capture::TARGET_SAMPLE_RATE,
            settings.rms_floor,
        ) {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: voice_capture_failure(&e),
            });
            return;
        }
        if !self.voice_session_alive(target) {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: proto::VoiceFailure::TargetGone { session: target },
            });
            return;
        }

        let audio = crate::voice::AudioBuffer {
            samples: captured.samples,
            sample_rate: crate::voice::capture::TARGET_SAMPLE_RATE,
        };
        let translate = settings.output_mode == proto::VoiceOutputMode::English;
        let language = settings.input_language.clone();
        let prompt = settings.vocabulary.clone();
        let engine = settings.engine.clone();
        let models_dir = self.voice_models_dir();
        let me = self.clone();
        let outcome =
            tokio::task::spawn_blocking(move || -> Result<(String, String, bool), String> {
                let request = crate::voice::TranscribeRequest {
                    language: language.as_deref(),
                    translate,
                    prompt: &prompt,
                };
                match &engine {
                    proto::VoiceEngine::Local { model_id } => {
                        let path = models_dir.join(format!("{model_id}.bin"));
                        let transcriber =
                            me.voice.local_engine(&path).map_err(|e| e.to_string())?;
                        let t =
                            crate::voice::Transcriber::transcribe(&*transcriber, &audio, &request)
                                .map_err(|e| e.to_string())?;
                        Ok((t.text, format!("local:{model_id}"), t.translated))
                    }
                    proto::VoiceEngine::Cloud { provider } => {
                        let proto::CloudStt::Groq = provider;
                        let key = crate::voice::cloud::load_key()
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| {
                                "no Groq API key is stored (Settings → Voice → Groq API key)"
                                    .to_string()
                            })?;
                        let transcriber = crate::voice::cloud::GroqTranscriber::new(key)
                            .map_err(|e| e.to_string())?;
                        let t =
                            crate::voice::Transcriber::transcribe(&transcriber, &audio, &request)
                                .map_err(|e| e.to_string())?;
                        Ok((t.text, "groq".to_string(), t.translated))
                    }
                }
            })
            .await;

        let (text, engine_label, translated) = match outcome {
            Ok(Ok(v)) => v,
            Ok(Err(message)) => {
                self.broadcast_voice_state(proto::VoiceState::Error {
                    failure: proto::VoiceFailure::Engine { message },
                });
                return;
            }
            Err(join) => {
                self.broadcast_voice_state(proto::VoiceState::Error {
                    failure: proto::VoiceFailure::Engine {
                        message: format!("the transcription task did not finish: {join}"),
                    },
                });
                return;
            }
        };
        if !self.voice_session_alive(target) {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: proto::VoiceFailure::TargetGone { session: target },
            });
            return;
        }
        self.broadcast_control(&proto::ServerMsg::VoiceTranscript {
            session: target,
            text,
            engine: engine_label,
            translated,
        });
        if captured.dropped > 0 {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: proto::VoiceFailure::RingBufferOverrun {
                    dropped: captured.dropped,
                },
            });
        } else if captured.truncated {
            self.broadcast_voice_state(proto::VoiceState::Error {
                failure: proto::VoiceFailure::Engine {
                    message: format!(
                        "recording stopped at the {:.0}s per-utterance cap; everything captured \
                         up to that point was transcribed",
                        crate::voice::capture::MAX_UTTERANCE_SECS
                    ),
                },
            });
        } else {
            self.broadcast_voice_state(proto::VoiceState::Idle);
        }
    }

    pub fn voice_model_download(self: &Arc<Self>, model_id: String) {
        if crate::voice::models::find(&model_id).is_none() {
            self.broadcast_control(&proto::ServerMsg::VoiceModelState {
                model: self.voice_model_state(&model_id),
            });
            return;
        }
        if self.voice.download_in_flight(&model_id) {
            self.broadcast_control(&proto::ServerMsg::VoiceModelState {
                model: self.voice_model_state(&model_id),
            });
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            me.voice.download_begin(&model_id);
            me.broadcast_control(&proto::ServerMsg::VoiceModelState {
                model: me.voice_model_state(&model_id),
            });
            let client = match reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    me.voice
                        .download_end(&model_id, Some(format!("building the HTTP client: {e}")));
                    me.broadcast_control(&proto::ServerMsg::VoiceModelState {
                        model: me.voice_model_state(&model_id),
                    });
                    return;
                }
            };
            let dir = me.voice_models_dir();
            let mut last_broadcast = std::time::Instant::now();
            let result = me
                .voice
                .models
                .download_with_progress(&client, &dir, &model_id, |done, total| {
                    let progress = if total == 0 {
                        0.0
                    } else {
                        done as f32 / total as f32
                    };
                    me.voice.download_progress(&model_id, progress);
                    if last_broadcast.elapsed() >= VOICE_DOWNLOAD_PROGRESS_INTERVAL {
                        last_broadcast = std::time::Instant::now();
                        me.broadcast_control(&proto::ServerMsg::VoiceModelState {
                            model: me.voice_model_state(&model_id),
                        });
                    }
                })
                .await;
            match result {
                Ok(path) => {
                    tracing::info!(model = %model_id, path = %path.display(), "voice: model downloaded and verified");
                    me.voice.download_end(&model_id, None);
                }
                Err(e) => {
                    tracing::warn!(model = %model_id, "voice: model download failed: {e}");
                    me.voice.download_end(&model_id, Some(e.to_string()));
                }
            }
            me.broadcast_control(&proto::ServerMsg::VoiceModelState {
                model: me.voice_model_state(&model_id),
            });
            me.broadcast_control(&me.voice_settings_reply());
        });
    }

    pub fn voice_model_delete(&self, model_id: &str) -> proto::ServerMsg {
        match crate::voice::models::delete(&self.voice_models_dir(), model_id) {
            Ok(freed) => {
                tracing::info!(model = %model_id, freed_bytes = freed, "voice: model deleted");
                self.voice.download_forget(model_id);
                self.voice.forget_engine();
            }
            Err(e) => {
                tracing::warn!(model = %model_id, "voice: model delete failed: {e}");
                self.voice.download_end(model_id, Some(e.to_string()));
            }
        }
        proto::ServerMsg::VoiceModelState {
            model: self.voice_model_state(model_id),
        }
    }

    pub fn voice_key_set(&self, provider: proto::CloudStt, key: String) -> Result<()> {
        let proto::CloudStt::Groq = provider;
        crate::voice::cloud::store_key(&crate::voice::cloud::Secret::new(key))
            .map_err(|e| anyhow::anyhow!("storing the Groq API key: {e}"))
    }

    pub fn voice_key_clear(&self, provider: proto::CloudStt) -> Result<()> {
        let proto::CloudStt::Groq = provider;
        crate::voice::cloud::delete_key()
            .map_err(|e| anyhow::anyhow!("removing the Groq API key: {e}"))
    }

    pub fn session_policy(&self) -> proto::SessionPolicy {
        let d = proto::SessionPolicy::default();
        let idle_reap_enabled = match self.db.get_setting(SESSION_IDLE_REAP_ENABLED_KEY) {
            Ok(Some(v)) => v == "1",
            _ => d.idle_reap_enabled,
        };
        let idle_reap_minutes = match self.db.get_setting(SESSION_IDLE_REAP_MINUTES_KEY) {
            Ok(Some(v)) => v.parse().unwrap_or(d.idle_reap_minutes),
            _ => d.idle_reap_minutes,
        };
        proto::SessionPolicy {
            idle_reap_enabled,
            idle_reap_minutes,
        }
    }

    pub fn session_policy_set(&self, policy: proto::SessionPolicy) -> Result<proto::SessionPolicy> {
        anyhow::ensure!(
            policy.idle_reap_minutes >= 1
                && policy.idle_reap_minutes <= SESSION_IDLE_REAP_MINUTES_MAX,
            "session idle_reap_minutes {} is out of range (expected 1..={})",
            policy.idle_reap_minutes,
            SESSION_IDLE_REAP_MINUTES_MAX
        );
        self.db.set_setting(
            SESSION_IDLE_REAP_ENABLED_KEY,
            if policy.idle_reap_enabled { "1" } else { "0" },
        )?;
        self.db.set_setting(
            SESSION_IDLE_REAP_MINUTES_KEY,
            &policy.idle_reap_minutes.to_string(),
        )?;
        Ok(self.session_policy())
    }

    fn swarm_mirror_hook(&self, session: u32, event: &str) {
        let target = match event {
            "UserPromptSubmit" => proto::SwarmAgentStatus::Running,
            "Stop" => proto::SwarmAgentStatus::Idle,
            _ => return,
        };
        let Ok(Some(a)) = self.db.swarm_agent_by_session(session) else {
            return;
        };
        if a.status == target
            || matches!(
                a.status,
                proto::SwarmAgentStatus::Done | proto::SwarmAgentStatus::Error
            )
        {
            return;
        }
        match self.db.swarm_agent_set_status(a.id, target) {
            Ok(agent) => self.broadcast_control(&proto::ServerMsg::SwarmAgent {
                agent: self.swarm_overlay(agent),
            }),
            Err(e) => tracing::warn!("mirroring hook onto swarm agent {}: {e}", a.id),
        }
    }

    fn acp_tick(self: &Arc<Self>, id: u32, session: &Session, chunk: &[u8]) {
        let Some(decoder) = session.acp.as_ref() else {
            return;
        };
        let outcomes = {
            let mut d = decoder.lock().expect("acp decoder lock");
            d.feed(chunk)
        };
        for outcome in outcomes {
            match outcome {
                crate::acp::AcpDecodeOutcome::Message(msg) => {
                    if let Some(event) = crate::acp::event_for_message(&msg) {
                        self.apply_agent_event(id, "ACP", event, false, true);
                    }
                }
                crate::acp::AcpDecodeOutcome::Error(e) => {
                    tracing::warn!("ACP stream of session {id}: {e}");
                }
            }
        }
    }

    pub fn swarm_list(&self) -> Result<Vec<proto::SwarmInfo>> {
        self.db.list_swarms()
    }

    pub fn swarm_create(
        &self,
        name: &str,
        root_dir: &str,
        goal: &str,
        roster: &[proto::SwarmRosterEntry],
        context_files: &[String],
    ) -> Result<u64> {
        let name = name.trim();
        anyhow::ensure!(
            !name.is_empty() && name.len() <= 40,
            "swarm name {name:?} must be 1–40 chars"
        );
        let root = Path::new(root_dir);
        if !root.is_dir() {
            bail!("swarm root_dir does not exist or is not a directory: {root_dir}");
        }
        let (info, agents) = self.db.swarm_create(name, root_dir, goal, roster, 0)?;
        let swarm_id = info.id;
        let scaffold = (|| -> Result<proto::SwarmInfo> {
            let exe = crate::exe_path::strip_deleted_exe_suffix(
                &std::env::current_exe().context("resolving daemon exe for rs-* wrappers")?,
            );
            let scope = crate::scope::init_scope(root, info.id, &exe)?;
            let mut info = info;
            if !context_files.is_empty() {
                let ctx_dir = scope.join("context");
                std::fs::create_dir_all(&ctx_dir)
                    .with_context(|| format!("creating {}", ctx_dir.display()))?;
                let mut copied: Vec<String> = Vec::new();
                for f in context_files {
                    let src = Path::new(f);
                    let Some(fname) = src.file_name() else {
                        tracing::warn!("swarm {}: context file has no filename: {f}", info.id);
                        continue;
                    };
                    match std::fs::copy(src, ctx_dir.join(fname)) {
                        Ok(_) => copied.push(format!(
                            ".houston/swarm/{}/context/{}",
                            info.id,
                            fname.to_string_lossy()
                        )),
                        Err(e) => {
                            tracing::warn!("swarm {}: copying context file {f}: {e}", info.id)
                        }
                    }
                }
                if !copied.is_empty() {
                    let listed = copied
                        .iter()
                        .map(|p| format!("- {p}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    info = self.db.swarm_set_goal(
                        info.id,
                        &format!(
                            "{}\n\nContext files (read these first):\n{listed}",
                            info.goal.trim()
                        ),
                    )?;
                }
            }
            let mail_layout = crate::scope::ScopeLayout::from_scope(scope.clone());
            let labels: Vec<String> = agents.iter().map(|a| a.label.clone()).collect();
            mail_layout
                .create_all(&labels)
                .with_context(|| format!("creating mailbox layout under {}", scope.display()))?;
            Ok(info)
        })();
        let info = match scaffold {
            Ok(info) => info,
            Err(e) => {
                tracing::warn!("swarm {name:?}: scaffolding failed; rolling back: {e}");
                let _ = self.db.swarm_remove(swarm_id);
                return Err(e.context(format!("scaffolding swarm {name:?}")));
            }
        };
        self.install_workspace_hooks(&info.root_dir);
        if let Err(e) = self.list_swarms_publishing_registry() {
            tracing::warn!("swarm {name:?}: republishing the scope registry after create: {e}");
        }
        self.swarm_mail_wake.notify_one();
        Ok(info.id)
    }

    pub fn swarm_send(
        self: &Arc<Self>,
        id: u64,
        from: &str,
        to: &str,
        body: &str,
        kind: proto::SwarmMsgKind,
    ) -> Result<proto::SwarmMessage> {
        self.swarm_send_with_wire_id(id, from, to, body, kind, crate::scope::gen_mailbox_id())
    }

    fn swarm_send_with_wire_id(
        self: &Arc<Self>,
        id: u64,
        from: &str,
        to: &str,
        body: &str,
        kind: proto::SwarmMsgKind,
        wire_id: String,
    ) -> Result<proto::SwarmMessage> {
        let body = body.trim();
        anyhow::ensure!(!body.is_empty(), "swarm message body must not be empty");
        let agents = self.db.list_swarm_agents(id)?;
        let labels: Vec<String> = agents.iter().map(|a| a.label.clone()).collect();
        let recipients = crate::scope::resolve_recipients(to, from, &labels)?;

        let info = self.db.get_swarm(id)?;
        let mail = crate::scope::MailMessage {
            id: wire_id,
            from: from.to_string(),
            to: to.to_string(),
            body: body.to_string(),
            kind,
            timestamp_ms: now_ms(),
        };

        let ingest = self.db.swarm_mail_ingest(id, &mail, &recipients)?;
        let msg = ingest.message().clone();
        if let crate::db::SwarmMailIngest::New(m) = &ingest {
            self.broadcast_control(&proto::ServerMsg::SwarmMessage { message: m.clone() });
        }

        let from_session = agents
            .iter()
            .find(|a| a.label == from)
            .and_then(|a| a.session);
        for recipient in &recipients {
            self.mail_deliver_one(id, &info.root_dir, from_session, recipient, &agents, &mail);
        }

        Ok(msg)
    }

    fn mail_deliver_one(
        self: &Arc<Self>,
        swarm: u64,
        workspace: &str,
        from_session: Option<u32>,
        recipient: &str,
        agents: &[proto::SwarmAgentInfo],
        mail: &crate::scope::MailMessage,
    ) {
        let live_session = agents
            .iter()
            .find(|a| a.label == recipient)
            .and_then(|a| a.session);
        let summary = format!("Mail from {}", mail.from);
        let (to_session, reason) = match live_session {
            Some(s) => (s, None),
            None => (
                0,
                Some(format!(
                    "parent_dead: swarm {swarm} agent {recipient:?} has no live session — mail \
                     from {:?} goes to the operator instead",
                    mail.from
                )),
            ),
        };
        let row = match orchestrate::inbox_row_new(
            to_session,
            workspace,
            from_session,
            None,
            orchestrate::InboxKind::Mail,
            &summary,
            &mail.body,
            Vec::new(),
            false,
            None,
            reason.as_deref(),
            true,
        ) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("swarm {swarm}: composing the mail row for {recipient:?}: {e}");
                return;
            }
        };
        match self.db.inbox_insert(&row, now_ms()) {
            Ok(id) => {
                self.broadcast_inbox_row(id);
                self.inbox_notify(to_session, false);
            }
            Err(e) => tracing::warn!("swarm {swarm}: writing the mail row for {recipient:?}: {e}"),
        }
    }

    pub fn swarm_remove(&self, id: u64) -> Result<()> {
        self.db.swarm_remove(id)?;
        if let Err(e) = self.list_swarms_publishing_registry() {
            tracing::warn!("swarm {id}: republishing the scope registry after remove: {e}");
        }
        Ok(())
    }

    fn swarm_session_finished(
        self: &Arc<Self>,
        session: u32,
        state: proto::SessionState,
        exit_code: Option<i32>,
    ) {
        let Ok(Some(a)) = self.db.swarm_agent_by_session(session) else {
            return;
        };
        if !self
            .swarm_finished_sessions
            .lock()
            .expect("swarm_finished_sessions lock")
            .insert(session)
        {
            return;
        }
        let target = match (state, exit_code) {
            (proto::SessionState::Killed, _) => proto::SwarmAgentStatus::Done,
            (_, Some(0)) => proto::SwarmAgentStatus::Done,
            _ => proto::SwarmAgentStatus::Error,
        };
        let terminal_ms = now_ms();
        self.swarm_terminal_since
            .lock()
            .expect("swarm_terminal_since lock")
            .insert(a.id, terminal_ms);
        if let Err(e) = self.db.swarm_agent_touch_activity(a.id, terminal_ms) {
            tracing::warn!(
                "persisting terminal timestamp for swarm agent {}: {e}",
                a.id
            );
        }
        match self.db.swarm_agent_set_status(a.id, target) {
            Ok(agent) => self.broadcast_control(&proto::ServerMsg::SwarmAgent {
                agent: self.swarm_overlay(agent),
            }),
            Err(e) => tracing::warn!("finishing swarm agent {}: {e}", a.id),
        }
    }

    fn swarm_overlay(&self, mut a: proto::SwarmAgentInfo) -> proto::SwarmAgentInfo {
        if let Some((text, _)) = self
            .swarm_activity
            .lock()
            .expect("swarm_activity lock")
            .get(&a.id)
        {
            a.activity = Some(text.clone());
        }
        a
    }

    fn swarm_activity_tick(&self, session: u32, agent_id: u64, chunk: &[u8]) {
        let now = now_ms();
        {
            let map = self.swarm_activity.lock().expect("swarm_activity lock");
            if map
                .get(&agent_id)
                .is_some_and(|(_, at)| now.saturating_sub(*at) < 1000)
            {
                return;
            }
        }
        let Some(text) = Self::extract_activity(chunk) else {
            return;
        };
        {
            let mut map = self.swarm_activity.lock().expect("swarm_activity lock");
            if map.get(&agent_id).is_some_and(|(prev, _)| *prev == text) {
                return;
            }
            map.insert(agent_id, (text, now));
        }
        if let Err(e) = self.db.swarm_agent_touch_activity(agent_id, now) {
            tracing::warn!("persisting activity timestamp for swarm agent {agent_id}: {e}");
        }
        let promoted = match self.db.swarm_agent(agent_id) {
            Ok(a) if a.status == proto::SwarmAgentStatus::Spawning => self
                .db
                .swarm_agent_set_status(agent_id, proto::SwarmAgentStatus::Running)
                .ok(),
            Ok(a) => Some(a),
            Err(e) => {
                tracing::warn!("swarm activity for session {session}: {e}");
                None
            }
        };
        if let Some(agent) = promoted {
            self.broadcast_control(&proto::ServerMsg::SwarmAgent {
                agent: self.swarm_overlay(agent),
            });
        }
    }

    fn extract_activity(chunk: &[u8]) -> Option<String> {
        let tail = if chunk.len() > 8192 {
            &chunk[chunk.len() - 8192..]
        } else {
            chunk
        };
        let text = crate::agents::strip_ansi(&String::from_utf8_lossy(tail));
        for line in text.lines().rev().take(40) {
            let t = line.trim();
            if t.is_empty() || t.len() < 3 {
                continue;
            }
            if t == ">" || t == "%" || t == "#" || t.starts_with("$ ") {
                continue;
            }
            if t.chars().all(|c| !c.is_alphanumeric()) {
                continue;
            }
            if t.starts_with("--- HoustonSwarm Inbox")
                || t.starts_with("--- End Inbox")
                || t == "No messages"
                || t.starts_with("Sent to ")
            {
                continue;
            }
            let mut out = t.to_string();
            if out.len() > 90 {
                let mut cut = 89;
                while !out.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.truncate(cut);
                out.push('…');
            }
            return Some(out);
        }
        None
    }

    fn swarm_wake_write(self: &Arc<Self>, session_id: u32, text: &str) -> Result<()> {
        self.swarm_wake_enqueue(session_id, WakeItem::Text(text.to_string()))
    }

    fn swarm_wake_enqueue(self: &Arc<Self>, session_id: u32, item: WakeItem) -> Result<()> {
        if self
            .dead
            .lock()
            .expect("dead lock")
            .contains_key(&session_id)
        {
            bail!(
                "session {session_id} is not running (restored after a daemon restart) — respawn it"
            );
        }
        self.get(session_id)?;
        let (start_drainer, generation) = {
            let mut lanes = self.swarm_wake_lanes.lock().expect("wake lanes lock");
            match lanes.get_mut(&session_id) {
                Some(lane) => {
                    if item == WakeItem::Inbox && lane.queue.contains(&WakeItem::Inbox) {
                        return Ok(());
                    }
                    if lane.queue.len() >= SWARM_WAKE_LANE_MAX {
                        let full = format!(
                            "session {session_id} already has {} nudges queued, the limit is \
                             {SWARM_WAKE_LANE_MAX} — it has not read the ones it has yet, so \
                             this one was refused rather than added to a backlog",
                            lane.queue.len()
                        );
                        drop(lanes);
                        self.note_to_operator(session_id, "lane_full", &full);
                        bail!("{full}");
                    }
                    lane.queue.push_back(item);
                    (false, lane.generation)
                }
                None => {
                    let generation = self.swarm_wake_generation.fetch_add(1, Ordering::Relaxed);
                    lanes.insert(
                        session_id,
                        WakeLane {
                            generation,
                            queue: VecDeque::from([item]),
                        },
                    );
                    (true, generation)
                }
            }
        };
        if !start_drainer {
            return Ok(());
        }
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name(format!("swarm-wake-{session_id}"))
            .spawn(move || this.swarm_wake_drain(session_id, generation))
            .with_context(|| format!("spawning the wake lane for session {session_id}"))?;
        Ok(())
    }

    fn swarm_wake_drain(self: &Arc<Self>, session_id: u32, generation: u64) {
        loop {
            let next = {
                let mut lanes = self.swarm_wake_lanes.lock().expect("wake lanes lock");
                take_wake_item(&mut lanes, session_id, generation)
            };
            match next {
                Some(WakeItem::Text(text)) => self.paste_text(session_id, &text),
                Some(WakeItem::Inbox) => self.paste_inbox(session_id),
                None => {
                    self.delegation_wake.notify_one();
                    return;
                }
            }
        }
    }

    fn paste_text(&self, session_id: u32, text: &str) {
        let payload = bracketed_paste(text);
        if let Err(e) = self.write_stdin(session_id, &payload) {
            tracing::warn!("swarm wake: pasting nudge into session {session_id}: {e}");
            return;
        }
        std::thread::sleep(SWARM_WAKE_SETTLE);
        if let Err(e) = self.write_stdin(session_id, b"\r") {
            tracing::warn!("swarm wake: submitting nudge for session {session_id}: {e}");
        }
    }
}

struct WakeLane {
    generation: u64,
    queue: VecDeque<WakeItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WakeItem {
    Text(String),
    Inbox,
}

fn take_wake_item(
    lanes: &mut HashMap<u32, WakeLane>,
    session_id: u32,
    generation: u64,
) -> Option<WakeItem> {
    let item = match lanes.get_mut(&session_id) {
        Some(lane) if lane.generation == generation => lane.queue.pop_front(),
        _ => return None,
    };
    if item.is_none()
        && lanes
            .get(&session_id)
            .is_some_and(|lane| lane.generation == generation)
    {
        lanes.remove(&session_id);
    }
    item
}

#[cfg(test)]
mod wake_lane_tests {
    use super::*;

    #[test]
    fn stale_drainer_cannot_remove_a_replacement_lane() {
        let mut lanes = HashMap::from([(
            7,
            WakeLane {
                generation: 11,
                queue: VecDeque::from([WakeItem::Text("first".into())]),
            },
        )]);

        assert_eq!(
            take_wake_item(&mut lanes, 7, 11),
            Some(WakeItem::Text("first".into()))
        );
        assert!(lanes.remove(&7).is_some());
        lanes.insert(
            7,
            WakeLane {
                generation: 12,
                queue: VecDeque::from([WakeItem::Inbox]),
            },
        );

        assert_eq!(take_wake_item(&mut lanes, 7, 11), None);
        assert_eq!(lanes.get(&7).map(|lane| lane.generation), Some(12));
        assert_eq!(take_wake_item(&mut lanes, 7, 12), Some(WakeItem::Inbox));
    }
}

fn bracketed_paste(text: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(text.len() + 12);
    payload.extend_from_slice(b"\x1b[200~");
    payload.extend_from_slice(text.as_bytes());
    payload.extend_from_slice(b"\x1b[201~");
    payload
}

struct InboxWaitGuard {
    daemon: Arc<Daemon>,
    session: u32,
    notify: Arc<tokio::sync::Notify>,
}

impl Drop for InboxWaitGuard {
    fn drop(&mut self) {
        self.daemon
            .inbox_waiting
            .lock()
            .expect("inbox waiting lock")
            .remove(&self.session);
        self.daemon
            .inbox_wake
            .lock()
            .expect("inbox wake lock")
            .remove(&self.session);
    }
}

impl Daemon {
    pub fn orchestration_state(&self) -> proto::ServerMsg {
        proto::ServerMsg::OrchestrationState {
            enabled: self.orchestration_enabled(),
            caps: proto::OrchestrationCaps {
                max_live_children: self.orchestration_max_live_children(),
                max_spawn_depth: self.orchestration_max_spawn_depth(),
            },
            acp_agents: crate::acp::KNOWN_ACP_AGENTS
                .iter()
                .map(|a| proto::AcpAgentInfo {
                    slug: a.slug.to_string(),
                    display_name: a.display_name.to_string(),
                    command: a.argv.join(" "),
                    agent: crate::acp::agent_kind_for(a),
                })
                .collect(),
        }
    }

    pub fn orchestration_enabled(&self) -> bool {
        matches!(
            self.db.get_setting(orchestrate::ENABLED_KEY),
            Ok(Some(v)) if v == "1"
        )
    }

    pub fn orchestration_set(self: &Arc<Self>, enabled: bool) -> Result<proto::ServerMsg> {
        self.db
            .set_setting(orchestrate::ENABLED_KEY, if enabled { "1" } else { "0" })?;
        tracing::info!(
            "agent spawning {}",
            if enabled { "ENABLED" } else { "disabled" }
        );
        if enabled {
            match crate::agent_hooks::ConfigHome::from_env() {
                Ok(home) => orchestrate::seed_skill_everywhere(&home),
                Err(e) => tracing::warn!("seeding the hs-pane skill stub: {e:#}"),
            }
        }
        self.mcp_notify.tools_changed_everywhere();
        Ok(self.orchestration_state())
    }

    pub(crate) fn live_children_of(&self, parent: u32) -> Vec<u32> {
        let sessions = self.sessions.lock().expect("sessions lock");
        let mut kids: Vec<u32> = sessions
            .values()
            .filter(|s| {
                s.info.spawned_by == Some(parent) && s.state.lock().expect("state lock").is_live()
            })
            .map(|s| s.info.id)
            .collect();
        kids.sort_unstable();
        kids
    }

    pub(crate) fn descendants_of(&self, root: u32) -> Vec<u32> {
        let sessions = self.sessions.lock().expect("sessions lock");
        let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
        for s in sessions.values() {
            if !s.state.lock().expect("state lock").is_live() {
                continue;
            }
            if let Some(p) = s.info.spawned_by {
                children_of.entry(p).or_default().push(s.info.id);
            }
        }
        let mut out = Vec::new();
        let mut queue = vec![root];
        while let Some(id) = queue.pop() {
            for kid in children_of.remove(&id).unwrap_or_default() {
                out.push(kid);
                queue.push(kid);
            }
        }
        out.sort_unstable();
        out
    }

    fn respawn_chain_tip(&self, id: u32) -> Option<u32> {
        let map = self.respawned_as.lock().expect("respawned_as lock");
        let mut cur = *map.get(&id)?;
        for _ in 0..1_000 {
            match map.get(&cur) {
                Some(next) => cur = *next,
                None => return Some(cur),
            }
        }
        Some(cur)
    }

    pub(crate) fn spawn_depth_of(&self, id: u32) -> u32 {
        let mut depth = 0;
        let mut cursor = Some(id);
        while depth <= proto::ORCHESTRATION_CAP_MAX {
            let parent = {
                let live = self.sessions.lock().expect("sessions lock");
                live.get(&cursor.unwrap_or(0))
                    .map(|s| s.info.spawned_by)
                    .or_else(|| {
                        self.dead
                            .lock()
                            .expect("dead lock")
                            .get(&cursor.unwrap_or(0))
                            .map(|i| i.spawned_by)
                    })
            };
            match parent.flatten() {
                Some(p) => {
                    depth += 1;
                    cursor = Some(p);
                }
                None => break,
            }
        }
        depth
    }

    fn assert_orchestration_target(&self, caller: u32, target: u32) -> Result<()> {
        if caller == target {
            bail!("refused: session {target} is not your child (it is you)");
        }
        // The delegation table is the authority record. Live roster membership is
        // intentionally not used here: a temporary child can leave the roster after
        // its result is durable while its parent is still allowed to wait for it.
        let scoped = self.recorded_descendant_of(caller, target)?;
        if !scoped {
            if let Some(latest) = self.respawn_chain_tip(target) {
                bail!("refused: session {target} was respawned as {latest}; use the new id");
            }
            bail!("refused: session {target} is not a session you spawned (transitively)");
        }
        Ok(())
    }

    fn recorded_descendant_of(&self, caller: u32, target: u32) -> Result<bool> {
        let mut cursor = target;
        for _ in 0..=proto::ORCHESTRATION_CAP_MAX {
            let Some(parent) = self.db.delegation_parent_of(cursor)? else {
                return Ok(false);
            };
            if parent == caller {
                return Ok(true);
            }
            if parent == cursor {
                return Ok(false);
            }
            cursor = parent;
        }
        Ok(false)
    }

    fn current_workspace(&self, id: u32) -> Result<String> {
        let sessions = self.sessions.lock().expect("sessions lock");
        let s = sessions
            .get(&id)
            .ok_or_else(|| anyhow!("unknown session id {id} (expected an active session)"))?;
        let ws = s.project_dir.lock().expect("project_dir lock").clone();
        Ok(ws)
    }

    pub fn orchestrate_whoami(&self, caller: u32) -> Result<proto::SessionInfo> {
        let sessions = self.sessions.lock().expect("sessions lock");
        sessions
            .get(&caller)
            .map(|s| s.info.clone())
            .ok_or_else(|| anyhow!("unknown session id {caller} (expected an active session)"))
    }

    pub fn orchestrate_whoami_json(&self, caller: u32) -> Result<serde_json::Value> {
        let info = self.orchestrate_whoami(caller)?;
        let registered_workspaces = self
            .workspace_list()?
            .into_iter()
            .map(|workspace| {
                serde_json::json!({
                    "path": workspace.path,
                    "name": workspace.name,
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({
            "session_id": info.id,
            "title": info.title,
            "codename": info.codename,
            "agent": info.agent,
            "workspace": info.project_dir,
            "cwd": info.cwd,
            "channel": self.channel(),
            "registered_workspaces": registered_workspaces,
        }))
    }

    fn resolve_named_profile(
        &self,
        kind: proto::AgentKind,
        label: &str,
    ) -> Result<ProfileSpawnEnvList> {
        let slug = Self::agent_profile_slug(kind)?;
        let rows = self.db.list_agent_profiles(slug)?;
        match rows.iter().find(|r| r.name == label) {
            Some(row) => Ok((
                vec![(
                    Self::agent_profile_env_var(kind),
                    self.expand_profile_dir(slug, row.config_dir.clone()),
                )],
                Some(row.name.clone()),
            )),
            None => {
                let known: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
                bail!(
                    "no {slug} agent profile named {label:?} (known profiles: [{}])",
                    if known.is_empty() {
                        "none saved".to_string()
                    } else {
                        known.join(", ")
                    }
                )
            }
        }
    }

    fn resolve_inherited_profile(
        &self,
        caller: u32,
        kind: proto::AgentKind,
        label: &str,
    ) -> Result<ProfileSpawnEnvList> {
        let slug = Self::agent_profile_slug(kind)?;
        let rows = self.db.list_agent_profiles(slug)?;
        Ok(match rows.iter().find(|r| r.name == label) {
            Some(row) => (
                vec![(
                    Self::agent_profile_env_var(kind),
                    self.expand_profile_dir(slug, row.config_dir.clone()),
                )],
                Some(row.name.clone()),
            ),
            None => {
                tracing::info!(
                    "child of pane {caller} not inheriting profile {label:?}: \
                     no {slug} profile by that name — spawning on the default account"
                );
                (Vec::new(), None)
            }
        })
    }

    fn inherit_profile_from_parent_process(
        &self,
        caller: u32,
        kind: proto::AgentKind,
    ) -> ProfileSpawnEnvList {
        let Ok(slug) = Self::agent_profile_slug(kind) else {
            return (Vec::new(), None);
        };
        let pid = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions.get(&caller).and_then(|s| s.pid)
        };
        let Some(pid) = pid else {
            return (Vec::new(), None);
        };
        let var = Self::agent_profile_env_var(kind);
        let Some(dir) = child_env_var(pid, &var) else {
            return (Vec::new(), None);
        };
        let label = self
            .db
            .list_agent_profiles(slug)
            .ok()
            .and_then(|rows| {
                rows.into_iter()
                    .find(|r| {
                        self.expand_profile_dir(slug, r.config_dir.clone())
                            .trim_end_matches('/')
                            == dir.trim_end_matches('/')
                    })
                    .map(|r| r.name)
            })
            .or_else(|| {
                std::path::Path::new(dir.trim_end_matches('/'))
                    .file_name()
                    .map(|b| b.to_string_lossy().into_owned())
            });
        tracing::info!(
            "child of pane {caller} inheriting {var}={dir} from the parent's own process tree"
        );
        (vec![(var, dir)], label)
    }

    fn resolve_spawn_workspace(&self, caller: u32, requested: Option<&str>) -> Result<PathBuf> {
        let current = PathBuf::from(self.current_workspace(caller)?).canonicalize()?;
        let Some(requested) = requested.map(str::trim).filter(|path| !path.is_empty()) else {
            return Ok(current);
        };
        let requested_path = PathBuf::from(requested);
        let requested_canonical = requested_path
            .canonicalize()
            .with_context(|| format!("resolving registered target workspace {requested:?}"))?;
        if !requested_canonical.is_dir() {
            bail!("target_workspace is not a directory: {requested}");
        }
        let registered = self.workspace_list()?;
        if registered.iter().any(|workspace| {
            PathBuf::from(&workspace.path)
                .canonicalize()
                .is_ok_and(|path| path == requested_canonical)
        }) {
            return Ok(requested_canonical);
        }
        let known = registered
            .iter()
            .map(|workspace| workspace.path.as_str())
            .collect::<Vec<_>>();
        bail!(
            "refused: target_workspace {requested:?} is not registered; registered targets: {}",
            if known.is_empty() {
                "none".to_string()
            } else {
                known.join(", ")
            }
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn orchestrate_spawn(
        self: &Arc<Self>,
        caller: u32,
        kind: proto::AgentKind,
        model: Option<String>,
        cwd: Option<String>,
        brief: orchestrate::Brief,
        auto_approve: Option<bool>,
        profile: Option<String>,
        role: Option<String>,
    ) -> Result<proto::SessionInfo> {
        self.orchestrate_spawn_with_options(
            caller,
            kind,
            model,
            cwd,
            brief,
            auto_approve,
            profile,
            role,
            None,
            false,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn orchestrate_spawn_with_options(
        self: &Arc<Self>,
        caller: u32,
        kind: proto::AgentKind,
        model: Option<String>,
        cwd: Option<String>,
        brief: orchestrate::Brief,
        auto_approve: Option<bool>,
        profile: Option<String>,
        role: Option<String>,
        target_workspace: Option<String>,
        reusable: bool,
        effort: Option<proto::ChatEffort>,
    ) -> Result<proto::SessionInfo> {
        // Cleanup and registration share the parent/child live roster. Keep the parent alive
        // through the whole spawn so a completed temporary parent cannot disappear between the
        // cap check and its durable delegation row.
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        if kind == proto::AgentKind::Custom {
            bail!(
                "spawn refused: kind `custom` cannot be spawned as a child — a custom command \
                 has no hooks, so Houston could never tell its parent when it finished; pick \
                 one of claude, codex, opencode, cursor, grok, antigravity"
            );
        }
        let role = match role.as_deref() {
            Some(r) => {
                Some(orchestrate::validate_role(r).map_err(|e| anyhow!("spawn refused: {e}"))?)
            }
            None => None,
        };
        let prompt = brief
            .compose(1)
            .map_err(|e| anyhow!("spawn refused: {e}"))?;
        let project_dir = self.resolve_spawn_workspace(caller, target_workspace.as_deref())?;
        let ws = project_dir.display().to_string();
        if !self.orchestration_enabled() {
            bail!(
                "spawn refused: agent spawning is switched off (asked from workspace \"{ws}\") - \
                 the operator turns it on in Settings → Orchestration → Enable orchestration; \
                 it is off by default because agents spawning agents spends money \
                 and runs code unattended - a spawned pane starts in its CLI's auto \
                 mode, so it does not stop for routine approvals"
            );
        }
        match crate::agent_hooks::ConfigHome::from_env() {
            Ok(home) => orchestrate::seed_skill_everywhere(&home),
            Err(e) => tracing::warn!("seeding the hs-pane skill stub: {e:#}"),
        }
        let cwd = match cwd {
            Some(d) => {
                let d = PathBuf::from(d);
                if !d.is_dir() {
                    bail!("cwd does not exist or is not a directory: {}", d.display());
                }
                let d = d
                    .canonicalize()
                    .with_context(|| format!("resolving {}", d.display()))?;
                let root = project_dir
                    .canonicalize()
                    .with_context(|| format!("resolving {}", project_dir.display()))?;
                if !d.starts_with(&root) {
                    bail!(
                        "refused: cwd {} is outside the target workspace ({})",
                        d.display(),
                        root.display()
                    );
                }
                d
            }
            None => project_dir.clone(),
        };
        if let Some(role) = &role {
            self.assert_role_free(caller, role)?;
        }
        let direct = self.live_children_of(caller).len() as u32;
        if let orchestrate::SpawnVerdict::Refused(msg) = orchestrate::children_cap_verdict(
            caller,
            direct,
            self.orchestration_max_live_children(),
        ) {
            bail!("{msg}");
        }
        if let orchestrate::SpawnVerdict::Refused(msg) = orchestrate::depth_cap_verdict(
            self.spawn_depth_of(caller) + 1,
            self.orchestration_max_spawn_depth(),
        ) {
            bail!("{msg}");
        }

        let (prompts_dir, _bin_dir) = init_orchestration_scope(&project_dir)?;

        if auto_approve.is_none() {
            if let orchestrate::SpawnVerdict::Refused(msg) =
                orchestrate::auto_mode_model_verdict(kind, model.as_deref())
            {
                bail!("{msg}");
            }
        }
        let requested_mode = match auto_approve {
            Some(true) => crate::launch::ApprovalMode::Bypass,
            Some(false) => crate::launch::ApprovalMode::Default,
            None => crate::launch::ApprovalMode::Auto,
        };
        if let orchestrate::SpawnVerdict::Refused(msg) =
            orchestrate::approval_ceiling_verdict(self.approval_mode_of(caller), requested_mode)
        {
            bail!("{msg}");
        }
        let mode_args = requested_mode.args(kind).unwrap_or_default();
        let (mut extra_args, prompt_file) = crate::launch::launch_args(
            kind,
            false,
            false,
            model.as_deref(),
            &prompt,
            Some(&prompts_dir),
            "spawned",
        )?;
        extra_args.extend(mode_args);
        if let Some(effort) = effort {
            extra_args.extend(crate::launch::effort_args(kind, effort)?);
        }
        if let Some((path, contents)) = prompt_file {
            std::fs::write(&path, contents)
                .with_context(|| format!("writing prompt file {}", path.display()))?;
        }
        let inherited = if profile.is_none() {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions
                .get(&caller)
                .and_then(|s| s.info.profile_label.clone())
        } else {
            None
        };
        let (extra_env, profile_label) = match (&profile, &inherited) {
            (None, None) => self.inherit_profile_from_parent_process(caller, kind),
            (None, Some(label)) => self.resolve_inherited_profile(caller, kind, label)?,
            (Some(label), _) => self
                .resolve_named_profile(kind, label)
                .context("spawn refused")?,
        };
        let sid = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (title, title_source, codename) = match &role {
            Some(role) => {
                let codename = self.next_codename();
                (role.clone(), TitleSource::Role, codename)
            }
            None => {
                let codename = self.next_codename();
                (codename.clone(), TitleSource::Codename, codename)
            }
        };
        let spawned = self.spawn_session(SpawnParams {
            id: sid,
            agent: kind,
            project_dir,
            cwd,
            custom_cmd: None,
            cols: 120,
            rows: 32,
            title,
            title_source,
            codename,
            shell_integration: false,
            hidden: false,
            shell_override: None,
            swarm_agent: None,
            spawned_by: Some(caller),
            extra_args,
            extra_env,
            wrap: None,
            acp: None,
            profile_label,
            tags: Vec::new(),
        });
        let info = spawned?;
        self.record_approval_mode(sid, requested_mode);
        if let Err(parent_error) = self.get(caller) {
            let rollback = self.rollback_spawned_child(sid);
            return match rollback {
                Ok(()) => Err(parent_error).context(format!(
                    "parent pane {caller} disappeared before the delegation for child {sid} \
                     could be recorded; the child was rolled back"
                )),
                Err(rollback_error) => Err(anyhow!(
                    "parent pane {caller} disappeared before the delegation for child {sid} \
                     could be recorded: {parent_error}; rolling back the spawned child also \
                     failed: {rollback_error}"
                )),
            };
        }
        if let Err(persist_error) = self.db.delegation_create_with_lifecycle(
            caller,
            sid,
            role.as_deref(),
            &prompt,
            reusable,
            now_ms(),
        ) {
            let rollback = self.rollback_spawned_child(sid);
            return match rollback {
                Ok(()) => Err(persist_error).context(format!(
                    "opening the delegation record for child {sid} of {caller} failed; the child was rolled back"
                )),
                Err(rollback_error) => Err(anyhow!(
                    "opening the delegation record for child {sid} of {caller} failed: {persist_error}; rolling back the spawned child also failed: {rollback_error}"
                )),
            };
        }
        self.delegation_wake.notify_one();
        self.broadcast_delegation(sid);
        self.broadcast_live_children(caller);
        Ok(info)
    }

    fn rollback_spawned_child(&self, child: u32) -> Result<()> {
        let first_close = self.db.mark_closed(child);
        let close_result = self.close(child);
        let final_close = self.db.mark_closed(child);
        if let Err(e) = close_result {
            return Err(e).context(format!("closing rolled-back child {child}"));
        }
        if let Err(e) = final_close {
            return Err(e).context(format!(
                "persisting the closed state for rolled-back child {child}"
            ));
        }
        if let Err(e) = first_close {
            tracing::warn!(
                "the first durable close for rolled-back child {child} failed, but the retry \
                 succeeded: {e}"
            );
        }
        Ok(())
    }

    pub fn orchestrate_list(&self, caller: u32) -> Result<Vec<serde_json::Value>> {
        let ids = self.descendants_of(caller);
        let infos: Vec<proto::SessionInfo> = {
            let sessions = self.sessions.lock().expect("sessions lock");
            ids.into_iter()
                .filter_map(|id| sessions.get(&id))
                .map(|s| {
                    let mut info = s.info.clone();
                    info.status = *s.status.lock().expect("status lock");
                    info.state = *s.state.lock().expect("state lock");
                    info
                })
                .collect()
        };
        Ok(infos
            .into_iter()
            .map(|info| {
                let mut v = serde_json::to_value(&info).unwrap_or(serde_json::Value::Null);
                if let (Some(obj), Some(row)) = (v.as_object_mut(), self.delegation_of(info.id)) {
                    let parent = row.parent_session;
                    let pending = self.pending_handback(parent, info.id);
                    let owed = self.inbox_owed(parent, info.id);
                    let capability = self.capability_note_of(info.id);
                    let hold = (owed.owed > 0)
                        .then(|| self.paste_hold_reason(parent))
                        .flatten();
                    let delegation = orchestrate::delegation_info(
                        row,
                        self.turn_end_source_of(info.id),
                        pending,
                        owed,
                        capability,
                        hold,
                    );
                    obj.insert(
                        "delegation".into(),
                        serde_json::to_value(&delegation).unwrap_or(serde_json::Value::Null),
                    );
                }
                v
            })
            .collect())
    }

    pub fn orchestrate_prompt(
        self: &Arc<Self>,
        caller: u32,
        target: u32,
        text: &str,
    ) -> Result<(&'static str, Option<proto::AgentStatus>)> {
        let text = text.trim();
        anyhow::ensure!(!text.is_empty(), "prompt text must not be empty");
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        if let Some(row) = self.delegation_of(target) {
            if row.parent_session == caller && self.respawn_chain_tip(target).is_none() {
                if let Some(state) = orchestrate::DelegationState::parse(&row.state) {
                    if let Some(refusal) = orchestrate::prompt_refusal(target, state) {
                        bail!("{refusal}");
                    }
                }
            }
        }
        self.assert_orchestration_target(caller, target)?;
        self.cancel_temporary_cleanup_locked(target);
        let source = {
            let s = self.get(target)?;
            let cur = *s.status.lock().expect("status lock");
            if cur == Some(proto::AgentStatus::NeedsInput) {
                bail!(
                    "refused: pane {target} needs input (NeedsInput) — inspect it with \
                     `hs-pane read {target}` and answer what it asked before sending a \
                     new prompt"
                );
            }
            crate::orchestrate::status_source(s.status_kind())
        };
        let source_label = source.label();
        let framed = match self.round_a_re_prompt_opens(target) {
            Some(round) => format!("{}\n\n{text}", orchestrate::request_header(round)),
            None => text.to_string(),
        };
        self.swarm_wake_write(target, &framed)?;
        if source == orchestrate::StatusSource::ProcessOnly {
            match self.db.delegation_bump_round(target, now_ms()) {
                Ok(Some(round)) => {
                    self.turn_start_round
                        .lock()
                        .expect("turn start round lock")
                        .insert(target, round);
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("opening a new round for child {target}: {e}"),
            }
        } else {
            self.prompt_awaiting_hook
                .lock()
                .expect("prompt awaiting hook lock")
                .insert(target);
        }
        if let Err(e) = self
            .db
            .delegation_set_no_handback(target, false, 0, now_ms())
        {
            tracing::warn!("clearing child {target}'s no_handback latch after a prompt: {e}");
        } else {
            self.broadcast_delegation(target);
        }
        Ok((source_label, self.session_status(target)?))
    }

    pub fn session_status(&self, id: u32) -> Result<Option<proto::AgentStatus>> {
        let s = self.get(id)?;
        let status = *s.status.lock().expect("status lock");
        Ok(status)
    }

    pub fn parent_of(&self, id: u32) -> Option<u32> {
        let sessions = self.sessions.lock().expect("sessions lock");
        sessions.get(&id).and_then(|s| s.info.spawned_by)
    }

    pub(crate) fn spawnable_by(&self, id: u32) -> bool {
        if !self.orchestration_enabled() {
            return false;
        }
        let max = self.orchestration_max_live_children();
        let free = max.saturating_sub(self.live_children_of(id).len() as u32);
        if free == 0 {
            return false;
        }
        self.spawn_depth_of(id) < self.orchestration_max_spawn_depth()
    }

    pub(crate) fn tool_role_of(&self, id: u32) -> orchestrate::ToolRole {
        orchestrate::tool_role(
            self.parent_of(id).is_some(),
            self.spawnable_by(id),
            !self.live_children_of(id).is_empty(),
        )
    }

    pub fn agent_kind_of(&self, id: u32) -> Option<proto::AgentKind> {
        let sessions = self.sessions.lock().expect("sessions lock");
        sessions.get(&id).map(|s| s.info.agent)
    }

    fn enter_inbox_wait(self: &Arc<Self>, caller: u32) -> Result<InboxWaitGuard> {
        let mut waiting = self.inbox_waiting.lock().expect("inbox waiting lock");
        if !waiting.insert(caller) {
            bail!(
                "refused: pane {caller} is already inside a pane_wait (one wait per pane) — end \
                 or time out that wait before starting another; a second wait cannot share its \
                 reservation"
            );
        }
        drop(waiting);
        let notify = self
            .inbox_wake
            .lock()
            .expect("inbox wake lock")
            .entry(caller)
            .or_insert_with(|| Arc::new(tokio::sync::Notify::new()))
            .clone();
        Ok(InboxWaitGuard {
            daemon: Arc::clone(self),
            session: caller,
            notify,
        })
    }

    pub async fn orchestrate_wait(
        self: &Arc<Self>,
        caller: u32,
        child: Option<u32>,
        kind: Option<orchestrate::InboxKind>,
        timeout_ms: u64,
        stall_guard: bool,
    ) -> Result<orchestrate::InboxWaitOutcome> {
        if stall_guard && child.is_none() {
            bail!(
                "wait refused: stall_guard requires session — it watches one child's own status \
                 for movement, which a whole-inbox wait has no single status to read"
            );
        }
        if let Some(target) = child {
            self.assert_orchestration_target(caller, target)?;
        }
        let guard = self.enter_inbox_wait(caller)?;
        let kind_str = kind.map(orchestrate::InboxKind::as_str);
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(timeout_ms);
        let stall_window = std::time::Duration::from_millis(orchestrate::PROMPT_STALL_MS);
        let baseline_status = child.and_then(|c| self.session_status(c).ok().flatten());
        let mut startup_stall_deadline = stall_guard.then_some(started + stall_window);

        let try_reserve = |this: &Arc<Self>| -> Result<Option<orchestrate::InboxWaitOutcome>> {
            let now = now_ms();
            let Some((delivery_id, rows)) = this.db.inbox_reserve_matching(
                caller,
                now,
                orchestrate::INBOX_BATCH_MAX_ROWS,
                orchestrate::INBOX_BATCH_MAX_BYTES,
                child,
                kind_str,
            )?
            else {
                return Ok(None);
            };
            this.db.inbox_mark_delivered(&delivery_id, "wait", now)?;
            let mut rows = rows;
            for row in &mut rows {
                row.delivered_at = Some(now);
                row.delivered_via = Some("wait".to_string());
                this.broadcast_inbox_row(row.id);
            }
            let has_more = this.db.inbox_count_matching(caller, now, child, kind_str)? > 0;
            Ok(Some(orchestrate::InboxWaitOutcome::Delivered {
                rows,
                delivery_id,
                has_more,
                waited_ms: started.elapsed().as_millis() as u64,
            }))
        };
        let timed_out = |this: &Arc<Self>| orchestrate::InboxWaitOutcome::TimedOut {
            waited_ms: started.elapsed().as_millis() as u64,
            status: child.and_then(|c| this.session_status(c).ok().flatten()),
            status_source: child
                .and_then(|c| this.agent_kind_of(c))
                .map(|k| orchestrate::status_source(k).label()),
        };
        loop {
            if let Some(outcome) = try_reserve(self)? {
                return Ok(outcome);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(timed_out(self));
            }
            if let Some(stall_deadline) = startup_stall_deadline {
                let cur = child.and_then(|c| self.session_status(c).ok().flatten());
                if cur != baseline_status {
                    startup_stall_deadline = None;
                } else if std::time::Instant::now() >= stall_deadline {
                    return Ok(orchestrate::InboxWaitOutcome::Stalled {
                        session: child.expect("stall_guard requires child, checked above"),
                        waited_ms: started.elapsed().as_millis() as u64,
                    });
                }
            }
            let notified = guard.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(outcome) = try_reserve(self)? {
                return Ok(outcome);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Ok(timed_out(self));
            }
            let wait_until = startup_stall_deadline
                .map_or(deadline, |stall_deadline| deadline.min(stall_deadline));
            let _ = tokio::time::timeout(wait_until.saturating_duration_since(now), notified).await;
        }
    }

    pub fn orchestrate_read(
        &self,
        caller: u32,
        target: u32,
        lines: usize,
        screen: bool,
    ) -> Result<Vec<String>> {
        self.assert_orchestration_target(caller, target)?;
        let lines = lines.max(1);
        let s = self.get(target)?;
        let text = if screen {
            self.session_screen(&s, lines)
        } else {
            let sb = s.scrollback.lock().expect("scrollback lock");
            sb.tail_lines(lines)
        };
        Ok(orchestrate::cap_read_tail(text, lines))
    }

    #[doc(hidden)]
    pub fn session_screen_for_test(&self, id: u32) -> Vec<String> {
        match self.get(id) {
            Ok(s) => self.session_screen(&s, orchestrate::UNSUBMITTED_TAIL_LINES),
            Err(_) => Vec::new(),
        }
    }

    fn session_screen(&self, s: &Arc<Session>, lines: usize) -> Vec<String> {
        match s.vt().as_mut() {
            Some(emulator) => emulator.screen_text(lines),
            None => Vec::new(),
        }
    }

    pub fn orchestrate_send_keys(&self, caller: u32, target: u32, keys: &[String]) -> Result<()> {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.assert_orchestration_target(caller, target)?;
        self.cancel_temporary_cleanup_locked(target);
        let bytes = orchestrate::keys_to_bytes(keys).map_err(|e| anyhow!("{e}"))?;
        self.write_stdin(target, &bytes)?;
        if let Err(e) = self
            .db
            .delegation_set_no_handback(target, false, 0, now_ms())
        {
            tracing::warn!("clearing child {target}'s no_handback latch after send_keys: {e}");
        } else {
            self.broadcast_delegation(target);
        }
        Ok(())
    }

    pub fn orchestrate_get(&self, caller: u32, target: u32) -> Result<orchestrate::PaneDetail> {
        if caller != target {
            self.assert_orchestration_target(caller, target)?;
        }
        let s = self.get(target)?;
        let mut info = s.info.clone();
        info.status = *s.status.lock().expect("status lock");
        info.state = *s.state.lock().expect("state lock");
        info.title = s.title.lock().expect("title lock").clone();
        let (live_children, children_waiting) = self.child_counts_of(target);
        info.children_waiting = children_waiting;
        Ok(orchestrate::PaneDetail {
            live_children,
            depth: self.spawn_depth_of(target),
            turn_end_source: orchestrate::turn_end_source(s.status_kind(), s.acp.is_some()).label(),
            delegation: self.delegation_of(target).map(|row| {
                let pending = self.pending_handback(row.parent_session, target);
                orchestrate::DelegationView::from_row(row, pending)
            }),
            info,
        })
    }

    pub fn orchestrate_kill(
        self: &Arc<Self>,
        caller: u32,
        target: u32,
        confirm_children: bool,
    ) -> Result<()> {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.assert_orchestration_target(caller, target)?;
        self.child_guard(target, confirm_children)?;
        self.close(target)
    }

    fn cancel_delegation(&self, child: u32) {
        match self.db.delegation_for_child(child) {
            Ok(Some(row))
                if !orchestrate::DelegationState::parse(&row.state)
                    .is_some_and(|s| s.is_closed()) =>
            {
                if let Err(e) = self.db.delegation_finish(
                    child,
                    orchestrate::DelegationState::Cancelled.as_str(),
                    Some("ended on purpose while its current request was still open"),
                    now_ms(),
                ) {
                    tracing::warn!("cancelling the delegation for child {child}: {e}");
                }
                self.broadcast_delegation(child);
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("reading the delegation record for child {child}: {e}"),
        }
    }

    fn child_guard(&self, id: u32, confirmed: bool) -> Result<()> {
        let kids = self.live_children_of(id);
        if !kids.is_empty() && !confirmed {
            bail!(
                "live_children_confirmation_required: session {id} still has {} live spawned \
                 children ({}) — kill or close them first, or repeat the request with \
                 confirm_children set",
                kids.len(),
                kids.iter()
                    .map(std::string::ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        Ok(())
    }

    fn cancel_temporary_cleanup_locked(&self, child: u32) {
        let Ok(Some(row)) = self.db.delegation_for_child(child) else {
            return;
        };
        if row.cleanup_after.is_none() {
            return;
        }
        if let Err(e) = self.db.delegation_set_cleanup_after(child, None, now_ms()) {
            tracing::warn!("cancelling temporary cleanup for child {child}: {e}");
        }
    }

    fn operator_ended_notice_facts(&self, id: u32) -> Option<(u32, String)> {
        let (parent, codename) = {
            let sessions = self.sessions.lock().expect("sessions lock");
            let s = sessions.get(&id)?;
            let codename = if s.info.codename.is_empty() {
                s.info.title.clone()
            } else {
                s.info.codename.clone()
            };
            (s.info.spawned_by?, codename)
        };
        Some((parent, self.child_label(id, &codename)))
    }

    pub fn session_kill_checked(self: &Arc<Self>, id: u32, confirm_children: bool) -> Result<()> {
        self.child_guard(id, confirm_children)?;
        let notice = self.operator_ended_notice_facts(id);
        self.kill(id)?;
        if let Some((parent, label)) = notice {
            self.queue_operator_ended_notice(id, parent, label);
        }
        Ok(())
    }

    pub fn session_close_checked(self: &Arc<Self>, id: u32, confirm_children: bool) -> Result<()> {
        self.child_guard(id, confirm_children)?;
        let notice = self.operator_ended_notice_facts(id);
        self.close(id)?;
        if let Some((parent, label)) = notice {
            self.queue_operator_ended_notice(id, parent, label);
        }
        Ok(())
    }

    fn resolve_artifacts(&self, child: u32, artifacts: &[String]) -> Result<Vec<String>> {
        if artifacts.is_empty() {
            return Ok(Vec::new());
        }
        orchestrate::artifacts_count_verdict(artifacts.len())
            .map_err(|e| anyhow!("submit refused: {e}"))?;
        let root = PathBuf::from(self.current_workspace(child)?)
            .canonicalize()
            .context("resolving this pane's workspace")?;
        let cwd = {
            let sessions = self.sessions.lock().expect("sessions lock");
            sessions
                .get(&child)
                .map(|s| PathBuf::from(s.info.cwd.clone()))
                .unwrap_or_else(|| root.clone())
        };
        let mut out = Vec::with_capacity(artifacts.len());
        for raw in artifacts {
            orchestrate::artifact_raw_verdict(raw).map_err(|e| anyhow!("submit refused: {e}"))?;
            let trimmed = raw.trim();
            let joined = if Path::new(trimmed).is_absolute() {
                PathBuf::from(trimmed)
            } else {
                cwd.join(trimmed)
            };
            let resolved = joined.canonicalize().map_err(|e| {
                anyhow!(
                    "submit refused: artifact {raw:?} does not exist ({}: {e}) — name a file \
                     you actually wrote, absolute or relative to {}",
                    joined.display(),
                    cwd.display()
                )
            })?;
            orchestrate::artifact_scope_verdict(raw, &resolved, &root)
                .map_err(|e| anyhow!("submit refused: {e}"))?;
            out.push(resolved.display().to_string());
        }
        Ok(out)
    }

    pub fn orchestrate_submit(
        self: &Arc<Self>,
        child: u32,
        submission: orchestrate::Submission,
    ) -> Result<orchestrate::SubmitOutcome> {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        let parent = {
            let s = self.get(child)?;
            s.info.spawned_by.ok_or_else(|| {
                anyhow!("session {child} was not spawned by an agent — nothing to submit to")
            })?
        };
        let artifacts = self.resolve_artifacts(child, &submission.artifacts)?;
        let workspace = self.current_workspace(child)?;
        let body = orchestrate::cap_submit_body(&orchestrate::sanitize_handoff_text(
            submission.body.trim(),
        ));
        let summary = submission
            .summary
            .as_deref()
            .map(|s| orchestrate::sanitize_handoff_text(s.trim()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| orchestrate::submit_summary_fallback(&body));
        let (request_id, reason, note) = self.stamp_submit(child, submission.request_id)?;
        let row = orchestrate::inbox_row_new(
            parent,
            &workspace,
            Some(child),
            request_id,
            orchestrate::InboxKind::Result,
            &summary,
            &body,
            artifacts,
            false,
            None,
            reason,
            reason.is_some(),
        )?;
        let id = self.db.inbox_insert(&row, now_ms()).with_context(|| {
            format!(
                "storing your result failed: {} characters of body and {} of summary, against \
                 the {} / {} caps",
                body.len(),
                summary.len(),
                orchestrate::SUBMIT_BODY_MAX_CHARS,
                orchestrate::SUBMIT_SUMMARY_MAX_CHARS
            )
        })?;
        if let Some(excerpt) = self.session_handoff_excerpt(child) {
            if let Err(e) = self.db.inbox_set_excerpt(id, &excerpt) {
                tracing::warn!("persisting the screen excerpt for child result {id} failed: {e}");
            }
        }
        let pending = self.db.inbox_pending_count(parent).unwrap_or(0);
        if pending > self.inbox_pending_max() {
            let why = format!(
                "backlog: pane {parent} holds {pending} undelivered row(s), over the {} the \
                 inbox keeps per pane; row #{id} (result) goes to you instead",
                self.inbox_pending_max()
            );
            self.readdress_row_to_operator(id, &why);
            self.inbox_notify(0, true);
        } else {
            self.broadcast_inbox_row(id);
            if reason == Some("late") || reason == Some("unstamped") {
                self.inbox_notify(parent, false);
            }
        }
        self.broadcast_delegation(child);
        Ok(orchestrate::SubmitOutcome {
            row_id: id,
            request_id,
            reason,
            note,
        })
    }

    fn stamp_submit(
        &self,
        child: u32,
        named: Option<u32>,
    ) -> Result<(Option<u32>, Option<&'static str>, String)> {
        let Some(row) = self.delegation_of(child) else {
            return Ok((
                None,
                None,
                "delivered to your parent's inbox; it reads it when it next waits or ends a turn"
                    .to_string(),
            ));
        };
        let current = row.round;
        let closed = orchestrate::DelegationState::parse(&row.state).is_some_and(|s| s.is_closed());
        if let Some(named) = named {
            if named > current {
                bail!(
                    "submit refused: request_id {named} has not been asked of you — you are on \
                     request {current}, and rounds count up from 1"
                );
            }
            if named < current || closed {
                return Ok((
                    Some(named),
                    Some("late"),
                    format!(
                        "stored as a late answer to request {named}; you are on request \
                         {current} now. It reaches your parent as its own entry and replaces \
                         nothing."
                    ),
                ));
            }
            return Ok((
                Some(named),
                None,
                format!("delivered to your parent's inbox as the answer to request {named}"),
            ));
        }
        if closed {
            return Ok((
                Some(current),
                Some("late"),
                format!(
                    "stored as a late answer to request {current}, which had already closed. It \
                     reaches your parent as its own entry and replaces nothing."
                ),
            ));
        }
        let started_in = self
            .turn_start_round
            .lock()
            .expect("turn start round lock")
            .get(&child)
            .copied();
        match orchestrate::stamp_unstamped_submit(current, started_in) {
            Some(stamped) => Ok((
                Some(stamped),
                None,
                format!("delivered to your parent's inbox as the answer to request {stamped}"),
            )),
            None => Ok((
                None,
                Some("unstamped"),
                orchestrate::unstamped_submit_note(
                    current,
                    started_in.expect("a differing round was just read"),
                ),
            )),
        }
    }

    fn close_delegations_lost_to_the_restart(&self) {
        let open = match self.db.delegations_open() {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("reading delegations left open by the last run: {e}");
                return;
            }
        };
        if open.is_empty() {
            return;
        }
        tracing::info!(
            "closing {} delegation(s) the daemon restart interrupted",
            open.len()
        );
        for row in open {
            if let Err(e) = self.db.delegation_finish(
                row.child_session,
                orchestrate::DelegationState::Unknown.as_str(),
                Some("the daemon restarted while this delegation was in flight"),
                now_ms(),
            ) {
                tracing::warn!(
                    "closing the interrupted delegation for child {}: {e}",
                    row.child_session
                );
            }
        }
    }

    pub fn delegation_of(&self, child: u32) -> Option<crate::db::DelegationRow> {
        match self.db.delegation_for_child(child) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("reading the delegation record for child {child}: {e}");
                None
            }
        }
    }

    pub fn delegations_of_parent(&self, parent: u32) -> Vec<crate::db::DelegationRow> {
        self.db.delegations_for_parent(parent).unwrap_or_else(|e| {
            tracing::warn!("listing delegations for parent {parent}: {e}");
            Vec::new()
        })
    }

    pub fn open_delegations(&self) -> Vec<crate::db::DelegationRow> {
        self.db.delegations_open().unwrap_or_else(|e| {
            tracing::warn!("listing open delegations: {e}");
            Vec::new()
        })
    }

    #[doc(hidden)]
    pub fn close_delegations_lost_to_the_restart_for_test(&self) {
        self.close_delegations_lost_to_the_restart();
    }

    pub fn delegation_round_of(&self, child: u32) -> Option<u32> {
        self.db.delegation_round(child).unwrap_or_else(|e| {
            tracing::warn!("reading child {child}'s current round: {e}");
            None
        })
    }

    fn round_a_re_prompt_opens(&self, target: u32) -> Option<u32> {
        let current = self.delegation_round_of(target)?;
        let spawning = self
            .delegation_of(target)
            .and_then(|row| orchestrate::DelegationState::parse(&row.state))
            == Some(orchestrate::DelegationState::Spawning);
        (!spawning).then_some(current + 1)
    }

    pub fn inbox_list(&self, workspace: &str) -> Result<proto::ServerMsg> {
        let rows = self
            .db
            .inbox_list_operator(workspace)?
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(proto::ServerMsg::InboxRows {
            workspace: workspace.to_string(),
            rows,
        })
    }

    #[doc(hidden)]
    pub fn inbox_rows_for_test(&self, to_session: u32) -> Vec<crate::db::InboxRow> {
        self.db
            .inbox_list_for_session(to_session)
            .expect("reading a pane's inbox")
    }

    fn note_continued_stop(&self, session: u32) -> u32 {
        let mut blocks = self.stop_blocks.lock().expect("stop blocks lock");
        let n = blocks.get(&session).copied().unwrap_or(0) + 1;
        blocks.insert(session, n);
        n
    }

    fn clear_stop_blocks(&self, session: u32) {
        self.stop_blocks
            .lock()
            .expect("stop blocks lock")
            .remove(&session);
    }

    fn stop_blocks(&self, session: u32) -> u32 {
        self.stop_blocks
            .lock()
            .expect("stop blocks lock")
            .get(&session)
            .copied()
            .unwrap_or(0)
    }

    #[doc(hidden)]
    pub fn stop_blocks_for_test(&self, session: u32) -> u32 {
        self.stop_blocks(session)
    }

    pub fn inbox_reserve_for_stop_hook(
        &self,
        caller: u32,
        now: u64,
    ) -> Result<orchestrate::StopHookReserveOutcome> {
        let blocks = self.stop_blocks(caller);
        if blocks >= orchestrate::STOP_BLOCKS_PER_TURN_MAX {
            tracing::debug!(
                "session {caller}: stop-hook reserve capped at {blocks} of {} blocks — the \
                 turn ends and the rest goes through door 3",
                orchestrate::STOP_BLOCKS_PER_TURN_MAX
            );
            return Ok(orchestrate::StopHookReserveOutcome::Capped {
                limit: orchestrate::STOP_BLOCKS_PER_TURN_MAX,
                blocks,
            });
        }
        let Some((delivery_id, rows)) = self.db.inbox_reserve(
            caller,
            now,
            orchestrate::INBOX_BATCH_MAX_ROWS,
            orchestrate::INBOX_BATCH_MAX_BYTES,
        )?
        else {
            return Ok(orchestrate::StopHookReserveOutcome::Empty);
        };
        let entries: Vec<orchestrate::InboxEntry> = rows
            .iter()
            .map(|row| orchestrate::InboxEntry {
                from_label: self.inbox_sender_label(row),
                excerpt: None,
                row: row.clone(),
            })
            .collect();
        let text = orchestrate::compose_inbox(&entries, &delivery_id);
        Ok(orchestrate::StopHookReserveOutcome::Reserved {
            rows,
            delivery_id,
            expires_at: now.saturating_add(orchestrate::INBOX_RESERVATION_MS),
            text,
        })
    }

    pub fn inbox_confirm_stop_hook(
        &self,
        caller: u32,
        delivery_id: &str,
        now: u64,
    ) -> Result<usize> {
        let rows = self.db.inbox_rows_by_delivery(delivery_id)?;
        let Some(first) = rows.first() else {
            bail!(
                "inbox confirm refused: no reservation {delivery_id} — it expired unconfirmed, \
                 was never taken, or names a delivery id this daemon never issued"
            );
        };
        if let Some(other) = rows.iter().find(|r| r.to_session != caller) {
            bail!(
                "inbox confirm refused: reservation {delivery_id} addresses pane {}, not pane \
                 {caller} — a token confirms only its own pane's reservation, and nothing was marked",
                other.to_session
            );
        }
        let reserved_at = first.reserved_at.unwrap_or(0);
        let expired = now.saturating_sub(reserved_at) > orchestrate::INBOX_RESERVATION_MS;
        let pending = rows.iter().any(|r| r.delivered_at.is_none());
        if expired && pending {
            bail!(
                "inbox confirm refused: reservation {delivery_id} expired — reserved_at {:?}, \
                 delivery_id {:?}, delivered_at {:?}; the rows are eligible again",
                first.reserved_at,
                first.delivery_id,
                first.delivered_at
            );
        }
        let marked = self
            .db
            .inbox_mark_delivered(delivery_id, "stop_hook", now)?;
        for row in &rows {
            self.broadcast_inbox_row(row.id);
        }
        Ok(marked)
    }

    #[doc(hidden)]
    pub fn inbox_lapsed_reservation_for_test(&self, to: u32, from: u32, now: u64) -> String {
        let workspace = self.current_workspace(to).unwrap_or_default();
        let row = orchestrate::inbox_row_new(
            to,
            &workspace,
            Some(from),
            None,
            orchestrate::InboxKind::Result,
            "lapsed",
            "LAPSED-ROW the task is done",
            Vec::new(),
            false,
            None,
            None,
            true,
        )
        .expect("a test row is well-formed");
        self.db
            .inbox_insert(&row, now)
            .expect("inserting a test row");
        let (delivery_id, _) = self
            .db
            .inbox_reserve(
                to,
                now,
                orchestrate::INBOX_BATCH_MAX_ROWS,
                orchestrate::INBOX_BATCH_MAX_BYTES,
            )
            .expect("reserving a test row")
            .expect("the test row is eligible");
        delivery_id
    }

    pub fn inbox_ack(&self, id: i64) -> Result<proto::InboxRow> {
        if !self.db.inbox_ack_operator(id, now_ms())? {
            bail!("no operator inbox row {id} to acknowledge");
        }
        Ok(self
            .db
            .inbox_get(id)?
            .ok_or_else(|| anyhow!("inbox row {id} vanished right after its own ack"))?
            .into())
    }

    pub fn inbox_resolve(&self, id: i64) -> Result<proto::InboxRow> {
        if self.db.inbox_resolve(id, "operator", now_ms())? == 0 {
            bail!("no inbox row {id} to resolve");
        }
        Ok(self
            .db
            .inbox_get(id)?
            .ok_or_else(|| anyhow!("inbox row {id} vanished right after its own resolve"))?
            .into())
    }

    fn delegation_child_exited(self: &Arc<Self>, child: u32) {
        let row = match self.db.delegation_for_child(child) {
            Ok(Some(row)) => row,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("reading the delegation record for child {child}: {e}");
                return;
            }
        };
        if orchestrate::DelegationState::parse(&row.state).is_some_and(|s| s.is_closed()) {
            return;
        }
        let parent = row.parent_session;
        let pending = self
            .db
            .inbox_pending_result(parent, child, row.round)
            .unwrap_or_else(|e| {
                tracing::warn!("reading child {child}'s stored result: {e}");
                None
            });
        let (state, reason) = if pending.is_some() {
            (orchestrate::DelegationState::Done, None)
        } else {
            (
                orchestrate::DelegationState::Failed,
                Some("the pane's process ended before it handed anything back"),
            )
        };
        if let Err(e) = self.db.delegation_close_round(
            child,
            state.as_str(),
            reason,
            true,
            match pending {
                Some(id) => crate::db::RoundHandback::Ready {
                    id,
                    provisional: false,
                    reason: None,
                },
                None => crate::db::RoundHandback::Nothing,
            },
            now_ms(),
        ) {
            tracing::warn!("closing the delegation for child {child}: {e}");
        }
        if let Some(id) = pending {
            self.broadcast_inbox_row(id);
        }
        let workspace = self.current_workspace(child).unwrap_or_default();
        let label = self.child_label_of(child);
        let body = orchestrate::exited_body(pending.is_some());
        if let Err(e) = self.inbox_write(
            parent,
            &workspace,
            Some(child),
            Some(row.round),
            orchestrate::InboxKind::Exited,
            &format!("{label}'s pane ended"),
            &body,
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!("telling parent {parent} that child {child} exited: {e}");
        }
        self.forget_round_state(child);
        self.broadcast_delegation(child);
        if pending.is_some() {
            self.arm_temporary_cleanup(child, false);
        }
    }

    fn arm_temporary_cleanup(self: &Arc<Self>, child: u32, provisional: bool) {
        let now = now_ms();
        {
            let _cleanup_guard = self
                .temporary_cleanup_lock
                .lock()
                .expect("temporary cleanup lock");
            let Ok(Some(row)) = self.db.delegation_for_child(child) else {
                return;
            };
            if row.reusable
                || orchestrate::DelegationState::parse(&row.state)
                    != Some(orchestrate::DelegationState::Done)
            {
                return;
            }
            let Ok(true) = self
                .db
                .inbox_round_has_result(row.parent_session, child, row.round)
            else {
                return;
            };
            let cleanup_after = if provisional {
                now.saturating_add(orchestrate::OWED_NOTIFICATION_MAX_MS)
            } else {
                now
            };
            if let Err(e) = self
                .db
                .delegation_set_cleanup_after(child, Some(cleanup_after), now)
            {
                tracing::warn!("scheduling temporary cleanup for child {child}: {e}");
                return;
            }
        }
        self.delegation_wake.notify_one();
        if let Ok(Some(updated)) = self.db.delegation_for_child(child) {
            self.cleanup_temporary_if_due(&updated, now);
        }
    }

    fn cleanup_temporary_if_due(self: &Arc<Self>, row: &crate::db::DelegationRow, now: u64) {
        let parent = {
            let _cleanup_guard = self
                .temporary_cleanup_lock
                .lock()
                .expect("temporary cleanup lock");
            let Ok(Some(fresh)) = self.db.delegation_for_child(row.child_session) else {
                return;
            };
            self.cleanup_temporary_if_due_locked(&fresh, now)
        };
        if let Some(parent) = parent {
            self.reevaluate_completed_ancestors(parent, now);
            self.reap_reevaluate();
        }
    }

    fn cleanup_temporary_if_due_locked(
        &self,
        row: &crate::db::DelegationRow,
        now: u64,
    ) -> Option<u32> {
        if row.reusable
            || orchestrate::DelegationState::parse(&row.state)
                != Some(orchestrate::DelegationState::Done)
            || row.cleanup_after.is_none_or(|at| at > now)
        {
            return None;
        }
        if !self.temporary_cleanup_safe(row.child_session, now) {
            return None;
        }
        let live_session = self
            .sessions
            .lock()
            .expect("sessions lock")
            .get(&row.child_session)
            .cloned();
        if let Some(session) = &live_session {
            // Prevent a completion callback from overwriting the durable closed state while the
            // cleanup lock bridges the database update and live-map removal.
            session.removed.store(true, Ordering::Release);
        }
        if let Err(e) = self.db.mark_closed(row.child_session) {
            tracing::warn!(
                "marking live temporary child {} closed before removal: {e}",
                row.child_session
            );
            if let Some(session) = live_session {
                session.removed.store(false, Ordering::Release);
            }
            return None;
        }
        let removed = self
            .sessions
            .lock()
            .expect("sessions lock")
            .remove(&row.child_session);
        if let Some(session) = removed {
            session.remove_shell_token_file();
            session.removed.store(true, Ordering::Release);
            if session.state.lock().expect("state lock").is_live() {
                let _ = session.backend.kill(row.child_session, session.pid);
            }
            self.mcp_creds.revoke_session(row.child_session);
            self.mcp_notify.close_session(row.child_session);
            self.remove_persisted_scrollback(row.child_session);
            self.frame_taps.forget_session(row.child_session);
            self.write_run_state();
            self.broadcast_control(&proto::ServerMsg::SessionRemoved {
                session: row.child_session,
            });
            self.broadcast_live_children(row.parent_session);
        } else if self
            .dead
            .lock()
            .expect("dead lock")
            .remove(&row.child_session)
            .is_some()
        {
            if let Err(e) = self.db.mark_closed(row.child_session) {
                tracing::warn!(
                    "marking restored temporary child {} closed: {e}",
                    row.child_session
                );
            }
            self.remove_persisted_scrollback(row.child_session);
            self.broadcast_control(&proto::ServerMsg::SessionRemoved {
                session: row.child_session,
            });
        } else {
            return None;
        }
        if let Err(e) = self
            .db
            .delegation_set_cleanup_after(row.child_session, None, now)
        {
            tracing::warn!(
                "clearing temporary cleanup marker for child {}: {e}",
                row.child_session
            );
        }
        Some(row.parent_session)
    }

    fn temporary_cleanup_safe(&self, child: u32, now: u64) -> bool {
        if !self.live_children_of(child).is_empty() {
            return false;
        }
        if self
            .swarm_wake_lanes
            .lock()
            .expect("wake lanes lock")
            .contains_key(&child)
        {
            return false;
        }
        if self
            .composer_occupied
            .lock()
            .expect("composer lock")
            .contains_key(&child)
        {
            return false;
        }
        if self
            .prompt_awaiting_hook
            .lock()
            .expect("prompt awaiting hook lock")
            .contains(&child)
        {
            return false;
        }
        let mut rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
        let Some(round) = rounds.get_mut(&child) else {
            return true;
        };
        if round.has_subagent_history() && round.reopen_window_open(now) {
            return false;
        }
        // A provisional row has a bounded correction window. Once it expires,
        // release the in-memory hold so ordinary completed panes can be reaped.
        round.take_released_row();
        round.is_quiescent()
    }

    fn reevaluate_completed_ancestors(self: &Arc<Self>, mut child: u32, now: u64) {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        for _ in 0..=proto::ORCHESTRATION_CAP_MAX {
            let Ok(Some(row)) = self.db.delegation_for_child(child) else {
                return;
            };
            let Some(parent) = self.cleanup_temporary_if_due_locked(&row, now) else {
                return;
            };
            child = parent;
        }
    }

    fn advance_delegation(self: &Arc<Self>, child: u32, ev: crate::agent_events::AgentEvent) {
        use crate::agent_events::AgentEvent;
        let cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        let opens_round = ev == AgentEvent::PromptSubmitted;
        let event = match ev {
            AgentEvent::PromptSubmitted | AgentEvent::InputResolved => {
                orchestrate::DelegationEvent::TurnStarted
            }
            AgentEvent::TurnEnded => orchestrate::DelegationEvent::TurnEnded,
            AgentEvent::NeedsInput => orchestrate::DelegationEvent::Blocked,
            AgentEvent::SessionStarted | AgentEvent::Activity | AgentEvent::TurnInterrupted => {
                return
            }
        };
        let row = match self.db.delegation_for_child(child) {
            Ok(Some(row)) => row,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("reading the delegation record for child {child}: {e}");
                return;
            }
        };
        let Some(from) = orchestrate::DelegationState::parse(&row.state) else {
            tracing::warn!(
                "delegation for child {child} holds state {:?}, which is not one of \
                 spawning|working|needs_input|done|failed|cancelled|unknown",
                row.state
            );
            return;
        };
        let parent = row.parent_session;
        let workspace = self.current_workspace(child).unwrap_or_default();
        let pending = self
            .db
            .inbox_pending_result(parent, child, row.round)
            .unwrap_or_else(|e| {
                tracing::warn!("reading child {child}'s stored result: {e}");
                None
            });
        let staged = pending.is_some();
        let to = orchestrate::delegation_transition(from, event, staged).filter(|to| *to != from);

        let mut moved_by_close = false;
        if let Some(to) = to {
            let reopened = from.is_closed() && !to.is_closed();
            let closing_round = staged
                && matches!(
                    event,
                    orchestrate::DelegationEvent::TurnEnded | orchestrate::DelegationEvent::Blocked
                );
            let wrote = if closing_round {
                moved_by_close = true;
                let provisional = self.round_closed_without_evidence(child);
                let id = pending.expect("a staged round has a stored result");
                self.note_provisional_release(child, provisional, id);
                self.db
                    .delegation_close_round(
                        child,
                        to.as_str(),
                        None,
                        to.is_closed(),
                        crate::db::RoundHandback::Ready {
                            id,
                            provisional,
                            reason: None,
                        },
                        now_ms(),
                    )
                    .map(|_| ())
            } else if to.is_closed() {
                self.db
                    .delegation_finish(child, to.as_str(), None, now_ms())
            } else if from.is_closed() {
                self.db.delegation_reopen(child, to.as_str(), now_ms())
            } else {
                self.db.delegation_set_state(child, to.as_str(), now_ms())
            };
            match wrote {
                Ok(()) if reopened => self.delegation_wake.notify_one(),
                Ok(()) => {}
                Err(e) => tracing::warn!("moving child {child} to {}: {e}", to.as_str()),
            }
        }

        if opens_round {
            self.open_round_on_external_prompt(child, from);
        }

        if staged
            && !moved_by_close
            && matches!(
                event,
                orchestrate::DelegationEvent::TurnEnded | orchestrate::DelegationEvent::Blocked
            )
        {
            let provisional = self.round_closed_without_evidence(child);
            let state = to.unwrap_or(from);
            let id = pending.expect("a staged round has a stored result");
            self.note_provisional_release(child, provisional, id);
            if let Err(e) = self.db.delegation_close_round(
                child,
                state.as_str(),
                None,
                state.is_closed(),
                crate::db::RoundHandback::Ready {
                    id,
                    provisional,
                    reason: None,
                },
                now_ms(),
            ) {
                tracing::warn!("releasing child {child}'s result: {e}");
            }
            moved_by_close = true;
        }

        let mut cleanup_provisional = None;
        if moved_by_close {
            if let Some(id) = pending {
                self.broadcast_inbox_row(id);
            }
            self.inbox_notify(parent, false);
            if self
                .db
                .delegation_for_child(child)
                .ok()
                .flatten()
                .is_some_and(|closed| {
                    !closed.reusable && closed.state == orchestrate::DelegationState::Done.as_str()
                })
            {
                cleanup_provisional = Some(self.round_closed_without_evidence(child));
            }
        }

        match event {
            orchestrate::DelegationEvent::Blocked => {
                let label = self.child_label_of(child);
                let body = orchestrate::needs_input_body(
                    self.permission_episodes
                        .lock()
                        .expect("episodes lock")
                        .get(&child)
                        .and_then(|eps| eps.newest_reason()),
                );
                let summary = format!("{label} is blocked");
                self.refresh_or_write_block(parent, child, &workspace, row.round, &summary, &body);
            }
            orchestrate::DelegationEvent::TurnStarted | orchestrate::DelegationEvent::TurnEnded
                if from == orchestrate::DelegationState::NeedsInput =>
            {
                match self.db.inbox_resolve_undelivered(
                    parent,
                    child,
                    orchestrate::InboxKind::NeedsInput.as_str(),
                    "block_ended",
                    now_ms(),
                ) {
                    Ok(0) => {}
                    Ok(n) => tracing::debug!(
                        "child {child}'s block ended before {n} needs_input row(s) reached \
                         parent {parent}"
                    ),
                    Err(e) => tracing::warn!("resolving child {child}'s needs_input rows: {e}"),
                }
            }
            _ => {}
        }

        let handed_back = self
            .db
            .inbox_round_handed_back(parent, child, row.round)
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "reading whether child {child} handed back request {}: {e}",
                    row.round
                );
                false
            });
        if !staged
            && !handed_back
            && !from.is_closed()
            && event == orchestrate::DelegationEvent::TurnEnded
        {
            let mut round = orchestrate::NoHandbackRound {
                reported: row.no_handback_reported,
                suppressed: row.no_handback_suppressed,
            };
            if round.on_unstaged_turn_end() {
                let provisional = self.round_closed_without_evidence(child);
                if self.deliver_unsubmitted_turn_end(child, from, provisional) {
                    if let Err(e) = self.db.delegation_set_no_handback(
                        child,
                        round.reported,
                        round.suppressed,
                        now_ms(),
                    ) {
                        tracing::warn!("latching child {child}'s no_handback notice: {e}");
                    }
                }
            } else {
                tracing::debug!(
                    "child {child} ended another unstaged turn while its parent already holds \
                     a no_handback notice for this round ({} suppressed so far)",
                    round.suppressed
                );
                if let Err(e) = self.db.delegation_set_no_handback(
                    child,
                    round.reported,
                    round.suppressed,
                    now_ms(),
                ) {
                    tracing::warn!(
                        "counting a suppressed no_handback turn end for child {child}: {e}"
                    );
                }
            }
        }
        self.broadcast_delegation(child);
        drop(cleanup_guard);
        if let Some(provisional) = cleanup_provisional {
            self.arm_temporary_cleanup(child, provisional);
        }
    }

    fn open_round_on_external_prompt(&self, child: u32, from: orchestrate::DelegationState) {
        use orchestrate::DelegationState::*;
        let current = self.db.delegation_round(child).ok().flatten();
        let houston_asked = self
            .prompt_awaiting_hook
            .lock()
            .expect("prompt awaiting hook lock")
            .remove(&child);
        let opened = match from {
            Spawning => current,
            Working if houston_asked => {
                match self.db.delegation_bump_round(child, now_ms()) {
                    Ok(round) => tracing::debug!(
                        "child {child} was asked request {round:?} while still answering \
                         request {current:?}"
                    ),
                    Err(e) => tracing::warn!("opening a new round for child {child}: {e}"),
                }
                None
            }
            Working => {
                tracing::debug!(
                    "child {child}: a prompt hook while working, with no pane_prompt behind it \
                     — not a new request, still on request {current:?}"
                );
                None
            }
            NeedsInput => match self.db.delegation_bump_round(child, now_ms()) {
                Ok(round) => round,
                Err(e) => {
                    tracing::warn!("opening a new round for child {child}: {e}");
                    None
                }
            },
            Done | Unknown | Failed | Cancelled => current,
        };
        if let Some(round) = opened {
            self.turn_start_round
                .lock()
                .expect("turn start round lock")
                .insert(child, round);
        }
    }

    fn refresh_or_write_block(
        self: &Arc<Self>,
        parent: u32,
        child: u32,
        workspace: &str,
        round: u32,
        summary: &str,
        body: &str,
    ) {
        let fresh = match orchestrate::inbox_row_new(
            parent,
            workspace,
            Some(child),
            Some(round),
            orchestrate::InboxKind::NeedsInput,
            summary,
            body,
            Vec::new(),
            false,
            None,
            None,
            true,
        ) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("composing the block notice for child {child}: {e}");
                return;
            }
        };
        let kind = orchestrate::InboxKind::NeedsInput.as_str();
        match self.db.inbox_refresh_undelivered(
            parent,
            child,
            kind,
            &fresh.summary,
            &fresh.body,
            now_ms(),
        ) {
            Ok(true) => {
                tracing::debug!(
                    "child {child} blocked again; parent {parent}'s unread notice now names \
                     what it is waiting on"
                );
                if let Ok(Some(row)) = self.db.inbox_get_undelivered(parent, child, kind) {
                    self.broadcast_inbox_row(row);
                }
                self.broadcast_delegation(child);
                return;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("refreshing child {child}'s block notice: {e}"),
        }
        if self
            .db
            .inbox_has_undelivered(parent, child, kind)
            .unwrap_or(false)
        {
            tracing::debug!(
                "child {child} is blocked and a door is mid-delivery with parent {parent}'s \
                 notice about it, so this block adds no second row"
            );
            self.broadcast_delegation(child);
            return;
        }
        match self.db.inbox_insert(&fresh, now_ms()) {
            Ok(id) => {
                self.broadcast_inbox_row(id);
                self.inbox_notify(parent, orchestrate::InboxKind::NeedsInput.urgent());
            }
            Err(e) => tracing::warn!("telling parent {parent} that child {child} is blocked: {e}"),
        }
    }

    fn note_provisional_release(&self, child: u32, provisional: bool, id: i64) {
        if !provisional {
            return;
        }
        if let Some(round) = self
            .subagent_rounds
            .lock()
            .expect("subagent rounds lock")
            .get_mut(&child)
        {
            round.note_released_row(id);
        }
    }

    fn correct_provisional_release(
        self: &Arc<Self>,
        child: u32,
        evidence: orchestrate::LateEvidence,
    ) {
        let released = self
            .subagent_rounds
            .lock()
            .expect("subagent rounds lock")
            .get_mut(&child)
            .and_then(|round| round.take_released_row());
        let Some(id) = released else { return };
        match self.db.inbox_clear_provisional(id, now_ms()) {
            Ok(true) => {
                tracing::warn!(
                    "child {child}: row #{id} was released against no sub-agent evidence and \
                     nobody had read it yet — the marker comes off in place"
                );
                self.broadcast_inbox_row(id);
                return;
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!("clearing the provisional marker on row {id}: {e}");
                return;
            }
        }
        let Some(parent) = self.parent_of(child) else {
            return;
        };
        let workspace = self.current_workspace(child).unwrap_or_default();
        let request_id = self.db.delegation_round(child).ok().flatten();
        let label = self.child_label_of(child);
        match self.inbox_write(
            parent,
            &workspace,
            Some(child),
            request_id,
            orchestrate::InboxKind::Result,
            &format!("{label}'s earlier result was released too early"),
            &orchestrate::correction_body(evidence),
            Vec::new(),
            None,
            Some(id),
            false,
            true,
        ) {
            Ok(new_id) => tracing::warn!(
                "child {child}: row #{new_id} corrects #{id}, released against no sub-agent \
                 evidence and already delivered"
            ),
            Err(e) => tracing::warn!("correcting row {id} for parent {parent}: {e}"),
        }
    }

    fn round_closed_without_evidence(&self, child: u32) -> bool {
        let rounds = self.subagent_rounds.lock().expect("subagent rounds lock");
        rounds.get(&child).is_some_and(|round| {
            round.has_subagent_history()
                && round.closed_by() == Some(orchestrate::RoundClose::StopEmptySets)
        })
    }

    fn forget_round_state(&self, child: u32) {
        self.turn_start_round
            .lock()
            .expect("turn start round lock")
            .remove(&child);
    }

    fn pending_handback(&self, parent: u32, child: u32) -> orchestrate::PendingHandback {
        orchestrate::PendingHandback::from_superseded(
            self.db
                .inbox_undelivered_result(parent, child)
                .unwrap_or_else(|e| {
                    tracing::warn!("reading child {child}'s undelivered result: {e}");
                    None
                }),
        )
    }

    fn inbox_owed(&self, parent: u32, child: u32) -> orchestrate::InboxOwed {
        let (owed, provisional, last_result_corrected_by) = self
            .db
            .inbox_child_summary(parent, child)
            .unwrap_or_else(|e| {
                tracing::warn!("reading child {child}'s owed inbox rows: {e}");
                (0, 0, None)
            });
        orchestrate::InboxOwed {
            owed,
            provisional,
            last_result_corrected_by,
        }
    }

    fn capability_note_of(&self, child: u32) -> Option<String> {
        let (kind, status) = {
            let sessions = self.sessions.lock().expect("sessions lock");
            let s = sessions.get(&child)?;
            let status = *s.status.lock().expect("status lock");
            (s.status_kind(), status)
        };
        if kind == proto::AgentKind::Codex && status.is_none() {
            if let Some(note) = self.codex_trust_pending_note() {
                return Some(note);
            }
        }
        orchestrate::capability_note(kind)
    }

    fn codex_trust_pending_note(&self) -> Option<String> {
        let home = crate::agent_hooks::ConfigHome::from_env().ok()?;
        let sentinel = self.hook_sentinel();
        crate::agent_hooks::is_installed(proto::AgentKind::Codex, &home, &sentinel)
            .then(|| "Codex hooks installed, not confirmed for this pane".to_string())
    }

    fn child_label_of(&self, child: u32) -> String {
        let codename = self
            .codename_of(child)
            .unwrap_or_else(|| format!("pane {child}"));
        self.child_label(child, &codename)
    }

    fn codename_of(&self, id: u32) -> Option<String> {
        if let Some(s) = self.sessions.lock().expect("sessions lock").get(&id) {
            let stored = s.info.codename.clone();
            if !stored.is_empty() {
                return Some(stored);
            }
            return Some(s.title.lock().expect("title lock").clone());
        }
        if let Some(name) = self.dead.lock().expect("dead lock").get(&id).map(|i| {
            if !i.codename.is_empty() {
                i.codename.clone()
            } else {
                i.title.clone()
            }
        }) {
            return Some(name);
        }
        self.db.session_codename(id).ok().flatten()
    }

    fn deliver_unsubmitted_turn_end(
        self: &Arc<Self>,
        child: u32,
        from: orchestrate::DelegationState,
        provisional: bool,
    ) -> bool {
        let Some(parent) = self.parent_of(child) else {
            return false;
        };
        let Ok(s) = self.get(child) else {
            return false;
        };
        let wrote_a_line = {
            let sb = s.scrollback.lock().expect("scrollback lock");
            sb.wrote_a_line()
        };
        if !orchestrate::unsubmitted_turn_end_reaches_parent(
            from,
            orchestrate::signals_turn_start(s.status_kind()),
            wrote_a_line,
        ) {
            return false;
        }
        let kind = s.status_kind();
        let last_message = orchestrate::provider_capabilities(kind)
            .last_message
            .then(|| self.last_hook_message(child))
            .flatten()
            .filter(|m| !m.trim().is_empty());
        let (excerpt, excerpt_source) = match last_message {
            Some(msg) => (msg, orchestrate::NoHandbackExcerptSource::LastMessage),
            None => {
                let tail = self
                    .session_screen(&s, orchestrate::UNSUBMITTED_TAIL_LINES)
                    .join("\n");
                (tail, orchestrate::NoHandbackExcerptSource::ScreenTail)
            }
        };
        let excerpt = orchestrate::sanitize_handoff_text(&excerpt);
        let source = self.turn_end_source_of(child);
        let label = self.child_label_of(child);
        let workspace = self.current_workspace(child).unwrap_or_default();
        let request_id = self.db.delegation_round(child).ok().flatten();
        if let Err(e) = self.inbox_write(
            parent,
            &workspace,
            Some(child),
            request_id,
            orchestrate::InboxKind::NoHandback,
            &format!("{label} ended a turn without handing anything back"),
            &orchestrate::unsubmitted_turn_end_body(source, excerpt_source, &excerpt),
            Vec::new(),
            None,
            None,
            provisional,
            true,
        ) {
            tracing::warn!(
                "telling parent {parent} that child {child} ended a turn without submitting: {e}"
            );
        }
        true
    }

    fn child_label(&self, child: u32, codename: &str) -> String {
        match self.delegation_of(child).and_then(|row| row.role) {
            Some(role) => format!("{codename} ({role})"),
            None => codename.to_string(),
        }
    }

    fn assert_role_free(&self, caller: u32, role: &str) -> Result<()> {
        let live = self.live_children_of(caller);
        for row in self.delegations_of_parent(caller) {
            if row.role.as_deref() == Some(role) && live.contains(&row.child_session) {
                bail!(
                    "spawn refused: role {role:?} is already taken by pane {} — roles are \
                     unique among your live children. Pick another name, or kill that pane \
                     first; the role is free again as soon as it is gone",
                    row.child_session
                );
            }
        }
        Ok(())
    }

    fn turn_end_source_of(&self, child: u32) -> orchestrate::TurnEndSource {
        match self.get(child) {
            Ok(s) => orchestrate::turn_end_source(s.status_kind(), s.acp.is_some()),
            Err(_) => orchestrate::TurnEndSource::QuietSettle,
        }
    }

    pub async fn delegation_watch_loop(self: Arc<Self>) {
        let period = Duration::from_millis(orchestrate::DELEGATION_WATCH_POLL_MS);
        loop {
            if !self.delegation_watch_armed() {
                self.delegation_wake.notified().await;
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(period) => {},
                _ = self.delegation_wake.notified() => {},
            }
            self.idle_tick_counts[1].fetch_add(1, Ordering::Relaxed);
            let me = Arc::clone(&self);
            if let Err(e) = tokio::task::spawn_blocking(move || me.delegation_watch_tick()).await {
                tracing::warn!("delegation watch tick panicked: {e}");
            }
        }
    }

    #[doc(hidden)]
    pub fn idle_tick_counts_for_test(&self) -> (u64, u64) {
        (
            self.idle_tick_counts[0].load(Ordering::Relaxed),
            self.idle_tick_counts[1].load(Ordering::Relaxed),
        )
    }

    #[doc(hidden)]
    pub fn delegation_watch_armed(&self) -> bool {
        self.db
            .delegations_open()
            .map(|rows| !rows.is_empty())
            .unwrap_or(true)
            || self.db.delegations_cleanup_pending().unwrap_or(true)
    }

    pub fn delegation_watch_tick(self: &Arc<Self>) {
        self.delegation_watch_tick_at(self.started.elapsed().as_millis() as u64);
    }

    #[doc(hidden)]
    pub fn delegation_watch_tick_at(self: &Arc<Self>, now: u64) {
        if self.refusing_mutations() {
            return;
        }
        let open = match self.db.delegations_open() {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("listing open delegations to watch: {e}");
                return;
            }
        };
        for row in &open {
            let child = row.child_session;
            let Ok(s) = self.get(child) else { continue };
            let busy = match s.pid {
                Some(pid) => has_running_procs(pid).unwrap_or(true),
                None => true,
            };
            self.delegation_stall_pass(row, &s, busy, now);
            self.delegation_settle_pass(row, &s, busy, now);
        }
        let cleanup_now = now_ms();
        let due = match self.db.delegations_cleanup_due(cleanup_now) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("listing temporary delegations ready for cleanup: {e}");
                Vec::new()
            }
        };
        for row in &due {
            self.cleanup_temporary_if_due(row, cleanup_now);
        }
        let mut samples = self
            .delegation_settle
            .lock()
            .expect("delegation settle lock");
        samples.retain(|child, _| open.iter().any(|r| r.child_session == *child));
    }

    #[doc(hidden)]
    pub fn with_temporary_cleanup_lock_for_test<T>(&self, f: impl FnOnce() -> T) -> T {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        f()
    }

    fn delegation_stall_pass(
        self: &Arc<Self>,
        row: &crate::db::DelegationRow,
        s: &Arc<Session>,
        busy: bool,
        now: u64,
    ) {
        let child = row.child_session;
        let blocked = orchestrate::DelegationState::parse(&row.state)
            == Some(orchestrate::DelegationState::NeedsInput);
        let quiet = now.saturating_sub(s.last_output.load(Ordering::Relaxed));
        let stalled = !blocked && !busy && quiet >= orchestrate::DELEGATION_STALL_MS;
        if stalled == row.stalled {
            return;
        }
        if let Err(e) = self.db.delegation_set_stalled(child, stalled, now_ms()) {
            tracing::warn!("flagging child {child} stalled={stalled}: {e}");
            return;
        }
        self.broadcast_delegation(child);
        if !stalled {
            return;
        }
        let Some(parent) = self.parent_of(child) else {
            return;
        };
        let label = self.child_label_of(child);
        let workspace = self.current_workspace(child).unwrap_or_default();
        if let Err(e) = self.inbox_write(
            parent,
            &workspace,
            Some(child),
            Some(row.round),
            orchestrate::InboxKind::Stalled,
            &format!("{label} has gone quiet"),
            &orchestrate::stalled_body(quiet),
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!("telling parent {parent} that child {child} stalled: {e}");
        }
    }

    fn delegation_settle_pass(
        self: &Arc<Self>,
        row: &crate::db::DelegationRow,
        s: &Arc<Session>,
        busy: bool,
        now: u64,
    ) {
        let child = row.child_session;
        let source = orchestrate::turn_end_source(s.status_kind(), s.acp.is_some());
        if source != orchestrate::TurnEndSource::QuietSettle {
            return;
        }
        let fingerprint =
            screen_fingerprint(&self.session_screen(s, orchestrate::DELEGATION_SETTLE_TAIL_LINES));
        let sample = {
            let mut samples = self
                .delegation_settle
                .lock()
                .expect("delegation settle lock");
            let entry = samples
                .entry(child)
                .or_insert(DelegationSettleSample::fresh(fingerprint, now));
            if entry.fingerprint != fingerprint || busy {
                *entry = DelegationSettleSample::fresh(fingerprint, now);
            }
            *entry
        };
        let pending = self
            .db
            .inbox_pending_result(row.parent_session, child, row.round)
            .unwrap_or_else(|e| {
                tracing::warn!("reading child {child}'s stored result: {e}");
                None
            });
        match orchestrate::delegation_settle_action(
            source,
            pending.is_some(),
            busy,
            now.saturating_sub(sample.still_since),
            sample.no_handback_reported,
        ) {
            orchestrate::SettleAction::Wait => {}
            orchestrate::SettleAction::FlushStaged => {
                let id = pending.expect("a settle release has a stored result");
                if let Err(e) = self.db.delegation_close_round(
                    child,
                    orchestrate::DelegationState::Done.as_str(),
                    Some("no turn-end event from this CLI; settled on a still screen"),
                    true,
                    crate::db::RoundHandback::Ready {
                        id,
                        provisional: false,
                        reason: Some("quiet_settle"),
                    },
                    now_ms(),
                ) {
                    tracing::warn!("closing child {child}'s quiet-settled delegation: {e}");
                }
                self.broadcast_inbox_row(id);
                self.inbox_notify(row.parent_session, false);
                self.broadcast_delegation(child);
            }
            orchestrate::SettleAction::ReportNoHandback => {
                let Some(from) = orchestrate::DelegationState::parse(&row.state) else {
                    return;
                };
                if let Some(entry) = self
                    .delegation_settle
                    .lock()
                    .expect("delegation settle lock")
                    .get_mut(&child)
                {
                    entry.no_handback_reported = true;
                }
                self.deliver_unsubmitted_turn_end(
                    child,
                    from,
                    self.round_closed_without_evidence(child),
                );
            }
        }
    }

    fn handoff_batch_window(&self) -> Duration {
        Duration::from_millis(self.handoff_batch_ms.load(Ordering::Relaxed))
    }

    #[doc(hidden)]
    pub fn set_handoff_batch_ms_for_test(&self, ms: u64) {
        self.handoff_batch_ms.store(ms, Ordering::Relaxed);
    }

    fn inbox_pending_max(&self) -> u32 {
        self.inbox_pending_max.load(Ordering::Relaxed)
    }

    #[doc(hidden)]
    pub fn set_inbox_pending_max_for_test(&self, rows: u32) {
        self.inbox_pending_max.store(rows, Ordering::Relaxed);
    }

    fn notify_inbox_wake(&self, to: u32) {
        if let Some(n) = self.inbox_wake.lock().expect("inbox wake lock").get(&to) {
            n.notify_waiters();
        }
    }

    fn inbox_notify(self: &Arc<Self>, to: u32, urgent: bool) {
        self.notify_inbox_wake(to);
        if to == 0 {
            match self
                .db
                .inbox_prune_operator(orchestrate::INBOX_OPERATOR_MAX_ROWS)
            {
                Ok(0) => {}
                Ok(n) => tracing::info!(
                    "operator inbox is over {} rows; pruned {n} already-read row(s)",
                    orchestrate::INBOX_OPERATOR_MAX_ROWS
                ),
                Err(e) => tracing::warn!("pruning the operator inbox: {e}"),
            }
            return;
        }
        if urgent {
            let this = Arc::clone(self);
            if let Err(e) = std::thread::Builder::new()
                .name(format!("inbox-urgent-{to}"))
                .spawn(move || this.flush_inbox_batch(to))
            {
                tracing::warn!("scheduling an urgent inbox flush for pane {to}: {e}");
            }
            return;
        }
        let schedule = self
            .inbox_flush_scheduled
            .lock()
            .expect("inbox flush lock")
            .insert(to);
        if !schedule {
            return;
        }
        let this = Arc::clone(self);
        if let Err(e) = std::thread::Builder::new()
            .name(format!("inbox-flush-{to}"))
            .spawn(move || {
                std::thread::sleep(this.handoff_batch_window());
                this.inbox_flush_scheduled
                    .lock()
                    .expect("inbox flush lock")
                    .remove(&to);
                this.flush_inbox_batch(to);
            })
        {
            self.inbox_flush_scheduled
                .lock()
                .expect("inbox flush lock")
                .remove(&to);
            tracing::warn!("scheduling the inbox flush for pane {to}: {e}");
        }
    }

    fn flush_inbox_batch(self: &Arc<Self>, parent: u32) {
        match self.db.inbox_pending_count(parent) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("reading pane {parent}'s pending inbox: {e}");
                return;
            }
        }
        if let Some(why) = self.paste_hold_reason(parent) {
            tracing::debug!("holding pane {parent}'s inbox — {why}");
            return;
        }
        if let Err(e) = self.swarm_wake_enqueue(parent, WakeItem::Inbox) {
            tracing::warn!("queueing pane {parent}'s inbox delivery: {e}");
        }
    }

    pub fn drain_pending_inbox(self: &Arc<Self>, id: u32) {
        if self.db.inbox_pending_count(id).unwrap_or(0) > 0 {
            self.flush_inbox_batch(id);
        }
    }

    fn paste_hold_reason(&self, parent: u32) -> Option<String> {
        match self.session_status(parent) {
            Ok(Some(proto::AgentStatus::Idle)) => {}
            Ok(Some(proto::AgentStatus::NeedsInput)) => {
                return Some(
                    "this pane is blocked on a question of its own; a paste and Enter here \
                     would answer it"
                        .to_string(),
                )
            }
            Ok(other) => {
                return Some(format!(
                    "this pane is {}, not idle",
                    other.map_or("of unknown status".to_string(), |s| format!("{s:?}"))
                ))
            }
            Err(e) => return Some(format!("this pane cannot be read: {e}")),
        }
        let typed = self
            .composer_occupied
            .lock()
            .expect("composer lock")
            .get(&parent)
            .copied();
        let quiet = now_ms().saturating_sub(typed?);
        if quiet < orchestrate::OPERATOR_TYPING_GUARD_MS {
            return Some(format!(
                "the operator typed into this pane {quiet} ms ago, inside the {} ms guard",
                orchestrate::OPERATOR_TYPING_GUARD_MS
            ));
        }
        Some("this pane's prompt has text the operator has not submitted".to_string())
    }

    pub fn note_operator_keystroke(&self, session: u32) {
        let _cleanup_guard = self
            .temporary_cleanup_lock
            .lock()
            .expect("temporary cleanup lock");
        self.cancel_temporary_cleanup_locked(session);
        self.composer_occupied
            .lock()
            .expect("composer lock")
            .insert(session, now_ms());
    }

    pub fn clear_composer_occupied(&self, session: u32) -> bool {
        self.composer_occupied
            .lock()
            .expect("composer lock")
            .remove(&session)
            .is_some()
    }

    pub fn inbox_deliver_now(self: &Arc<Self>, session: u32) -> Result<()> {
        self.get(session)?;
        self.clear_composer_occupied(session);
        self.flush_inbox_batch(session);
        Ok(())
    }

    fn paste_inbox(self: &Arc<Self>, parent: u32) {
        if let Some(why) = self.paste_hold_reason(parent) {
            tracing::debug!("holding pane {parent}'s inbox — {why}");
            return;
        }
        let reserved = self.db.inbox_reserve(
            parent,
            now_ms(),
            orchestrate::INBOX_BATCH_MAX_ROWS,
            orchestrate::INBOX_BATCH_MAX_BYTES,
        );
        let (delivery_id, rows) = match reserved {
            Ok(Some(claimed)) => claimed,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("reserving pane {parent}'s inbox rows: {e}");
                return;
            }
        };
        let entries: Vec<orchestrate::InboxEntry> = rows
            .iter()
            .map(|row| orchestrate::InboxEntry {
                from_label: self.inbox_sender_label(row),
                excerpt: self.inbox_excerpt(row),
                row: row.clone(),
            })
            .collect();
        let payload = bracketed_paste(&orchestrate::compose_inbox(&entries, &delivery_id));
        if let Some(why) = self.paste_hold_reason(parent) {
            tracing::debug!("holding pane {parent}'s inbox at the last moment — {why}");
            self.release_reservation(&delivery_id);
            return;
        }
        match self.write_stdin_counting(parent, &payload) {
            Ok(()) => {}
            Err(e) if e.nothing_written() => {
                self.paste_wrote_nothing(parent, &delivery_id, &rows, &e);
                return;
            }
            Err(e) => {
                self.paste_went_partial(&delivery_id, &rows, &format!("{e}"));
                return;
            }
        }
        std::thread::sleep(SWARM_WAKE_SETTLE);
        if let Some(why) = self.paste_hold_reason(parent) {
            self.paste_went_partial(
                &delivery_id,
                &rows,
                &format!(
                    "pasted into pane {parent} but not submitted — {why}. The text is sitting \
                     in that pane's prompt"
                ),
            );
            return;
        }
        if let Err(e) = self.write_stdin_counting(parent, b"\r") {
            self.paste_went_partial(
                &delivery_id,
                &rows,
                &format!("pasted into pane {parent} but the submitting Enter failed: {e}"),
            );
            return;
        }
        let now = now_ms();
        if let Err(e) = self.db.inbox_mark_delivered(&delivery_id, "paste", now) {
            tracing::warn!("marking pane {parent}'s paste delivered: {e}");
        }
        for row in &rows {
            self.broadcast_inbox_row(row.id);
        }
        self.paste_confirmations
            .lock()
            .expect("paste confirmations lock")
            .insert(parent, (delivery_id, now));
    }

    fn broadcast_inbox_row(&self, id: i64) {
        match self.db.inbox_get(id) {
            Ok(Some(row)) => self.broadcast_control(&proto::ServerMsg::InboxChanged {
                workspace: row.workspace.clone(),
                row: row.into(),
            }),
            Ok(None) => {}
            Err(e) => tracing::warn!("reading inbox row {id} to broadcast it: {e}"),
        }
    }

    fn paste_wrote_nothing(
        self: &Arc<Self>,
        parent: u32,
        delivery_id: &str,
        rows: &[crate::db::InboxRow],
        err: &StdinWriteError,
    ) {
        self.release_reservation(delivery_id);
        let spent: Vec<&crate::db::InboxRow> = rows
            .iter()
            .filter(|r| r.attempts >= orchestrate::PASTE_ATTEMPTS_MAX)
            .collect();
        if spent.is_empty() {
            tracing::debug!(
                "pane {parent}'s inbox paste wrote nothing ({err}); {} row(s) stay pending",
                rows.len()
            );
            return;
        }
        for row in spent {
            let reason = format!(
                "attempts: {} attempt(s) into pane {parent} wrote nothing, the limit is {} — \
                 last error: {err}",
                row.attempts,
                orchestrate::PASTE_ATTEMPTS_MAX
            );
            self.readdress_row_to_operator(row.id, &reason);
        }
        self.inbox_notify(0, true);
    }

    fn paste_went_partial(
        self: &Arc<Self>,
        delivery_id: &str,
        rows: &[crate::db::InboxRow],
        what: &str,
    ) {
        self.release_reservation(delivery_id);
        for row in rows {
            self.readdress_row_to_operator(row.id, &format!("partial: {what}"));
        }
        self.inbox_notify(0, true);
    }

    fn release_reservation(&self, delivery_id: &str) {
        if let Err(e) = self.db.inbox_release(delivery_id) {
            tracing::warn!("releasing inbox reservation {delivery_id}: {e}");
        }
    }

    fn readdress_row_to_operator(&self, id: i64, reason: &str) {
        tracing::warn!("inbox row {id} goes to the operator — {reason}");
        if let Err(e) = self.db.inbox_readdress_to_operator(id, reason) {
            tracing::warn!("re-addressing inbox row {id} to the operator: {e}");
        }
        self.broadcast_inbox_row(id);
    }

    fn note_to_operator(self: &Arc<Self>, about: u32, tag: &str, why: &str) {
        let workspace = self.current_workspace(about).unwrap_or_default();
        let row = match orchestrate::inbox_row_new(
            0,
            &workspace,
            Some(about),
            None,
            orchestrate::InboxKind::OperatorNote,
            &format!("pane {about}: {tag}"),
            why,
            Vec::new(),
            false,
            None,
            Some(tag),
            true,
        ) {
            Ok(row) => row,
            Err(e) => {
                tracing::warn!("composing the {tag} note about pane {about}: {e}");
                return;
            }
        };
        match self.db.inbox_insert(&row, now_ms()) {
            Ok(id) => {
                self.broadcast_inbox_row(id);
                self.inbox_notify(0, true);
            }
            Err(e) => tracing::warn!("writing the {tag} note about pane {about}: {e}"),
        }
    }

    fn inbox_excerpt(&self, row: &crate::db::InboxRow) -> Option<String> {
        if orchestrate::InboxKind::parse(&row.kind) != Some(orchestrate::InboxKind::Result) {
            return None;
        }
        match self.db.inbox_excerpt(row.id) {
            Ok(Some(excerpt)) if !excerpt.trim().is_empty() => return Some(excerpt),
            Ok(_) => {}
            Err(e) => tracing::warn!("reading the stored excerpt for inbox row {}: {e}", row.id),
        }
        self.session_handoff_excerpt(row.from_session?)
    }

    fn session_handoff_excerpt(&self, from: u32) -> Option<String> {
        let s = self.get(from).ok()?;
        let excerpt = orchestrate::sanitize_handoff_text(
            &self
                .session_screen(&s, orchestrate::HANDOFF_CORROBORATING_ROWS)
                .join("\n"),
        );
        orchestrate::cap_handoff_excerpt(&excerpt)
    }

    pub(crate) fn inbox_sender_label(&self, row: &crate::db::InboxRow) -> String {
        let Some(from) = row.from_session else {
            return "Houston".to_string();
        };
        let codename = row
            .from_codename
            .clone()
            .or_else(|| self.codename_of(from))
            .unwrap_or_else(|| format!("pane {from}"));
        if let Some(role) = row.from_role.as_deref() {
            return format!("{codename} ({role})");
        }
        if let Some(role) = self
            .delegation_of(from)
            .and_then(|delegation| delegation.role)
        {
            return format!("{codename} ({role})");
        }
        codename
    }

    #[allow(clippy::too_many_arguments)]
    fn inbox_write(
        self: &Arc<Self>,
        to: u32,
        workspace: &str,
        from: Option<u32>,
        request_id: Option<u32>,
        kind: orchestrate::InboxKind,
        summary: &str,
        body: &str,
        artifacts: Vec<String>,
        reason: Option<&str>,
        corrects: Option<i64>,
        provisional: bool,
        ready: bool,
    ) -> Result<i64> {
        let row = orchestrate::inbox_row_new(
            to,
            workspace,
            from,
            request_id,
            kind,
            summary,
            body,
            artifacts,
            provisional,
            corrects,
            reason,
            ready,
        )?;
        let id = self.db.inbox_insert(&row, now_ms())?;
        let pending = self.db.inbox_pending_count(to).unwrap_or(0);
        if pending > self.inbox_pending_max() {
            let why = format!(
                "backlog: pane {to} holds {pending} undelivered row(s), over the {} the inbox \
                 keeps per pane; row #{id} ({}) goes to you instead",
                self.inbox_pending_max(),
                kind.as_str()
            );
            self.readdress_row_to_operator(id, &why);
            self.inbox_notify(0, true);
            return Ok(id);
        }
        self.broadcast_inbox_row(id);
        self.inbox_notify(to, kind.urgent());
        Ok(id)
    }

    pub fn queue_operator_ended_notice(self: &Arc<Self>, child: u32, parent: u32, label: String) {
        if !self
            .sessions
            .lock()
            .expect("sessions lock")
            .contains_key(&parent)
        {
            return;
        }
        let workspace = self.current_workspace(child).unwrap_or_default();
        let request_id = self.db.delegation_round(child).ok().flatten();
        if let Err(e) = self.inbox_write(
            parent,
            &workspace,
            Some(child),
            request_id,
            orchestrate::InboxKind::OperatorNote,
            &format!("the operator ended {label}"),
            &orchestrate::operator_ended_body(),
            Vec::new(),
            None,
            None,
            false,
            true,
        ) {
            tracing::warn!("operator-ended notice for parent {parent}: {e}");
        }
    }
}

fn init_prompts_dir(project_dir: &Path) -> Result<PathBuf> {
    let dir = project_dir.join(crate::paths::PROJECT_DIR).join("prompts");
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n")
            .with_context(|| format!("writing {}", gitignore.display()))?;
    }
    Ok(dir)
}

fn init_orchestration_scope(project_dir: &Path) -> Result<(PathBuf, PathBuf)> {
    let orch_dir = project_dir
        .join(crate::paths::PROJECT_DIR)
        .join("orchestration");
    let prompts_dir = orch_dir.join("prompts");
    std::fs::create_dir_all(&prompts_dir)
        .with_context(|| format!("creating {}", prompts_dir.display()))?;
    let gitignore = orch_dir.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n")
            .with_context(|| format!("writing {}", gitignore.display()))?;
    }
    let bin_dir = orch_dir.join("bin");
    std::fs::create_dir_all(&bin_dir).with_context(|| format!("creating {}", bin_dir.display()))?;
    write_helper_wrapper(&bin_dir, "hs-pane", "hs-pane")?;
    Ok((prompts_dir, bin_dir))
}

fn path_with(bin_dir: &Path, base: Option<&str>) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    match base {
        Some(p) if !p.is_empty() => format!("{}{sep}{p}", bin_dir.display()),
        _ => bin_dir.display().to_string(),
    }
}

fn write_helper_wrapper(bin_dir: &Path, name: &str, subcmd: &str) -> Result<()> {
    let exe = std::env::current_exe()
        .map(|e| crate::exe_path::strip_deleted_exe_suffix(&e))
        .context("resolving this daemon's binary for the helper wrapper")?;
    let path = bin_dir.join(name);
    let script = format!(
        "#!/bin/sh\n# Houston pane helper — talks to this pane's daemon.\nexec {} {subcmd} \"$@\"\n",
        swarm_shell_quote(&exe.display().to_string()),
    );
    std::fs::write(&path, &script).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod {}", path.display()))?;
    }
    #[cfg(windows)]
    write_windows_cmd_wrapper(bin_dir, name, &exe, subcmd)?;
    Ok(())
}

fn swarm_shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(windows)]
fn write_windows_cmd_wrapper(bin_dir: &Path, name: &str, exe: &Path, subcmd: &str) -> Result<()> {
    let path = bin_dir.join(format!("{name}.cmd"));
    let escaped_exe = exe.display().to_string().replace('%', "%%");
    let script = format!("@echo off\r\n\"{escaped_exe}\" {subcmd} %*\r\nexit /b %ERRORLEVEL%\r\n");
    std::fs::write(&path, &script).with_context(|| format!("writing {}", path.display()))
}

#[cfg(all(test, windows))]
mod windows_helper_wrapper_tests {
    use super::*;

    #[test]
    fn write_helper_wrapper_emits_both_files_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        write_helper_wrapper(dir.path(), "hs-pane", "hs-pane").unwrap();

        let sh_path = dir.path().join("hs-pane");
        assert!(sh_path.is_file(), "the sh variant must still be written");
        let sh_content = std::fs::read_to_string(&sh_path).unwrap();
        assert!(
            sh_content.starts_with("#!/bin/sh\n"),
            "the sh variant's shape must be unchanged: {sh_content:?}"
        );

        let cmd_path = dir.path().join("hs-pane.cmd");
        assert!(
            cmd_path.is_file(),
            "Windows must also get a `.cmd` wrapper for PATHEXT resolution"
        );
    }

    #[test]
    fn cmd_wrapper_quotes_a_space_in_the_exe_path_and_forwards_args() {
        let dir = tempfile::tempdir().unwrap();
        let exe = Path::new(r"C:\Users\dev\AppData\Local\Houston\houston.exe");
        write_windows_cmd_wrapper(dir.path(), "hs-pane", exe, "hs-pane").unwrap();

        let content = std::fs::read_to_string(dir.path().join("hs-pane.cmd")).unwrap();
        assert!(
            content.contains(r#""C:\Users\dev\AppData\Local\Houston\houston.exe" hs-pane %*"#),
            "the space in the exe path must sit inside one quoted run with the \
             subcommand outside it, and every argument must be forwarded via \
             %*: {content:?}"
        );
        assert!(
            content.to_lowercase().starts_with("@echo off"),
            "must suppress command echoing: {content:?}"
        );
        assert!(
            content.contains("exit /b %ERRORLEVEL%"),
            "must propagate the daemon binary's own exit code, not cmd.exe's \
             own guess at whether the last line succeeded: {content:?}"
        );
    }

    #[test]
    fn cmd_wrapper_doubles_a_literal_percent_in_the_exe_path() {
        let dir = tempfile::tempdir().unwrap();
        let exe = Path::new(r"C:\Users\100%dev\houston.exe");
        write_windows_cmd_wrapper(dir.path(), "hs-pane", exe, "hs-pane").unwrap();

        let content = std::fs::read_to_string(dir.path().join("hs-pane.cmd")).unwrap();
        assert!(
            content.contains(r"C:\Users\100%%dev\houston.exe"),
            "a literal % in the exe path must be doubled, not left singly \
             (which cmd.exe would try to expand as a variable): {content:?}"
        );
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_ms() -> u64 {
    now_unix() * 1000
}

pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod hook_state_registry_tests {
    use super::*;

    fn roster() -> Vec<proto::SwarmRosterEntry> {
        vec![proto::SwarmRosterEntry {
            label: "Agent".into(),
            role: proto::SwarmRole::Coordinator,
            agent: proto::AgentKind::Custom,
            auto_approve: false,
            plan_mode: false,
            model: None,
            custom_prompt: None,
            cmd: Some(vec!["true".into()]),
        }]
    }

    #[test]
    fn boot_rebuilds_a_hand_corrupted_registry_from_sqlite() {
        let state = tempfile::tempdir().unwrap();
        let db_path = state.path().join("t.db");
        let root = tempfile::tempdir().unwrap();
        let root_s = root.path().display().to_string();
        let id = {
            let daemon = Daemon::new(DaemonConfig {
                token: "t".into(),
                db_path: db_path.clone(),
            })
            .unwrap();
            daemon
                .db
                .swarm_create("S", &root_s, "goal", &roster(), 60)
                .unwrap()
                .0
                .id
        };
        std::fs::create_dir_all(crate::hook_state::hook_state_dir(state.path())).unwrap();
        std::fs::write(
            crate::hook_state::scopes_path(state.path()),
            b"{\"v\":1,\"scopes\": TRUNCATED",
        )
        .unwrap();
        assert!(crate::hook_state::read_scopes(state.path()).is_empty());

        let _daemon2 = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path,
        })
        .unwrap();
        let healed = crate::hook_state::read_scopes(state.path());
        assert_eq!(healed.len(), 1, "boot must rebuild wholesale: {healed:?}");
        assert_eq!(healed[0].swarm, id);
    }
}

#[cfg(test)]
mod swarm_send_inbox_tests {
    use super::*;

    fn test_daemon() -> (Arc<Daemon>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("h.db");
        (
            Daemon::new(DaemonConfig {
                token: "t".into(),
                db_path,
            })
            .unwrap(),
            dir,
        )
    }

    fn roster_two() -> Vec<proto::SwarmRosterEntry> {
        vec![
            proto::SwarmRosterEntry {
                label: "Alice".into(),
                role: proto::SwarmRole::Builder,
                agent: proto::AgentKind::Custom,
                auto_approve: false,
                plan_mode: false,
                model: None,
                custom_prompt: None,
                cmd: None,
            },
            proto::SwarmRosterEntry {
                label: "Bob".into(),
                role: proto::SwarmRole::Builder,
                agent: proto::AgentKind::Custom,
                auto_approve: false,
                plan_mode: false,
                model: None,
                custom_prompt: None,
                cmd: None,
            },
        ]
    }

    #[test]
    fn agent_send_is_an_inbox_row() {
        let (daemon, _state) = test_daemon();
        let root = tempfile::tempdir().unwrap();
        let (info, agents) = daemon
            .db
            .swarm_create(
                "S",
                &root.path().display().to_string(),
                "goal",
                &roster_two(),
                60,
            )
            .unwrap();
        let bob = agents.iter().find(|a| a.label == "Bob").unwrap();
        daemon
            .db
            .swarm_agent_bind_session(bob.id, None, Some(4242))
            .unwrap();

        daemon
            .swarm_send(
                info.id,
                "Alice",
                "Bob",
                "ship the thing",
                proto::SwarmMsgKind::Message,
            )
            .unwrap();

        assert_eq!(
            daemon.db.swarm_messages(info.id, 500).unwrap().len(),
            1,
            "the swarm history table still gets its row"
        );

        let rows = daemon.db.inbox_list_for_session(4242).unwrap();
        assert_eq!(rows.len(), 1, "Bob's session must have exactly one row");
        assert_eq!(rows[0].kind, "mail");
        assert!(rows[0].body.contains("ship the thing"));
    }

    #[test]
    fn mail_to_a_recipient_with_no_live_session_reaches_the_operator() {
        let (daemon, _state) = test_daemon();
        let root = tempfile::tempdir().unwrap();
        let (info, _agents) = daemon
            .db
            .swarm_create(
                "S",
                &root.path().display().to_string(),
                "goal",
                &roster_two(),
                60,
            )
            .unwrap();

        daemon
            .swarm_send(
                info.id,
                "Alice",
                "Bob",
                "ship the thing",
                proto::SwarmMsgKind::Message,
            )
            .unwrap();

        let operator_rows = daemon.db.inbox_list_operator(&info.root_dir).unwrap();
        assert_eq!(operator_rows.len(), 1);
        assert_eq!(
            operator_rows[0]
                .reason
                .as_deref()
                .unwrap_or_default()
                .split(':')
                .next(),
            Some("parent_dead")
        );
    }
}

#[cfg(test)]
mod stdin_write_progress_tests {
    use super::*;

    struct HalfWriter {
        accept: usize,
        calls: usize,
    }

    impl Write for HalfWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.calls += 1;
            if self.calls == 1 {
                return Ok(self.accept.min(buf.len()));
            }
            Err(IoError::new(std::io::ErrorKind::BrokenPipe, "gone"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_write_that_fails_after_the_first_bytes_reports_what_landed() {
        let mut w = HalfWriter {
            accept: 4,
            calls: 0,
        };
        let (written, _) = write_all_counting(&mut w, b"0123456789").expect_err("it fails");
        assert_eq!(
            written, 4,
            "four bytes are on the wire; retrying the whole payload would paste them twice"
        );
    }

    #[test]
    fn a_write_that_fails_immediately_is_a_proven_zero() {
        let mut w = HalfWriter {
            accept: 0,
            calls: 1,
        };
        let (written, _) = write_all_counting(&mut w, b"0123456789").expect_err("it fails");
        assert_eq!(written, 0);
        let err = StdinWriteError {
            written: Some(written),
            error: anyhow!("gone"),
        };
        assert!(err.nothing_written(), "only this one may be retried");
    }

    #[test]
    fn a_backend_that_cannot_say_is_never_read_as_zero() {
        let err = StdinWriteError::unknown(anyhow!("ssh write failed"));
        assert!(
            !err.nothing_written(),
            "unknown progress is treated as partial, never as nothing"
        );
        assert!(format!("{err}").contains("cannot say"));
    }

    #[test]
    fn a_full_write_succeeds_across_several_partial_accepts() {
        struct Trickle;
        impl Write for Trickle {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                Ok(1.min(buf.len()))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        write_all_counting(&mut Trickle, b"hello").expect("a slow writer still finishes");
    }
}

#[cfg(test)]
mod swarm_mail_gc_sweep_dir_tests {
    use super::*;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    fn synth_id(ms_ago: u64, suffix: &str) -> String {
        format!("{:013}-{suffix}", now_ms().saturating_sub(ms_ago))
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn keeps_an_old_file_not_yet_in_the_durable_set() {
        let tmp = tempfile::tempdir().unwrap();
        let ago = Daemon::SWARM_MAIL_GC_RETENTION_MS + 3_600_000;
        let ingested_id = synth_id(ago, "deadbeef");
        let uningested_id = synth_id(ago, "cafebabe");
        std::fs::write(tmp.path().join(format!("{ingested_id}.json")), b"{}").unwrap();
        std::fs::write(tmp.path().join(format!("{uningested_id}.json")), b"{}").unwrap();

        let listing: Vec<std::ffi::OsString> = vec![
            format!("{ingested_id}.json").into(),
            format!("{uningested_id}.json").into(),
        ];
        let mut durable = HashSet::new();
        durable.insert(ingested_id.clone());
        let cutoff_ms = now_ms() - Daemon::SWARM_MAIL_GC_RETENTION_MS;

        let mut warned = HashSet::new();
        let (removed, bytes) = Daemon::gc_sweep_dir(
            1,
            tmp.path(),
            "transcript/",
            &listing,
            &durable,
            cutoff_ms,
            &mut warned,
        );

        assert_eq!(removed, 1, "exactly the ingested file must be removed");
        assert!(bytes > 0, "the reclaimed bytes must be counted");
        assert!(
            !tmp.path().join(format!("{ingested_id}.json")).exists(),
            "old + ingested file must be removed"
        );
        assert!(
            tmp.path().join(format!("{uningested_id}.json")).exists(),
            "old but not-yet-ingested file must survive — the safety gate"
        );
    }

    #[test]
    fn keeps_a_file_whose_name_does_not_parse_and_warns() {
        let tmp = tempfile::tempdir().unwrap();
        let name = "0000000000000-seed-primary-goal.json";
        std::fs::write(tmp.path().join(name), b"{}").unwrap();
        let listing: Vec<std::ffi::OsString> = vec![name.into()];
        let mut durable = HashSet::new();
        durable.insert("0000000000000-seed-primary-goal".to_string());
        let cutoff_ms = u64::MAX;

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut warned = HashSet::new();
        let (removed, _bytes) = tracing::subscriber::with_default(subscriber, || {
            Daemon::gc_sweep_dir(
                1,
                tmp.path(),
                "plan/events/",
                &listing,
                &durable,
                cutoff_ms,
                &mut warned,
            )
        });

        assert_eq!(
            removed, 0,
            "a file whose name doesn't parse must never be removed"
        );
        assert!(tmp.path().join(name).exists());
        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains(name),
            "the warning must name the offending file: {logged}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn warns_once_per_unparseable_file_across_repeated_sweeps_not_every_time() {
        use std::os::unix::ffi::OsStrExt;

        let tmp = tempfile::tempdir().unwrap();
        let unparseable_name = "0000000000000-seed-primary-goal.json";
        std::fs::write(tmp.path().join(unparseable_name), b"{}").unwrap();

        let mut raw = b"\xffbad".to_vec();
        raw.extend_from_slice(b".json");
        assert!(
            std::str::from_utf8(&raw).is_err(),
            "fixture filename must actually be non-UTF-8"
        );
        let non_utf8_name = std::ffi::OsStr::from_bytes(&raw).to_os_string();
        std::fs::write(tmp.path().join(&non_utf8_name), b"{}").unwrap();

        let listing: Vec<std::ffi::OsString> = vec![unparseable_name.into(), non_utf8_name.clone()];
        let durable = HashSet::new();
        let cutoff_ms = u64::MAX;

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut warned = HashSet::new();
        let ((first_removed, _), (second_removed, _), (third_removed, _)) =
            tracing::subscriber::with_default(subscriber, || {
                let first = Daemon::gc_sweep_dir(
                    1,
                    tmp.path(),
                    "plan/events/",
                    &listing,
                    &durable,
                    cutoff_ms,
                    &mut warned,
                );
                let second = Daemon::gc_sweep_dir(
                    1,
                    tmp.path(),
                    "plan/events/",
                    &listing,
                    &durable,
                    cutoff_ms,
                    &mut warned,
                );
                let third = Daemon::gc_sweep_dir(
                    1,
                    tmp.path(),
                    "plan/events/",
                    &listing,
                    &durable,
                    cutoff_ms,
                    &mut warned,
                );
                (first, second, third)
            });

        assert_eq!(first_removed, 0);
        assert_eq!(second_removed, 0);
        assert_eq!(third_removed, 0);
        assert!(tmp.path().join(unparseable_name).exists());
        assert!(tmp.path().join(&non_utf8_name).exists());

        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            logged.matches(unparseable_name).count(),
            1,
            "the parse-failure warning must fire exactly once across three sweeps of the same \
             permanent condition, not once per sweep: {logged}"
        );
        assert_eq!(
            logged.matches("not valid UTF-8").count(),
            1,
            "the non-UTF-8 warning must fire exactly once across three sweeps of the same \
             permanent condition, not once per sweep: {logged}"
        );
    }

    #[test]
    fn warned_unparseable_tracking_is_pruned_when_the_file_leaves_the_listing() {
        let tmp = tempfile::tempdir().unwrap();
        let name = "0000000000000-seed-primary-goal.json";
        std::fs::write(tmp.path().join(name), b"{}").unwrap();
        let listing: Vec<std::ffi::OsString> = vec![name.into()];
        let durable = HashSet::new();
        let cutoff_ms = u64::MAX;

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let mut warned = HashSet::new();
        tracing::subscriber::with_default(subscriber, || {
            Daemon::gc_sweep_dir(
                1,
                tmp.path(),
                "plan/events/",
                &listing,
                &durable,
                cutoff_ms,
                &mut warned,
            );
            Daemon::gc_sweep_dir(
                1,
                tmp.path(),
                "plan/events/",
                &[],
                &durable,
                cutoff_ms,
                &mut warned,
            );
        });

        assert!(
            warned.is_empty(),
            "tracking for a file no longer in the listing must be pruned, not leaked: {warned:?}"
        );
    }

    #[test]
    fn keeps_a_file_newer_than_the_bound_even_when_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let id = synth_id(1_000, "cafebabe");
        std::fs::write(tmp.path().join(format!("{id}.json")), b"{}").unwrap();
        let listing: Vec<std::ffi::OsString> = vec![format!("{id}.json").into()];
        let mut durable = HashSet::new();
        durable.insert(id.clone());
        let cutoff_ms = now_ms() - Daemon::SWARM_MAIL_GC_RETENTION_MS;

        let mut warned = HashSet::new();
        let (removed, _bytes) = Daemon::gc_sweep_dir(
            1,
            tmp.path(),
            "transcript/",
            &listing,
            &durable,
            cutoff_ms,
            &mut warned,
        );

        assert_eq!(removed, 0);
        assert!(tmp.path().join(format!("{id}.json")).exists());
    }
}

#[cfg(test)]
mod extract_activity_tests {
    use super::*;

    #[test]
    fn activity_extractor_skips_noise_and_caps() {
        let noisy = b"\x1b[32mworking on parser\x1b[0m\n$ \n>\n---\n";
        assert_eq!(
            Daemon::extract_activity(noisy).as_deref(),
            Some("working on parser")
        );
        assert_eq!(
            Daemon::extract_activity(b"--- HoustonSwarm Inbox ---\nNo messages\n"),
            None
        );
        let long = format!("{}\n", "a".repeat(200));
        let got = Daemon::extract_activity(long.as_bytes()).unwrap();
        assert_eq!(got.chars().count(), 90);
        assert!(got.ends_with('…'));
    }
}

#[cfg(test)]
mod agent_profile_env_tests {
    use super::*;

    fn test_daemon() -> (Arc<Daemon>, tempfile::TempDir) {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path: state.path().join("t.db"),
        })
        .unwrap();
        (daemon, state)
    }

    #[test]
    fn no_active_profile_means_no_env_override() {
        let (daemon, _state) = test_daemon();
        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Claude),
            None
        );
        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Codex),
            None
        );
    }

    #[test]
    fn active_profile_maps_to_the_right_variable_name() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        let claude_id = profiles[0].id;
        daemon
            .agent_profile_set_active(proto::AgentKind::Claude, Some(claude_id))
            .unwrap();

        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Claude),
            Some((
                "CLAUDE_CONFIG_DIR".to_string(),
                "/tmp/claude-work".to_string()
            ))
        );
        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Codex),
            None
        );

        daemon
            .agent_profile_upsert(
                None,
                proto::AgentKind::Codex,
                "personal",
                "/tmp/codex-personal",
            )
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        let codex_id = profiles
            .iter()
            .find(|p| p.agent == proto::AgentKind::Codex)
            .unwrap()
            .id;
        daemon
            .agent_profile_set_active(proto::AgentKind::Codex, Some(codex_id))
            .unwrap();
        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Codex),
            Some(("CODEX_HOME".to_string(), "/tmp/codex-personal".to_string()))
        );
    }

    #[test]
    fn a_tilde_in_a_profile_is_expanded_before_it_reaches_the_agent() {
        let (daemon, _state) = test_daemon();
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|h| !h.is_empty())
            .map(std::path::PathBuf::from)
            .expect("HOME or USERPROFILE must be set to run this test");
        let home = home.display().to_string();
        daemon
            .agent_profile_upsert(
                None,
                proto::AgentKind::Claude,
                "personal",
                "~/.claude-personal",
            )
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        daemon
            .agent_profile_set_active(proto::AgentKind::Claude, Some(profiles[0].id))
            .unwrap();

        let expected = std::path::Path::new(&home)
            .join(".claude-personal")
            .display()
            .to_string();
        assert_eq!(
            daemon.active_agent_profile_env(proto::AgentKind::Claude),
            Some(("CLAUDE_CONFIG_DIR".to_string(), expected)),
            "an exported CLAUDE_CONFIG_DIR must be a path the agent can open"
        );
    }

    #[test]
    fn every_other_agent_kind_is_a_no_op() {
        let (daemon, _state) = test_daemon();
        for kind in [
            proto::AgentKind::Opencode,
            proto::AgentKind::Shell,
            proto::AgentKind::Custom,
            proto::AgentKind::Ssh,
        ] {
            assert_eq!(daemon.active_agent_profile_env(kind), None, "{kind:?}");
        }
    }

    #[test]
    fn absent_choice_defers_to_the_active_switch_and_carries_its_label() {
        let (daemon, _state) = test_daemon();
        assert_eq!(
            daemon
                .resolve_spawn_profile(proto::AgentKind::Claude, None)
                .unwrap(),
            (None, None),
            "no active profile, no explicit choice: no override, no label"
        );
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        daemon
            .agent_profile_set_active(proto::AgentKind::Claude, Some(profiles[0].id))
            .unwrap();
        assert_eq!(
            daemon
                .resolve_spawn_profile(proto::AgentKind::Claude, None)
                .unwrap(),
            (
                Some((
                    "CLAUDE_CONFIG_DIR".to_string(),
                    "/tmp/claude-work".to_string()
                )),
                Some("work".to_string())
            )
        );
    }

    #[test]
    fn explicit_default_bypasses_an_active_switch() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        daemon
            .agent_profile_set_active(proto::AgentKind::Claude, Some(profiles[0].id))
            .unwrap();
        assert_eq!(
            daemon
                .resolve_spawn_profile(
                    proto::AgentKind::Claude,
                    Some(&proto::ProfileChoice::Default)
                )
                .unwrap(),
            (None, None),
            "Default must win over the active switch, not merely when none is set"
        );
    }

    #[test]
    fn explicit_profile_id_overrides_the_active_switch() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
            .unwrap();
        daemon
            .agent_profile_upsert(
                None,
                proto::AgentKind::Claude,
                "personal",
                "/tmp/claude-personal",
            )
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        let work_id = profiles.iter().find(|p| p.name == "work").unwrap().id;
        let personal_id = profiles.iter().find(|p| p.name == "personal").unwrap().id;
        daemon
            .agent_profile_set_active(proto::AgentKind::Claude, Some(work_id))
            .unwrap();
        assert_eq!(
            daemon
                .resolve_spawn_profile(
                    proto::AgentKind::Claude,
                    Some(&proto::ProfileChoice::Profile { id: personal_id })
                )
                .unwrap(),
            (
                Some((
                    "CLAUDE_CONFIG_DIR".to_string(),
                    "/tmp/claude-personal".to_string()
                )),
                Some("personal".to_string())
            ),
            "the explicit choice must win, not the switch (still pointing at work)"
        );
    }

    #[test]
    fn unknown_or_cross_agent_profile_id_is_refused_naming_known_labels() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "work", "/tmp/claude-work")
            .unwrap();
        daemon
            .agent_profile_upsert(
                None,
                proto::AgentKind::Codex,
                "codex-work",
                "/tmp/codex-work",
            )
            .unwrap();
        let proto::ServerMsg::AgentProfileState { profiles, .. } = daemon.agent_profile_state()
        else {
            unreachable!()
        };
        let codex_id = profiles
            .iter()
            .find(|p| p.agent == proto::AgentKind::Codex)
            .unwrap()
            .id;

        let err = daemon
            .resolve_spawn_profile(
                proto::AgentKind::Claude,
                Some(&proto::ProfileChoice::Profile { id: codex_id }),
            )
            .unwrap_err();
        assert!(
            err.to_string().contains(&codex_id.to_string()) && err.to_string().contains("work"),
            "refusal must name the offending id and Claude's own known labels: {err}"
        );

        let err = daemon
            .resolve_spawn_profile(
                proto::AgentKind::Claude,
                Some(&proto::ProfileChoice::Profile { id: 999_999 }),
            )
            .unwrap_err();
        assert!(err.to_string().contains("999999"), "{err}");
    }

    #[test]
    fn a_child_inherits_the_parents_profile_by_label() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "personal", "/tmp/claude-p")
            .unwrap();
        assert_eq!(
            daemon
                .resolve_inherited_profile(1, proto::AgentKind::Claude, "personal")
                .unwrap(),
            (
                vec![("CLAUDE_CONFIG_DIR".to_string(), "/tmp/claude-p".to_string())],
                Some("personal".to_string())
            )
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[allow(clippy::disallowed_methods)]
    fn child_env_var_reads_a_real_childs_environ() {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 5; :")
            .env("CLAUDE_CONFIG_DIR", "/tmp/tr-test-profile")
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn sh");
        let mut found = None;
        for _ in 0..50 {
            found = child_env_var(child.id(), "CLAUDE_CONFIG_DIR");
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(found.as_deref(), Some("/tmp/tr-test-profile"));
    }

    #[test]
    fn inheritance_falls_back_to_default_when_the_label_has_no_row() {
        let (daemon, _state) = test_daemon();
        daemon
            .agent_profile_upsert(None, proto::AgentKind::Claude, "personal", "/tmp/claude-p")
            .unwrap();
        assert_eq!(
            daemon
                .resolve_inherited_profile(1, proto::AgentKind::Codex, "personal")
                .unwrap(),
            (Vec::new(), None)
        );
    }
}

#[cfg(test)]
mod voice_mic_policy_tests {
    use super::*;

    fn settings(enabled: bool, policy: proto::MicPolicy) -> proto::VoiceSettings {
        proto::VoiceSettings {
            enabled,
            mic_policy: policy,
            ..Default::default()
        }
    }

    #[test]
    fn persistent_holds_the_device_only_while_dictation_is_enabled() {
        let on = settings(true, proto::MicPolicy::Persistent);
        assert!(voice_wants_open(&on, false, false));
        let off = settings(false, proto::MicPolicy::Persistent);
        assert!(
            !voice_wants_open(&off, false, false),
            "the policy is scoped by `enabled` — no device at boot (§4)"
        );
    }

    #[test]
    fn on_keypress_holds_nothing_when_idle() {
        let s = settings(true, proto::MicPolicy::OnKeypress);
        assert!(!voice_wants_open(&s, false, false));
    }

    #[test]
    fn the_level_meter_holds_the_device_even_under_on_keypress() {
        let s = settings(true, proto::MicPolicy::OnKeypress);
        assert!(voice_wants_open(&s, true, false));
    }

    #[test]
    fn an_utterance_in_flight_holds_the_device_against_everything_else() {
        let s = settings(true, proto::MicPolicy::OnKeypress);
        assert!(
            voice_wants_open(&s, false, true),
            "a held key must not lose its stream to a policy that would otherwise close it"
        );
        assert!(voice_wants_open(&s, false, true));
    }

    #[test]
    fn disabling_dictation_wins_over_an_in_flight_capture() {
        let off = settings(false, proto::MicPolicy::Persistent);
        assert!(voice_wants_open(&off, false, true));
    }
}

#[cfg(all(test, windows))]
mod windows_conpty_probe_tests {
    use super::*;

    const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

    #[test]
    fn conpty_spawns_echoes_eof_and_resizes() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty (ConPTY)");
        let mut cmd = CommandBuilder::new("cmd");
        cmd.args(["/C", "echo ok"]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn cmd /C echo ok");
        drop(pair.slave);
        let mut killer = child.clone_killer();

        pair.master
            .resize(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("master.resize on a live ConPTY pane");

        let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().expect("try_wait") {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = killer.kill();
                panic!("ConPTY probe child did not exit within 10s");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        let mut reader = pair.master.try_clone_reader().expect("try_clone_reader");
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name("conpty-probe-reader".to_string())
            .spawn(move || {
                let mut out = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => out.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = tx.send(out);
            })
            .expect("probe reader thread");

        drop(pair.master);
        let out = rx
            .recv_timeout(PROBE_TIMEOUT)
            .expect("reader finishes after master close");
        let text = String::from_utf8_lossy(&out);
        assert!(
            text.contains("ok"),
            "expected 'ok' in ConPTY echo output, got {text:?}"
        );
        assert_eq!(
            status.exit_code(),
            0,
            "cmd /C echo ok must report exit code 0 through ConPTY"
        );

        let _ = killer.kill();
    }
}

#[cfg(all(test, windows))]
mod windows_shell_ladder_tests {
    fn ladder_with(
        shell_override: Option<&str>,
        shell_env: Option<&str>,
        openssh: Option<&str>,
        powershell: Option<&str>,
        comspec: Option<&str>,
        present: &[&str],
    ) -> Vec<String> {
        super::default_shell_ladder(
            shell_override,
            shell_env,
            openssh,
            powershell,
            comspec,
            &|candidate| present.contains(&candidate),
        )
    }

    const BASH: &str = r"C:\Git\bin\bash.exe";
    const PWSH7: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";
    const WINPS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    const CMD: &str = r"C:\Windows\system32\cmd.exe";

    #[test]
    fn full_order_pins_every_rung() {
        let got = ladder_with(
            Some(PWSH7),
            Some(BASH),
            Some(PWSH7),
            Some(WINPS),
            Some(CMD),
            &[BASH, PWSH7, WINPS, CMD],
        );
        assert_eq!(
            got,
            vec![
                PWSH7.to_string(),
                BASH.to_string(),
                WINPS.to_string(),
                CMD.to_string(),
            ]
        );
    }

    #[test]
    fn override_is_never_existence_filtered() {
        let missing = r"C:\definitely\not\installed\sh.exe";
        let got = ladder_with(Some(missing), Some(BASH), None, Some(WINPS), Some(CMD), &[]);
        assert_eq!(got[0], missing);
        assert_eq!(got, vec![missing.to_string(), CMD.to_string()]);
    }

    #[test]
    fn missing_shell_env_rung_is_skipped_not_fatal() {
        let deleted_bash = r"C:\Deleted Install\bin\bash.exe";
        let got = ladder_with(
            None,
            Some(deleted_bash),
            Some(PWSH7),
            None,
            Some(CMD),
            &[PWSH7, CMD],
        );
        assert_eq!(got, vec![PWSH7.to_string(), CMD.to_string()]);
    }

    #[test]
    fn powershell_rung_precedes_comspec_when_present() {
        let got = ladder_with(None, None, None, Some(WINPS), Some(CMD), &[WINPS, CMD]);
        assert_eq!(got, vec![WINPS.to_string(), CMD.to_string()]);
    }

    #[test]
    fn comspec_unset_falls_to_literal_cmdexe_so_ladder_never_empties() {
        let got = ladder_with(None, None, None, None, None, &[]);
        assert_eq!(got, vec!["cmd.exe".to_string()]);
    }

    #[test]
    fn duplicate_binaries_collapse_into_one_attempt() {
        let got = ladder_with(
            None,
            None,
            Some(WINPS),
            Some(WINPS),
            Some(CMD),
            &[WINPS, CMD],
        );
        assert_eq!(got, vec![WINPS.to_string(), CMD.to_string()]);
    }

    #[test]
    fn blank_candidates_never_enter_the_ladder() {
        let got = ladder_with(Some("   "), Some(""), None, None, Some(CMD), &[CMD]);
        assert_eq!(got, vec![CMD.to_string()]);
    }

    #[test]
    fn terminal_rung_guarantees_non_empty_output() {
        let got = ladder_with(None, Some(BASH), Some(PWSH7), Some(WINPS), None, &[]);
        assert_eq!(got, vec!["cmd.exe".to_string()]);
    }
}

#[cfg(test)]
mod idle_profile_tests {
    use super::*;

    fn test_daemon() -> (Arc<Daemon>, tempfile::TempDir) {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path: state.path().join("t.db"),
        })
        .unwrap();
        (daemon, state)
    }

    fn interval(seconds: u32) -> proto::Cadence {
        proto::Cadence::Interval { seconds }
    }

    fn create_routine(daemon: &Daemon, name: &str, cadence: proto::Cadence) -> proto::Routine {
        let proto::ServerMsg::Routines { routines, .. } = daemon
            .routine_create_for_test(
                name,
                "do the thing",
                cadence,
                None,
                proto::AgentKind::Claude,
                None,
                None,
            )
            .expect("a well-formed create never Errs")
        else {
            panic!("routine_create must answer with Routines");
        };
        routines
            .into_iter()
            .find(|r| r.name == name)
            .expect("the routine just created is in the list")
    }

    #[test]
    fn nothing_armed_parks_the_routine_scheduler_indefinitely() {
        let (daemon, _state) = test_daemon();
        assert!(daemon.routine_next_wake_at(now_unix_ms()).is_none());
    }

    #[test]
    fn an_enabled_routine_arms_the_scheduler_to_its_next_run() {
        let (daemon, _state) = test_daemon();
        create_routine(&daemon, "r1", interval(3_600));
        let delay = daemon
            .routine_next_wake_at(now_unix_ms())
            .expect("an enabled routine must arm the scheduler");
        assert!(delay > Duration::from_secs(3_500), "delay was {delay:?}");
    }

    #[test]
    fn disabling_the_last_routine_parks_the_scheduler() {
        let (daemon, _state) = test_daemon();
        let routine = create_routine(&daemon, "r1", interval(3_600));
        assert!(daemon.routine_next_wake_at(now_unix_ms()).is_some());
        daemon
            .routine_update_for_test(
                routine.id,
                &routine.revision,
                None,
                None,
                None,
                Some(false),
                None,
                None,
                None,
            )
            .expect("disable must succeed");
        assert!(
            daemon.routine_next_wake_at(now_unix_ms()).is_none(),
            "the last enabled routine going disabled must park the scheduler"
        );
    }

    #[test]
    fn a_settling_pane_run_keeps_the_scheduler_polling() {
        let (daemon, _state) = test_daemon();
        assert!(daemon.routine_next_wake_at(now_unix_ms()).is_none());
        daemon
            .routine_runs
            .lock()
            .expect("routine run lock")
            .insert(
                1,
                RoutineRun {
                    run_id: 1,
                    session_id: Some(42),
                    started_at_ms: now_unix_ms(),
                    denied: false,
                },
            );
        let delay = daemon
            .routine_next_wake_at(now_unix_ms())
            .expect("a routine run holding a pane must keep the scheduler polling");
        assert!(delay <= Duration::from_millis(proto::ROUTINE_TICK_MS));
    }

    #[tokio::test]
    async fn a_notify_racing_entry_into_sleep_is_not_lost() {
        let (daemon, _state) = test_daemon();
        daemon.routine_wake.notify_one();
        tokio::time::timeout(Duration::from_millis(50), daemon.routine_wake.notified())
            .await
            .expect("a permit stored before the wait must still be observed");
    }

    #[tokio::test]
    async fn editing_a_routines_cadence_wakes_a_sleeping_scheduler() {
        let (daemon, _state) = test_daemon();
        let routine = create_routine(&daemon, "r1", interval(3_600));
        let notified = daemon.routine_wake.notified();
        tokio::pin!(notified);
        daemon
            .routine_update_for_test(
                routine.id,
                &routine.revision,
                None,
                None,
                Some(interval(300)),
                None,
                None,
                None,
                None,
            )
            .expect("cadence edit must succeed");
        tokio::time::timeout(Duration::from_millis(50), notified)
            .await
            .expect("a cadence edit must wake the sleeping scheduler");
    }

    #[test]
    fn delegation_open_arms_and_last_close_parks_the_watcher() {
        let (daemon, _state) = test_daemon();
        assert!(!daemon.delegation_watch_armed());
        daemon
            .db
            .delegation_create(1, 2, None, "brief", now_ms())
            .expect("open a delegation");
        assert!(
            daemon.delegation_watch_armed(),
            "an open delegation must arm the watcher"
        );
        daemon
            .db
            .delegation_finish(2, "done", None, now_ms())
            .expect("close the delegation");
        assert!(
            !daemon.delegation_watch_armed(),
            "the last open delegation closing must park the watcher"
        );
    }

    #[test]
    fn provider_activity_does_not_advance_a_delegation_round() {
        let (daemon, _state) = test_daemon();
        daemon
            .db
            .delegation_create(1, 2, None, "brief", now_ms())
            .expect("open a delegation");
        let before = daemon
            .db
            .delegation_for_child(2)
            .expect("read delegation")
            .expect("delegation exists");

        daemon.advance_delegation(2, crate::agent_events::AgentEvent::Activity);

        let after = daemon
            .db
            .delegation_for_child(2)
            .expect("read delegation")
            .expect("delegation exists");
        assert_eq!(after.state, before.state);
        assert_eq!(after.round, before.round);
    }
}

#[cfg(all(test, unix))]
mod handoff_refusal_tests {
    use super::*;
    use std::os::fd::AsRawFd;

    fn test_daemon() -> (Arc<Daemon>, tempfile::TempDir) {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path: state.path().join("t.db"),
        })
        .unwrap();
        (daemon, state)
    }

    fn manifest_entry(id: u32) -> crate::adoption::SessionManifest {
        crate::adoption::SessionManifest {
            session_id: id,
            pid: None,
            cols: 80,
            rows: 24,
            output_offset: 0,
            state: proto::SessionState::Running,
            status: None,
            hidden: false,
            project_dir: "/tmp".into(),
            cwd: "/tmp".into(),
            title: "ssh".into(),
            codename: "ssh".into(),
            tags: vec![],
            agent: proto::AgentKind::Shell,
            swarm_agent: None,
            hook_cwd: None,
            mcp_cred: None,
            vt_snapshot: Vec::new(),
            vt_format_version: 0,
        }
    }

    fn spare_fd() -> std::net::TcpListener {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap()
    }

    #[test]
    fn a_live_ssh_session_refuses_the_whole_handoff_by_id() {
        let (daemon, _state) = test_daemon();
        let session = Daemon::adopted_session(
            &manifest_entry(7),
            Backend::Ssh(crate::ssh::SshHandle::stub()),
        );
        daemon
            .sessions
            .lock()
            .expect("sessions lock")
            .insert(7, session);

        let result = daemon.begin_handoff(None);
        assert!(!result.accepted);
        let reason = result.reason.unwrap_or_default();
        assert!(
            reason.contains("SSH") && reason.contains('7'),
            "the refusal must name the SSH session's id: {reason}"
        );
    }

    #[test]
    fn a_daemon_with_no_registered_listener_refuses_by_name() {
        let (daemon, _state) = test_daemon();
        let reason = daemon.begin_handoff(None).reason.unwrap_or_default();
        assert!(
            reason.contains("listener fd"),
            "the refusal must name the missing listener fd: {reason}"
        );
    }

    #[test]
    fn a_daemon_with_no_registered_lock_refuses_by_name() {
        let (daemon, _state) = test_daemon();
        let listener = spare_fd();
        daemon.set_listener_fd(listener.as_raw_fd());
        let reason = daemon.begin_handoff(None).reason.unwrap_or_default();
        assert!(
            reason.contains("lock fd"),
            "the refusal must name the missing lock fd: {reason}"
        );
    }

    #[test]
    fn a_daemon_with_no_supervisor_refuses_by_name() {
        let (daemon, _state) = test_daemon();
        let listener = spare_fd();
        let lock = spare_fd();
        daemon.set_listener_fd(listener.as_raw_fd());
        daemon.set_lock_fd(lock.as_raw_fd());
        let reason = daemon.begin_handoff(None).reason.unwrap_or_default();
        assert!(
            reason.contains("supervisor"),
            "the refusal must name the missing supervisor: {reason}"
        );
    }

    #[test]
    fn no_candidate_falls_back_to_this_processes_own_executable() {
        let resolved = handoff_binary(None).expect("current_exe resolves in a test process");
        assert_eq!(
            resolved,
            std::env::current_exe().expect("current_exe"),
            "an absent candidate must keep the pre-candidate behavior"
        );
    }

    #[test]
    fn a_handoff_already_in_progress_is_refused_by_name() {
        let (daemon, _state) = test_daemon();
        daemon.handing_off.store(true, Ordering::Release);
        let reason = daemon.begin_handoff(None).reason.unwrap_or_default();
        assert!(reason.contains("already in progress"), "{reason}");
    }

    #[test]
    fn a_relative_candidate_is_refused_by_name() {
        let err = handoff_binary(Some("houston-core")).unwrap_err();
        assert!(err.contains("\"houston-core\""), "{err}");
        assert!(err.contains("absolute"), "{err}");
    }

    #[test]
    fn a_missing_candidate_is_refused_by_name() {
        let err = handoff_binary(Some("/nonexistent/houston-core-candidate")).unwrap_err();
        assert!(err.contains("/nonexistent/houston-core-candidate"), "{err}");
        assert!(err.contains("cannot be read"), "{err}");
    }

    #[test]
    fn a_directory_candidate_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().to_string_lossy().into_owned();
        let err = handoff_binary(Some(&raw)).unwrap_err();
        assert!(err.contains(&raw), "{err}");
        assert!(err.contains("not a regular file"), "{err}");
    }

    #[test]
    fn a_non_executable_candidate_is_refused_by_name() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("houston-core");
        std::fs::write(&file, b"not a binary").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let raw = file.to_string_lossy().into_owned();
        let err = handoff_binary(Some(&raw)).unwrap_err();
        assert!(err.contains(&raw), "{err}");
        assert!(err.contains("not executable"), "{err}");
    }

    #[test]
    fn an_executable_candidate_resolves_verbatim() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("houston-core");
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            handoff_binary(Some(&file.to_string_lossy())).unwrap(),
            file,
            "a valid candidate must resolve to the exact path the caller named"
        );
    }
}

#[cfg(all(test, not(target_os = "linux")))]
mod handoff_platform_refusal_tests {
    use super::*;

    #[test]
    fn handoff_refuses_by_platform_off_linux() {
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path: state.path().join("t.db"),
        })
        .unwrap();
        let result = daemon.begin_handoff(None);
        assert!(!result.accepted);
        let reason = result.reason.unwrap_or_default();
        assert!(
            reason.contains("Linux"),
            "an off-Linux refusal must say so: {reason}"
        );
    }
}

#[cfg(test)]
mod codex_trust_row_tests {
    use super::*;

    struct HomeGuard(Option<std::ffi::OsString>);
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(v) = self.0.take() {
                // SAFETY: single-threaded test process; no other thread reads env
                // concurrently with this restore.
                unsafe {
                    std::env::set_var("HOME", v);
                }
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    fn home_guard(home: &std::path::Path) -> HomeGuard {
        let prev = std::env::var_os("HOME");
        // SAFETY: single-threaded test process; no other thread reads env
        // concurrently with this mutation.
        unsafe {
            std::env::set_var("HOME", home);
        }
        HomeGuard(prev)
    }

    #[test]
    fn codex_trust_is_reported_on_the_setup_row() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(codex.join("hooks.json"), "{}").unwrap();
        std::fs::write(codex.join("config.toml"), "[model]\nname = \"gpt-5\"\n").unwrap();

        let _guard = home_guard(home.path());
        let state = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(DaemonConfig {
            token: "t".into(),
            db_path: state.path().join("t.db"),
        })
        .unwrap();

        let rows = daemon.agent_hooks_state();
        let codex_row = rows
            .iter()
            .find(|r| r.provider == proto::AgentKind::Codex)
            .expect("a Codex row");
        assert_eq!(
            codex_row.trust,
            Some(proto::HookTrust::NotConfirmed),
            "hooks installed but no [hooks.state] reads as not confirmed"
        );
        let claude_row = rows
            .iter()
            .find(|r| r.provider == proto::AgentKind::Claude)
            .expect("a Claude row");
        assert_eq!(
            claude_row.trust, None,
            "a provider without a trust seam carries no trust field"
        );
    }
}

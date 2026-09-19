#[cfg(unix)]
use houston_core::supervisor::{self, ExitReport, SpawnNext, ToSupervisor};
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process;
#[cfg(unix)]
use std::sync::mpsc::{self, Sender};
#[cfg(unix)]
use std::thread;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match Cli::parse(&args) {
        Ok(cli) => cli,
        Err(msg) => {
            eprintln!("houston-supervisor: {msg}");
            process::exit(2);
        }
    };
    if let Err(msg) = check_channel_dir_paths(&cli.channel_dir) {
        eprintln!("houston-supervisor: {msg}");
        process::exit(2);
    }
    if let Err(e) = nix::sys::prctl::set_child_subreaper(true) {
        eprintln!("houston-supervisor: PR_SET_CHILD_SUBREAPER failed: {e}");
        process::exit(1);
    }
    run(cli);
}

#[cfg(windows)]
fn main() {
    eprintln!(
        "houston-supervisor: the daemon supervisor is Linux-only; on Windows the app starts \
         houston-core directly"
    );
    std::process::exit(1);
}

#[cfg(unix)]
struct Cli {
    channel_dir: PathBuf,
    daemon_path: String,
    daemon_args: Vec<String>,
}

#[cfg(unix)]
impl Cli {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut channel_dir = None;
        let mut daemon_path = None;
        let mut daemon_args = Vec::new();
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--channel-dir" => {
                    i += 1;
                    let v = args.get(i).ok_or("--channel-dir requires a value")?;
                    channel_dir = Some(PathBuf::from(v));
                }
                "--daemon" => {
                    i += 1;
                    let v = args.get(i).ok_or("--daemon requires a value")?;
                    daemon_path = Some(v.clone());
                }
                "--" => {
                    daemon_args = args[i + 1..].to_vec();
                    break;
                }
                other => return Err(format!("unrecognized argument {other:?}")),
            }
            i += 1;
        }
        Ok(Cli {
            channel_dir: channel_dir.ok_or("--channel-dir is required")?,
            daemon_path: daemon_path.ok_or("--daemon is required")?,
            daemon_args,
        })
    }
}

#[cfg(unix)]
const PATH_MAX_ISH: usize = 4096;

#[cfg(unix)]
fn check_channel_dir_paths(channel_dir: &Path) -> Result<(), String> {
    let sup_json = channel_dir.join("supervisor.json");
    let len = sup_json.as_os_str().len();
    if len >= PATH_MAX_ISH {
        return Err(format!(
            "channel dir too long: supervisor.json's path is {len} bytes, limit is \
             {PATH_MAX_ISH} (PATH_MAX)"
        ));
    }
    Ok(())
}

#[cfg(unix)]
enum Event {
    Reaped {
        pid: i32,
        code: Option<i32>,
        signal: Option<i32>,
    },
    NoChildrenLeft,
    SpawnRequested(SpawnNext),
    ReaderClosed,
}

#[cfg(unix)]
fn run(cli: Cli) -> ! {
    let (tx, rx) = mpsc::channel::<Event>();

    {
        let tx = tx.clone();
        thread::spawn(move || reaper_loop(tx));
    }

    let mut generation: u64 = 1;
    let mut current_pid: Option<i32> = None;
    let mut writer: Option<UnixStream> = None;
    let mut generation_pids: std::collections::HashMap<i32, std::collections::VecDeque<u64>> =
        std::collections::HashMap::new();

    spawn_generation(
        &cli.channel_dir,
        &cli.daemon_path,
        &cli.daemon_args,
        generation,
        &mut current_pid,
        &mut writer,
        tx.clone(),
    );
    generation_pids
        .entry(current_pid.expect("spawn_generation always sets a pid"))
        .or_default()
        .push_back(generation);
    let mut daemon_alive = true;

    loop {
        match rx.recv() {
            Ok(Event::Reaped { pid, code, signal }) => {
                let owner_generation = match generation_pids.get_mut(&pid) {
                    Some(queue) => {
                        let owner = queue.pop_front();
                        let now_empty = queue.is_empty();
                        if now_empty {
                            generation_pids.remove(&pid);
                        }
                        owner
                    }
                    None => None,
                };
                if let Some(owner_generation) = owner_generation {
                    log(&format!(
                        "generation {owner_generation} (pid {pid}) exited code={code:?} signal={signal:?}"
                    ));
                    if Some(pid) == current_pid && owner_generation == generation {
                        current_pid = None;
                        daemon_alive = false;
                        writer = None;
                    }
                } else {
                    log(&format!(
                        "reaped orphan pid={pid} code={code:?} signal={signal:?}, relaying to generation {generation}"
                    ));
                    match writer.as_mut() {
                        Some(w) => {
                            if let Err(e) =
                                supervisor::write_exit_report(w, ExitReport { pid, code, signal })
                            {
                                log(&format!(
                                    "relaying exit report for pid {pid} to generation {generation}: {e}"
                                ));
                            }
                        }
                        None => log(&format!(
                            "no live generation to receive exit report for orphan pid={pid}; dropped"
                        )),
                    }
                }
            }
            Ok(Event::NoChildrenLeft) => {
                if daemon_alive {
                    continue;
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(Event::SpawnRequested(req)) => {
                        spawn_next_generation(
                            &cli,
                            req,
                            &mut generation,
                            &mut current_pid,
                            &mut writer,
                            &tx,
                        );
                        generation_pids
                            .entry(current_pid.expect("just spawned"))
                            .or_default()
                            .push_back(generation);
                        daemon_alive = true;
                    }
                    Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {
                        log("exiting: no daemon generation alive, no orphans remain, no spawn pending");
                        process::exit(0);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => process::exit(0),
                }
            }
            Ok(Event::SpawnRequested(req)) => {
                spawn_next_generation(
                    &cli,
                    req,
                    &mut generation,
                    &mut current_pid,
                    &mut writer,
                    &tx,
                );
                generation_pids
                    .entry(current_pid.expect("just spawned"))
                    .or_default()
                    .push_back(generation);
                daemon_alive = true;
            }
            Ok(Event::ReaderClosed) => {}
            Err(_) => {
                process::exit(0);
            }
        }
    }
}

#[cfg(unix)]
fn reaper_loop(tx: Sender<Event>) {
    loop {
        use nix::sys::wait::{waitid, Id, WaitPidFlag, WaitStatus};
        match waitid(Id::All, WaitPidFlag::WEXITED) {
            Ok(WaitStatus::Exited(pid, code)) => {
                let _ = tx.send(Event::Reaped {
                    pid: pid.as_raw(),
                    code: Some(code),
                    signal: None,
                });
            }
            Ok(WaitStatus::Signaled(pid, sig, _)) => {
                let _ = tx.send(Event::Reaped {
                    pid: pid.as_raw(),
                    code: None,
                    signal: Some(sig as i32),
                });
            }
            Ok(_) => {}
            Err(nix::errno::Errno::ECHILD) => {
                let _ = tx.send(Event::NoChildrenLeft);
                thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                log(&format!("waitid error: {e}"));
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

#[cfg(unix)]
fn spawn_generation(
    channel_dir: &Path,
    daemon_path: &str,
    args: &[String],
    generation: u64,
    current_pid: &mut Option<i32>,
    writer: &mut Option<UnixStream>,
    tx: Sender<Event>,
) {
    let (sup_end, daemon_end) = UnixStream::pair().expect("houston-supervisor: socketpair");
    let pid = spawn_daemon_process(daemon_path, args, daemon_end);
    *current_pid = Some(pid);
    if let Err(e) = write_supervisor_json(channel_dir, generation) {
        log(&format!("writing supervisor.json: {e}"));
    }
    let reader_half = sup_end
        .try_clone()
        .expect("houston-supervisor: clone control socket for reader thread");
    *writer = Some(sup_end);
    thread::spawn(move || {
        let mut r = reader_half;
        loop {
            match supervisor::read_to_supervisor(&mut r) {
                Ok(ToSupervisor::SpawnNext(req)) => {
                    let _ = tx.send(Event::SpawnRequested(req));
                }
                Err(_) => {
                    let _ = tx.send(Event::ReaderClosed);
                    break;
                }
            }
        }
    });
}

#[cfg(unix)]
fn spawn_next_generation(
    cli: &Cli,
    req: SpawnNext,
    generation: &mut u64,
    current_pid: &mut Option<i32>,
    writer: &mut Option<UnixStream>,
    tx: &Sender<Event>,
) {
    *generation += 1;
    log(&format!(
        "spawn_next requested: generation {} <- {} {:?}",
        *generation, req.daemon_path, req.args
    ));
    spawn_generation(
        &cli.channel_dir,
        &req.daemon_path,
        &req.args,
        *generation,
        current_pid,
        writer,
        tx.clone(),
    );
}

#[cfg(unix)]
fn spawn_daemon_process(daemon_path: &str, args: &[String], daemon_end: UnixStream) -> i32 {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;

    let fd = daemon_end.as_raw_fd();
    let mut cmd = houston_core::spawn::command(daemon_path);
    cmd.args(args);
    cmd.env(supervisor::SUPERVISOR_FD_ENV, "3");
    // SAFETY: `dup2` is async-signal-safe, the only kind of call allowed
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!("houston-supervisor: spawning {daemon_path:?}: {e}"));
    let pid = child.id() as i32;
    drop(child);
    pid
}

#[cfg(unix)]
fn write_supervisor_json(channel_dir: &Path, generation: u64) -> std::io::Result<()> {
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let file = supervisor::SupervisorFile {
        pid: process::id(),
        pid_creation: houston_core::pid::self_creation_token(),
        generation,
    };
    let path = channel_dir.join("supervisor.json");
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, file.to_json())?;
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, &path)
}

#[cfg(unix)]
fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "houston-supervisor: {msg}");
}

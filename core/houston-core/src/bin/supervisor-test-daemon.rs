#[cfg(unix)]
use houston_core::supervisor;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::fd::FromRawFd;
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(windows)]
fn main() {
    eprintln!(
        "supervisor-test-daemon: drives houston-supervisor over Unix sockets, which is \
         Linux-only"
    );
    std::process::exit(1);
}

#[cfg(unix)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("gen1") => gen1(&args[1..]),
        Some("gen2") => gen2(&args[1..]),
        other => panic!("supervisor-test-daemon: unknown mode {other:?}"),
    }
}

#[cfg(unix)]
fn supervisor_stream() -> UnixStream {
    let fd_str = std::env::var(supervisor::SUPERVISOR_FD_ENV)
        .unwrap_or_else(|_| panic!("{} not set", supervisor::SUPERVISOR_FD_ENV));
    let fd: i32 = fd_str.parse().expect("valid fd number");
    // SAFETY: set by `houston-supervisor` on every generation it forks,
    // guaranteed open and ours alone (see `main.rs::spawn_supervisor_reader`).
    unsafe { UnixStream::from_raw_fd(fd) }
}

#[cfg(unix)]
fn gen1(args: &[String]) {
    let pidfile = &args[0];
    let child_mode = args[1].as_str();
    let result_file = args[2].clone();

    let child = match child_mode {
        "normal-exit" => houston_core::spawn::command("/bin/sh")
            .arg("-c")
            .arg("sleep 0.2; exit 42")
            .spawn(),
        // Spawns `/bin/sleep` directly, not through `sh -c`: some shells do not
        // exec-optimize a lone command, so `child.id()` would be the wrapper's pid
        // and killing it would leave the real sleep reparented onto the supervisor.
        "slow" | "no-handoff" => houston_core::spawn::command("/bin/sleep")
            .arg("100")
            .spawn(),
        other => panic!("unknown child-mode {other:?}"),
    }
    .expect("spawn orphan child");
    std::fs::write(pidfile, child.id().to_string()).expect("write pidfile");
    drop(child);

    if child_mode == "no-handoff" {
        return;
    }

    let mut stream = supervisor_stream();
    let exe = std::env::current_exe().expect("current_exe");
    let req = supervisor::SpawnNext {
        daemon_path: exe.to_string_lossy().to_string(),
        args: vec!["gen2".to_string(), result_file],
    };
    supervisor::write_spawn_next(&mut stream, &req).expect("write spawn_next");
}

#[cfg(unix)]
fn gen2(args: &[String]) {
    let result_file = &args[0];
    let mut stream = supervisor_stream();
    std::fs::write(format!("{result_file}.ready"), "").expect("write readiness marker");
    let supervisor::FromSupervisor::ChildExited(report) =
        supervisor::read_from_supervisor(&mut stream).expect("read exit report");
    let mut f = std::fs::File::create(result_file).expect("create result file");
    writeln!(f, "{}\n{:?}\n{:?}", report.pid, report.code, report.signal).expect("write result");
}

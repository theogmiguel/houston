#![cfg(windows)]
//! Every process the daemon starts is opted out of EcoQoS execution-speed throttling: a
//! session's console host, its child and that child's own children.

use houston_core::daemon::{CreateParams, Daemon, DaemonConfig};
use houston_protocol as proto;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessInformation, ProcessPowerThrottling, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
};

// Windows throttles 1–3 s after a process starts; the sweep must beat that by a margin, and
// a loaded runner gets the rest.
const OPTED_OUT_WITHIN: Duration = Duration::from_secs(10);

struct Process {
    pid: u32,
    parent: u32,
    name: String,
}

fn processes() -> Vec<Process> {
    let mut out = Vec::new();
    // SAFETY: `entry.dwSize` is set before the first Process32FirstW/Process32NextW call,
    // as they require; `snap` is checked before use and closed once.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert!(
            snap != INVALID_HANDLE_VALUE,
            "process snapshot failed: {}",
            std::io::Error::last_os_error()
        );
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut listed = Process32FirstW(snap, &mut entry) != 0;
        while listed {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            out.push(Process {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            listed = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    out
}

enum Throttling {
    OptedOut,
    Not(PROCESS_POWER_THROTTLING_STATE),
    Exited,
    Unreadable(std::io::Error),
}

fn throttling(pid: u32) -> Throttling {
    let read = houston_core::pid::with_process_info_handle(pid, |handle| {
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            // The OS validates this field on read as well as on write.
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        // SAFETY: a handle with query access and a correctly sized out-value.
        let ok = unsafe {
            GetProcessInformation(
                handle,
                ProcessPowerThrottling,
                &mut state as *mut PROCESS_POWER_THROTTLING_STATE as *mut core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(state)
        }
    });
    let speed = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    match read {
        Err(_) => Throttling::Exited,
        Ok(Err(error)) => Throttling::Unreadable(error),
        Ok(Ok(state)) if state.ControlMask & speed == speed && state.StateMask & speed == 0 => {
            Throttling::OptedOut
        }
        Ok(Ok(state)) => Throttling::Not(state),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_console_host_child_and_grandchild_are_opted_out_of_throttling() {
    let state = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(DaemonConfig::new(
        crate::common::TOKEN.to_string(),
        state.path().join("t.db"),
        crate::common::base_env(),
    ))
    .unwrap();
    tokio::spawn(houston_core::power_throttling::sweep_loop());
    let session = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Custom,
            project_dir: project.path().to_path_buf(),
            // cmd waits on ping: a child with a grandchild, both alive past the bound.
            cmd: Some(vec![
                "cmd".into(),
                "/C".into(),
                "ping -n 120 127.0.0.1 >NUL".into(),
            ]),
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
    let _kill = KillOnDrop(&daemon, session);

    // Process names identify the tree for this test only; the sweep itself walks parent
    // links from the daemon's own pid.
    let me = std::process::id();
    let started = Instant::now();
    loop {
        let all = processes();
        let named = |pid: u32| {
            all.iter()
                .find(|p| p.pid == pid)
                .map_or("?".to_string(), |p| p.name.clone())
        };
        let grandchild = all.iter().find(|p| {
            p.name.eq_ignore_ascii_case("PING.EXE")
                && all.iter().any(|c| c.pid == p.parent && c.parent == me)
        });
        let hosts: Vec<u32> = all
            .iter()
            .filter(|p| {
                p.parent == me
                    && (p.name.eq_ignore_ascii_case("conhost.exe")
                        || p.name.eq_ignore_ascii_case("OpenConsole.exe"))
            })
            .map(|p| p.pid)
            .collect();
        let mut tree = hosts.clone();
        if let Some(grandchild) = grandchild {
            tree.push(grandchild.parent);
            tree.push(grandchild.pid);
        }
        let mut pending = Vec::new();
        for pid in &tree {
            match throttling(*pid) {
                Throttling::OptedOut | Throttling::Exited => {}
                // Some Windows builds (the CI runner's among them) refuse this read with
                // ERROR_INVALID_PARAMETER; there is nothing to assert there.
                Throttling::Unreadable(e) if e.raw_os_error() == Some(87) => {
                    eprintln!("ProcessPowerThrottling read-back unsupported on this build: {e}");
                    return;
                }
                Throttling::Unreadable(e) => {
                    panic!(
                        "reading ProcessPowerThrottling of {} {pid}: {e}",
                        named(*pid)
                    )
                }
                Throttling::Not(state) => pending.push(format!(
                    "{} {pid}: ControlMask {:#x} StateMask {:#x}",
                    named(*pid),
                    state.ControlMask,
                    state.StateMask
                )),
            }
        }
        let report = format!(
            "console hosts {hosts:?}, child and grandchild {:?}; not opted out: {pending:?}",
            grandchild.map(|g| (g.parent, g.pid))
        );
        if grandchild.is_some() && !hosts.is_empty() && pending.is_empty() {
            eprintln!(
                "opted out within {} ms: {report}",
                started.elapsed().as_millis()
            );
            break;
        }
        assert!(
            started.elapsed() < OPTED_OUT_WITHIN,
            "session {session}'s process tree after {OPTED_OUT_WITHIN:?}: {report}; expected \
             every process with EXECUTION_SPEED set in ControlMask and clear in StateMask"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

struct KillOnDrop<'a>(&'a std::sync::Arc<Daemon>, u32);

impl Drop for KillOnDrop<'_> {
    fn drop(&mut self) {
        if let Err(error) = self.0.kill(self.1) {
            eprintln!("cleanup: killing session {} failed: {error:#}", self.1);
        }
    }
}

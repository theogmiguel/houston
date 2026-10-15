//! Windows EcoQoS (power throttling) opt-out for the daemon and every process it starts.

// Windows throttles a windowless process 1–3 s after it starts working, so a new process
// is reached within a second. A pass costs one system-wide process snapshot (9 ms with 508
// processes, measured in this module's tests), so passes run only after a spawn or output.
#[cfg(windows)]
const SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

// Passes after a spawn whether or not output follows: a launcher, shim or CLI can start a
// silent child of its own during the first seconds.
#[cfg(windows)]
const SPAWN_BURST: u32 = 3;

// Bounds one pass, and with it the remembered set, against an unusually large tree.
#[cfg(windows)]
const SWEEP_MAX_DESCENDANTS: usize = 4096;

// One sweep per process: its root is the process itself, not a particular daemon.
static SPAWNED: tokio::sync::Notify = tokio::sync::Notify::const_new();
static OUTPUT: tokio::sync::Notify = tokio::sync::Notify::const_new();
static OUTPUT_SEEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Opts the current process out of Windows execution-speed throttling (EcoQoS).
/// A failure is logged and never fails boot; Linux has no EcoQoS, so this is a
/// documented no-op there.
pub fn opt_out_execution_speed_throttling() {
    #[cfg(windows)]
    {
        // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing.
        let current = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcess() };
        if let Err(error) = win::opt_out(current) {
            tracing::warn!(
                "SetProcessInformation(ProcessPowerThrottling) failed ({error}); Windows may                  throttle this process"
            );
        }
    }
}

/// Wakes the descendant sweep after a session's process tree was created.
pub fn note_spawn() {
    if cfg!(windows) {
        SPAWNED.notify_one();
    }
}

/// Marks PTY output since the last pass. Called per read chunk: past the first call in an
/// interval it is one relaxed load.
pub fn note_output() {
    use std::sync::atomic::Ordering::Relaxed;
    if cfg!(windows) && !OUTPUT_SEEN.load(Relaxed) && !OUTPUT_SEEN.swap(true, Relaxed) {
        OUTPUT.notify_one();
    }
}

/// Opts each descendant of this process (console hosts, children, their children) out of
/// execution-speed throttling once: after a spawn, then at most once per interval while
/// sessions produce output, parked otherwise. Returns at once where there is no EcoQoS.
pub async fn sweep_loop() {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering::Relaxed;
        let mut sweep = win::DescendantSweep::new();
        let mut burst = 0;
        loop {
            OUTPUT_SEEN.store(false, Relaxed);
            let pass = tokio::task::spawn_blocking(move || {
                let found = sweep.pass();
                (sweep, found)
            })
            .await;
            let found;
            (sweep, found) = match pass {
                Ok(pass) => pass,
                Err(error) => {
                    tracing::warn!("EcoQoS descendant sweep stopped: {error}");
                    return;
                }
            };
            tokio::select! {
                _ = SPAWNED.notified() => {
                    burst = SPAWN_BURST;
                    continue;
                }
                _ = tokio::time::sleep(SWEEP_INTERVAL) => {}
            }
            if found > 0 && (burst > 0 || OUTPUT_SEEN.load(Relaxed)) {
                burst = burst.saturating_sub(1);
                continue;
            }
            tokio::select! {
                _ = SPAWNED.notified() => burst = SPAWN_BURST,
                _ = OUTPUT.notified() => {}
            }
        }
    }
}

#[cfg(windows)]
mod win {
    use super::SWEEP_MAX_DESCENDANTS;
    use std::collections::{HashMap, HashSet};
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, ProcessPowerThrottling, SetProcessInformation,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE,
    };

    pub(super) fn opt_out(process: HANDLE) -> std::io::Result<()> {
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            // ControlMask names the throttle to touch; StateMask 0 opts out of it.
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: 0,
        };
        // SAFETY: a process handle with PROCESS_SET_INFORMATION (or the current-process
        // pseudo handle) and a correctly sized `PROCESS_POWER_THROTTLING_STATE`.
        let ok = unsafe {
            SetProcessInformation(
                process,
                ProcessPowerThrottling,
                &state as *const PROCESS_POWER_THROTTLING_STATE as *const core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn creation_time(process: HANDLE) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: a handle with query access and four valid out-values.
        let ok =
            unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
        (ok != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    /// (pid, parent pid) for every process, from one ToolHelp snapshot.
    fn snapshot() -> Option<Vec<(u32, u32)>> {
        // SAFETY: `entry.dwSize` is set before the first Process32FirstW/Process32NextW
        // call, as they require; `snap` is checked before use and closed once.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut out = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut listed = Process32FirstW(snap, &mut entry) != 0;
            while listed {
                out.push((entry.th32ProcessID, entry.th32ParentProcessID));
                listed = Process32NextW(snap, &mut entry) != 0;
            }
            let _ = CloseHandle(snap);
            Some(out)
        }
    }

    pub(super) struct DescendantSweep {
        root: u32,
        root_created: u64,
        // pid -> creation time of the process already handled under that pid; `None`
        // for one that could not be opened. Pruned to the current tree on every pass.
        pub(super) seen: HashMap<u32, Option<u64>>,
    }

    impl DescendantSweep {
        pub(super) fn new() -> Self {
            // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing.
            let current = unsafe { GetCurrentProcess() };
            Self {
                root: std::process::id(),
                root_created: creation_time(current).unwrap_or(0),
                seen: HashMap::new(),
            }
        }

        /// One pass over the current tree. Returns how many descendants it found.
        pub(super) fn pass(&mut self) -> usize {
            let Some(processes) = snapshot() else {
                tracing::debug!(
                    "EcoQoS sweep: process snapshot failed: {}",
                    std::io::Error::last_os_error()
                );
                return 0;
            };
            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            for (pid, parent) in processes {
                if pid != parent && pid != 0 {
                    children.entry(parent).or_default().push(pid);
                }
            }
            let mut found = HashSet::new();
            let mut frontier = vec![(self.root, self.root_created)];
            while let Some((parent, parent_created)) = frontier.pop() {
                for &pid in children.get(&parent).into_iter().flatten() {
                    if found.len() >= SWEEP_MAX_DESCENDANTS || !found.insert(pid) {
                        continue;
                    }
                    if let Some(created) = self.visit(pid, parent_created) {
                        frontier.push((pid, created));
                    }
                }
            }
            self.seen.retain(|pid, _| found.contains(pid));
            found.len()
        }

        /// Opts `pid` out unless it was already handled; returns its creation time when it
        /// is really a child of the parent created at `parent_created`.
        fn visit(&mut self, pid: u32, parent_created: u64) -> Option<u64> {
            let seen = self.seen.get(&pid).copied();
            let visited = crate::pid::with_process_info_handle(pid, |handle| {
                // A parent pid can outlive its process and be reused: a "child" older than
                // its parent belongs to an earlier owner of that pid.
                let created = creation_time(handle).filter(|c| *c >= parent_created)?;
                if seen != Some(Some(created)) {
                    if let Err(error) = opt_out(handle) {
                        tracing::debug!("EcoQoS sweep: opting process {pid} out failed: {error}");
                    }
                }
                Some(created)
            });
            match visited {
                Ok(created) => {
                    if let Some(created) = created {
                        self.seen.insert(pid, Some(created));
                    }
                    created
                }
                Err(error) => {
                    if self.seen.insert(pid, None).is_none() {
                        tracing::debug!("EcoQoS sweep: opening process {pid} failed: {error}");
                    }
                    None
                }
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::opt_out_execution_speed_throttling;
    use super::win::DescendantSweep;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessInformation, ProcessPowerThrottling,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE,
    };

    fn power_throttling_state(process: HANDLE) -> std::io::Result<PROCESS_POWER_THROTTLING_STATE> {
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            // The OS validates this field on read as well as on write.
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        // SAFETY: a process handle with query access and a correctly sized
        // `PROCESS_POWER_THROTTLING_STATE` out-value; the call only reads process info.
        let ok = unsafe {
            GetProcessInformation(
                process,
                ProcessPowerThrottling,
                &mut state as *mut PROCESS_POWER_THROTTLING_STATE as *mut core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(state)
    }

    /// `None` where this Windows build refuses the read-back with ERROR_INVALID_PARAMETER
    /// (the CI runner's among them); there is nothing to assert there.
    fn assert_opted_out(process: HANDLE, what: &str) -> Option<()> {
        let state = match power_throttling_state(process) {
            Ok(state) => state,
            Err(e) if e.raw_os_error() == Some(87) => {
                eprintln!("ProcessPowerThrottling read-back unsupported on this build: {e}");
                return None;
            }
            Err(e) => panic!("GetProcessInformation(ProcessPowerThrottling) of {what}: {e}"),
        };
        assert_eq!(
            state.ControlMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            "{what}: ControlMask is {:#x}, expected the EXECUTION_SPEED bit set",
            state.ControlMask
        );
        assert_eq!(
            state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            0,
            "{what}: StateMask is {:#x}, expected the EXECUTION_SPEED bit clear",
            state.StateMask
        );
        Some(())
    }

    #[test]
    fn execution_speed_throttling_is_opted_out() {
        // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing.
        let current = unsafe { GetCurrentProcess() };
        if let Ok(before) = power_throttling_state(current) {
            eprintln!(
                "ProcessPowerThrottling before the opt-out: Version {} ControlMask {:#x} \
                 StateMask {:#x}",
                before.Version, before.ControlMask, before.StateMask
            );
        }
        opt_out_execution_speed_throttling();
        assert_opted_out(current, "this process");
    }

    #[test]
    fn a_sweep_pass_opts_a_child_out_once_and_forgets_it_after_exit() {
        let mut child = crate::spawn::command("cmd")
            .args(["/C", "ping -n 3 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawning cmd");
        let pid = child.id();
        let mut sweep = DescendantSweep::new();
        let started = std::time::Instant::now();
        let found = sweep.pass();
        let first = started.elapsed();
        let started = std::time::Instant::now();
        sweep.pass();
        eprintln!(
            "sweep pass over {found} descendants: first {} us, repeat {} us",
            first.as_micros(),
            started.elapsed().as_micros()
        );
        assert!(
            found >= 1,
            "the pass found {found} descendants; expected cmd {pid}"
        );
        assert!(
            matches!(sweep.seen.get(&pid), Some(Some(_))),
            "cmd {pid} is not recorded as handled: {:?}",
            sweep.seen.get(&pid)
        );
        let checked = crate::pid::with_process_info_handle(pid, |handle| {
            assert_opted_out(handle, &format!("cmd {pid}"))
        })
        .expect("opening cmd for the read-back");
        child.kill().expect("killing cmd");
        child.wait().expect("reaping cmd");
        // Closes the last handle, so the exited process leaves the snapshot.
        drop(child);
        sweep.pass();
        assert!(
            !sweep.seen.contains_key(&pid),
            "cmd {pid} exited but the sweep still remembers it"
        );
        if checked.is_none() {
            eprintln!("read-back skipped; the pass and pruning were still checked");
        }
    }
}

//! Windows EcoQoS (power throttling) opt-out for the daemon process.

/// Opts the current process out of Windows execution-speed throttling (EcoQoS).
/// A failure is logged and never fails boot; Linux has no EcoQoS, so this is a
/// documented no-op there.
pub fn opt_out_execution_speed_throttling() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, ProcessPowerThrottling, SetProcessInformation,
            PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            PROCESS_POWER_THROTTLING_STATE,
        };
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            // ControlMask names the throttle to touch; StateMask 0 opts out of it.
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: 0,
        };
        // SAFETY: the pseudo handle from GetCurrentProcess and a correctly sized
        // `PROCESS_POWER_THROTTLING_STATE` out-value; the call only sets process info.
        let ok = unsafe {
            SetProcessInformation(
                GetCurrentProcess(),
                ProcessPowerThrottling,
                &state as *const PROCESS_POWER_THROTTLING_STATE as *const core::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            tracing::warn!(
                "SetProcessInformation(ProcessPowerThrottling) failed ({error}); Windows may \
                 throttle this process"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::opt_out_execution_speed_throttling;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessInformation, ProcessPowerThrottling,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE,
    };

    fn power_throttling_state() -> std::io::Result<PROCESS_POWER_THROTTLING_STATE> {
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            // The OS validates this field on read as well as on write.
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        // SAFETY: the pseudo handle from GetCurrentProcess and a correctly sized
        // `PROCESS_POWER_THROTTLING_STATE` out-value; the call only reads process info.
        let ok = unsafe {
            GetProcessInformation(
                GetCurrentProcess(),
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

    #[test]
    fn execution_speed_throttling_is_opted_out() {
        if let Ok(before) = power_throttling_state() {
            eprintln!(
                "ProcessPowerThrottling before the opt-out: Version {} ControlMask {:#x} \
                 StateMask {:#x}",
                before.Version, before.ControlMask, before.StateMask
            );
        }
        opt_out_execution_speed_throttling();
        let after = match power_throttling_state() {
            Ok(state) => state,
            // Some Windows builds (the CI runner's among them) set this class but refuse
            // to read it back with ERROR_INVALID_PARAMETER; there is nothing to assert.
            Err(e) if e.raw_os_error() == Some(87) => {
                eprintln!("ProcessPowerThrottling read-back unsupported on this build: {e}");
                return;
            }
            Err(e) => {
                panic!("GetProcessInformation(ProcessPowerThrottling) after the opt-out: {e}")
            }
        };
        assert_eq!(
            after.ControlMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            "ControlMask is {:#x}, expected the EXECUTION_SPEED bit set",
            after.ControlMask
        );
        assert_eq!(
            after.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            0,
            "StateMask is {:#x}, expected the EXECUTION_SPEED bit clear",
            after.StateMask
        );
    }
}

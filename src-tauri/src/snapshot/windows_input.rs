//! Windows global shortcut registration. Chords use `RegisterHotKey` on a dedicated
//! message-loop thread; modifier pairs are polled with `GetAsyncKeyState`, mirroring
//! the helper process upstream forked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, RegisterHotKey, UnregisterHotKey,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PostThreadMessageW, MSG, WM_HOTKEY, WM_QUIT,
};

use super::input_shortcut::{ChordSpec, ModifierPairPoll};
use super::platform::TriggerCallback;

const HOTKEY_ID: i32 = 1;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub struct ChordShortcut {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl ChordShortcut {
    pub fn start(spec: ChordSpec, on_capture: TriggerCallback) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel::<Option<u32>>();
        let thread = thread::Builder::new()
            .name("houston-snapshot-shortcut".to_string())
            .spawn(move || unsafe {
                let registered = RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ID,
                    spec.modifiers,
                    spec.virtual_key,
                );
                if registered == 0 {
                    let _ = sender.send(None);
                    return;
                }
                let _ = sender.send(Some(GetCurrentThreadId()));
                let mut message = MSG::default();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    if message.message == WM_HOTKEY {
                        on_capture();
                    }
                }
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
            })
            .map_err(|error| format!("starting the snapshot shortcut thread: {error}"))?;
        match receiver.recv() {
            Ok(Some(thread_id)) => Ok(Self {
                thread_id,
                thread: Some(thread),
            }),
            Ok(None) => {
                let _ = thread.join();
                Err(super::input_shortcut::chord_failure_message())
            }
            Err(_) => {
                let _ = thread.join();
                Err("The system could not register this shortcut.".to_string())
            }
        }
    }
}

impl Drop for ChordShortcut {
    fn drop(&mut self) {
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub struct ModifierPairShortcut {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ModifierPairShortcut {
    pub fn start(modifier: &str, on_capture: TriggerCallback) -> Result<Self, String> {
        let (left, right) = super::input_shortcut::modifier_pair_keys(modifier)
            .ok_or_else(|| format!("{modifier:?} is not a modifier this platform can poll"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("houston-snapshot-modifier-pair".to_string())
            .spawn(move || {
                let mut poll = ModifierPairPoll::new();
                while !running.load(Ordering::Relaxed) {
                    let pressed = key_down(left) && key_down(right);
                    if poll.step(pressed) {
                        on_capture();
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            })
            .map_err(|error| format!("starting the snapshot shortcut poller: {error}"))?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for ModifierPairShortcut {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn key_down(virtual_key: i32) -> bool {
    (unsafe { GetAsyncKeyState(virtual_key) } as u16 & 0x8000) != 0
}

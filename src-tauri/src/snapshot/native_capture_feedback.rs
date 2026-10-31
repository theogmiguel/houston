//! The bundled KDE/Hyprland helper's `feedback` subcommand. Mirrors upstream
//! `NativeCaptureFeedback.ts`; ready/landed are compositor receipts, not guesses.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use serde_json::{json, Value};

use super::platform::{Bounds, CaptureFeedback, NormalizedFrame};

const READY_DEADLINE: Duration = Duration::from_secs(2);
const MAX_LINE_BYTES: usize = 4_096;

pub struct NativeCaptureFeedback {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Receiver<Value>,
    animation_started: bool,
    flying: bool,
    landed: bool,
}

impl NativeCaptureFeedback {
    pub fn start(
        executable: &Path,
        directory: &Path,
        bounds: Bounds,
        pid: u32,
        flash: bool,
        animate: bool,
    ) -> Result<Self, String> {
        let mut child = crate::sys::spawn::command(executable)
            .arg("feedback")
            .arg(directory)
            .arg(
                json!({ "bounds": bounds, "pid": pid, "flash": flash, "animate": animate })
                    .to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "starting the capture feedback helper {}: {error}",
                    executable.display()
                )
            })?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the capture feedback helper has no stdout".to_string())?;
        let (sender, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.len() > MAX_LINE_BYTES {
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        let mut feedback = Self {
            child,
            stdin,
            events,
            animation_started: false,
            flying: false,
            landed: false,
        };
        match feedback.events.recv_timeout(READY_DEADLINE) {
            Ok(event) if event.get("event").and_then(Value::as_str) == Some("ready") => {
                feedback.animation_started = event
                    .get("animate")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok(feedback)
            }
            _ => {
                feedback.close();
                Err("The capture feedback helper did not become ready.".to_string())
            }
        }
    }

    fn send(&mut self, value: Value) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = writeln!(stdin, "{value}");
        }
    }
}

impl CaptureFeedback for NativeCaptureFeedback {
    fn animation_started(&self) -> bool {
        self.animation_started
    }

    fn animate_to(&mut self, frame: NormalizedFrame) -> Result<(), String> {
        if self.flying || !self.animation_started {
            return Ok(());
        }
        self.flying = true;
        self.send(json!({ "command": "animate", "title": "", "frame": frame }));
        while !self.landed {
            match self.events.recv_timeout(Duration::from_secs(5)) {
                Ok(event) if event.get("event").and_then(Value::as_str) == Some("landed") => {
                    self.landed = true;
                }
                Ok(event) if event.get("event").and_then(Value::as_str) == Some("done") => {
                    self.landed = true;
                }
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => {
                    return Err("The capture feedback helper did not land.".to_string())
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.landed = true;
                }
            }
        }
        Ok(())
    }

    fn complete(&mut self) {
        self.send(json!({ "command": "close" }));
        let _ = self.child.wait();
    }

    fn close(&mut self) {
        self.send(json!({ "command": "close" }));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for NativeCaptureFeedback {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_helpers_are_reported_with_the_path() {
        let result = super::NativeCaptureFeedback::start(
            std::path::Path::new("/nonexistent/houston-helper"),
            std::path::Path::new("/tmp"),
            super::Bounds {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
            1,
            false,
            false,
        );
        assert!(result.is_err());
    }
}

#![cfg(windows)]

//! The Claude hook entries Houston writes on Windows run through Git Bash, exec the
//! `.exe` launcher copy of the hook helper, and deliver events as drop files.

use houston_core::claude_hooks::{install, point_launcher, sentinel_for};
use houston_core::hook_drop::{drop_dir, parse_drop_name};
use serde_json::{json, Value};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const CHANNEL: &str = "wintest";

/// A bare `bash` on `PATH` can be the WSL launcher, so the Git for Windows one is named.
fn git_bash() -> PathBuf {
    ["ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join("Git").join("bin").join("bash.exe"))
        .find(|path| path.is_file())
        .expect("Git for Windows bash.exe under %ProgramFiles%\\Git\\bin (the CI runner has it)")
}

fn run_in_git_bash(command: &str, home: &Path, session: Option<u32>, stdin: &str) -> Output {
    let mut cmd = Command::new(git_bash());
    cmd.arg("-c")
        .arg(command)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("HOUSTON_CHANNEL", CHANNEL)
        .env_remove("TR_SESSION")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("GROK_SESSION_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(session) = session {
        cmd.env("TR_SESSION", session.to_string());
    }
    let mut child = cmd.spawn().expect("starting Git Bash");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn drops(state: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(drop_dir(state)) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| parse_drop_name(&e.file_name().to_string_lossy()).is_some())
        .map(|e| e.path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .collect()
}

#[test]
fn installed_hook_commands_deliver_events_through_git_bash_and_the_exe_launcher() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("Jo's Home");
    let state = home.join(format!(".houston-{CHANNEL}"));
    let settings = home.join(".claude").join("settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();

    let launcher = point_launcher(&state, Path::new(env!("CARGO_BIN_EXE_tr-helper"))).unwrap();
    install(
        &settings,
        &launcher.display().to_string(),
        &sentinel_for(Some(CHANNEL)),
    )
    .unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    let command_of = |event: &str| -> String {
        let hook = &written["hooks"][event][0]["hooks"][0];
        assert_eq!(hook["shell"], "bash", "{event} must select Git Bash");
        hook["command"].as_str().unwrap().to_string()
    };
    let cwd = home.display().to_string();
    let payload = |event: &str| {
        json!({"session_id": "claude-session", "cwd": cwd, "hook_event_name": event}).to_string()
    };

    let start = command_of("SessionStart");
    let outside = run_in_git_bash(&start, &home, None, &payload("SessionStart"));
    assert!(
        outside.status.success(),
        "outside a Houston pane the guard exits quietly: {}",
        String::from_utf8_lossy(&outside.stderr)
    );
    assert!(
        drops(&state).is_empty(),
        "no TR_SESSION must deliver nothing"
    );

    for event in ["SessionStart", "Stop"] {
        let out = run_in_git_bash(&command_of(event), &home, Some(42), &payload(event));
        assert!(
            out.status.success(),
            "{event} through Git Bash: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let delivered = drops(&state);
    let events: Vec<_> = delivered.iter().map(|d| d["event"].clone()).collect();
    assert_eq!(events, [json!("SessionStart"), json!("Stop")]);
    for drop in &delivered {
        assert_eq!(drop["session"], 42);
        assert_eq!(drop["cwd"], cwd.as_str());
    }
}

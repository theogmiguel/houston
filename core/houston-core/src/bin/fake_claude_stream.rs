//! Hermetic stand-in for `claude -p --input-format stream-json`. Only integration tests
//! launch this binary: it replays captured stream-json fixtures for each user message.
#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

/// The conversation id the captured fixtures carry; replaced by this process's own.
const FIXTURE_SESSION: &str = "00000000-0000-4000-8000-000000000001";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|arg| arg == "--fake-sleeper") {
        sleeper(&args[at + 1]);
    }
    if let Some(log) = std::env::var_os("HOUSTON_FAKE_CLAUDE_LOG") {
        let record = json!({"pid": std::process::id(), "argv": &args[1..]});
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .expect("opening the fake claude log");
        // One write per record, so a test reading the log never sees half a line.
        file.write_all(format!("{record}\n").as_bytes())
            .expect("writing the fake claude log");
    }
    let conversation = args
        .windows(2)
        .find(|pair| pair[0] == "--session-id" || pair[0] == "--resume")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| FIXTURE_SESSION.to_string());
    let fixtures = std::env::var_os("HOUSTON_FAKE_CLAUDE_FIXTURES").map(PathBuf::from);
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let message: Value = serde_json::from_str(&line).expect("stdin lines are JSON");
        let text = message
            .pointer("/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        turn(&text, &conversation, fixtures.as_deref());
    }
}

fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    out.write_all(line.as_bytes()).expect("stdout");
    out.write_all(b"\n").expect("stdout");
    out.flush().expect("stdout");
}

fn emit_value(value: Value) {
    emit(&value.to_string());
}

fn result(conversation: &str) {
    emit_value(
        json!({"type":"result","subtype":"success","is_error":false,"result":"done","session_id":conversation}),
    );
}

fn turn(text: &str, conversation: &str, fixtures: Option<&std::path::Path>) {
    // Real Claude opens every turn with `system/init`; replayed captures carry their own.
    if !text.starts_with("replay:") {
        emit_value(json!({"type":"system","subtype":"init","session_id":conversation}));
    }
    if let Some(name) = text.strip_prefix("replay:") {
        let dir = fixtures.expect("HOUSTON_FAKE_CLAUDE_FIXTURES names the fixture dir");
        let body = std::fs::read_to_string(dir.join(format!("{name}.jsonl")))
            .expect("reading a replay fixture");
        for line in body.lines().filter(|line| !line.trim().is_empty()) {
            emit(&line.replace(FIXTURE_SESSION, conversation));
        }
    } else if let Some(pidfile) = text.strip_prefix("hang:") {
        let exe = std::env::current_exe().expect("own path");
        // Left running on purpose: the test proves Stop ends it with the whole tree.
        #[allow(clippy::zombie_processes)]
        let _sleeper = std::process::Command::new(exe)
            .args(["--fake-sleeper", pidfile])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("starting the sleeper");
        emit_value(
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
            "delta":{"type":"text_delta","text":"working"}},"parent_tool_use_id":null,"api_message_id":"msg_hang"}),
        );
    } else if text == "deaf" {
        delta("msg_deaf", "deaf");
        // Stops reading stdin for good, as a frozen Claude would.
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    } else if text == "stubborn" {
        #[cfg(unix)]
        // SAFETY: SIG_IGN for SIGTERM changes only this test process's disposition.
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
        delta("msg_stubborn", "stubborn");
        // Keeps running without reading stdin, so only a group kill ends it.
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    } else if text == "crash" {
        emit_value(
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
            "delta":{"type":"text_delta","text":"partial answer"}},"parent_tool_use_id":null,"api_message_id":"msg_crash"}),
        );
        std::thread::sleep(Duration::from_millis(200));
        eprintln!("fatal: fake crash");
        std::process::exit(3);
    } else if let Some(count) = text.strip_prefix("flood:") {
        let count: usize = count.parse().expect("flood:<count>");
        for _ in 0..count {
            emit_value(
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"x"}},"parent_tool_use_id":null,"api_message_id":"msg_flood"}),
            );
        }
        emit_value(
            json!({"type":"assistant","message":{"id":"msg_flood","content":[{"type":"text","text":"x".repeat(count)}]},"parent_tool_use_id":null}),
        );
        result(conversation);
    } else if let Some(spec) = text.strip_prefix("big:") {
        let (count, kib) = spec.split_once(':').expect("big:<count>:<KiB>");
        let (count, kib): (usize, usize) = (count.parse().unwrap(), kib.parse().unwrap());
        for at in 0..count {
            emit_value(
                json!({"type":"assistant","message":{"id":format!("msg_big_{at}"),"content":[{"type":"text","text":"b".repeat(kib * 1024)}]},"parent_tool_use_id":null}),
            );
        }
        result(conversation);
    } else {
        emit_value(
            json!({"type":"assistant","message":{"id":"msg_echo","content":[{"type":"text","text":format!("echo: {text}")}]},"parent_tool_use_id":null}),
        );
        result(conversation);
    }
}

fn delta(message: &str, text: &str) {
    emit_value(
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
        "delta":{"type":"text_delta","text":text}},"parent_tool_use_id":null,"api_message_id":message}),
    );
}

fn sleeper(pidfile: &str) -> ! {
    // Renamed into place, so a test that sees the file reads the whole pid.
    let partial = format!("{pidfile}.partial");
    std::fs::write(&partial, std::process::id().to_string()).expect("writing the sleeper pid");
    std::fs::rename(&partial, pidfile).expect("publishing the sleeper pid");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#![cfg(unix)]

use houston_core::headless::{engine_for, one_shot, TurnRequest};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

fn shim(dir: &Path) -> PathBuf {
    let fixture = std::fs::read_to_string(format!(
        "{}/tests/fixtures/headless/opencode/resume.ndjson",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("the resume fixture exists");
    let path = dir.join("opencode");
    std::fs::write(&path, format!("#!/bin/sh\ncat <<'EOF'\n{fixture}EOF\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

#[tokio::test]
async fn one_shot_against_a_resumed_acp_stream_reads_the_final_assistant_text() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = shim(tmp.path());

    let engine = engine_for(proto::AgentKind::Opencode)
        .expect("opencode is registered as a headless engine");
    let req = TurnRequest {
        cwd: tmp.path().to_path_buf(),
        prompt: "keep going".into(),
        resume: Some("ses_opencode_resumed".into()),
        one_shot: true,
        ..Default::default()
    };

    let outcome = one_shot(engine, &exe, &req, std::time::Duration::from_secs(10))
        .await
        .expect("the shim's stream decodes to an answer");

    assert_eq!(outcome.text, "Continuing from before.");
}

#[tokio::test]
async fn grok_is_also_registered_and_decodes_its_own_resume_fixture() {
    let tmp = tempfile::tempdir().unwrap();
    let fixture = std::fs::read_to_string(format!(
        "{}/tests/fixtures/headless/grok/resume.ndjson",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("the grok resume fixture exists");
    let path = tmp.path().join("grok");
    std::fs::write(&path, format!("#!/bin/sh\ncat <<'EOF'\n{fixture}EOF\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let engine =
        engine_for(proto::AgentKind::Grok).expect("grok is registered as a headless engine");
    let req = TurnRequest {
        cwd: tmp.path().to_path_buf(),
        prompt: "keep going".into(),
        resume: Some("ses_grok_resumed".into()),
        one_shot: true,
        ..Default::default()
    };

    let outcome = one_shot(engine, &path, &req, std::time::Duration::from_secs(10))
        .await
        .expect("the shim's stream decodes to an answer");

    assert_eq!(outcome.text, "Picking up where we left off.");
}

fn echo_agent(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let script = r##"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":false}}}' ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ses-echo"}}' ;;
    *'"method":"session/prompt"'*)
      text=$(printf '%s' "$line" | sed 's/.*"text":"\([^"]*\)".*/\1/')
      printf '%s\n' '{"jsonrpc":"2.0","id":11,"method":"session/request_permission","params":{"sessionId":"ses-echo","toolCall":{"toolCallId":"c1","title":"Write notes.txt"},"options":[{"optionId":"allow-once","name":"Allow","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}' ;;
    *'"id":11'*)
      option=$(printf '%s' "$line" | sed 's/.*"optionId":"\([^"]*\)".*/\1/')
      printf '%s\n' "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"ses-echo\",\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"you said: $text; permission: $option\"}}}}"
      printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"##;
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

#[tokio::test]
async fn a_fresh_one_shot_delivers_its_prompt_and_rejects_the_permission_it_is_asked() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = echo_agent(tmp.path(), "opencode");
    let engine = engine_for(proto::AgentKind::Opencode).unwrap();
    let req = TurnRequest {
        cwd: tmp.path().to_path_buf(),
        prompt: "judge this".into(),
        one_shot: true,
        ..Default::default()
    };
    let outcome = one_shot(engine, &exe, &req, std::time::Duration::from_secs(10))
        .await
        .expect("the echo agent answers");
    assert_eq!(
        outcome.text,
        "you said: judge this; permission: reject-once"
    );
}

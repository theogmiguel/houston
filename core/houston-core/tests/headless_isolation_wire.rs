#![cfg(unix)]

use houston_core::headless::{claude::ClaudeEngine, one_shot, TurnRequest};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn shim(dir: &Path) -> PathBuf {
    let argv = dir.join("argv.txt");
    let env = dir.join("env.txt");
    let reply = dir.join("reply.json");
    std::fs::write(
        &reply,
        r#"{"type":"result","is_error":false,"result":"the answer"}"#,
    )
    .unwrap();
    let script = format!(
        "#!/bin/sh\n\
         : > {argv}\n\
         for a in \"$@\"; do printf '%s\\n' \"$a\" >> {argv}; done\n\
         env > {env}\n\
         cat {reply}\n",
        argv = argv.display(),
        env = env.display(),
        reply = reply.display(),
    );
    let exe = dir.join("claude");
    std::fs::write(&exe, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    exe
}

#[tokio::test]
async fn a_one_shot_runs_isolated_from_the_outer_pane() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = shim(tmp.path());

    std::env::set_var("TR_SESSION", "24");
    std::env::set_var("HOUSTON_SESSION", "24");
    std::env::set_var("HOUSTON_MCP_URL", "http://127.0.0.1:33633/mcp");
    std::env::set_var("HOUSTON_MCP_TOKEN", "the-outer-panes-credential");
    std::env::set_var("HOUSTON_MCP_CONFIG", "{\"mcpServers\":{\"houston\":{}}}");

    let req = TurnRequest {
        cwd: tmp.path().to_path_buf(),
        prompt: "hi".into(),
        model: Some("sonnet".into()),
        one_shot: true,
        ..Default::default()
    };
    let out = one_shot(
        Box::new(ClaudeEngine::default()),
        &exe,
        &req,
        Duration::from_secs(5),
    )
    .await
    .expect("the shim answers");
    assert_eq!(out.text, "the answer");

    let argv = std::fs::read_to_string(tmp.path().join("argv.txt")).expect("argv dump");
    let args: Vec<&str> = argv.lines().collect();
    let has_pair = |flag: &str, value: &str| args.windows(2).any(|w| w[0] == flag && w[1] == value);
    assert!(
        args.contains(&"--strict-mcp-config"),
        "without it the child inherits every MCP server the environment \
         resolves: {args:?}"
    );
    assert!(
        has_pair("--mcp-config", r#"{"mcpServers":{}}"#),
        "the empty server set is what --strict-mcp-config restricts it TO: {args:?}"
    );
    assert!(
        has_pair("--tools", ""),
        "a one-shot reads text and answers JSON; the built-in tool schema is \
         the single largest thing it would be billed for: {args:?}"
    );

    let env = std::fs::read_to_string(tmp.path().join("env.txt")).expect("env dump");
    for var in [
        "TR_SESSION=",
        "HOUSTON_SESSION=",
        "HOUSTON_MCP_URL=",
        "HOUSTON_MCP_TOKEN=",
        "HOUSTON_MCP_CONFIG=",
    ] {
        assert!(
            !env.lines().any(|l| l.starts_with(var)),
            "the one-shot inherited {var} — a daemon hosted in a pane hands its \
             own identity (and MCP credential) to a process that is not that \
             pane"
        );
    }
}

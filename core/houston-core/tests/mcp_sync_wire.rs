mod common;

use houston_protocol as proto;

use common::start_daemon_with_handle;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn set_test_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    home
}

fn mcp_state(msg: proto::ServerMsg) -> (Vec<proto::McpServer>, Vec<proto::McpSyncResult>) {
    match msg {
        proto::ServerMsg::McpState {
            source, results, ..
        } => (source, results),
        other => panic!("expected McpState, got {other:?}"),
    }
}

fn checks_of(msg: &proto::ServerMsg) -> Vec<(String, proto::McpConnectionCheck)> {
    match msg {
        proto::ServerMsg::McpState { checks, .. } => checks.clone(),
        other => panic!("expected McpState, got {other:?}"),
    }
}

fn stdio_server(name: &str, command: &str, args: &[&str]) -> proto::McpServer {
    proto::McpServer {
        name: name.to_string(),
        transport: proto::McpTransport::Stdio,
        command: Some(command.to_string()),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
        cwd: None,
        enabled: true,
        fingerprint: String::new(),
        destinations: Vec::new(),
    }
}

#[tokio::test]
async fn upsert_creates_then_edits_in_place_and_a_rename_moves_the_row() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    let created = stdio_server("docs", "npx", &["-y", "docs-mcp"]);
    let (source, _) = mcp_state(daemon.mcp_server_upsert(None, created.clone()));
    assert_eq!(source.len(), 1);
    assert_eq!(source[0].name, "docs");
    assert_eq!(source[0].command.as_deref(), Some("npx"));

    let edited = stdio_server("docs", "npx", &["-y", "docs-mcp@2"]);
    let (source, _) = mcp_state(daemon.mcp_server_upsert(Some("docs"), edited));
    assert_eq!(source.len(), 1, "editing must not add a second row");
    assert_eq!(source[0].args, vec!["-y", "docs-mcp@2"]);

    let renamed = stdio_server("documentation", "npx", &["-y", "docs-mcp@2"]);
    let (source, _) = mcp_state(daemon.mcp_server_upsert(Some("docs"), renamed));
    assert_eq!(source.len(), 1);
    assert_eq!(source[0].name, "documentation");
    assert!(
        !source.iter().any(|s| s.name == "docs"),
        "the old name must not survive a rename: {source:?}"
    );
}

#[tokio::test]
async fn upsert_refuses_a_rename_that_collides_with_an_existing_name() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_server_upsert(None, stdio_server("a", "npx", &["one"]));
    daemon.mcp_server_upsert(None, stdio_server("b", "npx", &["two"]));

    let (source, results) =
        mcp_state(daemon.mcp_server_upsert(Some("a"), stdio_server("b", "npx", &["one"])));
    assert_eq!(results.len(), 1, "{results:?}");
    let message = results[0].error.clone().expect("an error");
    assert!(message.contains('b'), "{message}");
    assert_eq!(source.len(), 2, "nothing was renamed or overwritten");
    assert_eq!(
        source.iter().find(|s| s.name == "b").unwrap().args,
        vec!["two"],
        "b's own entry must be untouched by the refused collision"
    );
}

#[tokio::test]
async fn upsert_refuses_an_empty_name() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let (_source, results) =
        mcp_state(daemon.mcp_server_upsert(None, stdio_server("  ", "npx", &["x"])));
    assert_eq!(results.len(), 1, "{results:?}");
    assert!(results[0].error.is_some());
}

#[tokio::test]
async fn remove_refuses_an_unknown_name_and_leaves_the_list_alone() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_server_upsert(None, stdio_server("a", "npx", &["one"]));

    let (source, results) = mcp_state(daemon.mcp_server_remove("nope"));
    assert_eq!(results.len(), 1, "{results:?}");
    assert!(results[0].error.as_ref().unwrap().contains("nope"));
    assert_eq!(source.len(), 1, "the real entry must be untouched");
}

#[tokio::test]
async fn remove_takes_the_row_out_of_your_list_but_a_tool_keeps_its_own_copy_until_sync() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    daemon.mcp_server_upsert(None, stdio_server("docs", "npx", &["-y", "docs-mcp"]));
    daemon.mcp_sync(Some(proto::AgentKind::Cursor));
    assert!(
        home.path().join(".cursor/mcp.json").exists(),
        "sync must have written Cursor's file"
    );

    let (source, _) = mcp_state(daemon.mcp_server_remove("docs"));
    assert!(source.is_empty(), "gone from Houston's own list");
    let cursor_config =
        std::fs::read_to_string(home.path().join(".cursor/mcp.json")).expect("read");
    assert!(
        cursor_config.contains("docs"),
        "removing from the list alone must not retract it from a tool that already has it: \
         {cursor_config}"
    );

    daemon.mcp_sync(Some(proto::AgentKind::Cursor));
    let cursor_config =
        std::fs::read_to_string(home.path().join(".cursor/mcp.json")).expect("read");
    assert!(
        !cursor_config.contains("docs"),
        "an explicit sync after the remove must retract it: {cursor_config}"
    );
}

#[tokio::test]
async fn sync_honors_per_server_destinations_and_narrowing_retracts_it() {
    let _guard = SERIAL.lock().await;
    let home = set_test_home();
    let (_addr, _state, daemon) = start_daemon_with_handle().await;

    let scoped = proto::McpServer {
        destinations: vec![proto::AgentKind::Cursor],
        ..stdio_server("scoped", "npx", &["-y", "docs-mcp"])
    };
    daemon.mcp_server_upsert(None, scoped);
    daemon.mcp_sync(Some(proto::AgentKind::Cursor));
    assert!(
        std::fs::read_to_string(home.path().join(".cursor/mcp.json"))
            .unwrap()
            .contains("scoped"),
        "the destination it names must get the server"
    );

    let outcome = daemon.mcp_sync(Some(proto::AgentKind::Opencode));
    let (_, results) = mcp_state(outcome);
    let opencode = results
        .iter()
        .find(|r| r.tool == proto::AgentKind::Opencode)
        .expect("opencode result");
    assert_eq!(opencode.written, 0, "{opencode:?}");
    assert!(
        !home.path().join(".config/opencode/opencode.json").exists()
            || !std::fs::read_to_string(home.path().join(".config/opencode/opencode.json"))
                .unwrap()
                .contains("scoped"),
        "a tool outside destinations must never receive the server"
    );

    let narrowed = proto::McpServer {
        destinations: vec![proto::AgentKind::Opencode],
        ..stdio_server("scoped", "npx", &["-y", "docs-mcp"])
    };
    daemon.mcp_server_upsert(Some("scoped"), narrowed);
    daemon.mcp_sync(Some(proto::AgentKind::Cursor));
    assert!(
        !std::fs::read_to_string(home.path().join(".cursor/mcp.json"))
            .unwrap()
            .contains("scoped"),
        "narrowing destinations must retract it from a tool it no longer names"
    );
}

fn fake_stdio_probe_server(name: &str) -> proto::McpServer {
    stdio_server(name, "false", &[])
}

#[tokio::test]
async fn mcp_test_reports_checking_immediately_then_settles_to_a_real_result() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_server_upsert(None, fake_stdio_probe_server("under-test"));

    let checks = checks_of(&daemon.mcp_state());
    assert!(checks.is_empty(), "nothing has been tested yet");

    daemon.mcp_test("under-test".to_string());
    let checks = checks_of(&daemon.mcp_state());
    assert_eq!(
        checks,
        vec![(
            "under-test".to_string(),
            proto::McpConnectionCheck::Checking
        )],
        "checking must be visible the instant the probe is accepted, before the async \
         handshake has had a chance to run"
    );

    let settled = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let checks = checks_of(&daemon.mcp_state());
            if checks
                .iter()
                .any(|(n, c)| n == "under-test" && *c != proto::McpConnectionCheck::Checking)
            {
                return checks;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the probe against a command that never speaks MCP must settle well within its own deadline");
    assert!(
        matches!(settled[0].1, proto::McpConnectionCheck::Failed { .. }),
        "{settled:?}"
    );
}

#[tokio::test]
async fn mcp_test_against_an_unknown_name_is_a_quiet_no_op() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_test("nope".to_string());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let checks = checks_of(&daemon.mcp_state());
    assert!(checks.is_empty(), "{checks:?}");
}

async fn settle(daemon: &std::sync::Arc<houston_core::daemon::Daemon>, name: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let checks = checks_of(&daemon.mcp_state());
            if checks
                .iter()
                .any(|(n, c)| n == name && *c != proto::McpConnectionCheck::Checking)
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the probe against a command that never speaks MCP must settle well within its own deadline");
}

#[tokio::test]
async fn editing_a_server_after_a_settled_check_drops_the_now_stale_result() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_server_upsert(None, fake_stdio_probe_server("under-test"));
    daemon.mcp_test("under-test".to_string());
    settle(&daemon, "under-test").await;
    let before = checks_of(&daemon.mcp_state());
    assert_eq!(before.len(), 1, "{before:?}");

    daemon.mcp_server_upsert(Some("under-test"), stdio_server("under-test", "true", &[]));
    let after = checks_of(&daemon.mcp_state());
    assert!(
        after.is_empty(),
        "the check answered a question about the old command, not this one: {after:?}"
    );
}

#[tokio::test]
async fn removing_a_server_prunes_its_check_so_a_later_re_add_reads_as_untested() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    daemon.mcp_server_upsert(None, fake_stdio_probe_server("under-test"));
    daemon.mcp_test("under-test".to_string());
    settle(&daemon, "under-test").await;
    assert_eq!(checks_of(&daemon.mcp_state()).len(), 1);

    daemon.mcp_server_remove("under-test");
    assert!(checks_of(&daemon.mcp_state()).is_empty());

    daemon.mcp_server_upsert(None, fake_stdio_probe_server("under-test"));
    let checks = checks_of(&daemon.mcp_state());
    assert!(
        checks.is_empty(),
        "a re-added server must read as untested, not carry over the removed server's \
         stale check: {checks:?}"
    );
}

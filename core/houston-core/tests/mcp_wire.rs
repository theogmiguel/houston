mod common;

use houston_core::db::Db;
use houston_protocol as proto;

use common::start_daemon_with_handle;

#[tokio::test]
async fn the_state_message_carries_tr_s_list_and_one_column_per_tool() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let proto::ServerMsg::McpState {
        source,
        source_path,
        tools,
        results,
        checks,
    } = daemon.mcp_state()
    else {
        panic!("mcp_state must answer with McpState");
    };
    assert!(
        source.is_empty(),
        "nobody has added a server yet: {source:?}"
    );
    assert!(results.is_empty(), "a read reports no sync results");
    assert!(checks.is_empty(), "nothing has been tested yet");
    assert_eq!(tools.len(), 4, "Houston's four tools");
    assert_eq!(
        tools[0].tool,
        proto::AgentKind::Claude,
        "Claude reads first"
    );
    for col in &tools {
        assert!(
            !col.path.is_empty(),
            "{:?} must name the file it reads even when it is absent",
            col.tool
        );
    }
    assert!(
        !houston_core::mcp::source_path(state.path()).exists(),
        "a read must not mint Houston's own file"
    );
    assert!(
        source_path.starts_with(&state.path().display().to_string()),
        "the Open action must point at THIS channel's file: {source_path}"
    );
}

#[tokio::test]
async fn switching_a_server_off_is_recorded_and_changes_its_fingerprint() {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    let server = proto::McpServer {
        name: "context7".to_string(),
        transport: proto::McpTransport::Stdio,
        command: Some("npx".to_string()),
        args: vec!["-y".to_string(), "@upstash/context7-mcp".to_string()],
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
        cwd: None,
        enabled: true,
        fingerprint: String::new(),
        destinations: Vec::new(),
    };
    let mut seeded = server.clone();
    seeded.fingerprint = houston_core::mcp::fingerprint(&seeded);
    houston_core::mcp::write_source(state.path(), &[seeded.clone()]).expect("seed");

    let proto::ServerMsg::McpState { source, .. } = daemon.mcp_set_enabled("context7", false)
    else {
        panic!("mcp_set_enabled must answer with McpState");
    };
    assert_eq!(source.len(), 1);
    assert!(!source[0].enabled);
    assert_ne!(
        source[0].fingerprint, seeded.fingerprint,
        "a server switched off is a difference the matrix must be able to see"
    );

    let back = houston_core::mcp::read_source(state.path()).expect("read");
    assert!(!back[0].enabled);
}

#[tokio::test]
async fn an_unknown_server_name_is_refused_by_name_rather_than_ignored() {
    let (_addr, _state, daemon) = start_daemon_with_handle().await;
    let proto::ServerMsg::McpState { results, .. } = daemon.mcp_set_enabled("nope", false) else {
        panic!("expected McpState");
    };
    assert_eq!(results.len(), 1);
    let message = results[0].error.clone().expect("an error");
    assert!(message.contains("nope"), "{message}");
}

#[test]
fn ownership_is_recorded_per_tool_and_replaced_wholesale() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Db::open(&dir.path().join("t.sqlite")).expect("db");
    assert!(db.mcp_managed_names("cursor").expect("read").is_empty());

    db.set_mcp_managed("cursor", &["a".to_string(), "b".to_string()])
        .expect("write");
    db.set_mcp_managed("codex", &["c".to_string()])
        .expect("write");
    assert_eq!(
        db.mcp_managed_names("cursor").expect("read"),
        vec!["a", "b"]
    );
    assert_eq!(db.mcp_managed_names("codex").expect("read"), vec!["c"]);

    db.set_mcp_managed("cursor", &["b".to_string()])
        .expect("rewrite");
    assert_eq!(
        db.mcp_managed_names("cursor").expect("read"),
        vec!["b"],
        "the old set is replaced, not merged"
    );
    assert_eq!(
        db.mcp_managed_names("codex").expect("read"),
        vec!["c"],
        "and one tool's record never touches another's"
    );
}

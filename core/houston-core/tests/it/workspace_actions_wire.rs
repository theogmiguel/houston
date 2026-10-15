use houston_core::daemon::{Daemon, DaemonConfig};
use houston_protocol as proto;

#[test]
fn workspace_actions_persist_and_limits_are_reported() {
    let state = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let workspace = workspace.path().display().to_string();
    let config = || DaemonConfig {
        token: "test-token-0000-0000-000000000000".into(),
        db_path: state.path().join("test.db"),
    };

    let daemon = Daemon::new(config()).unwrap();
    daemon.workspace_add(&workspace).unwrap();
    let action = proto::WorkspaceAction {
        id: "test".into(),
        name: "test".into(),
        command: "bun run test".into(),
        shortcut: Some("Ctrl+Shift+T".into()),
    };
    assert!(matches!(
        daemon
            .set_workspace_action(&workspace, action.clone())
            .unwrap(),
        proto::ServerMsg::WorkspaceActions { .. }
    ));
    drop(daemon);

    let daemon = Daemon::new(config()).unwrap();
    assert_eq!(daemon.workspace_actions(&workspace).unwrap(), [action]);
    let too_long = proto::WorkspaceAction {
        id: "long".into(),
        name: "long".into(),
        command: "x".repeat(4097),
        shortcut: None,
    };
    assert!(matches!(
        daemon.set_workspace_action(&workspace, too_long).unwrap(),
        proto::ServerMsg::WorkspaceActionRefused {
            limit: 4096,
            actual: 4097,
            requested: 4097,
            ..
        }
    ));

    for index in 1..24 {
        let action = proto::WorkspaceAction {
            id: format!("action-{index}"),
            name: format!("action {index}"),
            command: "true".into(),
            shortcut: None,
        };
        assert!(matches!(
            daemon.set_workspace_action(&workspace, action).unwrap(),
            proto::ServerMsg::WorkspaceActions { .. }
        ));
    }
    let overflow = proto::WorkspaceAction {
        id: "overflow".into(),
        name: "overflow".into(),
        command: "true".into(),
        shortcut: None,
    };
    assert!(matches!(
        daemon.set_workspace_action(&workspace, overflow).unwrap(),
        proto::ServerMsg::WorkspaceActionRefused {
            limit: 24,
            actual: 24,
            requested: 25,
            ..
        }
    ));
}

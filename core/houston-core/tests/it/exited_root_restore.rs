#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
use crate::common;

use houston_core::daemon::{Daemon, DaemonConfig, SafeModeFlags};
use houston_core::db::Db;
use houston_core::scrollback::Scrollback;
use houston_protocol as proto;
use std::path::Path;

fn info(id: u32, project: &Path, agent: proto::AgentKind) -> proto::SessionInfo {
    proto::SessionInfo {
        title_source: Default::default(),
        checkout: None,
        activity: None,
        id,
        agent,
        project_dir: project.display().to_string(),
        cwd: project.display().to_string(),
        state: proto::SessionState::Running,
        title: "Completed work".into(),
        codename: "Retained".into(),
        detected_agent: None,
        running_agent: None,
        hidden: false,
        ssh_host: None,
        restore_deferred: None,
        status: None,
        status_since_ms: None,
        context: None,
        swarm_agent: None,
        spawned_by: None,
        acp: None,
        live_children: 0,
        profile_label: None,
        children_waiting: 0,
        inbox_unread: 0,
        delegation: None,
        tags: vec![],
        session_origin: Some(id),
        checkout_root: None,
        worktree: None,
        resumable: false,
        resume_notice: None,
        compactions: None,
        task: None,
        sleep_notice: None,
        latest_prompt: Some("Last user prompt".into()),
        last_agent_message: Some("Finished output".into()),
        slept_at_ms: None,
    }
}

#[test]
fn exited_roots_keep_passive_panes_and_output_until_explicit_close() {
    if std::env::var_os("HOUSTON_EXITED_ROOT_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let status = common::hermetic_command(std::env::current_exe().unwrap(), home.path())
            .args([
                "--exact",
                &common::exact_path(
                    module_path!(),
                    "exited_roots_keep_passive_panes_and_output_until_explicit_close",
                ),
                "--nocapture",
            ])
            .env("HOUSTON_EXITED_ROOT_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    for disable_auto_restore in [false, true] {
        let state = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let database = state.path().join("test.db");
        let db = Db::open(&database).unwrap();
        for id in 1..=6 {
            let mut session = info(
                id,
                project.path(),
                if id == 4 {
                    proto::AgentKind::Custom
                } else {
                    proto::AgentKind::Claude
                },
            );
            if id == 6 {
                session.session_origin = Some(5);
            }
            db.insert_session(&session).unwrap();
        }
        db.update_session_state(1, proto::SessionState::Exited, Some(0))
            .unwrap();
        db.update_session_state(2, proto::SessionState::Killed, None)
            .unwrap();
        db.mark_closed(3).unwrap();
        db.update_session_state(4, proto::SessionState::Exited, Some(0))
            .unwrap();
        // Older versions left a replaced live row Exited; closing its successor
        // must not revive that historical row as a newly retained pane.
        db.update_session_state(5, proto::SessionState::Exited, Some(0))
            .unwrap();
        db.mark_closed(6).unwrap();
        let transcript = project.path().join("completed.jsonl");
        std::fs::write(&transcript, b"{}\n").unwrap();
        db.set_session_resume_handle(1, Some(("completed-conversation", transcript.to_str())))
            .unwrap();
        let scrollback_dir = state.path().join("scrollback");
        std::fs::create_dir(&scrollback_dir).unwrap();
        let mut ring = Scrollback::default();
        ring.push(b"naturally exited output\r\n");
        for id in 1..=6 {
            ring.persist(&scrollback_dir.join(format!("{id}.bin")))
                .unwrap();
        }
        let boot = || {
            Daemon::new_with_safe_mode_flags_for_test(
                DaemonConfig::new(
                    common::TOKEN.into(),
                    database.clone(),
                    crate::common::capture_env(),
                ),
                SafeModeFlags {
                    disable_auto_restore,
                    disable_swarm_autolaunch: true,
                },
            )
            .unwrap()
        };
        let daemon = boot();
        let listed = daemon.list();
        assert_eq!(
            listed.len(),
            1,
            "Killed, Closed and custom-command roots stay excluded"
        );
        let retained = &listed[0];
        assert_eq!(
            retained.id, 1,
            "passive restore must not allocate or launch a replacement"
        );
        assert_eq!(retained.state, proto::SessionState::Exited);
        assert_eq!(retained.title, "Completed work");
        assert_eq!(retained.cwd, project.path().display().to_string());
        assert_eq!(retained.latest_prompt.as_deref(), Some("Last user prompt"));
        assert_eq!(
            retained.last_agent_message.as_deref(),
            Some("Finished output")
        );
        assert!(retained.resumable);
        assert_eq!(retained.restore_deferred, None);
        assert!(daemon.recovery_summary().is_none());
        assert_eq!(
            db.next_session_id().unwrap(),
            7,
            "boot launched a new session"
        );
        assert_eq!(
            db.session_final(1).unwrap(),
            Some((proto::SessionState::Exited, Some(0)))
        );
        let replay = daemon.scrollback(1, None).unwrap();
        assert!(String::from_utf8_lossy(&replay.data).contains("naturally exited output"));
        assert!(scrollback_dir.join("1.bin").exists());
        for id in 2..=6 {
            assert!(!scrollback_dir.join(format!("{id}.bin")).exists());
        }
        drop(daemon);
        let reopened = boot();
        assert_eq!(reopened.list()[0].state, proto::SessionState::Exited);
        reopened.close(1).unwrap();
        assert!(db.session_is_closed(1).unwrap());
        assert_eq!(db.session_resume_handle(1).unwrap(), None);
        assert!(!scrollback_dir.join("1.bin").exists());
        drop(reopened);
        assert!(
            boot().list().is_empty(),
            "explicit close must remain durable"
        );
    }
}

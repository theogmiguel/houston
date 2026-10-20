#![allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly

//! A pane Houston launched as a known provider keeps that provider when its output
//! quotes another CLI's banner, for example while printing Houston's own sources.

use crate::common;

use houston_core::daemon::CreateParams;
use houston_protocol as proto;

const MARKER: &str = "IDENTITY-FIXTURE-UP";

#[tokio::test]
async fn a_launched_zcode_pane_that_prints_an_antigravity_banner_stays_zcode() {
    if std::env::var_os("LAUNCHED_IDENTITY_FIXTURE").is_none() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = bin.join("zcode");
            std::fs::write(
                &path,
                format!("#!/bin/sh\necho 'Antigravity ready'\necho {MARKER}\nexec sleep 60\n"),
            )
            .unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        std::fs::write(
            bin.join("zcode.cmd"),
            format!("@echo off\r\necho Antigravity ready\r\necho {MARKER}\r\npowershell.exe -NoProfile -Command \"Start-Sleep -Seconds 60\"\r\n"),
        )
        .unwrap();
        let mut command = common::hermetic_command(std::env::current_exe().unwrap(), home.path());
        let inherited = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let separator = if cfg!(windows) { ';' } else { ':' };
        let status = command
            .args([
                "--exact",
                &common::exact_path(
                    module_path!(),
                    "a_launched_zcode_pane_that_prints_an_antigravity_banner_stays_zcode",
                ),
                "--nocapture",
            ])
            .env("PATH", format!("{}{separator}{inherited}", bin.display()))
            .env("LAUNCHED_IDENTITY_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let (_addr, _state, daemon) = common::start_daemon_with_handle().await;
    let dir = tempfile::tempdir().unwrap();
    let mut rx = daemon.observe();
    let info = daemon
        .create_session(CreateParams {
            agent: proto::AgentKind::Zcode,
            project_dir: dir.path().to_path_buf(),
            cmd: None,
            cols: 80,
            rows: 24,
            cwd_from: None,
            shell_integration: false,
            auto_approve: false,
            acp: None,
            profile: None,
            prompt: None,
            model: None,
            effort: None,
        })
        .unwrap();
    common::collect_broadcast_until(&mut rx, info.id, MARKER).await;
    let listed = daemon.list().into_iter().find(|s| s.id == info.id).unwrap();
    assert_eq!(listed.agent, proto::AgentKind::Zcode);
    assert_ne!(
        listed.detected_agent,
        Some(proto::AgentKind::Antigravity),
        "a banner quoted in a launched ZCode pane's output relabelled it"
    );
    assert_eq!(daemon.agent_kind_of(info.id), Some(proto::AgentKind::Zcode));
    daemon.kill(info.id).ok();
}

#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // runs the built binary with a cleared environment

use crate::night_shift_wire::rig;
use houston_protocol as proto;
use std::process::Command;

fn hs_night(args: &[&str], mcp: Option<(&str, &str)>) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_houston-core"));
    cmd.arg("hs-night").args(args).env_clear();
    cmd.env(
        "PATH",
        crate::common::base_env().var("PATH").unwrap_or_default(),
    );
    if let Some((url, token)) = mcp {
        cmd.env("HOUSTON_MCP_URL", url)
            .env("HOUSTON_MCP_TOKEN", token);
    }
    let out = cmd.output().expect("running houston-core hs-night");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[tokio::test]
async fn cli_door() {
    let (code, _, err) = tokio::task::spawn_blocking(|| hs_night(&["plan", "--title", "x"], None))
        .await
        .unwrap();
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("HOUSTON_MCP_URL"), "{err}");

    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let token = r.token(run.session_id.unwrap());
    let url = format!("http://{}/mcp", r.addr);
    let (code, out, err) = tokio::task::spawn_blocking(move || {
        hs_night(
            &[
                "plan",
                "--title",
                "Cache the diff",
                "--theme",
                "performance",
                "--deferred",
            ],
            Some((&url, &token)),
        )
    })
    .await
    .unwrap();
    assert_eq!(code, 0, "stdout {out} stderr {err}");
    assert!(out.contains("recorded deferred entry"), "{out}");
    let entries = r.run(run.run_id).entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, proto::NightEntryKind::Deferred);
    assert_eq!(entries[0].title, "Cache the diff");
    assert_eq!(entries[0].theme.as_deref(), Some("performance"));
}

/// Each choice is its own argument, so no shell or `.cmd` wrapper sees a `|`.
#[tokio::test]
async fn decision_options_are_repeated_flags() {
    let r = rig().await;
    let routine = r.ready(|_| {});
    let run = r.run_now(routine.id, 120);
    let token = r.token(run.session_id.unwrap());
    let url = format!("http://{}/mcp", r.addr);
    let (code, out, err) = tokio::task::spawn_blocking(move || {
        let mcp = Some((url.as_str(), token.as_str()));
        let refused = hs_night(
            &[
                "decision",
                "--title",
                "Old API?",
                "--options",
                "keep|remove",
            ],
            mcp,
        );
        assert_eq!(refused.0, 2, "{refused:?}");
        assert!(
            refused.2.contains("--option keep --option remove"),
            "{refused:?}"
        );
        hs_night(
            &[
                "decision",
                "--title",
                "Keep the old API?",
                "--option",
                "keep",
                "--option",
                "remove it",
            ],
            mcp,
        )
    })
    .await
    .unwrap();
    assert_eq!(code, 0, "stdout {out} stderr {err}");
    let entries = r.run(run.run_id).entries;
    assert_eq!(entries.len(), 1, "the refused form records nothing");
    assert_eq!(entries[0].kind, proto::NightEntryKind::Decision);
    assert!(
        entries[0].body.ends_with("Options: keep | remove it"),
        "{:?}",
        entries[0].body
    );
}

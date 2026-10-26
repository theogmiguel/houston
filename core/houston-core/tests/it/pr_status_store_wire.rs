#![cfg(unix)]
#![allow(clippy::disallowed_methods)]

use crate::common;

use common::{connect_and_hello, next_control, TOKEN};
use futures_util::SinkExt;
use houston_core::daemon::{Daemon, DaemonConfig};
use houston_core::server;
use houston_protocol as proto;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message;

/// gh answers `pr view` with the title in `bin/title` and logs every call.
fn write_fake_gh(bin: &Path) {
    std::fs::create_dir_all(bin).unwrap();
    let dir = bin.display();
    let script = format!(
        r#"#!/bin/sh
echo "$*" >> '{dir}/gh.log'
case "$1" in
  --version) echo 'gh version 2.0.0'; exit 0;;
  auth) exit 0;;
  pr) printf '{{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","title":"%s","headRefName":"feature","additions":2,"deletions":1,"isDraft":false}}' "$(cat '{dir}/title')"; exit 0;;
esac
exit 1
"#
    );
    let gh = bin.join("gh");
    std::fs::write(&gh, script).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
}

async fn serve(state: &Path) -> (std::net::SocketAddr, Arc<Daemon>) {
    let daemon = Daemon::new(DaemonConfig::new(
        TOKEN.to_string(),
        state.join("test.db"),
        common::base_env(),
    ))
    .unwrap();
    let (addr, _handle) = server::start(daemon.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    daemon.set_port(addr.port());
    (addr, daemon)
}

async fn pr_titles(addr: std::net::SocketAddr, dir: &Path, replies: usize) -> Vec<String> {
    let mut ws = connect_and_hello(addr, TOKEN).await;
    while !matches!(
        next_control(&mut ws).await,
        proto::ServerMsg::HelloOk { .. }
    ) {}
    let request = proto::ClientMsg::PrStatus {
        dir: dir.display().to_string(),
    };
    ws.send(Message::text(serde_json::to_string(&request).unwrap()))
        .await
        .unwrap();
    let mut titles = Vec::new();
    while titles.len() < replies {
        if let proto::ServerMsg::PrStatus { pr, .. } = next_control(&mut ws).await {
            titles.push(pr.map(|pr| pr.title).unwrap_or_default());
        }
    }
    titles
}

#[tokio::test]
async fn a_restarted_daemon_answers_pr_status_from_its_file_then_from_gh() {
    let state = houston_core::fixture_dirs::tempdir_outside_git();
    let repo = state.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    let bin = state.path().join("bin");
    write_fake_gh(&bin);
    let _path = common::prepend_path(&bin);
    let title = bin.join("title");
    std::fs::write(&title, "Before restart").unwrap();

    let (addr, first) = serve(state.path()).await;
    assert_eq!(pr_titles(addr, &repo, 1).await, ["Before restart"]);
    first.persist_all();
    let stored =
        std::fs::read_to_string(state.path().join(houston_core::pr_status_store::FILE_NAME))
            .expect("the answer is on disk");
    assert!(stored.contains("Before restart"), "{stored}");
    assert!(
        !stored.contains("token") && !stored.contains(TOKEN),
        "nothing secret is stored: {stored}"
    );

    std::fs::write(&title, "After restart").unwrap();
    houston_core::gh::clear_pr_status_cache_for_test();
    let (addr, _second) = serve(state.path()).await;
    assert_eq!(
        pr_titles(addr, &repo, 2).await,
        ["Before restart", "After restart"],
        "the stored answer comes first, then gh's fresh one replaces it"
    );
    assert_eq!(
        pr_titles(addr, &repo, 1).await,
        ["After restart"],
        "a stored answer is served once"
    );
}

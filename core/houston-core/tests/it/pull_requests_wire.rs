#![allow(clippy::disallowed_methods)]

use houston_core::pull_requests::{
    self, Host, PullRequestLink, PullRequestLinkSource, PullRequestState,
};
use houston_protocol as proto;
use std::path::Path;
use std::process::Command;

fn run_git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo(dir: &Path) {
    run_git(dir, &["init", "-b", "main"]);
    run_git(dir, &["config", "user.email", "t@t.local"]);
    run_git(dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    run_git(dir, &["add", "-A"]);
    run_git(dir, &["commit", "-m", "init"]);
}

fn sample_link(number: u32) -> PullRequestLink {
    PullRequestLink {
        host: "GitHub".to_string(),
        repository: "owner/repo".to_string(),
        number,
        url: format!("https://github.com/owner/repo/pull/{number}"),
        state: PullRequestState::Open,
        source: PullRequestLinkSource::Created,
        title: Some("a change".to_string()),
        is_draft: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        checks: Some(proto::PrChecks::Passing),
        review_decision: None,
        linked_at: 1,
        merged_at: None,
        closed_at: None,
        synced_at: Some(1),
    }
}

#[test]
fn remote_kinds_are_classified_and_non_github_hosts_are_refused_by_name() {
    assert_eq!(
        pull_requests::classify_remote("git@github.com:owner/repo.git"),
        Host::GitHub
    );
    assert_eq!(
        pull_requests::classify_remote("https://gitlab.com/owner/repo.git"),
        Host::GitLab
    );
    assert_eq!(
        pull_requests::classify_remote("https://bitbucket.org/owner/repo.git"),
        Host::Bitbucket
    );
    assert_eq!(
        pull_requests::classify_remote("https://dev.azure.com/org/project/_git/repo"),
        Host::AzureDevOps
    );

    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let err = pull_requests::ensure_supported(repo.path())
        .unwrap_err()
        .to_string();
    assert!(err.contains("no git remote"), "unexpected: {err}");

    run_git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://gitlab.com/owner/repo.git",
        ],
    );
    let err = pull_requests::ensure_supported(repo.path())
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("GitLab"),
        "the refusal must name the host: {err}"
    );

    run_git(
        repo.path(),
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:owner/repo.git",
        ],
    );
    assert_eq!(
        pull_requests::ensure_supported(repo.path()).unwrap(),
        Host::GitHub
    );
}

#[test]
fn linking_and_unlinking_a_pull_request_is_a_roundtrip() {
    let mut linked: Option<PullRequestLink> = None;
    let mut list: Vec<PullRequestLink> = Vec::new();

    pull_requests::link_pr(&mut linked, &mut list, sample_link(7));
    assert_eq!(linked.as_ref().unwrap().number, 7);
    assert_eq!(list.len(), 1);

    pull_requests::link_pr(&mut linked, &mut list, sample_link(7));
    assert_eq!(
        list.len(),
        1,
        "linking the same pull request twice must replace, not duplicate"
    );

    assert!(pull_requests::unlink_pr(
        &mut linked,
        &mut list,
        "GitHub",
        "owner/repo",
        7
    ));
    assert!(linked.is_none());
    assert!(list.is_empty());

    assert!(
        !pull_requests::unlink_pr(&mut linked, &mut list, "GitHub", "owner/repo", 7),
        "unlinking a pull request that is not linked must be reported, not invented"
    );
}

#[test]
fn a_linked_pull_request_is_kept_when_a_different_one_is_unlinked() {
    let mut linked = Some(sample_link(7));
    let mut list = vec![sample_link(7), sample_link(8)];

    assert!(pull_requests::unlink_pr(
        &mut linked,
        &mut list,
        "GitHub",
        "owner/repo",
        8
    ));
    assert_eq!(list.len(), 1);
    assert_eq!(
        linked.as_ref().unwrap().number,
        7,
        "the linked pull request must stay linked while the list loses another one"
    );
    assert!(pull_requests::unlink_pr(
        &mut linked,
        &mut list,
        "GitHub",
        "owner/repo",
        7
    ));
    assert!(linked.is_none());
}

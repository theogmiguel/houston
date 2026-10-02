//! Which forge serves a workspace, decided from its git remote in one place.
//! Reads that every forge answers dispatch here; writes stay GitHub-only.

use anyhow::{bail, Result};
use std::path::Path;

use crate::gh::PrLookup;
use crate::pull_requests::{self, Host, PrDetail, PullRequestLink, PullRequestLinkSource};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Forge {
    /// Through the operator's own `gh`.
    GitHub,
    /// bitbucket.org, addressed by its workspace and repository slug.
    Bitbucket { workspace: String, repo: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeResolution {
    Ready(Forge),
    /// A remote on a host without an adapter.
    Unsupported {
        host: String,
    },
    NoRemote,
}

pub fn resolve(dir: &Path) -> ForgeResolution {
    let Some(url) = crate::git::remote_url(dir) else {
        return ForgeResolution::NoRemote;
    };
    match pull_requests::classify_remote(&url) {
        Host::GitHub => ForgeResolution::Ready(Forge::GitHub),
        Host::Bitbucket => match crate::gh::split_repository(&url) {
            Some((workspace, repo)) => ForgeResolution::Ready(Forge::Bitbucket { workspace, repo }),
            None => ForgeResolution::Unsupported {
                host: Host::Bitbucket.name().to_string(),
            },
        },
        other => ForgeResolution::Unsupported {
            host: other.name().to_string(),
        },
    }
}

/// Why `dir` has no pull request reader, in the words the tab has always shown.
fn refusal(dir: &Path, resolution: &ForgeResolution) -> String {
    let host = match resolution {
        ForgeResolution::NoRemote => {
            return format!(
                "{} has no git remote; a pull request needs one, and only GitHub through `gh` is supported here",
                dir.display()
            )
        }
        ForgeResolution::Ready(Forge::GitHub) => "GitHub",
        ForgeResolution::Ready(Forge::Bitbucket { .. }) => Host::Bitbucket.name(),
        ForgeResolution::Unsupported { host } => host,
    };
    format!(
        "{host} is not supported here: only GitHub through `gh` is, and GitLab, Bitbucket and Azure DevOps are follow-ups"
    )
}

/// The branch's own pull request; `Ok(None)` is the forge saying there is none.
pub fn read_branch(dir: &Path) -> Result<Option<(PullRequestLink, PrDetail)>> {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::GitHub) => pull_requests::read_branch(dir),
        other => bail!("{}", refusal(dir, &other)),
    }
}

/// One pull request by number, keeping a persisted link's source and time.
pub fn read(
    dir: &Path,
    number: u32,
    source: PullRequestLinkSource,
    existing: Option<&PullRequestLink>,
) -> Result<(PullRequestLink, PrDetail)> {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::GitHub) => {
            pull_requests::read(dir, Some(number), source, existing)
        }
        other => bail!("{}", refusal(dir, &other)),
    }
}

/// The merged-pull-request question the worktree sweep asks of a checkout.
pub fn merged_facts(dir: &Path) -> PrLookup {
    crate::gh::pr_for_checkout(dir)
}

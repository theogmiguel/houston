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

/// A remote's host without its userinfo or port, which a refusal may show: a
/// remote URL can embed a token. `None` for a local path or `file://`.
pub fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = match url.split_once("://") {
        Some((scheme, _)) if scheme.eq_ignore_ascii_case("file") => return None,
        Some((_, rest)) => rest.split('/').next().unwrap_or(rest),
        None => {
            let (authority, _) = url.split_once(':')?;
            // `C:\repo` and `./a:b` are paths, not hosts.
            if authority.len() < 2 || authority.contains(['/', '\\']) {
                return None;
            }
            authority
        }
    };
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(v6),
        None => host_port.split(':').next().unwrap_or(host_port),
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
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

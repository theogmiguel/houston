//! Which forge serves a workspace, decided from its git remote in one place.
//! Reads that every forge answers dispatch here; writes stay GitHub-only.

use anyhow::{bail, Result};
use houston_protocol as proto;
use std::path::Path;

use crate::gh::PrLookup;
use crate::pull_requests::bitbucket::BitbucketClient;
use crate::pull_requests::{self, PrDetail, PullRequestLink, PullRequestLinkSource};

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
    /// A remote on a forge known not to be GitHub, named for the user; `host`
    /// never carries credentials.
    Unsupported {
        host: String,
    },
    /// A host Houston does not recognise, or a local path. `gh` decides what it
    /// serves (GitHub Enterprise Server, another remote), so only the reads that
    /// have always refused it do.
    Unknown {
        host: String,
    },
    NoRemote,
}

pub fn resolve(dir: &Path) -> ForgeResolution {
    match crate::git::remote_url(dir) {
        Some(url) => resolve_url(&url),
        None => ForgeResolution::NoRemote,
    }
}

/// By the remote's host, never its path or userinfo. Any host naming
/// `github.com` is GitHub, which keeps SSH aliases such as `github.com-work`
/// working through `gh`; a host Houston does not know is `Unknown`, not refused.
pub fn resolve_url(url: &str) -> ForgeResolution {
    let Some(remote) = parse_remote(url) else {
        return ForgeResolution::Unknown {
            host: "a local path".to_string(),
        };
    };
    let host = remote.host.as_str();
    let named = |name: &str| ForgeResolution::Unsupported {
        host: name.to_string(),
    };
    match host {
        h if h.contains("github.com") => ForgeResolution::Ready(Forge::GitHub),
        "bitbucket.org" | "www.bitbucket.org" | "altssh.bitbucket.org" => {
            let mut parts = remote.path.split('/').filter(|p| !p.is_empty());
            match (
                parts.next(),
                parts.next().map(|r| r.trim_end_matches(".git")),
            ) {
                (Some(workspace), Some(repo)) if is_slug(workspace) && is_slug(repo) => {
                    ForgeResolution::Ready(Forge::Bitbucket {
                        workspace: workspace.to_string(),
                        repo: repo.to_string(),
                    })
                }
                _ => named("bitbucket.org"),
            }
        }
        h if h.contains("bitbucket") => named("Bitbucket Data Center"),
        h if h.contains("gitlab") => named("GitLab"),
        "dev.azure.com" | "ssh.dev.azure.com" => named("Azure DevOps"),
        h if h.ends_with(".visualstudio.com") => named("Azure DevOps"),
        h => ForgeResolution::Unknown {
            host: h.to_string(),
        },
    }
}

/// A Bitbucket workspace or repository slug, which goes into the API path
/// as is: `.`, `..`, separators and control characters never do.
pub fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

struct Remote {
    host: String,
    path: String,
}

/// `scheme://[userinfo@]host[:port]/path` or scp-like `[user@]host:path`, with
/// the userinfo dropped; `None` for a local path or `file://`.
fn parse_remote(url: &str) -> Option<Remote> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((scheme, _)) if scheme.eq_ignore_ascii_case("file") => return None,
        Some((_, rest)) => rest.split_once('/').unwrap_or((rest, "")),
        None => {
            let (authority, path) = url.split_once(':')?;
            // `C:\repo` and `./a:b` are paths, not hosts.
            if authority.len() < 2 || authority.contains(['/', '\\']) {
                return None;
            }
            (authority, path)
        }
    };
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(v6),
        None => host_port.split(':').next().unwrap_or(host_port),
    };
    if host.is_empty() {
        return None;
    }
    Some(Remote {
        host: host.to_ascii_lowercase(),
        path: path.split(['?', '#']).next().unwrap_or(path).to_string(),
    })
}

/// What only the daemon knows: whether the user enabled the Bitbucket reader,
/// where its API lives, and which keychain service holds the token.
pub struct ForgeContext {
    pub bitbucket_enabled: bool,
    pub bitbucket_api_base: String,
    pub keychain_service: String,
}

/// What can read a pull request in a workspace.
pub enum Reader {
    GitHub,
    Bitbucket {
        workspace: String,
        repo: String,
        client: Box<BitbucketClient>,
    },
}

/// The forge's access state for the tab, and its reader when it has one. A
/// blocked forge carries the hint the tab shows, a reader that could not be
/// built the reason; nothing here touches the network.
pub struct Opened {
    pub access: proto::ForgeAccess,
    pub reader: Option<Reader>,
    pub hint: Option<String>,
    pub message: Option<String>,
}

pub fn open(dir: &Path, ctx: &ForgeContext) -> Opened {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::GitHub) | ForgeResolution::NoRemote => {
            let gh = crate::gh::state(dir);
            Opened {
                access: proto::ForgeAccess::Github { gh },
                reader: (gh == proto::GhState::Ready).then_some(Reader::GitHub),
                hint: crate::gh::hint_for(gh),
                message: None,
            }
        }
        // An unknown host has never been read here: the GitHub read refuses it.
        ForgeResolution::Unsupported { host } | ForgeResolution::Unknown { host } => Opened {
            hint: Some(unsupported_hint(&host)),
            access: proto::ForgeAccess::Unsupported { host },
            reader: None,
            message: None,
        },
        ForgeResolution::Ready(Forge::Bitbucket { workspace, repo }) => {
            open_bitbucket(workspace, repo, ctx)
        }
    }
}

fn open_bitbucket(workspace: String, repo: String, ctx: &ForgeContext) -> Opened {
    let blocked = |state, hint: String| Opened {
        access: proto::ForgeAccess::Bitbucket { state },
        reader: None,
        hint: Some(hint),
        message: None,
    };
    if !ctx.bitbucket_enabled {
        return blocked(
            proto::BitbucketAccess::Off,
            "Bitbucket Cloud pull requests are off; turn them on in Settings ▸ Accounts"
                .to_string(),
        );
    }
    let credentials = match crate::forge_credentials::load(&ctx.keychain_service) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return blocked(
                proto::BitbucketAccess::NoToken,
                "no Bitbucket API token is stored; add one in Settings ▸ Accounts".to_string(),
            )
        }
        Err(e) => return blocked(proto::BitbucketAccess::KeychainUnavailable, e.to_string()),
    };
    let ready = proto::ForgeAccess::Bitbucket {
        state: proto::BitbucketAccess::Ready,
    };
    match BitbucketClient::with_base_url(&credentials, &ctx.bitbucket_api_base) {
        Ok(client) => Opened {
            access: ready,
            reader: Some(Reader::Bitbucket {
                workspace,
                repo,
                client: Box::new(client),
            }),
            hint: None,
            message: None,
        },
        // The token was read; what failed is Houston's own HTTP client.
        Err(e) => Opened {
            access: ready,
            reader: None,
            hint: None,
            message: Some(e.to_string()),
        },
    }
}

fn unsupported_hint(host: &str) -> String {
    format!("Pull requests on {host} are not supported; Houston reads GitHub through `gh` and Bitbucket Cloud")
}

/// The branch's own pull request; `Ok(None)` is the forge saying there is none.
pub fn read_branch(dir: &Path, reader: &Reader) -> Result<Option<(PullRequestLink, PrDetail)>> {
    match reader {
        Reader::GitHub => pull_requests::read_branch(dir),
        Reader::Bitbucket {
            workspace,
            repo,
            client,
        } => {
            let Some(branch) = crate::git::branch(dir) else {
                return Ok(None);
            };
            match client.branch_pull_request(workspace, repo, &branch)? {
                Some(number) => client
                    .read(
                        workspace,
                        repo,
                        number,
                        PullRequestLinkSource::Detected,
                        pull_requests::now_unix(),
                    )
                    .map(Some),
                None => Ok(None),
            }
        }
    }
}

/// One pull request by number, keeping a persisted link's source and time.
pub fn read(
    dir: &Path,
    reader: &Reader,
    number: u32,
    source: PullRequestLinkSource,
    existing: Option<&PullRequestLink>,
) -> Result<(PullRequestLink, PrDetail)> {
    match reader {
        Reader::GitHub => pull_requests::read(dir, Some(number), source, existing),
        Reader::Bitbucket {
            workspace,
            repo,
            client,
        } => client.read(
            workspace,
            repo,
            number,
            source,
            existing
                .map(|l| l.linked_at)
                .unwrap_or_else(pull_requests::now_unix),
        ),
    }
}

/// The merged-pull-request question the worktree sweep asks of a checkout. A
/// Bitbucket checkout is not asked yet: the sweep runs unattended, and nothing
/// unattended contacts Bitbucket.
pub fn merged_facts(dir: &Path) -> PrLookup {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::Bitbucket { .. }) => PrLookup::Failed(
            "Bitbucket pull requests are not read by the worktree check yet".to_string(),
        ),
        _ => crate::gh::pr_for_checkout(dir),
    }
}

/// The one guard in front of every write and GitHub-only read: a forge known
/// not to be GitHub is refused by forge and operation before a request is made.
/// An unknown host or no remote passes, so `gh` answers as it always has.
pub fn require_github(dir: &Path, op: &str) -> Result<()> {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::GitHub)
        | ForgeResolution::Unknown { .. }
        | ForgeResolution::NoRemote => Ok(()),
        ForgeResolution::Ready(Forge::Bitbucket { .. }) => bail!(
            "Bitbucket Cloud pull requests are read-only in Houston; refusing to {op} — do it on Bitbucket"
        ),
        ForgeResolution::Unsupported { host } => {
            bail!("{host} is not supported here; refusing to {op}")
        }
    }
}

/// The name of a forge known not to be GitHub, for a caller that only asks
/// `gh`; `None` for GitHub, an unknown host or no remote, which `gh` answers.
pub fn non_github_forge(dir: &Path) -> Option<String> {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::Bitbucket { .. }) => Some("Bitbucket Cloud".to_string()),
        ForgeResolution::Unsupported { host } => Some(host),
        ForgeResolution::Ready(Forge::GitHub)
        | ForgeResolution::Unknown { .. }
        | ForgeResolution::NoRemote => None,
    }
}

/// The Changes pane's PR line for a forge known not to be GitHub, so `gh pr
/// view` is not run there; `None` lets `gh` answer.
pub fn status_hint(dir: &Path) -> Option<String> {
    match resolve(dir) {
        ForgeResolution::Ready(Forge::GitHub)
        | ForgeResolution::Unknown { .. }
        | ForgeResolution::NoRemote => None,
        ForgeResolution::Ready(Forge::Bitbucket { .. }) => Some(
            "Bitbucket Cloud pull requests show, read-only, in the Pull request tab".to_string(),
        ),
        ForgeResolution::Unsupported { host } => Some(unsupported_hint(&host)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bitbucket(workspace: &str, repo: &str) -> ForgeResolution {
        ForgeResolution::Ready(Forge::Bitbucket {
            workspace: workspace.into(),
            repo: repo.into(),
        })
    }

    fn unsupported(host: &str) -> ForgeResolution {
        ForgeResolution::Unsupported { host: host.into() }
    }

    fn unknown(host: &str) -> ForgeResolution {
        ForgeResolution::Unknown { host: host.into() }
    }

    #[test]
    fn remotes_resolve_by_their_host() {
        let github = ForgeResolution::Ready(Forge::GitHub);
        for (url, want) in [
            ("git@github.com:owner/repo.git", github.clone()),
            ("https://github.com/owner/repo.git", github.clone()),
            (
                "ssh://git@ssh.github.com:443/owner/repo.git",
                github.clone(),
            ),
            ("git@github.com-work:owner/repo.git", github.clone()),
            ("ssh://git@github.com-work/owner/repo.git", github.clone()),
            ("github.com-work:owner/repo.git", github.clone()),
            (
                "https://github.mycorp.com/owner/repo.git",
                unknown("github.mycorp.com"),
            ),
            ("https://bitbucket.org/ws/repo.git", bitbucket("ws", "repo")),
            ("git@bitbucket.org:ws/repo.git", bitbucket("ws", "repo")),
            (
                "ssh://git@altssh.bitbucket.org:443/ws/repo.git",
                bitbucket("ws", "repo"),
            ),
            (
                "https://user@bitbucket.org/ws/repo",
                bitbucket("ws", "repo"),
            ),
            (
                "https://x-bitbucket-api-token-auth:SECRET@bitbucket.org/ws/repo.git",
                bitbucket("ws", "repo"),
            ),
            ("https://bitbucket.org/ws", unsupported("bitbucket.org")),
            (
                "https://bitbucket.example.com/scm/a/b.git",
                unsupported("Bitbucket Data Center"),
            ),
            ("https://gitlab.com/owner/repo.git", unsupported("GitLab")),
            (
                "https://dev.azure.com/org/project/_git/repo",
                unsupported("Azure DevOps"),
            ),
            (
                "https://proxy.example.com/github.com/owner/repo.git",
                unknown("proxy.example.com"),
            ),
            ("/srv/git/repo.git", unknown("a local path")),
            ("file:///srv/git/repo.git", unknown("a local path")),
        ] {
            assert_eq!(resolve_url(url), want, "{url}");
        }
    }

    #[test]
    fn a_bitbucket_remote_whose_slugs_could_leave_the_api_path_is_refused() {
        for url in [
            "https://bitbucket.org/../../x",
            "https://bitbucket.org/ws/..",
            "https://bitbucket.org/./repo",
            "git@bitbucket.org:ws/re%2fpo.git",
            "https://bitbucket.org/ws/re\u{7}po",
        ] {
            assert_eq!(resolve_url(url), unsupported("bitbucket.org"), "{url}");
        }
        assert_eq!(
            resolve_url("https://bitbucket.org/my-ws_1/repo.name.git"),
            bitbucket("my-ws_1", "repo.name")
        );
    }

    #[test]
    fn no_resolution_carries_a_remotes_userinfo() {
        for url in [
            "https://x-token-auth:SECRET@git.example.com/a/b.git",
            "https://user:SECRET@gitlab.com/a/b.git",
            "ssh://SECRET@bitbucket.corp.example:7999/a/b.git",
            "https://SECRET@[::1]:8443/a/b.git",
        ] {
            let resolved = resolve_url(url);
            assert!(
                !format!("{resolved:?}").contains("SECRET"),
                "{url}: {resolved:?}"
            );
        }
    }
}

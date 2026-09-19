pub(crate) mod github;

use anyhow::{bail, Result};
use houston_protocol as proto;
use std::path::Path;

pub use houston_protocol::{
    PrCheck, PrCheckState, PrComment, PrDetail, PrMergeState, PrMergeable, PrReview,
    PullRequestLink, PullRequestLinkSource, PullRequestState,
};
pub use proto::PrMergeMethod;

/// How many comments and reviews one `pr_detail` reply carries; the totals ride
/// beside them so a capped list can say what it is not showing.
pub const DETAIL_MAX_COMMENTS: usize = 20;
pub const DETAIL_MAX_REVIEWS: usize = 20;

/// One comment or review body is clipped at this many bytes (UTF-8 safe) with an
/// explicit marker: a wall-of-text review must not ride the control socket whole.
pub const DETAIL_BODY_MAX: usize = 4_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    GitHub,
    GitLab,
    Bitbucket,
    AzureDevOps,
    Unknown(String),
}

impl Host {
    pub fn name(&self) -> &str {
        match self {
            Host::GitHub => "GitHub",
            Host::GitLab => "GitLab",
            Host::Bitbucket => "Bitbucket",
            Host::AzureDevOps => "Azure DevOps",
            Host::Unknown(s) => s,
        }
    }
}

pub fn classify_remote(url: &str) -> Host {
    let lower = url.to_lowercase();
    if lower.contains("github.com") {
        Host::GitHub
    } else if lower.contains("gitlab") {
        Host::GitLab
    } else if lower.contains("bitbucket") {
        Host::Bitbucket
    } else if lower.contains("dev.azure.com") || lower.contains("visualstudio.com") {
        Host::AzureDevOps
    } else {
        Host::Unknown(url.to_string())
    }
}

pub fn ensure_supported(dir: &Path) -> Result<Host> {
    let Some(url) = crate::git::remote_url(dir) else {
        bail!(
            "{} has no git remote; a pull request needs one, and only GitHub through `gh` is supported here",
            dir.display()
        );
    };
    let host = classify_remote(&url);
    match host {
        Host::GitHub => Ok(host),
        other => bail!(
            "{} is not supported here: only GitHub through `gh` is, and GitLab, Bitbucket and Azure DevOps are follow-ups",
            other.name()
        ),
    }
}

pub fn create(
    dir: &Path,
    base: Option<&str>,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<PullRequestLink> {
    ensure_supported(dir)?;
    let created = crate::gh::pr_create_branch(dir, title, body, base, draft);
    if created.gh != proto::GhState::Ready {
        bail!(
            "{}",
            created
                .message
                .unwrap_or_else(|| "gh is not ready to create a pull request".to_string())
        );
    }
    let Some(number) = created.pr.as_ref().map(|p| p.number) else {
        bail!(
            "{}",
            created
                .message
                .unwrap_or_else(|| "gh created no readable pull request".to_string())
        );
    };
    read(dir, Some(number), PullRequestLinkSource::Created, None).map(|(link, _)| link)
}

pub fn refresh(dir: &Path, existing: &PullRequestLink) -> Result<PullRequestLink> {
    read(dir, Some(existing.number), existing.source, Some(existing)).map(|(link, _)| link)
}

/// Read one pull request whole: its link (identity + state) and its detail
/// (body, checks, reviews, merge gate). `None` reads the branch's own pull
/// request, which is never a persisted association.
pub fn read(
    dir: &Path,
    number: Option<u32>,
    source: PullRequestLinkSource,
    existing: Option<&PullRequestLink>,
) -> Result<(PullRequestLink, PrDetail)> {
    let (link, mut detail, head_owner) = read_core(dir, number, source, existing)?;
    enrich(dir, &link, &mut detail, head_owner.as_deref());
    detail.merge_disabled_reason = merge_disabled_reason(link.number, &link, &detail);
    Ok((link, detail))
}

/// The single `gh pr view` read, no GraphQL alongside: identity and the merge
/// gate, nothing that needs permissions or discussions — the merge recheck
/// above all. The third value is the head owner, qualifying the base comparison.
pub fn read_core(
    dir: &Path,
    number: Option<u32>,
    source: PullRequestLinkSource,
    existing: Option<&PullRequestLink>,
) -> Result<(PullRequestLink, PrDetail, Option<String>)> {
    let host = ensure_supported(dir)?;
    let target = number
        .map(|n| format!("#{n}"))
        .unwrap_or_else(|| "the branch's pull request".to_string());
    let json = match crate::gh::pr_detail_read(dir, number) {
        crate::gh::PrRead::Found(v) => v,
        crate::gh::PrRead::NoPr => bail!(
            "gh found no pull request {target} in {}; check the number, or the branch the pull request comes from",
            dir.display()
        ),
        crate::gh::PrRead::Failed(reason) => bail!(
            "could not read {target} from gh in {}: {reason}",
            dir.display()
        ),
    };
    let ctx = github::LinkContext {
        host: host.name(),
        source,
        linked_at: existing.map(|l| l.linked_at).unwrap_or_else(now_unix),
        synced_at: now_unix(),
    };
    let (link, detail) = github::detail_from_json(&json, &ctx).ok_or_else(|| {
        anyhow::anyhow!(
            "gh returned {target} without a number or url; expected a `gh pr view --json` payload"
        )
    })?;
    let head_owner = json
        .pointer("/headRepositoryOwner/login")
        .and_then(|o| o.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok((link, detail, head_owner))
}

/// Fills in what the one `gh pr view` cannot: what GitHub says this viewer may
/// do, and the inline review discussions. Both reads degrade to a named note —
/// a GraphQL hiccup must not blank a page whose core read succeeded.
fn enrich(dir: &Path, link: &PullRequestLink, detail: &mut PrDetail, head_owner: Option<&str>) {
    let Some(repository) = repository_identity(dir, link) else {
        detail.viewer_message = Some(format!(
            "cannot ask GitHub about PR #{} without an `owner/name` repository; the remote names none",
            link.number
        ));
        detail.threads_message = detail.viewer_message.clone();
        return;
    };
    // The comparison is qualified `owner:branch`, because a fork's branch of the
    // same name does not exist in the base repository. A deleted fork has no
    // owner to qualify with, so the comparison is skipped rather than guessed.
    let head_ref = head_owner
        .zip(detail.head_ref.as_deref())
        .map(|(owner, branch)| format!("{owner}:{branch}"));
    let (access, threads) = std::thread::scope(|scope| {
        let access_handle =
            scope.spawn(|| github::access(dir, &repository, link.number, head_ref.as_deref()));
        let threads_handle = scope.spawn(|| github::threads(dir, &repository, link.number));
        (access_handle.join(), threads_handle.join())
    });
    match access {
        Ok(Ok(access)) => {
            detail.viewer = Some(access.permissions);
            detail.behind_by = access.behind_by;
        }
        Ok(Err(e)) => {
            detail.viewer = None;
            detail.viewer_message = Some(format!(
                "could not read what you may do with PR #{}: {e}",
                link.number
            ));
        }
        Err(_) => {
            detail.viewer = None;
            detail.viewer_message = Some(format!(
                "the read of what you may do with PR #{} panicked; refresh",
                link.number
            ));
        }
    }
    match threads {
        Ok(Ok(threads)) => {
            detail.threads = threads.threads;
            detail.threads_truncated = threads.truncated;
            detail.reactions = threads.reactions;
            if !threads.reviewers.is_empty() {
                detail.reviewers = threads.reviewers;
            }
            for comment in detail.comments.iter_mut() {
                if let Some(id) = comment.id.as_deref() {
                    if let Some((_, counts)) =
                        threads.reactions_by_id.iter().find(|(rid, _)| rid == id)
                    {
                        comment.reactions = counts.clone();
                    }
                }
            }
            for review in detail.reviews.iter_mut() {
                if let Some(id) = review.id.as_deref() {
                    if let Some((_, counts)) =
                        threads.reactions_by_id.iter().find(|(rid, _)| rid == id)
                    {
                        review.reactions = counts.clone();
                    }
                }
            }
        }
        Ok(Err(e)) => {
            detail.threads_message = Some(format!(
                "could not read the review threads of PR #{}: {e}",
                link.number
            ));
        }
        Err(_) => {
            detail.threads_message = Some(format!(
                "the review-thread read of PR #{} panicked; refresh",
                link.number
            ));
        }
    }
}

/// `owner/name` for the GraphQL reads: the link's own identity, else the git
/// remote, so a link read from a URL-less payload is still addressable.
fn repository_identity(dir: &Path, link: &PullRequestLink) -> Option<String> {
    if !link.repository.is_empty() {
        return Some(link.repository.clone());
    }
    crate::git::remote_url(dir)
        .and_then(|url| crate::gh::split_repository(&url))
        .map(|(owner, name)| format!("{owner}/{name}"))
}

/// Read the branch's own pull request. `Ok(None)` is only the empty state: gh
/// itself said no pull request exists for the branch. A failed read is an
/// error carrying gh's reason, never an empty state.
pub fn read_branch(dir: &Path) -> Result<Option<(PullRequestLink, PrDetail)>> {
    let host = ensure_supported(dir)?;
    let json = match crate::gh::pr_detail_read(dir, None) {
        crate::gh::PrRead::Found(v) => v,
        crate::gh::PrRead::NoPr => return Ok(None),
        crate::gh::PrRead::Failed(reason) => bail!(
            "could not read the branch's pull request in {}: {reason}",
            dir.display()
        ),
    };
    let ctx = github::LinkContext {
        host: host.name(),
        source: PullRequestLinkSource::Detected,
        linked_at: now_unix(),
        synced_at: now_unix(),
    };
    let (link, mut detail) = github::detail_from_json(&json, &ctx).ok_or_else(|| {
        anyhow::anyhow!(
            "gh returned the branch's pull request without a number or url; expected a `gh pr view --json` payload"
        )
    })?;
    let head_owner = json
        .pointer("/headRepositoryOwner/login")
        .and_then(|o| o.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    enrich(dir, &link, &mut detail, head_owner.as_deref());
    detail.merge_disabled_reason = merge_disabled_reason(link.number, &link, &detail);
    Ok(Some((link, detail)))
}

/// The one merge gate: `None` allows, `Some` names the blocking fact, in the
/// same words for the button and the daemon's own pre-merge recheck. Only
/// `(Mergeable, Clean)` allows; every unknown, pending or failed check blocks.
pub fn merge_disabled_reason(
    number: u32,
    link: &PullRequestLink,
    detail: &PrDetail,
) -> Option<String> {
    match link.state {
        PullRequestState::Merged => return Some(format!("PR #{number} is already merged")),
        PullRequestState::Closed => return Some(format!("PR #{number} is closed")),
        PullRequestState::Open => {}
    }
    if link.is_draft {
        return Some(format!(
            "PR #{number} is a draft — mark it ready for review first"
        ));
    }
    if let Some(reason) = checks_refusal(number, &detail.checks) {
        return Some(reason);
    }
    match link.review_decision.as_deref() {
        Some("CHANGES_REQUESTED") => {
            return Some(format!("changes were requested on PR #{number}"))
        }
        Some("REVIEW_REQUIRED") => return Some(format!("PR #{number} needs an approving review")),
        _ => {}
    }
    let base = detail.base_ref.as_deref().unwrap_or("its base branch");
    match (detail.mergeable, detail.merge_state) {
        (PrMergeable::Mergeable, PrMergeState::Clean) => {}
        (PrMergeable::Conflicting, _) | (_, PrMergeState::Dirty) => {
            return Some(format!("PR #{number} conflicts with {base}"))
        }
        (_, PrMergeState::Behind) => {
            return Some(format!(
                "PR #{number} is behind {base} — update the branch first"
            ))
        }
        (_, PrMergeState::Draft) => {
            return Some(format!(
                "PR #{number} is a draft — mark it ready for review first"
            ))
        }
        (_, PrMergeState::Blocked) => {
            return Some(format!(
                "GitHub reports PR #{number} blocked by branch protection"
            ))
        }
        (_, PrMergeState::HasHooks) => {
            return Some(format!("PR #{number} is waiting on repository hooks"))
        }
        (_, PrMergeState::Unstable) => {
            return Some(format!(
                "GitHub reports PR #{number} unstable — a check may have failed"
            ))
        }
        _ => {
            return Some(format!(
                "GitHub is still computing whether PR #{number} can merge — refresh"
            ))
        }
    }
    None
}

/// What a write needs from GitHub's own answer, so the daemon refuses by the
/// same rule the UI hid behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrNeed {
    Write,
    Update,
    UpdateBranch,
    Triage,
    Resolve,
}

impl PrNeed {
    pub fn allowed(self, p: &proto::PrPermissions) -> bool {
        match self {
            PrNeed::Write => p.can_write,
            PrNeed::Update => p.can_update,
            PrNeed::UpdateBranch => p.can_write && p.can_update_branch,
            PrNeed::Triage => p.can_triage,
            PrNeed::Resolve => p.can_write || p.did_author,
        }
    }

    pub fn missing(self) -> &'static str {
        match self {
            PrNeed::Write => "you do not have write access to this repository",
            PrNeed::Update => "GitHub says you may not update this pull request",
            PrNeed::UpdateBranch => {
                "GitHub says either you may not write to this repository or the branch has nothing to update"
            }
            PrNeed::Triage => "labelling needs triage access, which this account does not have",
            PrNeed::Resolve => {
                "resolving a discussion needs write access or authorship of the pull request"
            }
        }
    }
}

/// Read what GitHub says this account may do, and refuse the write by name when
/// the answer is no: fresh, because access changed since the page loaded is the
/// case this guards, and a failed read refuses too.
pub fn require_access(
    dir: &Path,
    repository: &str,
    number: u32,
    need: PrNeed,
    head_ref: Option<&str>,
) -> Result<proto::PrPermissions> {
    let access = github::access(dir, repository, number, head_ref)
        .map_err(|e| anyhow::anyhow!("could not read what you may do with PR #{number}: {e}"))?;
    if !need.allowed(&access.permissions) {
        bail!("{}; refusing the write to PR #{number}", need.missing());
    }
    Ok(access.permissions)
}

/// Read what GitHub says this account may do, refusing only on a failed read.
/// The review flow needs the answer itself — whether this account wrote the
/// pull request decides which verdicts GitHub will take — rather than a gate.
pub fn read_access(dir: &Path, repository: &str, number: u32) -> Result<proto::PrPermissions> {
    github::access(dir, repository, number, None)
        .map(|a| a.permissions)
        .map_err(|e| anyhow::anyhow!("could not read what you may do with PR #{number}: {e}"))
}

/// `owner/name` for a write, refusing by name when neither the link nor the
/// remote names one.
pub fn repository_for(dir: &Path, link: &PullRequestLink) -> Result<String> {
    repository_identity(dir, link).ok_or_else(|| {
        anyhow::anyhow!(
            "cannot address PR #{} on GitHub: neither the link nor the git remote names an `owner/name` repository",
            link.number
        )
    })
}

/// Approves the fork workflow runs one head commit is waiting on. Each run is
/// re-checked against a fresh head and list, so a push mid-pass stops the pass;
/// a same-repository head is left alone, GitHub starts those itself.
pub fn approve_workflows(dir: &Path, number: u32) -> Result<String> {
    let json = match crate::gh::pr_detail_read(dir, Some(number)) {
        crate::gh::PrRead::Found(v) => v,
        crate::gh::PrRead::NoPr => bail!("gh found no pull request #{number} in {}", dir.display()),
        crate::gh::PrRead::Failed(reason) => {
            bail!("could not read PR #{number} to approve its workflows: {reason}")
        }
    };
    let Some(head) = github::cross_repo_head(&json) else {
        bail!(
            "PR #{number} is not an open cross-repository pull request; GitHub starts same-repository workflows itself and has none waiting on approval"
        );
    };
    let runs = crate::gh::workflow_runs_requiring_approval(dir, &head.sha, &head.branch)?;
    if runs.is_empty() {
        return Ok(format!(
            "no workflow runs on {} await approval for PR #{number}",
            head.sha
        ));
    }
    let mut approved = 0usize;
    for run in &runs {
        let current = match crate::gh::pr_detail_read(dir, Some(number)) {
            crate::gh::PrRead::Found(v) => v,
            _ => bail!(
                "could not re-read PR #{number} before approving run {}",
                run.id
            ),
        };
        let Some(now) = github::cross_repo_head(&current) else {
            bail!(
                "PR #{number} stopped being an open cross-repository pull request; approving stopped at run {}",
                run.id
            );
        };
        if now.sha != head.sha
            || now.branch != head.branch
            || !now.owner.eq_ignore_ascii_case(&head.owner)
        {
            bail!(
                "PR #{number} head moved from {} to {} while approving; run {} was not approved",
                head.sha,
                now.sha,
                run.id
            );
        }
        let still = crate::gh::workflow_runs_requiring_approval(dir, &now.sha, &now.branch)?;
        if !still.iter().any(|r| r.id == run.id) {
            continue;
        }
        let outcome = crate::gh::approve_workflow_run(dir, run.id);
        if !outcome.ok {
            bail!(
                "{}",
                outcome
                    .message
                    .unwrap_or_else(|| format!("approving workflow run {} failed", run.id))
            );
        }
        approved += 1;
    }
    Ok(format!(
        "approved {approved} workflow {} on {} for PR #{number}",
        if approved == 1 { "run" } else { "runs" },
        head.sha
    ))
}

fn checks_refusal(number: u32, checks: &[PrCheck]) -> Option<String> {
    let failing: Vec<&str> = checks
        .iter()
        .filter(|c| c.state == PrCheckState::Failing)
        .map(|c| c.name.as_str())
        .collect();
    if !failing.is_empty() {
        return Some(format!(
            "PR #{number} has {}: {}",
            plural(failing.len(), "failing check", "failing checks"),
            name_list(&failing)
        ));
    }
    let pending: Vec<&str> = checks
        .iter()
        .filter(|c| {
            matches!(
                c.state,
                PrCheckState::Running | PrCheckState::Queued | PrCheckState::Unknown
            )
        })
        .map(|c| c.name.as_str())
        .collect();
    if !pending.is_empty() {
        return Some(format!(
            "PR #{number} is waiting on {}: {}",
            plural(pending.len(), "check", "checks"),
            name_list(&pending)
        ));
    }
    None
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// Names the first three checks and counts the rest, so a wall of check names
/// never crowds out the fact that blocks the merge.
fn name_list(names: &[&str]) -> String {
    const SHOWN: usize = 3;
    if names.len() <= SHOWN {
        return names.join(", ");
    }
    format!(
        "{}, and {} more",
        names[..SHOWN].join(", "),
        names.len() - SHOWN
    )
}

pub fn link_pr(
    linked: &mut Option<PullRequestLink>,
    pull_requests: &mut Vec<PullRequestLink>,
    new: PullRequestLink,
) {
    pull_requests.retain(|p| {
        !(p.host == new.host && p.repository == new.repository && p.number == new.number)
    });
    pull_requests.push(new.clone());
    *linked = Some(new);
}

pub fn unlink_pr(
    linked: &mut Option<PullRequestLink>,
    pull_requests: &mut Vec<PullRequestLink>,
    host: &str,
    repository: &str,
    number: u32,
) -> bool {
    let same =
        |p: &PullRequestLink| p.host == host && p.repository == repository && p.number == number;
    let before = pull_requests.len();
    pull_requests.retain(|p| !same(p));
    let removed = pull_requests.len() != before;
    if linked.as_ref().is_some_and(same) {
        *linked = None;
        return true;
    }
    removed
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> PullRequestLink {
        PullRequestLink {
            host: "GitHub".into(),
            repository: "owner/repo".into(),
            number: 7,
            url: "https://github.com/owner/repo/pull/7".into(),
            state: PullRequestState::Open,
            source: PullRequestLinkSource::Manual,
            title: Some("a change".into()),
            is_draft: false,
            additions: 1,
            deletions: 0,
            changed_files: 1,
            checks: None,
            review_decision: None,
            linked_at: 1,
            merged_at: None,
            closed_at: None,
            synced_at: Some(1),
        }
    }

    fn detail(mergeable: PrMergeable, merge_state: PrMergeState) -> PrDetail {
        PrDetail {
            body: None,
            author: None,
            base_ref: Some("main".into()),
            head_ref: Some("feat/x".into()),
            head_sha: "abc1234".into(),
            commit_count: 1,
            created_at: 0,
            updated_at: 0,
            mergeable,
            merge_state,
            checks: Vec::new(),
            comments: Vec::new(),
            reviews: Vec::new(),
            comments_total: 0,
            reviews_total: 0,
            merge_disabled_reason: None,
            viewer: None,
            viewer_message: None,
            behind_by: None,
            labels: Vec::new(),
            reviewers: Vec::new(),
            reactions: Vec::new(),
            threads: Vec::new(),
            threads_truncated: false,
            threads_message: None,
            auto_merge_enabled: None,
            auto_merge_method: None,
            cross_repository: false,
        }
    }

    #[test]
    fn a_write_need_reads_githubs_own_answer() {
        let none = proto::PrPermissions {
            can_write: false,
            can_triage: false,
            can_update: false,
            did_author: false,
            can_update_branch: false,
        };
        assert!(!PrNeed::Write.allowed(&none));
        assert!(!PrNeed::Update.allowed(&none));
        assert!(!PrNeed::Triage.allowed(&none));
        assert!(!PrNeed::Resolve.allowed(&none));

        let author = proto::PrPermissions {
            did_author: true,
            ..none
        };
        assert!(PrNeed::Resolve.allowed(&author), "an author may resolve");
        assert!(!PrNeed::Write.allowed(&author));

        let triager = proto::PrPermissions {
            can_triage: true,
            ..none
        };
        assert!(PrNeed::Triage.allowed(&triager));
        assert!(!PrNeed::Write.allowed(&triager), "triage is not write");

        let writer = proto::PrPermissions {
            can_write: true,
            can_update: true,
            ..none
        };
        assert!(PrNeed::Write.allowed(&writer));
        assert!(
            !PrNeed::UpdateBranch.allowed(&writer),
            "write alone is not update-branch"
        );

        let updater = proto::PrPermissions {
            can_write: true,
            can_update_branch: true,
            ..none
        };
        assert!(PrNeed::UpdateBranch.allowed(&updater));
    }

    #[test]
    fn a_permission_refusal_names_the_need() {
        assert!(PrNeed::Write.missing().contains("write access"));
        assert!(PrNeed::Triage.missing().contains("triage"));
        assert!(PrNeed::Resolve.missing().contains("authorship"));
    }

    fn reason(link: &PullRequestLink, detail: &PrDetail) -> Option<String> {
        merge_disabled_reason(link.number, link, detail)
    }

    #[test]
    fn only_mergeable_and_clean_allows_the_merge() {
        assert_eq!(
            reason(
                &link(),
                &detail(PrMergeable::Mergeable, PrMergeState::Clean)
            ),
            None
        );
        assert!(reason(
            &link(),
            &detail(PrMergeable::Mergeable, PrMergeState::Behind)
        )
        .unwrap()
        .contains("behind main"));
        assert!(reason(
            &link(),
            &detail(PrMergeable::Mergeable, PrMergeState::Unstable)
        )
        .unwrap()
        .contains("unstable"));
    }

    #[test]
    fn an_unknown_mergeable_or_state_never_becomes_allowed() {
        let unknown_mergeable = reason(&link(), &detail(PrMergeable::Unknown, PrMergeState::Clean));
        assert!(
            unknown_mergeable.unwrap().contains("still computing"),
            "an unknown mergeable with a clean state must refuse"
        );
        let unknown_state = reason(
            &link(),
            &detail(PrMergeable::Mergeable, PrMergeState::Unknown),
        );
        assert!(unknown_state.unwrap().contains("still computing"));
        let both = reason(
            &link(),
            &detail(PrMergeable::Unknown, PrMergeState::Unknown),
        );
        assert!(both.unwrap().contains("still computing"));
    }

    #[test]
    fn a_check_in_an_unknown_state_blocks_and_is_named() {
        let mut d = detail(PrMergeable::Mergeable, PrMergeState::Clean);
        d.checks = vec![PrCheck {
            name: "unnamed check".into(),
            state: PrCheckState::Unknown,
            url: None,
            duration_ms: None,
        }];
        let reason = reason(&link(), &d).unwrap();
        assert!(reason.contains("waiting on 1 check"), "{reason}");
        assert!(reason.contains("unnamed check"), "{reason}");
    }

    #[test]
    fn failing_and_running_checks_block_with_their_names() {
        let mut d = detail(PrMergeable::Mergeable, PrMergeState::Clean);
        d.checks = vec![
            PrCheck {
                name: "core-checks".into(),
                state: PrCheckState::Failing,
                url: None,
                duration_ms: None,
            },
            PrCheck {
                name: "renderer-checks".into(),
                state: PrCheckState::Running,
                url: None,
                duration_ms: None,
            },
        ];
        let reason = reason(&link(), &d).unwrap();
        assert!(reason.contains("failing check"), "{reason}");
        assert!(reason.contains("core-checks"), "{reason}");
        assert!(
            !reason.contains("renderer-checks"),
            "a failing check outranks a running one: {reason}"
        );
    }

    #[test]
    fn closed_merged_draft_and_conflicts_refuse() {
        let mut merged = link();
        merged.state = PullRequestState::Merged;
        assert!(reason(
            &merged,
            &detail(PrMergeable::Mergeable, PrMergeState::Clean)
        )
        .unwrap()
        .contains("already merged"));

        let mut closed = link();
        closed.state = PullRequestState::Closed;
        assert!(reason(
            &closed,
            &detail(PrMergeable::Mergeable, PrMergeState::Clean)
        )
        .unwrap()
        .contains("closed"));

        let mut draft = link();
        draft.is_draft = true;
        assert!(
            reason(&draft, &detail(PrMergeable::Mergeable, PrMergeState::Clean))
                .unwrap()
                .contains("draft")
        );

        let conflict = reason(
            &link(),
            &detail(PrMergeable::Conflicting, PrMergeState::Dirty),
        )
        .unwrap();
        assert!(conflict.contains("conflicts with main"), "{conflict}");
    }

    #[test]
    fn a_review_requirement_refuses_by_name() {
        let mut link = link();
        link.review_decision = Some("CHANGES_REQUESTED".into());
        assert!(reason(
            &link,
            &detail(PrMergeable::Mergeable, PrMergeState::Blocked)
        )
        .unwrap()
        .contains("changes were requested"));

        link.review_decision = Some("REVIEW_REQUIRED".into());
        assert!(reason(
            &link,
            &detail(PrMergeable::Mergeable, PrMergeState::Blocked)
        )
        .unwrap()
        .contains("approving review"));
    }

    #[test]
    fn more_than_three_check_names_are_counted_not_dropped() {
        let mut d = detail(PrMergeable::Mergeable, PrMergeState::Clean);
        d.checks = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|n| PrCheck {
                name: (*n).into(),
                state: PrCheckState::Failing,
                url: None,
                duration_ms: None,
            })
            .collect();
        let reason = reason(&link(), &d).unwrap();
        assert!(reason.contains("5 failing checks"), "{reason}");
        assert!(reason.contains("a, b, c, and 2 more"), "{reason}");
    }
}

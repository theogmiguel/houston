use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use std::path::Path;

pub const AUTH_HINT: &str = "gh is not signed in — run `gh auth login`";

pub const MISSING_HINT: &str = "gh is not installed — install the GitHub CLI to open PRs from here";

const PR_VIEW_FIELDS: &str = "number,url,state,reviewDecision,statusCheckRollup";

// Two commands, not one: unauthenticated `gh` and absent `gh` both exit
// non-zero, so only probing `--version` first can tell the two hints apart.
pub fn state(dir: &Path) -> proto::GhState {
    let Ok(out) = run(dir, &["--version"]) else {
        return proto::GhState::Missing;
    };
    if !out.ok {
        return proto::GhState::Missing;
    }
    match run(dir, &["auth", "status"]) {
        Ok(o) if o.ok => proto::GhState::Ready,
        _ => proto::GhState::Unauthenticated,
    }
}

pub fn hint_for(state: proto::GhState) -> Option<String> {
    match state {
        proto::GhState::Missing => Some(MISSING_HINT.to_string()),
        proto::GhState::Unauthenticated => Some(AUTH_HINT.to_string()),
        proto::GhState::Ready => None,
    }
}

pub struct PrStatus {
    pub gh: proto::GhState,
    pub has_upstream: bool,
    pub pr: Option<proto::PrInfo>,
    pub hint: Option<String>,
}

pub fn pr_status(dir: &Path) -> PrStatus {
    let gh = state(dir);
    let has_upstream = crate::git::sync(dir).upstream.is_some();
    if gh != proto::GhState::Ready {
        return PrStatus {
            gh,
            has_upstream,
            pr: None,
            hint: hint_for(gh),
        };
    }
    let pr = match run(dir, &["pr", "view", "--json", PR_VIEW_FIELDS]) {
        Ok(o) if o.ok => parse_pr(&o.stdout),
        _ => None,
    };
    PrStatus {
        gh,
        has_upstream,
        pr,
        hint: None,
    }
}

pub struct PrCreate {
    pub gh: proto::GhState,
    pub pr: Option<proto::PrInfo>,
    pub message: Option<String>,
}

/// Opens the branch's pull request. With a title and body the caller wrote
/// (a person or the writer model), those are what GitHub gets; without them,
/// `--fill` lets the commits write the text.
pub fn pr_create(dir: &Path, title: Option<&str>, body: Option<&str>) -> PrCreate {
    if let (Some(title), Some(body)) = (title, body) {
        return pr_create_branch(dir, title, body, None, false);
    }
    let gh = state(dir);
    if gh != proto::GhState::Ready {
        return PrCreate {
            gh,
            pr: None,
            message: hint_for(gh),
        };
    }
    match run(dir, &["pr", "create", "--fill"]) {
        Ok(o) if o.ok => {
            let pr = match run(dir, &["pr", "view", "--json", PR_VIEW_FIELDS]) {
                Ok(v) if v.ok => parse_pr(&v.stdout),
                _ => None,
            };
            let message = pr
                .is_none()
                .then(|| "PR created, but reading it back with `gh pr view` failed".to_string());
            PrCreate { gh, pr, message }
        }
        Ok(o) => PrCreate {
            gh,
            pr: None,
            message: Some(
                first_meaningful_line(&o.stderr)
                    .unwrap_or_else(|| format!("gh pr create --fill failed (exit {:?})", o.code)),
            ),
        },
        Err(e) => PrCreate {
            gh,
            pr: None,
            message: Some(format!("running gh pr create failed: {e}")),
        },
    }
}

// Everything the pull-request tab shows, in the one `gh pr view` call: identity,
// branches, the body, every check (with its timestamps where gh has them),
// reviews and comments. `gh pr checks --json` does not exist on the pinned gh.
const PR_DETAIL_FIELDS: &str = "number,url,state,title,body,author,isDraft,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,mergedAt,closedAt,createdAt,updatedAt,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,commits,comments,reviews";

/// What a `gh pr view` read produced. `NoPr` is reserved for the branch read
/// whose own stderr says there is nothing to show; every other failure keeps
/// gh's first stderr line so the pane can name an actionable reason.
pub enum PrRead {
    Found(serde_json::Value),
    NoPr,
    Failed(String),
}

pub fn pr_detail_read(dir: &Path, number: Option<u32>) -> PrRead {
    let gh = state(dir);
    if gh != proto::GhState::Ready {
        return PrRead::Failed(
            hint_for(gh).unwrap_or_else(|| "gh is not ready to read a pull request".to_string()),
        );
    }
    let number = number.map(|n| n.to_string());
    let mut args = vec!["pr", "view"];
    if let Some(n) = number.as_deref() {
        args.push(n);
    }
    args.push("--json");
    args.push(PR_DETAIL_FIELDS);
    let out = match run(dir, &args) {
        Ok(out) => out,
        Err(e) => return PrRead::Failed(format!("running gh pr view failed: {e}")),
    };
    if out.ok {
        return match serde_json::from_str(&out.stdout) {
            Ok(v) => PrRead::Found(v),
            Err(e) => PrRead::Failed(format!("gh pr view returned unreadable JSON: {e}")),
        };
    }
    let reason = first_meaningful_line(&out.stderr)
        .unwrap_or_else(|| format!("gh pr view failed (exit {:?})", out.code));
    if number.is_none() && reason.to_lowercase().contains("no pull requests found") {
        PrRead::NoPr
    } else {
        PrRead::Failed(reason)
    }
}

pub struct PrMergeOutcome {
    pub ok: bool,
    pub message: Option<String>,
}

/// Merge one pull request, refusing a head this caller has not seen: gh
/// re-verifies the sha with `--match-head-commit` after the daemon's own
/// recheck. No `--admin`, no `--auto`, no branch deletion.
pub fn pr_merge(
    dir: &Path,
    number: u32,
    expected_head_sha: &str,
    method: proto::PrMergeMethod,
) -> PrMergeOutcome {
    let flag = match method {
        proto::PrMergeMethod::Merge => "--merge",
        proto::PrMergeMethod::Squash => "--squash",
        proto::PrMergeMethod::Rebase => "--rebase",
    };
    let number = number.to_string();
    match run(
        dir,
        &[
            "pr",
            "merge",
            &number,
            "--match-head-commit",
            expected_head_sha,
            flag,
        ],
    ) {
        Ok(o) if o.ok => PrMergeOutcome {
            ok: true,
            message: None,
        },
        Ok(o) => PrMergeOutcome {
            ok: false,
            message: Some(
                first_meaningful_line(&o.stderr)
                    .unwrap_or_else(|| format!("gh pr merge {number} failed (exit {:?})", o.code)),
            ),
        },
        Err(e) => PrMergeOutcome {
            ok: false,
            message: Some(format!("running gh pr merge failed: {e}")),
        },
    }
}

pub fn pr_create_branch(
    dir: &Path,
    title: &str,
    body: &str,
    base: Option<&str>,
    draft: bool,
) -> PrCreate {
    let gh = state(dir);
    if gh != proto::GhState::Ready {
        return PrCreate {
            gh,
            pr: None,
            message: hint_for(gh),
        };
    }
    let mut args = vec!["pr", "create", "--title", title, "--body", body];
    if let Some(b) = base {
        args.push("--base");
        args.push(b);
    }
    if draft {
        args.push("--draft");
    }
    match run(dir, &args) {
        Ok(o) if o.ok => {
            let pr = match run(dir, &["pr", "view", "--json", PR_VIEW_FIELDS]) {
                Ok(v) if v.ok => parse_pr(&v.stdout),
                _ => None,
            };
            let message = pr
                .is_none()
                .then(|| "PR created, but reading it back with `gh pr view` failed".to_string());
            PrCreate { gh, pr, message }
        }
        Ok(o) => PrCreate {
            gh,
            pr: None,
            message: Some(
                first_meaningful_line(&o.stderr)
                    .unwrap_or_else(|| format!("gh pr create failed (exit {:?})", o.code)),
            ),
        },
        Err(e) => PrCreate {
            gh,
            pr: None,
            message: Some(format!("running gh pr create failed: {e}")),
        },
    }
}

pub fn checks_from_rollup(v: Option<&serde_json::Value>) -> proto::PrChecks {
    rollup(v)
}

pub fn parse_pr(stdout: &str) -> Option<proto::PrInfo> {
    let v: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let number = u32::try_from(v.get("number")?.as_u64()?).ok()?;
    let url = v.get("url")?.as_str()?.to_string();
    let state = v
        .get("state")
        .and_then(|s| s.as_str())
        .unwrap_or("OPEN")
        .to_string();
    let review_decision = v
        .get("reviewDecision")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(proto::PrInfo {
        number,
        url,
        state,
        review_decision,
        checks: rollup(v.get("statusCheckRollup")),
    })
}

// A failure outranks a still-running check: the red one is the fact the line
// exists to deliver, and reporting "running" while one failed delays it.
fn rollup(v: Option<&serde_json::Value>) -> proto::PrChecks {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return proto::PrChecks::None;
    };
    if arr.is_empty() {
        return proto::PrChecks::None;
    }
    let mut running = false;
    let mut failing = false;
    for c in arr {
        let status = c.get("status").and_then(|s| s.as_str()).unwrap_or("");
        let conclusion = c.get("conclusion").and_then(|s| s.as_str()).unwrap_or("");
        let st = c.get("state").and_then(|s| s.as_str()).unwrap_or("");
        if status == "IN_PROGRESS" || status == "QUEUED" || status == "PENDING" || st == "PENDING" {
            running = true;
        }
        if matches!(
            conclusion,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
        ) || matches!(st, "FAILURE" | "ERROR")
        {
            failing = true;
        }
    }
    if failing {
        proto::PrChecks::Failing
    } else if running {
        proto::PrChecks::Running
    } else {
        proto::PrChecks::Passing
    }
}

fn first_meaningful_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// The most body bytes one write accepts. The cap is the pipe's own: the body is
/// written to the child's stdin before its output is read, and a body larger
/// than the 64 KiB pipe could block a child that answers before reading it all.
pub const PR_BODY_MAX: usize = 60_000;

/// The most a `pr_list` may ask for. gh itself would answer more, but a listing
/// this wide is a client bug, and the refusal names the cap and the ask.
pub const PR_LIST_LIMIT_MAX: u32 = 100;

/// The most inline drafts one review may carry. GitHub takes more, but a review
/// with hundreds of anchored remarks is a scripted bulk write, not a review.
pub const PR_REVIEW_DRAFT_MAX: usize = 50;

/// The most patch bytes one `pr_diff` reply carries; past it the patch is cut on
/// a character boundary and reported truncated.
pub const PR_DIFF_MAX_BYTES: usize = 512 * 1024;

/// A plain write outcome: `ok` and, on failure, gh's own first stderr line.
pub struct Outcome {
    pub ok: bool,
    pub message: Option<String>,
}

impl Outcome {
    fn done(o: &Output, what: &str) -> Outcome {
        if o.ok {
            Outcome {
                ok: true,
                message: None,
            }
        } else {
            Outcome {
                ok: false,
                message: Some(
                    first_meaningful_line(&o.stderr)
                        .unwrap_or_else(|| format!("{what} failed (exit {:?})", o.code)),
                ),
            }
        }
    }

    pub fn refused(message: impl Into<String>) -> Outcome {
        Outcome {
            ok: false,
            message: Some(message.into()),
        }
    }
}

/// Bodies are refused before the write when over [`PR_BODY_MAX`]; the refusal
/// names the cap and the actual length, because this is a limit a person hits.
pub fn body_refusal(body: &str) -> Option<String> {
    (body.len() > PR_BODY_MAX).then(|| {
        format!(
            "the body is {} bytes and the limit is {PR_BODY_MAX} — send a shorter one",
            body.len()
        )
    })
}

fn run_stdin(dir: &Path, args: &[&str], stdin: &str) -> Result<Output> {
    use std::io::Write as _;
    use std::process::Stdio;
    let mut child = crate::spawn::command("gh")
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning gh {args:?} in {}", dir.display()))?;
    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(stdin.as_bytes())
            .with_context(|| format!("writing gh {args:?} stdin"))?;
        drop(pipe);
    }
    let out = child
        .wait_with_output()
        .with_context(|| format!("waiting on gh {args:?}"))?;
    Ok(Output {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn ready(dir: &Path, what: &str) -> Result<()> {
    let gh = state(dir);
    if gh != proto::GhState::Ready {
        bail!(
            "{}",
            hint_for(gh).unwrap_or_else(|| format!("gh is not ready to {what}"))
        );
    }
    Ok(())
}

/// `gh pr edit`: the pull request's own words. A field the caller did not name
/// is left out of argv entirely, so GitHub keeps what is there.
pub fn pr_edit(dir: &Path, number: u32, title: Option<&str>, body: Option<&str>) -> Outcome {
    if let Some(refusal) = title.and_then(body_refusal).or(body.and_then(body_refusal)) {
        return Outcome::refused(refusal);
    }
    if let Err(e) = ready(dir, "edit a pull request") {
        return Outcome::refused(e.to_string());
    }
    let n = number.to_string();
    let mut args = vec!["pr", "edit", n.as_str()];
    if let Some(t) = title {
        args.push("--title");
        args.push(t);
    }
    if body.is_some() {
        args.push("--body-file");
        args.push("-");
    }
    let result = match body {
        Some(b) => run_stdin(dir, &args, b),
        None => run(dir, &args),
    };
    match result {
        Ok(o) => Outcome::done(&o, &format!("gh pr edit {number}")),
        Err(e) => Outcome::refused(format!("running gh pr edit {number} failed: {e}")),
    }
}

/// `gh pr comment`: a new conversation comment on the pull request.
pub fn pr_comment(dir: &Path, number: u32, body: &str) -> Outcome {
    if let Some(refusal) = body_refusal(body) {
        return Outcome::refused(refusal);
    }
    if let Err(e) = ready(dir, "comment on a pull request") {
        return Outcome::refused(e.to_string());
    }
    let n = number.to_string();
    match run_stdin(
        dir,
        &["pr", "comment", n.as_str(), "--body-file", "-"],
        body,
    ) {
        Ok(o) => Outcome::done(&o, &format!("gh pr comment {number}")),
        Err(e) => Outcome::refused(format!("running gh pr comment {number} failed: {e}")),
    }
}

/// Rewrites a remark somebody already posted. Issue comments and review comments
/// live at different REST paths, and the command names which.
pub fn pr_comment_edit(
    dir: &Path,
    comment_id: &str,
    kind: proto::PrCommentKind,
    body: &str,
) -> Outcome {
    if let Some(refusal) = body_refusal(body) {
        return Outcome::refused(refusal);
    }
    if comment_id.trim().is_empty() {
        return Outcome::refused("a comment id is required to edit a comment; none was sent");
    }
    if let Err(e) = ready(dir, "edit a comment") {
        return Outcome::refused(e.to_string());
    }
    let path = match kind {
        proto::PrCommentKind::IssueComment => {
            format!("repos/{{owner}}/{{repo}}/issues/comments/{comment_id}")
        }
        proto::PrCommentKind::ReviewComment => {
            format!("repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}")
        }
    };
    let payload = serde_json::json!({ "body": body }).to_string();
    match run_stdin(
        dir,
        &["api", "--method", "PATCH", &path, "--input", "-"],
        &payload,
    ) {
        Ok(o) => Outcome::done(&o, &format!("editing comment {comment_id}")),
        Err(e) => Outcome::refused(format!(
            "running gh api for comment {comment_id} failed: {e}"
        )),
    }
}

/// Sends a whole review at once: verdict, body and inline drafts in one REST
/// request, which is what keeps it invisible until the verdict is sent.
pub fn pr_review(
    dir: &Path,
    number: u32,
    repository: &str,
    verdict: proto::PrReviewVerdict,
    body: &str,
    drafts: &[proto::PrReviewDraft],
) -> Outcome {
    if let Some(refusal) = body_refusal(body) {
        return Outcome::refused(refusal);
    }
    if let Err(e) = ready(dir, "review a pull request") {
        return Outcome::refused(e.to_string());
    }
    if drafts.len() > PR_REVIEW_DRAFT_MAX {
        return Outcome::refused(format!(
            "{} inline drafts were sent and the limit is {PR_REVIEW_DRAFT_MAX}",
            drafts.len()
        ));
    }
    for (index, draft) in drafts.iter().enumerate() {
        if draft.path.trim().is_empty() {
            return Outcome::refused(format!(
                "inline draft {} names no path; a comment anchors to a file",
                index + 1
            ));
        }
        if let Some(refusal) = body_refusal(&draft.body) {
            return Outcome::refused(format!("inline draft {}: {refusal}", index + 1));
        }
    }
    let (owner, name) = match split_repository(repository) {
        Some(pair) => pair,
        None => {
            return Outcome::refused(format!(
                "cannot address the reviews API for PR #{number}: repository {repository:?} is not `owner/name`"
            ))
        }
    };
    let event = match verdict {
        proto::PrReviewVerdict::Comment => "COMMENT",
        proto::PrReviewVerdict::Approve => "APPROVE",
        proto::PrReviewVerdict::RequestChanges => "REQUEST_CHANGES",
    };
    let comments: Vec<serde_json::Value> = drafts
        .iter()
        .map(|d| {
            serde_json::json!({
                "path": d.path,
                "line": d.line,
                "side": match d.side {
                    proto::PrDiffSide::Left => "LEFT",
                    proto::PrDiffSide::Right => "RIGHT",
                },
                "body": d.body,
            })
        })
        .collect();
    let payload = serde_json::json!({
        "event": event,
        "body": body,
        "comments": comments,
    })
    .to_string();
    let path = format!("repos/{owner}/{name}/pulls/{number}/reviews");
    match run_stdin(
        dir,
        &["api", "--method", "POST", &path, "--input", "-"],
        &payload,
    ) {
        Ok(o) => Outcome::done(&o, &format!("submitting the review on PR #{number}")),
        Err(e) => Outcome::refused(format!("running gh api for the review failed: {e}")),
    }
}

/// One GraphQL request through `gh api graphql --input -`. The document and its
/// variables travel together over stdin, so nothing a person typed reaches argv.
pub fn graphql(dir: &Path, query: &str, variables: serde_json::Value) -> Result<serde_json::Value> {
    let payload = serde_json::json!({ "query": query, "variables": variables }).to_string();
    let out = run_stdin(dir, &["api", "graphql", "--input", "-"], &payload)
        .context("running gh api graphql")?;
    if !out.ok {
        bail!(
            "{}",
            first_meaningful_line(&out.stderr)
                .unwrap_or_else(|| format!("gh api graphql failed (exit {:?})", out.code))
        );
    }
    let value: serde_json::Value = serde_json::from_str(&out.stdout).with_context(|| {
        // The offending value rides in the error: an unreadable GraphQL answer is
        // almost always a proxy or a host refusing before GitHub ever saw it.
        let head: String = out.stdout.chars().take(400).collect();
        format!(
            "gh api graphql returned unreadable JSON; {} bytes, first 400 chars: {head:?}",
            out.stdout.len()
        )
    })?;
    if let Some(errors) = value.get("errors").and_then(|e| e.as_array()) {
        if let Some(first) = errors.first() {
            let message = first
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown GraphQL error");
            bail!("{message}");
        }
    }
    Ok(value)
}

/// A reply on an inline review discussion.
pub fn pr_thread_reply(dir: &Path, thread_id: &str, body: &str) -> Outcome {
    if let Some(refusal) = body_refusal(body) {
        return Outcome::refused(refusal);
    }
    const QUERY: &str = "mutation($threadId: ID!, $body: String!) { \
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) \
        { comment { id } } }";
    match graphql(
        dir,
        QUERY,
        serde_json::json!({ "threadId": thread_id, "body": body }),
    ) {
        Ok(_) => Outcome {
            ok: true,
            message: None,
        },
        Err(e) => Outcome::refused(format!("replying to the review thread failed: {e}")),
    }
}

/// Resolves or reopens an inline review discussion.
pub fn pr_thread_resolve(dir: &Path, thread_id: &str, resolved: bool) -> Outcome {
    let query = if resolved {
        "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }"
    } else {
        "mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }"
    };
    match graphql(dir, query, serde_json::json!({ "threadId": thread_id })) {
        Ok(_) => Outcome {
            ok: true,
            message: None,
        },
        Err(e) => Outcome::refused(format!(
            "{} the review thread failed: {e}",
            if resolved { "resolving" } else { "reopening" }
        )),
    }
}

/// Adds or removes one of GitHub's eight reactions. `subject_id` absent means
/// the pull request itself, resolved here; present means a remark, verified to
/// belong to this pull request first.
pub fn pr_reaction(
    dir: &Path,
    number: u32,
    repository: &str,
    subject_id: Option<&str>,
    content: proto::PrReaction,
    reacted: bool,
) -> Outcome {
    if let Err(e) = ready(dir, "react to a pull request") {
        return Outcome::refused(e.to_string());
    }
    let subject = match subject_id {
        Some(id) => {
            match super::pull_requests::github::subject_belongs(dir, repository, number, id) {
                Ok(true) => id.to_string(),
                Ok(false) => {
                    return Outcome::refused(format!(
                        "comment {id:?} does not belong to PR #{number}; refusing to react on it"
                    ))
                }
                Err(e) => {
                    return Outcome::refused(format!(
                        "could not verify that comment {id:?} belongs to PR #{number}: {e}"
                    ))
                }
            }
        }
        None => match super::pull_requests::github::pull_request_node_id(dir, repository, number) {
            Ok(id) => id,
            Err(e) => {
                return Outcome::refused(format!("could not read the node id of PR #{number}: {e}"))
            }
        },
    };
    let query = if reacted {
        "mutation($subjectId: ID!, $content: ReactionContent!) { \
         addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } } }"
    } else {
        "mutation($subjectId: ID!, $content: ReactionContent!) { \
         removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } } }"
    };
    match graphql(
        dir,
        query,
        serde_json::json!({
            "subjectId": subject,
            "content": github_reaction_content(content),
        }),
    ) {
        Ok(_) => Outcome {
            ok: true,
            message: None,
        },
        Err(e) => Outcome::refused(format!("the reaction was refused: {e}")),
    }
}

pub fn github_reaction_content(content: proto::PrReaction) -> &'static str {
    match content {
        proto::PrReaction::ThumbsUp => "THUMBS_UP",
        proto::PrReaction::ThumbsDown => "THUMBS_DOWN",
        proto::PrReaction::Laugh => "LAUGH",
        proto::PrReaction::Hooray => "HOORAY",
        proto::PrReaction::Confused => "CONFUSED",
        proto::PrReaction::Heart => "HEART",
        proto::PrReaction::Rocket => "ROCKET",
        proto::PrReaction::Eyes => "EYES",
    }
}

/// Asks GitHub for a review, or takes the request back. Both directions use the
/// same body, because GitHub takes a request back from exactly whom it was made of.
pub fn pr_reviewer_set(
    dir: &Path,
    number: u32,
    reviewers: &[proto::PrReviewer],
    requested: bool,
) -> Outcome {
    if reviewers.is_empty() {
        return Outcome::refused("no reviewers were named; a review request needs at least one");
    }
    if let Err(e) = ready(dir, "request a review") {
        return Outcome::refused(e.to_string());
    }
    let users: Vec<&str> = reviewers
        .iter()
        .filter(|r| r.kind == proto::PrReviewerKind::User)
        .map(|r| r.id.as_str())
        .collect();
    let teams: Vec<&str> = reviewers
        .iter()
        .filter(|r| r.kind == proto::PrReviewerKind::Team)
        .map(|r| r.id.as_str())
        .collect();
    let payload = serde_json::json!({ "reviewers": users, "team_reviewers": teams }).to_string();
    let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/requested_reviewers");
    let method = if requested { "POST" } else { "DELETE" };
    match run_stdin(
        dir,
        &["api", "--method", method, &path, "--input", "-"],
        &payload,
    ) {
        Ok(o) => Outcome::done(&o, &format!("the review request on PR #{number}")),
        Err(e) => Outcome::refused(format!("running gh api for reviewers failed: {e}")),
    }
}

/// Puts labels on the pull request, or takes them off. Adding posts the whole
/// list at once; taking off is one delete per label, since the endpoint names
/// one in its path.
pub fn pr_label_set(dir: &Path, number: u32, labels: &[String], applied: bool) -> Outcome {
    if labels.is_empty() {
        return Outcome::refused("no labels were named; a label change needs at least one");
    }
    if let Err(e) = ready(dir, "change labels") {
        return Outcome::refused(e.to_string());
    }
    let issue = format!("repos/{{owner}}/{{repo}}/issues/{number}/labels");
    if applied {
        let payload = serde_json::json!({ "labels": labels }).to_string();
        return match run_stdin(
            dir,
            &["api", "--method", "POST", &issue, "--input", "-"],
            &payload,
        ) {
            Ok(o) => Outcome::done(&o, &format!("labelling PR #{number}")),
            Err(e) => Outcome::refused(format!("running gh api for labels failed: {e}")),
        };
    }
    for label in labels {
        let encoded: String = label
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        let path = format!("{issue}/{encoded}");
        match run(dir, &["api", "--method", "DELETE", &path]) {
            Ok(o) if o.ok => {}
            Ok(o) => return Outcome::done(&o, &format!("removing label {label:?}")),
            Err(e) => {
                return Outcome::refused(format!("running gh api to remove {label:?} failed: {e}"))
            }
        }
    }
    Outcome {
        ok: true,
        message: None,
    }
}

/// Every pull-request action that is not a merge. Update-branch goes through the
/// REST endpoint rather than `gh pr update-branch`, which older pinned gh builds
/// do not have; the endpoint is the same operation with the same method choice.
pub fn pr_action(
    dir: &Path,
    number: u32,
    action: proto::PrAction,
    merge_method: Option<proto::PrMergeMethod>,
    update_method: Option<proto::PrUpdateMethod>,
) -> Outcome {
    if let Err(e) = ready(dir, "change a pull request") {
        return Outcome::refused(e.to_string());
    }
    let n = number.to_string();
    let method_flag = match merge_method.unwrap_or(proto::PrMergeMethod::Merge) {
        proto::PrMergeMethod::Merge => "--merge",
        proto::PrMergeMethod::Squash => "--squash",
        proto::PrMergeMethod::Rebase => "--rebase",
    };
    let result = match action {
        proto::PrAction::Ready => run(dir, &["pr", "ready", n.as_str()]),
        proto::PrAction::Draft => run(dir, &["pr", "ready", n.as_str(), "--undo"]),
        proto::PrAction::Close => run(dir, &["pr", "close", n.as_str()]),
        proto::PrAction::Reopen => run(dir, &["pr", "reopen", n.as_str()]),
        proto::PrAction::EnableAutoMerge => {
            run(dir, &["pr", "merge", n.as_str(), "--auto", method_flag])
        }
        proto::PrAction::DisableAutoMerge => {
            run(dir, &["pr", "merge", n.as_str(), "--disable-auto"])
        }
        proto::PrAction::UpdateBranch => {
            let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/update-branch");
            let method = match update_method.unwrap_or(proto::PrUpdateMethod::Merge) {
                proto::PrUpdateMethod::Merge => "merge",
                proto::PrUpdateMethod::Rebase => "rebase",
            };
            run(
                dir,
                &[
                    "api",
                    "--method",
                    "PUT",
                    &path,
                    "-f",
                    &format!("update_method={method}"),
                ],
            )
        }
        proto::PrAction::Revert | proto::PrAction::ApproveWorkflows => {
            return Outcome::refused(format!(
                "{} is not a plain gh subcommand and must be composed by the pull request engine",
                action_name(action)
            ))
        }
    };
    match result {
        Ok(o) => Outcome::done(&o, &format!("gh pr {} {number}", action_name(action))),
        Err(e) => Outcome::refused(format!("running {} failed: {e}", action_name(action))),
    }
}

pub fn action_name(action: proto::PrAction) -> &'static str {
    match action {
        proto::PrAction::Ready => "ready",
        proto::PrAction::Draft => "draft",
        proto::PrAction::Close => "close",
        proto::PrAction::Reopen => "reopen",
        proto::PrAction::UpdateBranch => "update-branch",
        proto::PrAction::EnableAutoMerge => "enable-auto-merge",
        proto::PrAction::DisableAutoMerge => "disable-auto-merge",
        proto::PrAction::Revert => "revert",
        proto::PrAction::ApproveWorkflows => "approve-workflows",
    }
}

/// One repository's pull requests, newest update first. `limit + 1` is asked for
/// so one row over the page reveals that the host has more.
pub fn pr_list(
    dir: &Path,
    state: proto::PrListState,
    involvement: proto::PrListInvolvement,
    query: Option<&str>,
    limit: u32,
) -> Result<(Vec<proto::PrListItem>, bool)> {
    ready(dir, "list pull requests")?;
    if limit == 0 || limit > PR_LIST_LIMIT_MAX {
        bail!("a pull request listing asks for 1..={PR_LIST_LIMIT_MAX} rows; {limit} was asked");
    }
    let state_flag = match state {
        proto::PrListState::Open => "open",
        proto::PrListState::Closed => "closed",
        proto::PrListState::Merged => "merged",
        proto::PrListState::All => "all",
    };
    let mut search: Vec<String> = Vec::new();
    if state == proto::PrListState::Closed {
        // gh's closed includes merged; the Closed tab is the unmerged ones.
        search.push("is:unmerged".to_string());
    }
    if involvement == proto::PrListInvolvement::Reviewing {
        search.push("review-requested:@me".to_string());
    }
    if let Some(text) = query.map(str::trim).filter(|q| !q.is_empty()) {
        search.push(search_phrase(text));
    }
    // The order the list reads in, and the only order a bigger page can carry on
    // from: a change request opened last year and touched this morning belongs on top.
    search.push("sort:updated-desc".to_string());
    let probe = limit + 1;
    let probe_string = probe.to_string();
    let mut args = vec![
        "pr",
        "list",
        "--state",
        state_flag,
        "--limit",
        probe_string.as_str(),
        "--json",
        LIST_FIELDS,
        "--search",
    ];
    let combined = search.join(" ");
    args.push(&combined);
    if involvement == proto::PrListInvolvement::Authored {
        args.push("--author");
        args.push("@me");
    }
    let out = run(dir, &args)?;
    if !out.ok {
        bail!(
            "{}",
            first_meaningful_line(&out.stderr)
                .unwrap_or_else(|| format!("gh pr list failed (exit {:?})", out.code))
        );
    }
    let raw = out.stdout.trim();
    if raw.is_empty() {
        return Ok((Vec::new(), false));
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).with_context(|| "gh pr list returned unreadable JSON")?;
    let items = super::pull_requests::github::list_items(&value);
    let truncated = items.len() as u32 > limit;
    Ok((items.into_iter().take(limit as usize).collect(), truncated))
}

/// The reader's own words as one quoted phrase of a GitHub search query: the
/// quoting stops `is:merged` typed as text from widening the listing, and one
/// argv element cannot become a flag of its own.
fn search_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('\\', "\\\\").replace('"', "\\\""))
}

const LIST_FIELDS: &str =
    "number,title,url,author,headRefName,baseRefName,state,isDraft,reviewDecision,additions,deletions,updatedAt,mergedAt,labels,statusCheckRollup,reviewRequests";

/// `gh pr diff --color never`, cut to [`PR_DIFF_MAX_BYTES`] on a character
/// boundary when GitHub serves more; the flag says which it was.
pub fn pr_diff(dir: &Path, number: u32) -> Result<(String, bool)> {
    ready(dir, "read a pull request diff")?;
    let n = number.to_string();
    let out = run(dir, &["pr", "diff", n.as_str(), "--color", "never"])?;
    if !out.ok {
        bail!(
            "{}",
            first_meaningful_line(&out.stderr)
                .unwrap_or_else(|| format!("gh pr diff failed (exit {:?})", out.code))
        );
    }
    let mut patch = out.stdout;
    if patch.len() <= PR_DIFF_MAX_BYTES {
        return Ok((patch, false));
    }
    let mut end = PR_DIFF_MAX_BYTES;
    while !patch.is_char_boundary(end) {
        end -= 1;
    }
    patch.truncate(end);
    Ok((patch, true))
}

/// One stack as the stacks preview reports it, or `None` where the host does
/// not serve the preview (a 404), which is not an error.
pub fn pr_stack(dir: &Path, number: u32) -> Result<Option<super::pull_requests::github::Stack>> {
    ready(dir, "read a stack")?;
    let path = format!("repos/{{owner}}/{{repo}}/stacks?pull_request={number}");
    let out = run(dir, &["api", &path])?;
    if !out.ok {
        let reason = first_meaningful_line(&out.stderr).unwrap_or_default();
        if reason.contains("404") {
            return Ok(None);
        }
        bail!(
            "{}",
            if reason.is_empty() {
                format!(
                    "gh api stacks?pull_request={number} failed (exit {:?})",
                    out.code
                )
            } else {
                reason
            }
        );
    }
    let raw = out.stdout.trim();
    if raw.is_empty() || raw == "[]" {
        return Ok(None);
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).with_context(|| "gh api stacks returned unreadable JSON")?;
    super::pull_requests::github::stack_from_json(&value)
}

/// How long a stack merge waits on GitHub's async job before telling the user to
/// watch it there. GitHub's own merge queue can sit far longer; a control plane
/// that blocks a socket for that long is worse than one that hands the link back.
pub const STACK_MERGE_POLL_MAX_MS: u64 = 120_000;

/// Merges a stack up to and including `number`, pinned to the layer heads the
/// user saw. The preview endpoint takes one async job for the whole run and is
/// polled until it reports a terminal state or the wait runs out.
pub fn pr_stack_merge(
    dir: &Path,
    number: u32,
    stack_number: u32,
    heads: &[proto::PrStackHead],
    method: proto::PrMergeMethod,
) -> Outcome {
    let stack = match pr_stack(dir, number) {
        Ok(Some(stack)) => stack,
        Ok(None) => {
            return Outcome::refused(format!(
                "GitHub serves no stack for PR #{number}; there is nothing to merge as one"
            ))
        }
        Err(e) => return Outcome::refused(format!("could not read the stack: {e}")),
    };
    if stack.number != stack_number {
        return Outcome::refused(format!(
            "the stack on PR #{number} changed from #{stack_number} to #{}; refresh before merging",
            stack.number
        ));
    }
    let Some(target_index) = stack.layers.iter().position(|l| l.number == number) else {
        return Outcome::refused(format!(
            "PR #{number} is not a layer of stack #{}",
            stack.number
        ));
    };
    let affected: Vec<&super::pull_requests::github::StackLayer> = stack.layers[..=target_index]
        .iter()
        .filter(|l| l.state != proto::PullRequestState::Merged)
        .collect();
    if affected.is_empty() {
        return Outcome::refused(format!("every layer up to PR #{number} is already merged"));
    }
    if affected
        .iter()
        .any(|l| l.state != proto::PullRequestState::Open)
    {
        return Outcome::refused(format!(
            "every open layer of stack #{} must be open to merge it; one is closed",
            stack.number
        ));
    }
    if affected.iter().any(|l| l.is_draft) {
        return Outcome::refused(format!(
            "a layer of stack #{} is still a draft; mark it ready first",
            stack.number
        ));
    }
    let matches = heads.len() == affected.len()
        && heads
            .iter()
            .map(|h| h.number)
            .collect::<std::collections::HashSet<_>>()
            .len()
            == heads.len()
        && affected.iter().all(|layer| {
            heads.iter().any(|h| {
                h.number == layer.number
                    && layer
                        .head_sha
                        .as_deref()
                        .is_some_and(|sha| sha == h.head_sha)
            })
        });
    if !matches {
        return Outcome::refused(format!(
            "stack #{} changed since it was read; refresh before merging",
            stack.number
        ));
    }
    let Some(target) = stack.layers.get(target_index) else {
        return Outcome::refused(format!("PR #{number} left stack #{}", stack.number));
    };
    let Some(target_sha) = target.head_sha.as_deref() else {
        return Outcome::refused(format!(
            "GitHub reported no head revision for PR #{number}; refusing an unpinned stack merge"
        ));
    };
    let method_flag = match method {
        proto::PrMergeMethod::Merge => "merge",
        proto::PrMergeMethod::Squash => "squash",
        proto::PrMergeMethod::Rebase => "rebase",
    };
    let path = format!("repos/{{owner}}/{{repo}}/pulls/{number}/merge-async");
    let out = match run(
        dir,
        &[
            "api",
            "--method",
            "PUT",
            &path,
            "-f",
            &format!("merge_method={method_flag}"),
            "-f",
            "merge_action=default",
            "-f",
            &format!("sha={target_sha}"),
        ],
    ) {
        Ok(o) => o,
        Err(e) => return Outcome::refused(format!("running the stack merge failed: {e}")),
    };
    if !out.ok {
        return Outcome::done(&out, &format!("merging stack #{}", stack.number));
    }
    let Some(mut status) = super::pull_requests::github::stack_merge_status_of(&out.stdout) else {
        return Outcome::refused(
            "GitHub returned an unreadable stack merge response; check the stack on GitHub",
        );
    };
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(STACK_MERGE_POLL_MAX_MS);
    let mut attempt = 0u32;
    while status.state == "pending" && std::time::Instant::now() < deadline {
        let Some(uuid) = status.uuid.as_deref() else {
            return Outcome::refused(
                "GitHub reported the stack merge pending without a job id; check it on GitHub",
            );
        };
        let wait_ms = std::cmp::min(1_000u64.saturating_mul(1 << attempt.min(4)), 10_000);
        std::thread::sleep(std::time::Duration::from_millis(wait_ms));
        attempt += 1;
        let poll = match run(
            dir,
            &["api", &format!("{path}/{}", percent_encode_path(uuid))],
        ) {
            Ok(o) if o.ok => o,
            Ok(o) => {
                return Outcome::refused(format!(
                    "polling the stack merge failed: {}",
                    first_meaningful_line(&o.stderr)
                        .unwrap_or_else(|| format!("exit {:?}", o.code))
                ))
            }
            Err(e) => return Outcome::refused(format!("polling the stack merge failed: {e}")),
        };
        match super::pull_requests::github::stack_merge_status_of(&poll.stdout) {
            Some(next) => status = next,
            None => {
                return Outcome::refused(
                    "GitHub returned an unreadable stack merge status; check it on GitHub",
                )
            }
        }
    }
    match status.state.as_str() {
        "merged" | "enqueued" => Outcome {
            ok: true,
            message: Some(format!("stack #{} merged to PR #{number}", stack.number)),
        },
        "failed" => Outcome::refused(status.detail.unwrap_or_else(|| {
            format!(
                "GitHub refused the merge of stack #{}; check its branch rules and merge requirements",
                stack.number
            )
        })),
        "pending" => Outcome::refused(format!(
            "GitHub is still merging stack #{} after {} seconds; check it there before retrying",
            stack.number,
            STACK_MERGE_POLL_MAX_MS / 1000
        )),
        other => Outcome::refused(format!(
            "GitHub reported an unknown stack merge status {other:?}; check it there"
        )),
    }
}

/// A path segment's reserved characters, so a job id from GitHub can never name
/// a different endpoint.
fn percent_encode_path(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The pull request's GraphQL node id, which is what a reaction on its
/// description or a revert names. Read only when one is being written.
pub fn pr_node_id(dir: &Path, repository: &str, number: u32) -> Result<String> {
    super::pull_requests::github::pull_request_node_id(dir, repository, number)
}

/// Reverts a merged pull request, opening the revert pull request GitHub
/// creates. Returns its number when the mutation's answer carries one.
pub fn pr_revert(dir: &Path, repository: &str, number: u32) -> Outcome {
    const QUERY: &str = "mutation($pullRequestId: ID!) { \
        revertPullRequest(input: { pullRequestId: $pullRequestId }) \
        { revertPullRequest { number url } } }";
    let id = match pr_node_id(dir, repository, number) {
        Ok(id) => id,
        Err(e) => {
            return Outcome::refused(format!("could not read the node id of PR #{number}: {e}"))
        }
    };
    match graphql(dir, QUERY, serde_json::json!({ "pullRequestId": id })) {
        Ok(v) => {
            let made = v
                .pointer("/data/revertPullRequest/revertPullRequest/number")
                .and_then(|n| n.as_u64());
            Outcome {
                ok: true,
                message: made.map(|n| format!("opened revert pull request #{n}")),
            }
        }
        Err(e) => Outcome::refused(format!("reverting PR #{number} was refused: {e}")),
    }
}

/// Workflow runs on one head commit that still need a maintainer's approval.
/// One over a hard cap is asked so a truncated read is refused, not approved
/// from: the first page of a fifty-run fork is not what the user saw.
pub struct WorkflowRun {
    pub id: u64,
    pub name: String,
}

pub const WORKFLOW_RUN_MAX: usize = 100;

pub fn workflow_runs_requiring_approval(
    dir: &Path,
    head_sha: &str,
    head_branch: &str,
) -> Result<Vec<WorkflowRun>> {
    let limit = (WORKFLOW_RUN_MAX + 1).to_string();
    let out = run(
        dir,
        &[
            "run",
            "list",
            "--commit",
            head_sha,
            "--branch",
            head_branch,
            "--event",
            "pull_request",
            "--status",
            "action_required",
            "--limit",
            &limit,
            "--json",
            "databaseId,workflowName,url",
        ],
    )?;
    if !out.ok {
        bail!(
            "{}",
            first_meaningful_line(&out.stderr)
                .unwrap_or_else(|| format!("gh run list failed (exit {:?})", out.code))
        );
    }
    let value: serde_json::Value = serde_json::from_str(out.stdout.trim())
        .with_context(|| "gh run list returned unreadable JSON")?;
    let runs = super::pull_requests::github::workflow_runs(&value);
    if runs.len() > WORKFLOW_RUN_MAX {
        bail!(
            "GitHub reported {} workflow runs awaiting approval on {head_sha}, and the limit is {WORKFLOW_RUN_MAX}; refusing to approve a truncated list",
            runs.len()
        );
    }
    Ok(runs)
}

/// Approves one workflow run. The run id is re-checked against a fresh list by
/// the caller, so a run that started or vanished in between is never approved.
pub fn approve_workflow_run(dir: &Path, run_id: u64) -> Outcome {
    let path = format!("repos/{{owner}}/{{repo}}/actions/runs/{run_id}/approve");
    match run(dir, &["api", "--method", "POST", &path, "--silent"]) {
        Ok(o) => Outcome::done(&o, &format!("approving workflow run {run_id}")),
        Err(e) => Outcome::refused(format!(
            "running gh api to approve run {run_id} failed: {e}"
        )),
    }
}

/// `owner/name` out of a repository selector, or of any GitHub URL that names one.
pub fn split_repository(value: &str) -> Option<(String, String)> {
    let cleaned = value.trim().trim_end_matches(".git");
    if cleaned.is_empty() {
        return None;
    }
    if let Some(rest) = cleaned.split("github.com").nth(1) {
        let rest = rest.trim_start_matches(['/', ':']);
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }
    let parts: Vec<&str> = cleaned.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() == 2 {
        return Some((parts[0].to_string(), parts[1].to_string()));
    }
    if parts.len() >= 3 {
        return Some((
            parts[parts.len() - 2].to_string(),
            parts[parts.len() - 1].to_string(),
        ));
    }
    None
}

struct Output {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(dir: &Path, args: &[&str]) -> Result<Output> {
    let out = crate::spawn::command("gh")
        .current_dir(dir)
        .args(args)
        .output()
        .with_context(|| format!("spawning gh {args:?} in {}", dir.display()))?;
    Ok(Output {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_running_rollup() {
        let json = r#"{
          "number": 212,
          "url": "https://github.com/o/r/pull/212",
          "state": "OPEN",
          "reviewDecision": "REVIEW_REQUIRED",
          "statusCheckRollup": [
            {"status":"COMPLETED","conclusion":"SUCCESS"},
            {"status":"IN_PROGRESS","conclusion":""}
          ]
        }"#;
        let pr = parse_pr(json).expect("recorded gh output must parse");
        assert_eq!(pr.number, 212);
        assert_eq!(pr.url, "https://github.com/o/r/pull/212");
        assert_eq!(pr.state, "OPEN");
        assert_eq!(pr.review_decision.as_deref(), Some("REVIEW_REQUIRED"));
        assert_eq!(pr.checks, proto::PrChecks::Running);
    }

    #[test]
    fn a_failure_outranks_a_running_check() {
        let json = r#"{"number":1,"url":"u","state":"OPEN","reviewDecision":null,
          "statusCheckRollup":[{"status":"IN_PROGRESS"},{"status":"COMPLETED","conclusion":"FAILURE"}]}"#;
        assert_eq!(parse_pr(json).unwrap().checks, proto::PrChecks::Failing);
    }

    #[test]
    fn no_checks_is_not_passing() {
        let json =
            r#"{"number":1,"url":"u","state":"OPEN","reviewDecision":null,"statusCheckRollup":[]}"#;
        assert_eq!(parse_pr(json).unwrap().checks, proto::PrChecks::None);
        let absent = r#"{"number":1,"url":"u","state":"OPEN","reviewDecision":null}"#;
        assert_eq!(parse_pr(absent).unwrap().checks, proto::PrChecks::None);
    }

    #[test]
    fn empty_review_decision_reads_as_none() {
        let json =
            r#"{"number":1,"url":"u","state":"OPEN","reviewDecision":"","statusCheckRollup":[]}"#;
        assert_eq!(parse_pr(json).unwrap().review_decision, None);
    }

    #[test]
    fn commit_status_entries_use_state() {
        let json = r#"{"number":1,"url":"u","state":"OPEN","reviewDecision":null,
          "statusCheckRollup":[{"state":"FAILURE","context":"ci/legacy"}]}"#;
        assert_eq!(parse_pr(json).unwrap().checks, proto::PrChecks::Failing);
    }

    #[test]
    fn malformed_output_yields_no_pr() {
        assert!(parse_pr("").is_none());
        assert!(parse_pr("not json").is_none());
        assert!(parse_pr(r#"{"url":"u"}"#).is_none(), "a PR needs a number");
    }

    #[test]
    fn every_blocked_state_names_its_fix() {
        assert!(hint_for(proto::GhState::Missing)
            .unwrap()
            .contains("install"));
        assert!(hint_for(proto::GhState::Unauthenticated)
            .unwrap()
            .contains("gh auth login"));
        assert_eq!(hint_for(proto::GhState::Ready), None);
    }

    #[test]
    fn a_body_past_the_cap_is_refused_with_both_numbers() {
        let at_cap = "x".repeat(PR_BODY_MAX);
        assert_eq!(body_refusal(&at_cap), None, "the cap itself is allowed");
        let over = "x".repeat(PR_BODY_MAX + 1);
        let refusal = body_refusal(&over).expect("over the cap must refuse");
        assert!(
            refusal.contains(&format!("{} bytes", PR_BODY_MAX + 1))
                && refusal.contains(&PR_BODY_MAX.to_string()),
            "{refusal}"
        );
    }

    #[test]
    fn repository_selectors_come_from_urls_and_selectors() {
        assert_eq!(
            split_repository("owner/repo").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
        assert_eq!(
            split_repository("https://github.com/owner/repo.git").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
        assert_eq!(
            split_repository("git@github.com:owner/repo.git").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
        assert_eq!(
            split_repository("https://github.com/owner/repo/pull/61").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
        assert_eq!(split_repository(""), None);
        assert_eq!(split_repository("owner"), None);
    }

    #[test]
    fn a_search_phrase_quotes_the_readers_words() {
        assert_eq!(search_phrase("flaky test"), "\"flaky test\"");
        assert_eq!(
            search_phrase("is:merged \"x\""),
            "\"is:merged \\\"x\\\"\"",
            "a quote and a qualifier stay inside the phrase"
        );
        assert_eq!(search_phrase("back\\slash"), "\"back\\\\slash\"");
    }

    #[test]
    fn the_listing_cap_and_the_row_cap_are_the_documented_numbers() {
        assert_eq!(PR_LIST_LIMIT_MAX, 100);
        assert_eq!(PR_DIFF_MAX_BYTES, 512 * 1024);
        assert_eq!(PR_REVIEW_DRAFT_MAX, 50);
        assert_eq!(WORKFLOW_RUN_MAX, 100);
    }
}

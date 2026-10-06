use houston_protocol as proto;
use std::collections::HashSet;

/// Poll once a minute: GitHub's checks and review activity change at human timescales.
pub const PR_WATCH_INTERVAL_MS: u64 = 60_000;
/// Fifteen failed reads bounds watches that outlive a removed or unreachable PR.
pub const PR_WATCH_READ_FAILURE_LIMIT: u32 = 15;
/// Ten comment-only wakes prevent review chatter from keeping a pane awake forever.
pub const PR_WATCH_COMMENT_WAKE_LIMIT: u32 = 10;
/// Ten entries keep a single wake readable while reporting the remaining count.
pub const PR_WATCH_LIST_CAP: usize = 10;
/// Two hundred characters preserve a useful comment excerpt without flooding the inbox.
pub const PR_WATCH_SNIPPET_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct State {
    pub started_at: u64,
    #[serde(default)]
    pub last_checked_at_ms: Option<i64>,
    pub head_sha: String,
    pub failed_checks: HashSet<String>,
    pub passed: bool,
    pub comments_through: u64,
    pub comment_ids: HashSet<String>,
    pub conflicting: bool,
    pub comment_only_wakes: u32,
    pub read_failures: u32,
    pub own_login: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    pub login: String,
    pub path: Option<String>,
    pub body: String,
    pub created_at: u64,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    FailedCheck {
        sha: String,
        name: String,
        status: String,
    },
    ChecksPassed {
        sha: String,
        count: usize,
    },
    NewComment(Comment),
    Conflict {
        base: String,
    },
    StopReadFailures,
    StopCommentWakeLimit,
    StopClosed,
    StopMerged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub state: Option<State>,
    pub changes: Vec<Change>,
}

pub fn evaluate(
    mut state: State,
    link: &proto::PullRequestLink,
    detail: &proto::PrDetail,
    author: Option<&str>,
    own_login: Option<&str>,
) -> Evaluation {
    if link.state == proto::PullRequestState::Merged {
        return Evaluation {
            state: None,
            changes: vec![Change::StopMerged],
        };
    }
    if link.state == proto::PullRequestState::Closed {
        return Evaluation {
            state: None,
            changes: vec![Change::StopClosed],
        };
    }

    let mut changes = Vec::new();
    state.last_checked_at_ms = Some(crate::daemon::now_unix_ms());
    state.read_failures = 0;
    if detail.head_sha != state.head_sha {
        state.head_sha.clone_from(&detail.head_sha);
        state.failed_checks.clear();
        state.passed = false;
    }

    for check in &detail.checks {
        if check.state == proto::PrCheckState::Failing
            && state.failed_checks.insert(check.name.clone())
        {
            changes.push(Change::FailedCheck {
                sha: state.head_sha.clone(),
                name: check.name.clone(),
                status: "failure".into(),
            });
        }
    }

    // `gh pr view` omits GitHub's per-context `isRequired`, so every reported check is a gate.
    let checks_passed = !detail.checks.is_empty()
        && detail.checks.iter().all(|check| {
            matches!(
                check.state,
                proto::PrCheckState::Passing | proto::PrCheckState::Skipped
            )
        });
    if checks_passed && !state.passed {
        state.passed = true;
        changes.push(Change::ChecksPassed {
            sha: state.head_sha.clone(),
            count: detail.checks.len(),
        });
    }

    let comments = detail
        .comments
        .iter()
        .map(|c| Comment {
            login: c.author.clone(),
            path: None,
            body: c.body.clone(),
            created_at: c.created_at,
            id: c.id.clone(),
        })
        .chain(detail.reviews.iter().map(|r| Comment {
            login: r.author.clone(),
            path: None,
            body: r.body.clone(),
            created_at: r.submitted_at,
            id: r.id.clone(),
        }))
        .chain(detail.threads.iter().flat_map(|thread| {
            thread.comments.iter().map(|comment| Comment {
                login: comment.author.clone(),
                path: thread.path.clone(),
                body: comment.body.clone(),
                created_at: comment.created_at,
                id: Some(comment.id.clone()),
            })
        }));
    for comment in comments {
        if comment.created_at < state.started_at
            || comment.created_at < state.comments_through
            || author.is_some_and(|v| v.eq_ignore_ascii_case(&comment.login))
            || own_login.is_some_and(|v| v.eq_ignore_ascii_case(&comment.login))
            || comment
                .id
                .as_ref()
                .is_some_and(|id| state.comment_ids.contains(id))
        {
            continue;
        }
        if let Some(id) = &comment.id {
            state.comment_ids.insert(id.clone());
        }
        changes.push(Change::NewComment(comment));
    }
    state.comments_through = state.comments_through.max(
        detail
            .comments
            .iter()
            .map(|c| c.created_at)
            .chain(detail.reviews.iter().map(|r| r.submitted_at))
            .max()
            .unwrap_or(state.comments_through),
    );

    let conflicting = detail.mergeable == proto::PrMergeable::Conflicting;
    if conflicting && !state.conflicting {
        changes.push(Change::Conflict {
            base: detail
                .base_ref
                .clone()
                .unwrap_or_else(|| "the base branch".into()),
        });
    }
    state.conflicting = conflicting;

    if !changes.is_empty() && changes.iter().all(|c| matches!(c, Change::NewComment(_))) {
        state.comment_only_wakes = state.comment_only_wakes.saturating_add(1);
    } else if !changes.is_empty() {
        state.comment_only_wakes = 0;
    }
    if state.comment_only_wakes >= PR_WATCH_COMMENT_WAKE_LIMIT {
        changes.push(Change::StopCommentWakeLimit);
        return Evaluation {
            state: None,
            changes,
        };
    }
    Evaluation {
        state: Some(state),
        changes,
    }
}

pub fn failed_read(mut state: State) -> Evaluation {
    state.last_checked_at_ms = Some(crate::daemon::now_unix_ms());
    state.read_failures = state.read_failures.saturating_add(1);
    if state.read_failures >= PR_WATCH_READ_FAILURE_LIMIT {
        Evaluation {
            state: None,
            changes: vec![Change::StopReadFailures],
        }
    } else {
        Evaluation {
            state: Some(state),
            changes: Vec::new(),
        }
    }
}

pub fn snippet(body: &str) -> String {
    let mut end = body.len().min(PR_WATCH_SNIPPET_MAX);
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let mut value = body[..end].replace(['\n', '\r'], " ");
    if body.len() > end {
        value.push('…');
    }
    value
}

pub fn message(number: u32, changes: &[Change]) -> String {
    let mut lines = vec![format!(
        "Update on pull request #{number}, which Houston is watching for you:"
    )];
    let mut items = Vec::new();
    let mut comments = Vec::new();
    for change in changes {
        match change {
            Change::FailedCheck { sha, name, status } => {
                items.push(format!("checks failed on {sha}: {name} ({status})"));
            }
            Change::ChecksPassed { sha, count } => {
                items.push(format!("all {count} required checks passed on {sha}"));
            }
            Change::NewComment(comment) => comments.push(comment),
            Change::Conflict { base } => {
                items.push(format!("the branch now conflicts with {base}"))
            }
            Change::StopReadFailures => {
                items.push(format!(
                    "the watch stopped after {PR_WATCH_READ_FAILURE_LIMIT} failed reads"
                ));
            }
            Change::StopCommentWakeLimit => {
                items.push(format!(
                    "the watch stopped after {PR_WATCH_COMMENT_WAKE_LIMIT} comment-only wakes"
                ));
            }
            Change::StopClosed => items.push("the pull request closed; the watch ended".into()),
            Change::StopMerged => items.push("the pull request merged; the watch ended".into()),
        }
    }
    let comment_total = comments.len();
    for comment in comments.into_iter().take(PR_WATCH_LIST_CAP) {
        let path = comment.path.as_deref().unwrap_or("the pull request");
        let body = snippet(&comment.body).replace('"', "'");
        items.push(format!("{} on {path}: \"{body}\"", comment.login));
    }
    for item in items.iter().take(PR_WATCH_LIST_CAP) {
        lines.push(format!("- {item}"));
    }
    let hidden = items.len().saturating_sub(PR_WATCH_LIST_CAP)
        + comment_total.saturating_sub(PR_WATCH_LIST_CAP);
    if hidden > 0 {
        lines.push(format!("- and {hidden} more"));
    }
    lines.push("Act on each item, then end your turn. Call pane_pr_unwatch when you no longer need updates.".into());
    if changes.contains(&Change::StopReadFailures) {
        lines.push(format!("Houston stopped watching after {PR_WATCH_READ_FAILURE_LIMIT} consecutive read failures."));
    }
    if changes.contains(&Change::StopCommentWakeLimit) {
        lines.push(format!("Houston stopped watching after {PR_WATCH_COMMENT_WAKE_LIMIT} comment-only wakes in a row."));
    }
    if changes.contains(&Change::StopMerged) {
        lines.push("Houston stopped watching because the pull request was merged.".into());
    }
    if changes.contains(&Change::StopClosed) {
        lines.push("Houston stopped watching because the pull request was closed.".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State {
            started_at: 1,
            last_checked_at_ms: None,
            head_sha: "abc".into(),
            failed_checks: HashSet::new(),
            passed: false,
            comments_through: 1,
            comment_ids: HashSet::new(),
            conflicting: false,
            comment_only_wakes: 0,
            read_failures: 0,
            own_login: None,
        }
    }

    #[test]
    fn persisted_state_without_last_checked_time_defaults_to_unknown() {
        let mut value = serde_json::to_value(state()).unwrap();
        value.as_object_mut().unwrap().remove("last_checked_at_ms");
        let restored: State = serde_json::from_value(value).unwrap();
        assert_eq!(restored.last_checked_at_ms, None);
    }

    fn link(state: proto::PullRequestState) -> proto::PullRequestLink {
        proto::PullRequestLink {
            host: "GitHub".into(),
            repository: "owner/repo".into(),
            number: 12,
            url: "https://github.com/owner/repo/pull/12".into(),
            state,
            source: proto::PullRequestLinkSource::Agent,
            title: Some("title".into()),
            is_draft: false,
            additions: 0,
            deletions: 0,
            changed_files: 0,
            checks: None,
            review_decision: None,
            linked_at: 0,
            merged_at: None,
            closed_at: None,
            synced_at: None,
        }
    }

    fn detail(sha: &str) -> proto::PrDetail {
        proto::PrDetail {
            body: None,
            author: Some("author".into()),
            base_ref: Some("main".into()),
            head_ref: Some("feature".into()),
            head_sha: sha.into(),
            commit_count: 1,
            created_at: 1,
            updated_at: 1,
            mergeable: proto::PrMergeable::Mergeable,
            merge_state: proto::PrMergeState::Clean,
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
    fn head_change_resets_check_state_and_reports_a_failed_check_once() {
        let mut state = state();
        state.passed = true;
        state.failed_checks.insert("build".into());
        let mut detail = detail("def");
        detail.checks.push(proto::PrCheck {
            name: "build".into(),
            state: proto::PrCheckState::Failing,
            url: None,
            duration_ms: None,
        });
        let first = evaluate(
            state,
            &link(proto::PullRequestState::Open),
            &detail,
            None,
            None,
        );
        assert!(
            matches!(first.changes.as_slice(), [Change::FailedCheck { sha, .. }] if sha == "def")
        );
        let second = evaluate(
            first.state.unwrap(),
            &link(proto::PullRequestState::Open),
            &detail,
            None,
            None,
        );
        assert!(second.changes.is_empty());
    }

    #[test]
    fn passing_required_checks_wake_once_and_empty_rollup_does_not_pass() {
        let link = link(proto::PullRequestState::Open);
        let mut checks = detail("abc");
        checks.checks.push(proto::PrCheck {
            name: "build".into(),
            state: proto::PrCheckState::Passing,
            url: None,
            duration_ms: None,
        });
        let first = evaluate(state(), &link, &checks, None, None);
        assert!(matches!(
            first.changes.as_slice(),
            [Change::ChecksPassed { count: 1, .. }]
        ));
        let second = evaluate(first.state.unwrap(), &link, &checks, None, None);
        assert!(second.changes.is_empty());
        assert!(evaluate(state(), &link, &detail("abc"), None, None)
            .changes
            .is_empty());
    }

    #[test]
    fn a_new_conflict_wakes_once_and_a_clear_conflict_resets_it() {
        let link = link(proto::PullRequestState::Open);
        let mut detail = detail("abc");
        detail.mergeable = proto::PrMergeable::Conflicting;
        let first = evaluate(state(), &link, &detail, None, None);
        assert_eq!(
            first.changes,
            [Change::Conflict {
                base: "main".into()
            }]
        );
        let clear = evaluate(first.state.unwrap(), &link, &detail, None, None);
        assert!(clear.changes.is_empty());
        let mut resolved = detail.clone();
        resolved.mergeable = proto::PrMergeable::Mergeable;
        let cleared = evaluate(clear.state.unwrap(), &link, &resolved, None, None);
        assert!(cleared.changes.is_empty());
        let again = evaluate(cleared.state.unwrap(), &link, &detail, None, None);
        assert_eq!(
            again.changes,
            [Change::Conflict {
                base: "main".into()
            }]
        );
    }

    #[test]
    fn merge_and_close_end_the_watch() {
        let detail = detail("abc");
        assert_eq!(
            evaluate(
                state(),
                &link(proto::PullRequestState::Merged),
                &detail,
                None,
                None
            )
            .changes,
            [Change::StopMerged]
        );
        assert_eq!(
            evaluate(
                state(),
                &link(proto::PullRequestState::Closed),
                &detail,
                None,
                None
            )
            .changes,
            [Change::StopClosed]
        );
    }

    #[test]
    fn comments_from_author_or_own_login_are_ignored_and_ids_are_deduplicated() {
        let mut detail = detail("abc");
        detail.comments.push(proto::PrComment {
            id: Some("1".into()),
            author: "reviewer".into(),
            body: "hello".into(),
            created_at: 2,
            url: None,
            reactions: Vec::new(),
        });
        detail.reviews.push(proto::PrReview {
            id: Some("review-1".into()),
            author: "reviewer".into(),
            state: "COMMENTED".into(),
            body: "please reconsider".into(),
            submitted_at: 4,
            reactions: Vec::new(),
        });
        detail.threads.push(proto::PrThread {
            id: "thread-1".into(),
            path: Some("src/main.rs".into()),
            line: Some(4),
            resolved: false,
            outdated: false,
            comments: vec![proto::PrThreadComment {
                id: "thread-comment-1".into(),
                author: "reviewer".into(),
                body: "inline note".into(),
                created_at: 5,
                url: None,
                reactions: Vec::new(),
            }],
        });
        detail.comments.push(proto::PrComment {
            id: Some("2".into()),
            author: "author".into(),
            body: "mine".into(),
            created_at: 3,
            url: None,
            reactions: Vec::new(),
        });
        detail.comments.push(proto::PrComment {
            id: Some("3".into()),
            author: "self".into(),
            body: "also mine".into(),
            created_at: 6,
            url: None,
            reactions: Vec::new(),
        });
        let first = evaluate(
            state(),
            &link(proto::PullRequestState::Open),
            &detail,
            Some("author"),
            Some("self"),
        );
        assert_eq!(first.changes.len(), 3);
        assert!(first.changes.iter().any(
            |change| matches!(change, Change::NewComment(comment) if comment.path.as_deref() == Some("src/main.rs"))
        ));
        let second = evaluate(
            first.state.unwrap(),
            &link(proto::PullRequestState::Open),
            &detail,
            Some("author"),
            Some("self"),
        );
        assert!(second.changes.is_empty());
    }

    #[test]
    fn failure_limit_and_comment_only_limit_stop() {
        let mut read_state = state();
        read_state.read_failures = PR_WATCH_READ_FAILURE_LIMIT - 1;
        assert_eq!(failed_read(read_state).changes, [Change::StopReadFailures]);
        let mut comment_state = state();
        comment_state.comment_only_wakes = PR_WATCH_COMMENT_WAKE_LIMIT - 1;
        let mut detail = detail("abc");
        detail.comments.push(proto::PrComment {
            id: Some("1".into()),
            author: "reviewer".into(),
            body: "hello".into(),
            created_at: 2,
            url: None,
            reactions: Vec::new(),
        });
        let result = evaluate(
            comment_state,
            &link(proto::PullRequestState::Open),
            &detail,
            None,
            None,
        );
        assert!(result.state.is_none());
        assert!(result.changes.contains(&Change::StopCommentWakeLimit));
    }

    #[test]
    fn message_caps_lists_and_snippets_utf8_safely() {
        let comment = Comment {
            login: "reviewer".into(),
            path: Some("src/main.rs".into()),
            body: "é".repeat(150),
            created_at: 2,
            id: None,
        };
        let changes = (0..12)
            .map(|_| Change::NewComment(comment.clone()))
            .collect::<Vec<_>>();
        let message = message(12, &changes);
        assert!(message.contains("and 2 more"));
        assert!(message.contains("reviewer on src/main.rs"));
        assert!(message.ends_with("Call pane_pr_unwatch when you no longer need updates."));
    }
}

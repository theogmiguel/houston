//! Conflict prediction between managed worktrees: each branch against its base and its
//! siblings, re-run when a head moves. A new conflict is one note to the worktree's
//! creator. See docs/internals/daemon.md.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::{now_ms, Daemon};
use crate::conflict_prediction::{self as cp, MergeVerdict};
use crate::db::ManagedWorktreeRow;
use crate::orchestrate;

/// Branch heads move at commit pace: a minute warns well before a PR exists, and a tick
/// with no moved head costs one `for-each-ref` per repository.
pub(super) const CONFLICT_CHECK_INTERVAL_MS: u64 = 60_000;
/// A merge-tree run can take seconds on a large repository. The least recently checked
/// pairs go first, so a branch that moves every tick cannot starve the others.
const MAX_RUNS_PER_TICK: usize = 8;
/// Bounds the note; the remainder is counted, not listed.
const MAX_NOTED_FILES: usize = 20;

#[derive(Default)]
pub(super) struct ConflictState {
    /// The installed Git's verdict, detected once per daemon.
    git: Option<Result<(), String>>,
    refusal_noted: HashSet<u32>,
    checked: HashMap<String, Checked>,
}

struct Checked {
    heads: (String, String),
    at_ms: u64,
}

struct Side {
    branch: String,
    head: String,
    /// The worktree on this branch; `None` for a base branch.
    path: Option<String>,
}

struct Pair {
    key: String,
    git_dir: PathBuf,
    ours: Side,
    theirs: Side,
    recipients: Vec<u32>,
}

impl Daemon {
    pub async fn conflict_prediction_loop(self: Arc<Self>) {
        loop {
            let daemon = Arc::clone(&self);
            let _ = tokio::task::spawn_blocking(move || daemon.conflict_prediction_tick()).await;
            tokio::time::sleep(Duration::from_millis(CONFLICT_CHECK_INTERVAL_MS)).await;
        }
    }

    /// One pass. Only creators with a live inbox recipient count: a closed one's notes
    /// would reach the operator queue as its abandoned branches fall behind. With no one
    /// to tell nothing runs, not even the Git version check.
    pub fn conflict_prediction_tick(self: &Arc<Self>) {
        let rows = self.db.managed_worktrees().unwrap_or_default();
        let creators: BTreeSet<u32> = rows.iter().filter_map(|r| r.created_by_session).collect();
        let reachable: HashSet<u32> = creators
            .into_iter()
            .filter(|s| self.live_inbox_recipient(*s) != 0)
            .collect();
        if reachable.is_empty() {
            return;
        }
        if let Err(why) = self.conflict_git_support() {
            self.note_conflict_refusal(&reachable, &why);
            return;
        }
        let mut repos: BTreeMap<&str, Vec<&ManagedWorktreeRow>> = BTreeMap::new();
        for row in &rows {
            repos
                .entry(row.repo_common_dir.as_str())
                .or_default()
                .push(row);
        }
        let mut known = HashSet::new();
        let mut pairs = Vec::new();
        for (common_dir, rows) in repos {
            for (key, _, _) in pair_shapes(&rows) {
                known.insert(key);
            }
            if !rows
                .iter()
                .any(|r| r.created_by_session.is_some_and(|s| reachable.contains(&s)))
            {
                continue;
            }
            let git_dir = PathBuf::from(common_dir);
            match cp::branch_heads(&git_dir) {
                Ok(heads) => pairs.extend(resolve_pairs(&git_dir, &rows, &heads)),
                Err(e) => tracing::warn!("conflict prediction: reading branch heads: {e}"),
            }
        }

        for pair in &mut pairs {
            pair.recipients.retain(|s| reachable.contains(s));
        }
        pairs.retain(|p| !p.recipients.is_empty());

        let due: Vec<Pair> = {
            let state = self.conflict_prediction.lock().expect("conflict lock");
            let mut due: Vec<(u64, Pair)> = pairs
                .into_iter()
                .filter_map(|pair| match state.checked.get(&pair.key) {
                    Some(c) if c.heads.0 == pair.ours.head && c.heads.1 == pair.theirs.head => None,
                    checked => Some((checked.map_or(0, |c| c.at_ms), pair)),
                })
                .collect();
            due.sort_by_key(|(at, _)| *at);
            due.into_iter()
                .take(MAX_RUNS_PER_TICK)
                .map(|(_, p)| p)
                .collect()
        };

        for pair in due {
            let verdict = cp::merge_tree(&pair.git_dir, &pair.ours.head, &pair.theirs.head);
            self.conflict_prediction
                .lock()
                .expect("conflict lock")
                .checked
                .insert(
                    pair.key.clone(),
                    Checked {
                        heads: (pair.ours.head.clone(), pair.theirs.head.clone()),
                        at_ms: now_ms(),
                    },
                );
            match verdict {
                Ok(MergeVerdict::Clean) => {
                    if let Err(e) = self.db.predicted_conflict_clear(&pair.key) {
                        tracing::warn!("conflict prediction: clearing a resolved pair: {e:#}");
                    }
                }
                Ok(MergeVerdict::Conflict(files)) => {
                    match self.db.predicted_conflict_note(&pair.key, now_ms() as i64) {
                        Ok(true) => self.note_predicted_conflict(&pair, &files),
                        Ok(false) => {}
                        Err(e) => tracing::warn!("conflict prediction: recording a pair: {e:#}"),
                    }
                }
                // The pair keeps its previous verdict; a moved head retries it.
                Err(e) => tracing::warn!("conflict prediction: {e}"),
            }
        }

        self.conflict_prediction
            .lock()
            .expect("conflict lock")
            .checked
            .retain(|key, _| known.contains(key));
        for key in self.db.predicted_conflicts().unwrap_or_default() {
            if !known.contains(&key) {
                let _ = self.db.predicted_conflict_clear(&key);
            }
        }
    }

    fn conflict_git_support(&self) -> Result<(), String> {
        if let Some(known) = &self.conflict_prediction.lock().expect("conflict lock").git {
            return known.clone();
        }
        let support = cp::require_merge_tree(cp::git_version());
        if let Err(why) = &support {
            tracing::warn!("conflict prediction is off: {why}");
        }
        self.conflict_prediction
            .lock()
            .expect("conflict lock")
            .git
            .get_or_insert(support)
            .clone()
    }

    /// Each orchestrator with managed worktrees learns once per daemon why it gets no
    /// conflict notes, instead of silence.
    fn note_conflict_refusal(self: &Arc<Self>, creators: &HashSet<u32>, why: &str) {
        let creators: Vec<u32> = {
            let mut state = self.conflict_prediction.lock().expect("conflict lock");
            creators
                .iter()
                .copied()
                .filter(|s| state.refusal_noted.insert(*s))
                .collect()
        };
        for session in creators {
            let workspace = self.current_workspace(session).unwrap_or_default();
            let body = format!(
                "{why}. Houston does not predict merge conflicts between this pane's \
                 worktrees until Git is updated and the Houston daemon restarts."
            );
            if let Err(e) = self.inbox_write(
                session,
                &workspace,
                None,
                None,
                orchestrate::InboxKind::OperatorNote,
                "Conflict prediction is unavailable",
                &body,
                Vec::new(),
                Some("conflict_prediction_refused"),
                None,
                false,
                true,
            ) {
                tracing::warn!("noting conflict prediction refusal to pane {session}: {e:#}");
            }
        }
    }

    fn note_predicted_conflict(self: &Arc<Self>, pair: &Pair, files: &[String]) {
        let (summary, body) = conflict_note(pair, files);
        let repo = pair.git_dir.parent().unwrap_or(&pair.git_dir);
        for &session in &pair.recipients {
            let workspace = self
                .current_workspace(session)
                .unwrap_or_else(|_| repo.display().to_string());
            if let Err(e) = self.inbox_write(
                session,
                &workspace,
                None,
                None,
                orchestrate::InboxKind::OperatorNote,
                &summary,
                &body,
                Vec::new(),
                Some("conflict_predicted"),
                None,
                false,
                true,
            ) {
                tracing::warn!("noting a predicted conflict to pane {session}: {e:#}");
            }
        }
    }
}

/// Every pair a repository's rows define, whether or not its branches resolve: a base
/// pair per worktree with a distinct recorded base, and one per two worktrees of which
/// at least one has an orchestrator to tell.
fn pair_shapes<'a>(
    rows: &[&'a ManagedWorktreeRow],
) -> Vec<(
    String,
    &'a ManagedWorktreeRow,
    Option<&'a ManagedWorktreeRow>,
)> {
    let mut shapes = Vec::new();
    for row in rows {
        if let Some(base) = row.base_branch.as_deref().filter(|b| *b != row.branch) {
            if row.created_by_session.is_some() {
                shapes.push((
                    format!("base\n{}\n{}\n{base}", row.path, row.branch),
                    *row,
                    None,
                ));
            }
        }
    }
    for (i, a) in rows.iter().enumerate() {
        for b in &rows[i + 1..] {
            if a.branch == b.branch
                || (a.created_by_session.is_none() && b.created_by_session.is_none())
            {
                continue;
            }
            let (a, b) = if a.path <= b.path { (*a, *b) } else { (*b, *a) };
            shapes.push((
                format!("pair\n{}\n{}\n{}\n{}", a.path, a.branch, b.path, b.branch),
                a,
                Some(b),
            ));
        }
    }
    shapes
}

fn resolve_pairs(
    git_dir: &Path,
    rows: &[&ManagedWorktreeRow],
    heads: &HashMap<String, String>,
) -> Vec<Pair> {
    let side = |row: &ManagedWorktreeRow| {
        Some(Side {
            head: cp::resolve(heads, &row.branch)?.to_string(),
            branch: row.branch.clone(),
            path: Some(row.path.clone()),
        })
    };
    pair_shapes(rows)
        .into_iter()
        .filter_map(|(key, a, b)| {
            let ours = side(a)?;
            let (theirs, recipients) = match b {
                None => {
                    let base = a.base_branch.clone()?;
                    let theirs = Side {
                        head: cp::resolve(heads, &base)?.to_string(),
                        branch: base,
                        path: None,
                    };
                    (theirs, a.created_by_session.into_iter().collect())
                }
                Some(b) => {
                    let mut recipients: Vec<u32> = a.created_by_session.into_iter().collect();
                    if let Some(s) = b.created_by_session.filter(|s| !recipients.contains(s)) {
                        recipients.push(s);
                    }
                    (side(b)?, recipients)
                }
            };
            Some(Pair {
                key,
                git_dir: git_dir.to_path_buf(),
                ours,
                theirs,
                recipients,
            })
        })
        .collect()
}

fn conflict_note(pair: &Pair, files: &[String]) -> (String, String) {
    let short = |head: &str| head.chars().take(10).collect::<String>();
    let describe = |side: &Side| match &side.path {
        Some(path) => format!("{} ({}, worktree {path})", side.branch, short(&side.head)),
        None => format!("{} ({})", side.branch, short(&side.head)),
    };
    let (summary, merge) = if pair.theirs.path.is_none() {
        (
            format!(
                "Predicted conflict: {} into {}",
                pair.ours.branch, pair.theirs.branch
            ),
            format!(
                "Merging {} into its base {}",
                describe(&pair.ours),
                describe(&pair.theirs)
            ),
        )
    } else {
        (
            format!(
                "Predicted conflict: {} with {}",
                pair.ours.branch, pair.theirs.branch
            ),
            format!(
                "Merging {} with {}",
                describe(&pair.ours),
                describe(&pair.theirs)
            ),
        )
    };
    let mut body = format!(
        "{merge} would conflict in {} file{}",
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    if files.is_empty() {
        body.push_str(" (git named no paths).");
    } else {
        body.push(':');
        for file in files.iter().take(MAX_NOTED_FILES) {
            body.push_str("\n- ");
            body.push_str(file);
        }
        if files.len() > MAX_NOTED_FILES {
            body.push_str(&format!("\n- and {} more", files.len() - MAX_NOTED_FILES));
        }
    }
    body.push_str(
        "\n\nPredicted with `git merge-tree` from the committed branch heads; uncommitted \
         changes are not included. Houston notes this pair once while the conflict \
         persists, and again only if it recurs after merging clean.",
    );
    (summary, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::WorktreeProvenance;

    fn row(path: &str, branch: &str, creator: Option<u32>) -> ManagedWorktreeRow {
        ManagedWorktreeRow {
            path: path.into(),
            repo_common_dir: "/r/.git".into(),
            branch: branch.into(),
            base_branch: Some("main".into()),
            provenance: WorktreeProvenance::PaneSpawn,
            created_by_session: creator,
            created_at_ms: 0,
            bytes: None,
            measured_at_ms: None,
        }
    }

    #[test]
    fn pairs_cover_bases_and_siblings_with_someone_to_tell() {
        let a = row("/r/a", "houston/a", Some(1));
        let b = row("/r/b", "houston/b", None);
        let c = row("/r/c", "houston/c", None);
        let on_base = ManagedWorktreeRow {
            base_branch: Some("houston/d".into()),
            ..row("/r/d", "houston/d", Some(1))
        };
        let keys: Vec<String> = pair_shapes(&[&b, &a, &c, &on_base])
            .into_iter()
            .map(|(k, _, _)| k)
            .collect();
        assert_eq!(
            keys,
            vec![
                "base\n/r/a\nhouston/a\nmain".to_string(),
                "pair\n/r/a\nhouston/a\n/r/b\nhouston/b".into(),
                "pair\n/r/b\nhouston/b\n/r/d\nhouston/d".into(),
                "pair\n/r/a\nhouston/a\n/r/c\nhouston/c".into(),
                "pair\n/r/a\nhouston/a\n/r/d\nhouston/d".into(),
                "pair\n/r/c\nhouston/c\n/r/d\nhouston/d".into(),
            ],
            "b-c has no orchestrator, and d is on its own base"
        );
    }

    #[test]
    fn sibling_recipients_are_each_creator_once() {
        let a = row("/r/a", "houston/a", Some(1));
        let b = row("/r/b", "houston/b", Some(1));
        let c = row("/r/c", "houston/c", Some(2));
        let heads: HashMap<String, String> = [
            ("refs/heads/houston/a", "1"),
            ("refs/heads/houston/b", "2"),
            ("refs/heads/houston/c", "3"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let pairs = resolve_pairs(Path::new("/r/.git"), &[&a, &b, &c], &heads);
        let recipients: Vec<_> = pairs.iter().map(|p| p.recipients.clone()).collect();
        // No `main` head, so the base pairs do not resolve.
        assert_eq!(recipients, vec![vec![1], vec![1, 2], vec![1, 2]]);
    }

    #[test]
    fn a_note_names_both_branches_and_bounds_its_files() {
        let pair = Pair {
            key: String::new(),
            git_dir: PathBuf::from("/r/.git"),
            ours: Side {
                branch: "houston/a".into(),
                head: "0123456789abcdef".into(),
                path: Some("/r/a".into()),
            },
            theirs: Side {
                branch: "houston/b".into(),
                head: "fedcba9876543210".into(),
                path: Some("/r/b".into()),
            },
            recipients: vec![1],
        };
        let files: Vec<String> = (0..25).map(|i| format!("f{i}.rs")).collect();
        let (summary, body) = conflict_note(&pair, &files);
        assert_eq!(summary, "Predicted conflict: houston/a with houston/b");
        assert!(body.starts_with(
            "Merging houston/a (0123456789, worktree /r/a) with houston/b (fedcba9876, \
             worktree /r/b) would conflict in 25 files:"
        ));
        assert!(body.contains("\n- f19.rs\n- and 5 more"));
        assert!(!body.contains("f20.rs"));
    }
}

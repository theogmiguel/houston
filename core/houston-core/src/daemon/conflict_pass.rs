//! Conflict prediction between managed worktrees: each branch against its base and its
//! active siblings, re-run when a head moves. A tick's new conflicts reach a worktree's
//! creator as one note per branch. See docs/internals/daemon.md.
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
/// A grouped note lists several partners, so each gets a shorter file list.
const MAX_FILES_PER_PARTNER: usize = 5;
/// Deciding that a branch is integrated can cost a `merge-tree` run, like a pair does. The
/// verdict is kept until a head moves, and a branch left undecided this tick is not
/// compared until a later one.
const MAX_INTEGRATION_CHECKS_PER_TICK: usize = 8;
/// Per-call merge-tree object quarantines live here in the state dir, each deleted with
/// its call, so their throwaway objects never reach a repository's store.
const MERGE_TREE_SCRATCH: &str = "merge-tree";

#[derive(Default)]
pub(super) struct ConflictState {
    /// The installed Git's verdict, detected once per daemon.
    git: Option<Result<(), String>>,
    refusal_noted: HashSet<u32>,
    checked: HashMap<String, Checked>,
    /// Whether a worktree head is already in its base, keyed by (head, base head).
    integrated: HashMap<(String, String), bool>,
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
    /// The head of the worktree's recorded base, when that branch resolves.
    base_head: Option<String>,
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
        cp::sweep_quarantines(&self.merge_tree_scratch());
        let mut repos: BTreeMap<&str, Vec<&ManagedWorktreeRow>> = BTreeMap::new();
        for row in &rows {
            repos
                .entry(row.repo_common_dir.as_str())
                .or_default()
                .push(row);
        }
        let active = self.active_worktrees(&rows);
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
                Ok(heads) => pairs.extend(resolve_pairs(&git_dir, &rows, &heads, &|row| {
                    active.contains(row.path.as_str())
                })),
                Err(e) => tracing::warn!("conflict prediction: reading branch heads: {e}"),
            }
        }

        for pair in &mut pairs {
            pair.recipients.retain(|s| reachable.contains(s));
        }
        pairs.retain(|p| !p.recipients.is_empty());
        self.drop_integrated_pairs(&mut pairs);

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

        let mut fresh = Vec::new();
        for pair in due {
            let verdict = cp::merge_tree(
                &self.merge_tree_scratch(),
                &pair.git_dir,
                &pair.ours.head,
                &pair.theirs.head,
            );
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
                        Ok(true) => fresh.push((pair, files)),
                        Ok(false) => {}
                        Err(e) => tracing::warn!("conflict prediction: recording a pair: {e:#}"),
                    }
                }
                // The pair keeps its previous verdict; a moved head retries it.
                Err(e) => tracing::warn!("conflict prediction: {e}"),
            }
        }
        self.note_predicted_conflicts(&fresh);

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

    fn merge_tree_scratch(&self) -> PathBuf {
        self.state_dir().join(MERGE_TREE_SCRATCH)
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

    /// Paths of the worktrees someone is working in: their creating pane is live, or a
    /// live session runs inside them. Worktrees left over from finished work are not.
    fn active_worktrees<'a>(&self, rows: &'a [ManagedWorktreeRow]) -> HashSet<&'a str> {
        let (live, cwds): (HashSet<u32>, Vec<PathBuf>) = {
            let sessions = self.sessions.lock().expect("sessions lock");
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| s.state.lock().expect("state lock").is_live())
                .map(|(id, _)| *id)
                .collect();
            drop(sessions);
            let cwds = ids
                .iter()
                .filter_map(|id| self.live_cwd(*id))
                .map(|cwd| cwd.canonicalize().unwrap_or(cwd))
                .collect();
            (ids.into_iter().collect(), cwds)
        };
        rows.iter()
            .filter(|row| {
                row.created_by_session.is_some_and(|s| live.contains(&s)) || {
                    let path = PathBuf::from(&row.path);
                    let path = path.canonicalize().unwrap_or(path);
                    cwds.iter().any(|cwd| cwd.starts_with(&path))
                }
            })
            .map(|row| row.path.as_str())
            .collect()
    }

    /// Drops pairs with a worktree whose changes are already in its base: a branch with no
    /// commits of its own conflicts exactly as its base does, and an integrated one only
    /// reports what its base changed since.
    fn drop_integrated_pairs(&self, pairs: &mut Vec<Pair>) {
        let mut budget = MAX_INTEGRATION_CHECKS_PER_TICK;
        let mut known = self
            .conflict_prediction
            .lock()
            .expect("conflict lock")
            .integrated
            .clone();
        let mut seen = HashSet::new();
        pairs.retain(|pair| {
            [&pair.ours, &pair.theirs].into_iter().all(|side| {
                let Some(base_head) = side.path.as_ref().and(side.base_head.as_ref()) else {
                    return true;
                };
                let key = (side.head.clone(), base_head.clone());
                seen.insert(key.clone());
                let integrated = match known.get(&key) {
                    Some(verdict) => *verdict,
                    None if budget == 0 => return false,
                    None => {
                        budget -= 1;
                        match cp::is_integrated(
                            &self.merge_tree_scratch(),
                            &pair.git_dir,
                            &side.head,
                            base_head,
                        ) {
                            Ok(known_verdict) => {
                                known.insert(key, known_verdict);
                                known_verdict
                            }
                            Err(e) => {
                                tracing::warn!("conflict prediction: {e}");
                                false
                            }
                        }
                    }
                };
                !integrated
            })
        });
        known.retain(|key, _| seen.contains(key));
        self.conflict_prediction
            .lock()
            .expect("conflict lock")
            .integrated = known;
    }

    /// One note per branch and recipient: a branch that conflicts with several others names
    /// them all instead of filling the inbox with one row per pair.
    fn note_predicted_conflicts(self: &Arc<Self>, fresh: &[(Pair, Vec<String>)]) {
        let sessions: BTreeSet<u32> = fresh
            .iter()
            .flat_map(|(pair, _)| pair.recipients.iter().copied())
            .collect();
        for session in sessions {
            let mine: Vec<&(Pair, Vec<String>)> = fresh
                .iter()
                .filter(|(pair, _)| pair.recipients.contains(&session))
                .collect();
            let repo = mine[0].0.git_dir.parent().unwrap_or(&mine[0].0.git_dir);
            let workspace = self
                .current_workspace(session)
                .unwrap_or_else(|_| repo.display().to_string());
            for (summary, body) in grouped_notes(&mine) {
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
    active: &dyn Fn(&ManagedWorktreeRow) -> bool,
) -> Vec<Pair> {
    let side = |row: &ManagedWorktreeRow| {
        Some(Side {
            head: cp::resolve(heads, &row.branch)?.to_string(),
            branch: row.branch.clone(),
            path: Some(row.path.clone()),
            base_head: row
                .base_branch
                .as_deref()
                .and_then(|base| cp::resolve(heads, base))
                .map(str::to_string),
        })
    };
    pair_shapes(rows)
        .into_iter()
        .filter_map(|(key, a, b)| {
            if b.is_some_and(|b| !active(a) || !active(b)) {
                return None;
            }
            let ours = side(a)?;
            let (theirs, recipients) = match b {
                None => {
                    let base = a.base_branch.clone()?;
                    let theirs = Side {
                        head: cp::resolve(heads, &base)?.to_string(),
                        branch: base,
                        path: None,
                        base_head: None,
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

const NOTE_FOOTER: &str = "\n\nPredicted with `git merge-tree` from the committed branch heads; \
    uncommitted changes are not included. Houston notes this pair once while the conflict \
    persists, and again only if it recurs after merging clean.";

fn describe(side: &Side) -> String {
    let head: String = side.head.chars().take(10).collect();
    match &side.path {
        Some(path) => format!("{} ({head}, worktree {path})", side.branch),
        None => format!("{} ({head})", side.branch),
    }
}

fn file_lines(files: &[String], limit: usize) -> String {
    let mut lines = String::new();
    for file in files.iter().take(limit) {
        lines.push_str("\n- ");
        lines.push_str(file);
    }
    if files.len() > limit {
        lines.push_str(&format!("\n- and {} more", files.len() - limit));
    }
    lines
}

fn conflict_note(pair: &Pair, files: &[String]) -> (String, String) {
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
        body.push_str(&file_lines(files, MAX_NOTED_FILES));
    }
    body.push_str(NOTE_FOOTER);
    (summary, body)
}

/// One recipient's notes for a tick's new conflicts: a branch in several sibling conflicts
/// is one note naming its partners, the branch in the most pairs first. Base pairs and lone
/// pairs keep the per-pair note.
fn grouped_notes(fresh: &[&(Pair, Vec<String>)]) -> Vec<(String, String)> {
    let mut notes = Vec::new();
    let mut siblings: Vec<&(Pair, Vec<String>)> = Vec::new();
    for entry in fresh {
        if entry.0.theirs.path.is_none() {
            notes.push(conflict_note(&entry.0, &entry.1));
        } else {
            siblings.push(entry);
        }
    }
    while !siblings.is_empty() {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for (pair, _) in &siblings {
            *counts.entry(&pair.ours.branch).or_default() += 1;
            *counts.entry(&pair.theirs.branch).or_default() += 1;
        }
        let (anchor, count) = counts
            .into_iter()
            .max_by_key(|(name, count)| (*count, std::cmp::Reverse(*name)))
            .expect("a pair names two branches");
        let anchor = anchor.to_string();
        let (members, rest): (Vec<_>, Vec<_>) = siblings
            .into_iter()
            .partition(|(pair, _)| pair.ours.branch == anchor || pair.theirs.branch == anchor);
        siblings = rest;
        if count == 1 {
            notes.extend(
                members
                    .iter()
                    .map(|(pair, files)| conflict_note(pair, files)),
            );
            continue;
        }
        let mut body = String::new();
        let mut anchor_side = None;
        for (pair, files) in &members {
            let (own, partner) = if pair.ours.branch == anchor {
                (&pair.ours, &pair.theirs)
            } else {
                (&pair.theirs, &pair.ours)
            };
            anchor_side.get_or_insert(own);
            body.push_str(&format!(
                "\n- {}: {} file{}",
                describe(partner),
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            ));
            if !files.is_empty() {
                body.push(':');
                body.push_str(&file_lines(files, MAX_FILES_PER_PARTNER).replace('\n', "\n  "));
            }
        }
        let anchor_side = anchor_side.expect("a group has a member");
        notes.push((
            format!("Predicted conflict: {anchor} with {count} other branches"),
            format!(
                "Merging {} with each of these branches would conflict:{body}{NOTE_FOOTER}",
                describe(anchor_side)
            ),
        ));
    }
    notes
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
        let pairs = resolve_pairs(Path::new("/r/.git"), &[&a, &b, &c], &heads, &|_| true);
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
                base_head: None,
            },
            theirs: Side {
                branch: "houston/b".into(),
                head: "fedcba9876543210".into(),
                path: Some("/r/b".into()),
                base_head: None,
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

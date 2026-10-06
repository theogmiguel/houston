# Changes

## Opening source control

Open Source control from the top bar or use the `g` shortcut outside terminal typing
mode. It opens beside your grid as the inspector of the focused pane, with Changes, PR
and Files tabs; a pane that has started child panes also offers their Overview. The
header names the pane, its checkout and how many commits it is ahead. Drag its left
edge to resize it; double-click the edge to reset the width. Closing the panel
leaves your terminal sessions running.

The panel follows the selected workspace. In All workspaces, it follows the
focused terminal's workspace. Check the workspace in the header before acting.

## What Changes shows

Changes lists modified, staged, added,
deleted, renamed and untracked files, and shows how far your branch is ahead of or
behind its upstream. A scope toggle switches between "Working tree" (your uncommitted
changes) and "Branch vs `<base>`" (everything your branch has that the base branch
doesn't). A repository with no upstream, or a detached HEAD, is shown as such rather
than left blank. Below the files, On this branch lists the commits your upstream does
not have yet, newest first; View all expands the list.

## Reviewing a diff

Selecting a file shows its diff. Diffs are capped in size; a patch beyond the cap is
truncated rather than left to grow the pane without bound. Certain path patterns (things
that look like secrets — for example anything with "secrets" in the name) are excluded
or redacted from the diff Houston builds for review, on the same rules whether the diff
is read by you or handed to an agent for review.

Review with agent opens a picker with the six engines Houston can spawn — Claude Code,
Codex, Cursor Agent, Antigravity, OpenCode or Grok — and starts the one you choose in a
new pane, with the prepared diff as its brief. Nothing is sent until you press Start
review; Cancel sends nothing at all.

## Staging, committing, pushing

Changes can stage and unstage individual files or all of them, commit the staged set
with a message you write, and push. Push is its own action, independent of committing —
a branch that is already ahead with a clean working tree still needs a way to push, so it
does not require you to make a new commit first. Houston also offers "Commit & push" in
one step when you want both. None of this happens on its own: every commit and push is a
button you click, with the message you typed.

A branch with no upstream is published by the push itself, which sets the upstream as it
goes: a brand-new branch does not send you to a terminal first.

## Discarding changes

Discarding a tracked file's changes, or deleting an untracked file, asks for confirmation
first and says plainly that it cannot be undone — deleting an untracked file is worded as
a delete, since git has no copy to fall back to.

## Branches, worktrees and checkpoints

The Git tools menu in the Changes strip opens three lists, each acting on the selected
workspace:

- **Branches** lists local and remote-tracking branches and marks the default. Switch to
  one, create one off any base (and switch to it in the same step), rename one, or delete
  one. Deleting a branch whose work is not merged into the current branch asks first and
  says what would be lost. A branch that another worktree has checked out says so instead
  of offering the switch.
- **Worktrees** adds a worktree beside the repository (Houston names its branch
  `houston/<name>`), removes one — a worktree with uncommitted changes asks first — and
  prunes registrations whose directory is already gone. "Add as workspace" turns a
  worktree into a workspace you can open panes in.
- **Checkpoints** captures the working tree and staging area as a snapshot you can come
  back to. Inspect shows what a checkpoint would change; Restore replaces the current
  files and staging with the snapshot (your commits are not moved, and anything newer
  than the snapshot is lost unless it is committed); Delete removes the snapshot and
  touches no file. A checkpoint is stored as a hidden git ref in the repository itself.

### Cleaning up worktrees

Worktrees Houston created — from this dialog, or for an agent through `pane_spawn`'s
`worktree` — are listed under **Created by Houston** with their size and what, if
anything, keeps each one. A worktree you made yourself is never removed by Houston.

One can go when it is still on the branch Houston created it with, its PR is merged or
its commits are integrated into the branch it came from, it has no uncommitted or
untracked files, it has no ignored file that a build would not recreate, no commit is
missing from the remote, no pane is working inside it, and the grace period has passed.
**Check** finds out
which worktrees can go and measures them. **Clean now** lists only Ready worktrees and
the space they free, and asks once; it then removes only the ones it listed, together
with their branches.

Removing a worktree deletes its ignored files too. A directory that is ignored as a whole,
such as `target/` or `node_modules/`, is treated as build output and goes with it. A
single ignored file, such as `.env` or a local settings file, keeps the worktree until
you move or delete it.

Otherwise the row says why it stays: the worktree was switched to another branch,
uncommitted or ignored files, commits outside the PR, the PR's head could not be
fetched, a pane inside it, the grace period, a PR that is open or was closed without
merging, no PR, `gh` unavailable, or a removal that failed. Without `gh`, a branch whose
upstream was deleted, as of your own last `git fetch --prune`, reads "probably
integrated": Houston cannot tell a merge from a closed PR, so it offers **Remove** and
leaves the choice to you.

To remove merged or idle worktrees on its own, turn on **Remove worktrees automatically**
under Settings ▸ Workspaces (off by default). Merged or integrated worktrees are removed
after **Grace after merge** (1 to 720 hours, 24 by default); idle worktrees are removed
after **Remove idle worktrees after** (1 to 365 days, 30 by default). Idle cleanup keeps
the branch. The daemon then checks at start and every 6 hours; while the setting is off
it checks only when you press **Check** or **Clean now**.

Each check runs `gh pr view` once per recorded worktree, which sends that branch's name
to GitHub through your own `gh`. When the PR's head commit is not in your repository, it
also fetches that one ref, `refs/pull/<number>/head`, from the remote whose URL is the
PR's repository, using your own git credentials. Without `gh`, a check sends nothing and
fetches nothing.

### Idle worktrees

Clean worktrees with no unpushed commits or active panes are marked **Stale** halfway to
the idle-removal threshold. Each Stale row can be removed early; its confirmation keeps
the branch. When **Remove worktrees automatically** is on, Houston removes idle worktrees
after the threshold and keeps their branches. Set the threshold in Settings → Workspaces
→ **Remove idle worktrees after** (1–365 days; default 30). Worktrees with uncommitted
changes, unpushed commits or a pane inside them stay.

## Fetching and pulling

Fetch brings remote-tracking branches up to date and reports what changed. Pull is
fast-forward only: it refuses a branch with no upstream, and it refuses a divergence
rather than creating a merge commit behind your back.

## Pull requests

The PR tab shows the branch's GitHub PR, its checks and its open review comments.
It requires the GitHub CLI (`gh`) to be installed and signed in. If no PR exists,
you can create one for the branch or link an existing PR by number. Reply to a comment
in place or send it to the orchestrator pane. Details holds the title and description
editor, reviewers and labels, resolving discussions and submitting a review. Choose the
merge method from the merge button's menu. Merge when green turns on GitHub auto-merge,
which merges once the repository's required checks and reviews pass.

Refresh before reviewing the latest state. Merge is available only when the PR is
ready; an unavailable action explains what blocks it. If new commits arrive after
you review the PR, refresh and review them before trying to merge again.

Push remains independent of GitHub: it needs a configured git remote and credentials,
not the GitHub CLI.

# Changes

## Opening source control

Open Source control from the top bar or use the `g` shortcut outside terminal typing
mode. It opens beside your grid, with Changes and Pull request tabs. Drag its left
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
than left blank.

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

## Fetching and pulling

Fetch brings remote-tracking branches up to date and reports what changed. Pull is
fast-forward only: it refuses a branch with no upstream, and it refuses a divergence
rather than creating a merge commit behind your back.

## Writing with AI

The sparkles control beside the commit message writes one from the staged diff, and
"Create PR with AI" writes a title and body from the branch's commits. Both put the text
in the same editable control you type in, and nothing is committed or opened until you
accept it. They run on the Writer role — pick its engine and model under Settings →
Houston's own agents → Write with AI — on your own account.

## Pull requests

The Pull request tab shows the branch's GitHub PR, its checks, reviews and comments.
It requires the GitHub CLI (`gh`) to be installed and signed in. If no PR exists,
you can create one for the branch or link an existing PR by number.

Refresh before reviewing the latest state. Merge is available only when the PR is
ready; an unavailable action explains what blocks it. If new commits arrive after
you review the PR, refresh and review them before trying to merge again.

Push remains independent of GitHub: it needs a configured git remote and credentials,
not the GitHub CLI.

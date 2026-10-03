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

### Cleaning up merged worktrees

Worktrees Houston created — from this dialog, or for an agent through `pane_spawn`'s
`worktree` — are listed under **Created by Houston** with their size and what, if
anything, keeps each one. A worktree you made yourself is never removed by Houston.

One can go when it is still on the branch Houston created it with, that branch's PR is
merged on GitHub, it has no uncommitted or untracked files, it has no ignored file that
a build would not recreate, its branch has no commit the PR does not contain, no pane is
working inside it, and the grace period after the merge has passed. **Check** finds out
which worktrees can go and measures them. **Clean now** lists those worktrees and the
space they free, and asks once; it then removes only the ones it listed, together with
their branches.

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

To remove merged worktrees on its own, turn on **Remove merged worktrees automatically**
under Settings ▸ Workspaces (off by default) and set **Grace after merge** (1 to 720
hours, 24 by default). The daemon then checks at start and every 6 hours; while the
setting is off it checks only when you press **Check** or **Clean now**.

Each check runs `gh pr view` once per recorded worktree, which sends that branch's name
to GitHub through your own `gh`. When the PR's head commit is not in your repository, it
also fetches that one ref, `refs/pull/<number>/head`, from the remote whose URL is the
PR's repository, using your own git credentials. Without `gh`, a check sends nothing and
fetches nothing.

Worktrees of a Bitbucket repository are not checked yet: they stay listed with `gh`
unavailable, and a check sends nothing to Bitbucket for them.

## Fetching and pulling

Fetch brings remote-tracking branches up to date and reports what changed. Pull is
fast-forward only: it refuses a branch with no upstream, and it refuses a divergence
rather than creating a merge commit behind your back.

## Pull requests

The Pull request tab shows the branch's GitHub PR, its checks, reviews and comments.
It requires the GitHub CLI (`gh`) to be installed and signed in. If no PR exists,
you can create one for the branch or link an existing PR by number.

Refresh before reviewing the latest state. Merge is available only when the PR is
ready; an unavailable action explains what blocks it. If new commits arrive after
you review the PR, refresh and review them before trying to merge again.

Push remains independent of GitHub: it needs a configured git remote and credentials,
not the GitHub CLI.

### Bitbucket Cloud

A workspace whose git remote is on `bitbucket.org` can show its pull request in the same
tab, read-only: title, state, author, branches, changed lines and files, commits, build
statuses as checks, approvals and change requests, comments and inline threads. Houston
does not create, comment on, review or merge Bitbucket pull requests; **Open on
Bitbucket** opens the pull request's page instead. Linking a pull request by number and
unlinking it work as they do for GitHub. Bitbucket Data Center and Server are not
supported.

To turn it on:

1. In your Atlassian account settings, create an API token with the
   `read:pullrequest:bitbucket` and `read:repository:bitbucket` scopes. Bitbucket makes
   the token expire within a year; create a new one when it does.
2. In Settings ▸ Accounts ▸ Bitbucket Cloud, enter your Atlassian account e-mail and the
   token, and turn on **Read Bitbucket Cloud pull requests** (off by default).

The token is stored in your OS keychain, never in Houston's settings or logs, and is not
shown again. **Disconnect** removes it from the keychain. If the keychain is unavailable,
the tab says so and Houston stores nothing.

While the setting is off, or no token is stored, Houston sends nothing to Bitbucket.
When it is on, Houston contacts `api.bitbucket.org` over HTTPS only while the Pull
request tab is open, when you press Refresh and when you link a pull request by number;
never in the background. Each read sends:

- your Atlassian e-mail and API token, as the request's `Authorization` header;
- a `User-Agent` header naming Houston and its version (`houston/<version>`);
- the workspace and repository names, and the pull request number;
- paging parameters (`pagelen` and Bitbucket's page cursor);
- to find the branch's own pull request, the local branch name, with the pull request
  states searched, the sort order and the response fields wanted.

It sends no file content, diff or agent transcript. One refresh makes about six
requests. Bitbucket allows 1,000 API requests per hour per user, shared with your other
tools that use the same account; when the limit is reached, the tab says so and Houston
does not retry.

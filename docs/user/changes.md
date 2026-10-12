# Changes

## Opening Changes and Pull request

Open the side panel and choose **Changes** or **Pull request**, or press the prefix key followed
by `D` or `P` in a terminal. Changes shows working tree changes for the panel's checkout;
Pull request shows the current branch's PR summary and details. Drag the panel edge to
resize it; double-click the edge to reset the width. Closing the panel leaves your
terminal sessions running.

The panel uses the selected workspace's checkout. In **All workspaces**, it follows the
focused terminal's checkout. Reviewing an agent's work can target that run's worktree.
Check the checkout in the header before acting.

## Comparing changes

Changes lists modified, staged, added,
deleted, renamed and untracked files, and shows how far your branch is ahead of or
behind its upstream. Choose **Uncommitted N** for local working-tree changes or **vs <base> N** for the
branch comparison. Each number counts distinct changed files in that comparison.
The Changes tab continues to count uncommitted files when you review the branch diff.
A repository with no upstream, or a detached HEAD, is shown as such rather
than left blank. Below the files, On this branch lists the commits your upstream does
not have yet, newest first; View all expands the list.

## Reviewing a diff

Selecting a file shows its diff. Diffs are capped in size; a patch beyond the cap is
truncated rather than left to grow the pane without bound. Certain path patterns (things
that look like secrets — for example anything with "secrets" in the name) are excluded
or redacted from the diff Houston builds for review, on the same rules whether the diff
is read by you or handed to an agent for review. Filename rules also apply to paths
containing tabs or non-ASCII characters, and to both names of a renamed file.
Patches whose file names cannot be safely identified are excluded from review and
checkpoint inspection.

Each patch retains at most 512 KiB. Combined untracked-file previews stop after
1,024 files or the patch size limit. A Git command that produces more than 8 MiB
of output is refused with an error, and commands have a two-minute deadline.
If a commit, push or other mutation times out, inspect the repository and remote
before retrying: part of the operation may already have completed.

For a larger review, maximize Changes to keep the file list and diff alongside one
another. Press `/` to focus the filename filter, then use `J` and `K` to move through
matching files when you are not typing into a field. **Unified** and **Split** choose the
diff layout. Press **Esc** to restore the panel's previous width.

Review with agent opens a picker with the seven engines Houston can spawn — Claude Code,
Codex, Cursor Agent, Antigravity, OpenCode, Grok or ZCode — and starts the one you choose in a
new pane, with the prepared diff as its brief. Nothing is sent until you press Start
review; Cancel sends nothing at all.

## Pull requests

Open **Pull requests** from the rail or press the prefix key followed by `R` to browse
requests for the repository. Filter by state or involvement, search by title, branch,
author, number or `label:bug`, and sort the results. Open a request to review its status,
author, source and target branches, and recent activity. Ctrl-click a PR number to open
it on GitHub.

Use **Summary**, **Timeline** and **Files** to read the description, review discussions
and inspect changed files. Timeline and Files report their item counts. Reply to review
comments, resolve discussions, submit a review or send a comment to the orchestrator
pane. Details also let you edit the title and description, reviewers and labels.

Merge readiness reports checks, required reviews and conflicts with the base branch.
Choose squash, merge commit or rebase, and review the stated consequence before
merging: squash combines the request's commits into one. Actions remain subject to
GitHub permissions and repository requirements; unavailable actions explain the reason.

For a failing check, **Log** opens its available log tail and **Fix with agent** sends
the failure context to a selected agent. Checks without an available Actions log say so.
**Merge when green** requests GitHub auto-merge after the required checks and reviews
pass. Refresh before reviewing the latest state or retrying a blocked merge.

The additional actions copy `gh pr checkout <number>` or the PR link, update the branch
from its base, convert it to a draft, or close it after confirmation. **Unlink from this
pane** removes the local association without closing the request on GitHub. Closed
requests can be reopened when permitted. If no PR exists, create one for the branch or
link an existing request by number.

To open Changes automatically after the focused agent stops, enable **Open diff when an agent
stops** in Settings ▸ Appearance ▸ Panels. Houston opens it when the workspace has changes
and you have not interacted with the panel after the agent's turn.

## Staging, committing, pushing

Changes can stage and unstage individual files or all of them, commit the staged set
with a message you write, and push. Push is its own action, independent of committing —
a branch that is already ahead with a clean working tree still needs a way to push, so it
does not require you to make a new commit first. Houston also offers "Commit & push" in
one step when you want both. None of this happens on its own: every commit and push is a
button you click, with the message you typed.

Before committing, stage at least one file and write a nonempty message. When commit is
unavailable, Changes reports the reason, including **Stage files to commit**, **Write a
message to commit**, or an unavailable connection. **Amend** replaces the most recent
commit using the staged changes and message. It is refused when that commit is already
in the branch's upstream; amend only unpublished work.

A branch with no upstream is published by the push itself, which sets the upstream as it
goes: a brand-new branch does not send you to a terminal first.

## Discarding changes

Discarding a tracked file's changes, or deleting an untracked file, asks for confirmation
first and says plainly that it cannot be undone — deleting an untracked file is worded as
a delete, since git has no copy to fall back to.

## Branches, worktrees and checkpoints

Open the current branch name to search or switch branches. For a new name, **Enter**
creates and switches to a branch from the repository's default branch, falling back to
HEAD when no base is known. **Ctrl+Enter** creates a worktree and opens a Shell pane
there. Worktree branches use `houston/<slug>`; names are normalized to lowercase ASCII
letters, digits, hyphens and underscores. If a branch already belongs to a worktree,
choosing it focuses its known pane or opens a Shell in that checkout.

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

One can go when it is still on the branch Houston created it with, its work is done, it
has no uncommitted or untracked files, it has no ignored file that a build would not
recreate, no pane is working inside it, and the grace period has passed. Its work is done
when its PR is merged with no commit outside the PR, or, for a branch with no PR, when
every commit has a patch-equivalent in the branch it was created from (or in the default
branch, for worktrees recorded before Houston kept that base). Squash and cherry-pick
integration count. For a branch with no PR the grace runs from the first check that finds
it integrated. **Check** finds out which worktrees can go and measures them. **Clean now**
lists only Ready worktrees and the space they free, and asks once; it then removes only the
ones it listed, together with their branches.

A worktree with no evidence that its work is done — no PR, a PR still open, or commits not
yet integrated — becomes **Stale** once it is clean, every commit is on a remote, no pane
is inside it, and nobody has touched it for half of **Remove idle worktrees after**. A
Stale row shows how long it has been idle and when it will be removed; **Remove…** removes
it early. Removing a stale worktree keeps its branch.

Removing a worktree deletes its ignored files too. A directory that is ignored as a whole,
such as `target/` or `node_modules/`, is treated as build output and goes with it. A
single ignored file, such as `.env` or a local settings file, keeps the worktree until
you move or delete it.

Otherwise the row says why it stays: the worktree was switched to another branch,
uncommitted or ignored files, commits outside the PR, commits not yet in the branch it
came from, the PR's head could not be fetched, a pane inside it, the grace period, a PR
that is open or was closed without merging, no PR, `gh` unavailable, or a removal that
failed. Without `gh`, a branch whose
upstream was deleted, as of your own last `git fetch --prune`, reads "probably
integrated": Houston cannot tell a merge from a closed PR, so it offers **Remove** and
leaves the choice to you.

To remove merged or idle worktrees on its own, turn on **Remove worktrees automatically**
under Settings ▸ Workspaces (off by default). Merged or integrated worktrees are removed
after **Grace after merge** (1 to 720 hours, 24 by default); idle worktrees are removed
after **Remove idle worktrees after** (1 to 365 days, 30 by default). Idle cleanup keeps
the branch. The daemon then checks at start, every 6 hours, and when a pane that created a
worktree closes; while the setting is off it removes nothing on its own.

Each check runs `gh pr view` once per recorded worktree, which sends that branch's name
to GitHub through your own `gh`. When the PR's head commit is not in your repository, it
also fetches that one ref, `refs/pull/<number>/head`, from the remote whose URL is the
PR's repository, using your own git credentials. Without `gh`, a check sends nothing and
fetches nothing.

## Fetching and pulling

Fetch brings remote-tracking branches up to date and reports what changed. Pull is
fast-forward only: it refuses a branch with no upstream, and it refuses a divergence
rather than creating a merge commit behind your back.

Push remains independent of GitHub: it needs a configured git remote and credentials,
not the GitHub CLI.

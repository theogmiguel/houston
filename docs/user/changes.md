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
not have yet, newest first; View all expands the list. Added and deleted line counts
follow the staged and unstaged versions separately, including renamed files and
filenames with non-ASCII characters or control characters. Binary changes have no
line counts.

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

Review with agent opens a picker with the five engines Houston can spawn — Claude Code,
Codex, Antigravity, OpenCode or ZCode — and starts the one you choose in a
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

**Hide resolved** and **Hide bots** filter a pull request's discussions and comments; each
names how many items it applies to, and hidden items collapse to one line with **Show**.
A comment counts as a bot's when GitHub reports its author as an app. A discussion counts as
a bot's only until a person replies in it. Both toggles are off by default, and the choice
is remembered on this device for every pull request. The Timeline already omits resolved
discussions, so it offers only **Hide bots**.

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

## Merge queue

The **Merge queue** view on the Pull requests page, next to **Requests**, lists the open pull
requests waiting to merge in the selected workspace, in the order they merge. Agents add their
pull requests with `pane_pr_enqueue`; you can add one with **Add to merge queue** in its merge
box or from the command palette (**Add to merge queue** acts on the focused pane's pull
request, and **Open merge queue** opens the view). The queue needs a GitHub remote; a
workspace without one, or a pull request from a fork or another repository, is refused.

Entries merge first in, first out. An entry enqueued with `depends_on` waits behind the pull
request it depends on. Each row shows its place, one status and one reason. Select a row to
see its gates:

- **Mergeable**: GitHub's merge requirements, checks and conflicts allow the merge.
- **No unresolved review threads**.
- **Reviewer passed**: for a task Slice, the newest reviewer verdict is pass. Other pull
  requests skip this gate.
- **Verification**: when the workspace has a verification command, the head passed it on the
  current base (see below). Without a command this gate does not apply.

Houston re-reads queued pull requests once a minute, sharing the read with pull request
watches. Until a pull request has been read, or when a read fails, it is Blocked. A pull
request merged or closed outside the queue leaves it.

Only the first entry in line can be merged from the queue. Its **Merge** merges the exact
commit shown, with the repository's allowed merge method (squash when allowed); if the head
moved, the base moved or a gate fails, the merge is refused and nothing merges. If GitHub
refuses the method, its message is shown unchanged. To merge any other queued pull request,
**Dequeue** it first, then merge it from its merge box. After a merge the next entry moves up,
the merge appears under **Today**, and the worktree cleanup check runs if it is turned on. A
queue holds at most 32 entries.

### Verification and merging on its own

Set the queue up in **Settings ▸ Workspaces ▸ Merge queue**:

- **Verification command**: the command that proves a pull request works, such as
  `cargo nextest run`. It is stored in Houston, never read from the repository, so a pull
  request cannot change its own test.
- **Time limit**: a run past it counts as failed. 1 to 240 minutes; 30 by default.
- **Merge when verified**: off by default. It cannot be turned on while the command is empty.
- **Queue**: shows whether the queue is paused, with **Pause** and **Resume**.

With a command set, Houston verifies the first entry in line once its gates pass; entries
behind a blocked first entry wait for it. It fetches the base and
the pull request's branch from the remote, rebases the branch onto the latest base in a
temporary worktree under Houston's state directory, runs the command there at lowered priority,
and removes the worktree. One verification runs at a time on this machine, across every
workspace; other entries show **Waiting for a slot**. The head shows **Verifying** with the
time it has run against the limit. A verification holds until the head or the base moves.

What happens next depends on the policy:

- **Off**: the head shows **Ready**, verified on the base it names. Its **Merge** pushes the
  verified commit to the branch and merges exactly that commit.
- **On**: Houston pushes and merges the verified head on its own, then verifies the next
  entry. The merge box shows the queue state instead of **Merge**; **Merge now, skipping the
  queue** stays in its overflow menu.

**What Houston pushes, and when.** Only when it lands a verified head, and only to a
`houston/*` branch that Houston itself created for a worktree. It pushes the rebased commit
with a lease on the commit it verified, so it never overwrites a commit someone pushed
meanwhile; it never pushes to the base or the default branch. Fetches and pushes use your git
remote and credentials; merges, reads, reverts, retargets and the hand-off to GitHub's merge
queue or auto-merge (see below) use `gh`. Nothing else leaves the machine.

**When verification fails.** A rebase conflict names the conflicting files; a failing or
timed-out command shows the last lines of its output. If the pane that enqueued the pull
request, or an agent pane in its worktree, is still open, it gets one message with that
detail and the entry shows **Fixing**. Otherwise the entry is **Parked** under its own group
with the reason, and the rail's **Pull requests** item counts it. Either way the queue moves
on. Pushing a new commit to the branch puts it back in line; **Retry** does so for the same
commit. **Hand to a new pane** asks which agent to open, with the workspace's default agent
from Settings ▸ Tasks preselected, then opens it in the pull request's worktree with the
failure as its prompt. Houston never opens a pane on its own. If GitHub's checks fail on a
commit Houston pushed, the entry leaves the line the same way.

### Stacked pull requests

A pull request built on another one's branch, enqueued with `depends_on` naming it, waits
behind it. Once the first merges, usually by squash, the second's branch still carries the
first one's original commits. Houston restacks it at its next verification: it finds the
newest head of the first pull request that the second one contains, replays only the second
one's own commits onto the base, and verifies that. When it lands, the restacked commit is
pushed with the same lease, and a pull request that still targets the first one's branch is
moved to the base on GitHub first. **Today** lists the restack and the retarget. A chain of
three or more restacks one pull request at a time, as each lands.

If the branch carries the first pull request's commits but none of the heads Houston saw for
it, for example because that branch was rewritten before Houston read it, Houston does not
guess: the entry fails with that reason, and you rebase the branch yourself. A conflict while
restacking is handled like any other conflict. A `depends_on` that only orders two
independent branches needs no restack, and GitHub's native stacks are left to GitHub.

### Repositories with GitHub's merge queue or auto-merge

Houston's gates and verification always run first. Then:

- **GitHub's merge queue** on the base branch: Houston adds the verified pull request to
  GitHub's merge queue instead of merging it. Nothing is pushed for it, because GitHub's merge
  group tests the real merge; only a restacked branch is pushed first.
- **Auto-merge** allowed with required checks on the base: Houston pushes the verified commit
  and turns auto-merge on for exactly that commit, with the repository's merge method.

The queue view's policy line names the path, such as **Hands off to GitHub's merge queue**.
While GitHub holds the pull request it shows **Watching**, stays first in line, and its detail
names the commit GitHub has. When GitHub merges it, Houston fetches, tells the other panes the
base moved and logs the merge, as for its own merges. When GitHub removes it from its merge
queue, turns auto-merge off or a check fails, the entry fails with GitHub's reason. **Dequeue**
and **Pause** take the pull request back from GitHub first; a paused entry loses its place in
GitHub's merge queue and is added again when you resume. Houston learns which path applies
from the pull request reads it already makes. If GitHub hides that from your account, Houston
merges itself; if GitHub then refuses because the branch requires its merge queue, the entry
fails with GitHub's message and later landings use the merge queue.

**Pause and revert.** **Pause** on the queue view or in Settings, or **Pause merge queue** in
the command palette, stops pushes and merges at once; entries keep their place and any
verification they hold. **Pause all** in Settings pauses every workspace's queue on this
machine. Every push and merge the queue makes is logged with the old and new
commits under **Merge history** in Settings. **Revert** on a merge under **Today** opens a
revert pull request on GitHub; Houston never pushes to the base to undo a merge.

When you come back after the queue merged or parked pull requests on its own, one notice at
the top of the workspace says how many, with **Review** to open the queue.

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

Open the current branch name to search or switch branches. The current branch stays
first; other branches are ordered by their most recent commit, with upstream ahead/behind
counts and commit age when available. Use arrow keys to choose, **Enter** to switch,
and **Esc** to close. For a new name, **Enter**
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
  prunes registrations whose directory is already gone. A new worktree receives the ignored
  files listed in `.worktreeinclude` (see [orchestration](orchestration.md)). "Add as workspace" turns a
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
you move or delete it, unless it is byte for byte the file at the same path in your
checkout: a `.worktreeinclude` copy you have not changed can be recreated, so it does not
keep the worktree. A copy you edited does.

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

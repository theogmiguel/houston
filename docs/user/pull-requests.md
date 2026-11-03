# Pull requests

Open **Pull requests** from the sidebar or press `Ctrl+Shift+K` in a thread to copy the
current request number. The page has two views: **Requests** and **Merge queue**.

## Requests

Requests lists the pull requests of the projects in scope. Search by title, branch, author,
number or `label:bug`; filter by state, involvement and draft; sort the result. A row shows
its project, checks and review state.

Open a request to read it in the right panel:

- **Summary** — description, branches, reviewers and merge readiness.
- **Timeline** — comments and review activity.
- **Files** — the diff; each file carries a **Viewed** toggle. A viewed file that changes
  after a new push reads unviewed and shows **Changed since viewed**.
- **Checks** — checks with their state; a failing check can show its available log.
- **Queue** — appears when the request is in the merge queue; see below.

**Hide resolved** and **Hide bots** filter discussions; each says how many items it
affects. A comment counts as a bot's when GitHub reports its author as an app. A discussion
counts as a bot's until a person replies.

The merge box offers the methods the repository allows: squash, merge commit or rebase. It
reports checks, required reviews and conflicts with the base branch. **Enable auto-merge**
asks GitHub to merge once the required checks and reviews pass. **Copy link**, **Convert to
draft** / **Ready for review**, **Reopen** and **Close** are in the request's menu.

The thread's **Pull request** tab lists requests linked to the thread. **Link pull request**
links one by URL or number, and **Unlink from thread** removes the association without
closing the request on the host. Create a new request from the Git menu's create action.

## Merge queue

**Merge queue** lists the open pull requests waiting to merge in the selected project, in
the order they merge. Add a request with **Add to merge queue** in its menu or from the
command palette; agents add theirs with the server's merge-queue tool. A request from a fork
or another repository, or a project without a GitHub remote, is refused.

Entries merge first in, first out. An entry added with a dependency waits behind the one it
depends on. The view groups them as **In line**, **Parked** and **Today**. Each row shows
its place, status and one reason. Select a row for its gates:

- **Mergeable** — GitHub's requirements, checks and conflicts allow the merge.
- **No unresolved review threads**.
- **Reviewer passed** — for a task slice, the newest reviewer verdict is a pass. Other
  requests skip this gate.
- **Verification** — when the project has a verification command, the head passed it on the
  current base. Without a command this gate does not apply.

Houston re-reads queued requests once a minute. Until a request has been read, or when a
read fails, it is **Blocked**. A request merged or closed outside the queue leaves it.

The queue works on the first entry in line that is not blocked. A blocked entry keeps its
place while the entries behind it go ahead; when it clears it goes first again. A request
that depends on a blocked one waits with it. While Houston has no answer for an entry — it
has not been read, a read failed, checks are still running, or GitHub is still computing
mergeability — the whole queue waits and later entries name it as their reason.

Only the entry that goes next can be merged from the queue. Its **Merge head** merges the
exact commit shown, with the repository's allowed method (squash when allowed). If the head
moved, the base moved or a gate fails, nothing merges. To merge another queued request,
**Dequeue** it first, then merge it from its merge box. A queue holds at most 32 entries.

### Verification and automatic merging

Set the queue up in **Settings ▸ Projects ▸ Merge queue**:

- **Verification command** — the command that proves a request works, such as
  `cargo nextest run`. It is stored in Houston, never read from the repository, so a request
  cannot change its own test. At most 1,024 bytes.
- **Time limit** — a run past it counts as failed. 1 to 240 minutes.
- **Merge when verified** — off by default. It cannot be turned on while the command is
  empty.
- **Queue** — shows whether the queue is paused, with **Pause** and **Resume**.
- **Every project** — pauses every project's queue on this machine.

With a command set, Houston verifies the entry that goes next in a scratch worktree at
lowered priority and removes the worktree afterwards. One verification runs at a time on
this machine; other entries show **Waiting for a slot**. A verification holds until the head
or the base moves.

When verification fails, a rebase conflict names the conflicting files and a failing or
timed-out command shows the last lines of its output. A request whose thread is still open
gets one message with that detail and shows **Fixing**. Otherwise it is **Parked** with its
reason. Pushing a new commit to the branch puts it back in line; **Retry** does the same for
the same commit. **Hand to a new thread** opens a thread in the request's worktree with the
failure as its first message.

**Pause** on the queue view or in Settings, or the command palette's pause command, stops
pushes and merges at once; entries keep their place. Every push and merge the queue makes is
logged under **Merge history** in Settings. **Revert** on a merge opens a revert pull request
on GitHub; Houston never pushes to the base to undo a merge.

When the queue merged or parked requests on its own, one notice at the top says how many,
with **Acknowledge** to dismiss it.

## What leaves the machine

Reads, merges, reviews and reverts use your Git credentials and the repository's host
through the source control integration configured in **Settings ▸ Source control**. Nothing
is sent to Houston.

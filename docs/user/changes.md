# Changes

**Changes** is the Git surface for a thread's checkout. Open it from the right panel's
**Diff** tab, from the thread header, or with `Ctrl+D`. Drag the panel edge to resize it;
double-click the edge to reset the width.

## Comparing changes

Changes lists modified, staged, added, deleted, renamed and untracked files and shows how
far the branch is ahead of or behind its upstream. A repository with no upstream, or a
detached HEAD, says so rather than showing an empty state.

Choose a file to see its diff. Diffs are capped in size and truncate rather than growing
without bound. Paths that look like secrets are excluded or redacted, for you and for an
agent asked to review the diff.

**Split view** in the diff menu switches between stacked and side-by-side layout; the default
is set in **Settings ▸ Diffs & pull requests**. Press `/` to focus the filename filter,
then `J` and `K` to move through matching files while you are not typing in a field.

To find text in a diff, click into it and press `Ctrl+F`. The find strip counts matches;
**Enter** and **Shift+Enter** move between them, **Aa** matches case, and `Esc` closes it.
A count is marked **partial** when a patch was truncated at its size cap.

Each file in **Uncommitted** carries a **Viewed** checkbox. The mark belongs to the
checkout's branch: a new commit that touches the file, or an edit that changes it, clears
the mark and shows **Changed since viewed** until you mark the new content.

## Staging and committing

Stage and unstage individual files or all of them, then commit the staged set. The commit
dialog accepts a message; leave it empty to generate one. The Git menu's **Commit & push**
does both in one step. **Amend last commit…** rewrites the most recent commit and needs a
message; it is refused once that commit is on the branch's upstream.

Git actions in the Git menu cover **Commit & push**, **Push**, **Fetch** and creating a
pull request. Push refuses while the working tree is dirty, while the branch is behind its
upstream, or when the branch has no upstream and no remote. A new branch is published by
its first push.

Discarding a tracked file's changes, or deleting an untracked file, asks for confirmation
and says it cannot be undone. Untracked files are deleted, not restored.

## Branches, worktrees and stashes

**Branches and worktrees…** in the Git menu lists the checkout's local branches, worktrees
and stashes:

- **Branches** marks the current branch. Rename one in place; delete one, with a second
  confirmation when Git refuses because it is not merged.
- **Worktrees** lists the checkout's worktrees and prunes registrations whose directory is
  already gone.
- **Stashes** saves tracked changes with an optional message, restores one with **Pop**, or
  drops one after confirmation.

A new worktree copies the ignored files listed in `.worktreeinclude` and initialises its
submodules according to **Settings ▸ Worktrees**.

## Review with an agent

**Review with agent…** opens a new thread with the prepared diff in its composer. Nothing
is sent until you send that message.

When a merge, rebase or cherry-pick stops part-way, Changes shows a banner naming the
operation and its conflicted files. **Resolve with agent** opens a thread with the conflict
brief; the banner leaves once Git no longer reports the operation.

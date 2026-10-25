# Workspace transfer

A workspace transfer moves a workspace's Claude Code and Codex conversations, together with
its code state, from one computer to another in a single encrypted file. The conversations
resume on the other computer where they stopped. You carry the file yourself: Houston sends
nothing over the network, and there is no account or service involved.

Both computers must run the same operating system. Moving between Windows and Linux is not
supported yet.

## What the file contains

A `.houston-transfer` file is encrypted with the passphrase you choose at export
([age](https://age-encryption.org) passphrase encryption). Inside it:

- **Conversations.** The full transcript of each exported Claude Code and Codex pane, copied
  byte for byte, with Claude's per-conversation folder (subagent transcripts and stored
  tool results). A transcript contains everything the agent read and wrote, including file
  contents and command output.
- **Code state** of the workspace folder and of each Houston worktree a pane runs in: the
  branch and commit, a git bundle of the commits that no remote branch has, a binary diff of
  uncommitted changes to tracked files, and every untracked file that is not ignored.
  Untracked symbolic links are not carried and are listed after export.
- **Pane details:** each pane's name, provider, model, effort, approval mode and agent
  profile label, and the provider CLI versions.
- **Grids:** the workspace's grid layouts.

The file does not contain credentials, provider sign-in files, agent profile folders, MCP
secrets, Houston's database or Claude's file-history checkpoints. Because checkpoints stay
behind, `/rewind` on the other computer cannot restore edits made before the transfer.

Treat the file like the source code and conversations it holds. Anyone with the file and
the passphrase can read them.

## Exporting

1. Wait until every pane in the workspace has finished its turn. Export is refused while a
   pane is working, waiting for input or starting, and the message names each pane. A
   Claude Code or Codex pane that reports no status counts as busy: turn its status hooks
   on in **Settings ▸ Agents ▸ CLIs**, or close the pane.
2. Open the workspace's menu in the rail and choose **Export transfer…**.
3. Enter a passphrase of at least 12 characters twice, select **Export** and choose where
   to save the file. Houston adds the `.houston-transfer` extension when the name lacks it,
   and replaces an existing file only when you confirmed replacing that file in the save
   dialog.

Export is also refused while a file has staged content that differs from its working copy:
the transfer carries the working copy only. Stage or unstage such a file completely first.
Only one transfer of a workspace runs at a time.

Export includes Claude Code and Codex panes, including panes in Houston worktrees under
`.houston/worktrees/`. It leaves out shell panes, other providers, orchestrated child panes
and panes without a recorded conversation, and lists each with the reason. Worktrees that
the Changes panel creates live outside the workspace folder and are not carried in this
version: a pane running in one is listed as left out, and keeps running.

The file may be at most 200 MB after compression. A larger export is refused and lists the
largest files; push long unpushed history to the remote, or commit, ignore or delete large
untracked files, then export again.

Export stops the exported agents before it reads the code and conversations, so nothing
changes while they are packed. After a successful export, their panes show **Transferred**
with the time. If an export fails after stopping them, the panes stay stopped without the
mark; restart them to continue on this computer. Restarting such a pane is possible: it continues a separate
fork of the conversation and shows **Fork**.

## Importing

1. Move the file to the other computer.
2. Open it with Houston, or open a workspace's menu and choose **Import transfer…** and pick
   the file.
3. Enter the passphrase. Houston shows the panes, the panes that were left out, the source
   operating system and the CLI versions that wrote the conversations.
4. Confirm the workspace. An import started from a workspace's menu targets that workspace.
   An import of a file opened with Houston proposes the registered workspace whose git remote
   matches the exported one. Either way, you can choose another checkout of the same project.
5. If a pane used an agent profile that this computer does not have, choose a local profile
   or the default account for it.
6. Select **Import**.

Import restores the code before any pane starts: it adds the carried commits, checks out the
recorded branch (creating it, or moving it forward when it is behind), applies the
uncommitted changes and writes the untracked files. Worktrees are recreated under
`.houston/worktrees/`. The conversations are placed in the provider's folders (Claude's
`projects/` folder and Codex's `sessions/` folder of the effective profile), and the panes
resume with the conversation. When the project folder differs from the exporting
computer's, each resumed pane's prompt is prefilled with a note that the project moved; it
is sent with your first message.

Opening a file with the app works with the Windows installer and the Debian package, and on
Linux after `scripts/install-desktop.sh`. The AppImage registers no file type; use
**Import transfer…** there.

Workspaces inside a WSL environment cannot be exported or imported in this version.

## Refusals

Import checks everything it can before it changes anything. Each refusal names the problem,
the exact paths or values, and the steps that remove it. Import is refused when:

- the passphrase is wrong or the file is damaged;
- the file was written by a newer Houston with a format this version cannot read;
- the file comes from another operating system;
- a provider CLI on this computer is older than the one that wrote the conversations, or
  its version cannot be read;
- the target checkout has uncommitted changes;
- this computer lacks commits the carried state builds on (run `git fetch`, then import
  again);
- the recorded branch exists here with commits the file does not have, or is checked out
  in another folder;
- an untracked file in the transfer, or a file that its commits or uncommitted changes add,
  already exists here, including an ignored one such as a local `.env`; import never
  overwrites it;
- the carried uncommitted changes do not apply to their commit on this computer;
- a conversation in the file is already open in a pane on this computer, or another version
  of it exists in the provider's folder here;
- another transfer of the same workspace is running.

If import fails after it has started changing the workspace, it undoes every change: the
checkout returns to its branch and commit, created branches, worktrees and files are
removed, replaced conversations are put back and started panes are closed. The message
says the import was undone and names anything that could not be put back.

## Returning to the first computer

When you import a file on the computer that exported the same workspace, and its panes and
code have not changed since that export, Houston continues in place: it replaces the
exported code state with the returning one, writes the newer transcripts where the original
panes read them, and resumes those panes instead of opening new ones. The returning branch
must build on the exported commit.

This return is refused, and names what changed, when the workspace was edited after the
export or a transferred pane was restarted on this computer. Undo those changes, or close
the restarted pane, then import again, or import into another workspace.

import type { GitTools } from './useGitToolsSubscription'
import { BranchesDialog } from './BranchesDialog'
import { WorktreesDialog } from './WorktreesDialog'
import { CheckpointsDialog } from './CheckpointsDialog'

export interface GitToolsDialogsProps {
  open: 'branches' | 'worktrees' | 'checkpoints' | null
  dir: string | null
  tools: GitTools
  busy: boolean
  error: string | null
  fallbackBase: string | null
  onClose: () => void
  onAddWorkspace: (path: string) => void
}

// All four Git dialogs in one place so ChangesPane's render stays a layout and
// never a decision tree. Each dialog is a top-level component of its own.
export function GitToolsDialogs({
  open,
  dir,
  tools,
  busy,
  error,
  fallbackBase,
  onClose,
  onAddWorkspace
}: GitToolsDialogsProps): React.JSX.Element {
  return (
    <>
      {open === 'branches' && (
        <BranchesDialog
          branches={tools.branches}
          remotes={tools.remotes}
          defaultBranch={tools.defaultBranch ?? fallbackBase}
          truncated={tools.branchesTruncated}
          busy={busy}
          error={error}
          onClose={onClose}
          onRefresh={tools.refreshBranches}
          onCreate={(name, base, switchTo) => tools.createBranch(name, base, switchTo)}
          onSwitch={(name) => tools.switchBranch(name)}
          onRename={(from, to) => tools.renameBranch(from, to)}
          onDelete={(name, force) => tools.deleteBranch(name, force)}
        />
      )}
      {open === 'worktrees' && (
        <WorktreesDialog
          dir={dir}
          worktrees={tools.worktrees}
          branches={tools.branches}
          defaultBranch={tools.defaultBranch ?? fallbackBase}
          busy={busy}
          error={error}
          onClose={onClose}
          onRefresh={() => {
            tools.refreshBranches()
            tools.refreshWorktrees()
          }}
          onCreate={(name, base) => tools.createWorktree(name, base)}
          onRemove={(path, force) => tools.removeWorktree(path, force)}
          onPrune={tools.pruneWorktrees}
          onAddWorkspace={onAddWorkspace}
        />
      )}
      {open === 'checkpoints' && (
        <CheckpointsDialog
          checkpoints={tools.checkpoints}
          busy={busy}
          error={error}
          inspect={tools.inspecting}
          onClose={onClose}
          onRefresh={tools.refreshCheckpoints}
          onCreate={(label) => tools.createCheckpoint(label)}
          onInspect={tools.inspectCheckpoint}
          onRestore={tools.restoreCheckpoint}
          onDelete={tools.deleteCheckpoint}
        />
      )}
    </>
  )
}

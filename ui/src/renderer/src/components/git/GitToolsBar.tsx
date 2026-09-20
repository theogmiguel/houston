import { useCallback, useState } from 'react'
import type { GitTools, GitToolKind } from './useGitToolsSubscription'
import { GitToolsMenu } from './GitToolsMenu'
import { GitToolsDialogs } from './GitToolsDialogs'
import { pullDisabledReason } from './changes'

export interface GitToolsBarProps {
  clientReady: boolean
  dir: string | null
  tools: GitTools
  busy: boolean
  error: string | null
  behind: number
  upstream: string | null
  fallbackBase: string | null
  onAddWorkspace: (path: string) => void
}

// The strip's Git menu and the dialogs it opens, in one place: the menu owns
// the open kind, the dialogs render from it, and ChangesPane keeps its layout.
export function GitToolsBar({
  clientReady,
  dir,
  tools,
  busy,
  error,
  behind,
  upstream,
  fallbackBase,
  onAddWorkspace
}: GitToolsBarProps): React.JSX.Element {
  const [open, setOpen] = useState<GitToolKind | null>(null)

  const openTool = useCallback(
    (kind: GitToolKind): void => {
      setOpen(kind)
      tools.ensure(kind)
    },
    [tools]
  )

  const close = useCallback((): void => {
    setOpen(null)
  }, [])

  const onPull = tools.pull
  const onFetch = tools.fetch

  return (
    <>
      <GitToolsMenu
        disabled={!clientReady}
        behind={behind}
        busy={busy}
        pullDisabledReason={pullDisabledReason(upstream, behind)}
        fetchDisabledReason={null}
        onPull={onPull}
        onFetch={onFetch}
        onBranches={() => openTool('branches')}
        onWorktrees={() => openTool('worktrees')}
        onCheckpoints={() => openTool('checkpoints')}
      />
      <GitToolsDialogs
        open={open}
        dir={dir}
        tools={tools}
        busy={busy}
        error={error}
        fallbackBase={fallbackBase}
        onClose={close}
        onAddWorkspace={onAddWorkspace}
      />
    </>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { HoustonClient, WorkspaceAction } from './client'
import type { KeymapOverrides } from './client'
import { chordFromEvent, chordLabel } from '../keymap'

export function useWorkspaceActions({
  client,
  workspace,
  shellIntegration,
  keymapOverrides,
  setExpandedId,
  onError
}: {
  client: HoustonClient | null
  workspace: string
  shellIntegration: boolean
  keymapOverrides: KeymapOverrides
  setExpandedId: (id: number | null) => void
  onError: (message: string) => void
}): {
  byWorkspace: Record<string, WorkspaceAction[]>
  actions: WorkspaceAction[]
  run: (action: WorkspaceAction) => void
  save: (action: WorkspaceAction) => void
  remove: (id: string) => void
} {
  const [byWorkspace, setByWorkspace] = useState<Record<string, WorkspaceAction[]>>({})
  const actions = byWorkspace[workspace] ?? []

  useEffect(() => {
    if (!client || workspace === 'all') return
    const path = workspace
    const offActions = client.subscribe('workspace_actions', (msg) => {
      if (msg.workspace === path) setByWorkspace((current) => ({ ...current, [path]: msg.actions }))
    })
    const offRefused = client.subscribe('workspace_action_refused', (msg) => {
      if (msg.workspace === path) onError(msg.reason)
    })
    client.workspaceActionsGet(path)
    return () => { offActions(); offRefused() }
  }, [client, workspace, onError])

  const run = useCallback((action: WorkspaceAction): void => {
    if (!client || workspace === 'all') return
    setExpandedId(null)
    void client.runWorkspaceAction(action, workspace, shellIntegration).catch((error: unknown) => {
      onError(`Could not run workspace action “${action.name}”: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [client, workspace, shellIntegration, setExpandedId, onError])

  const save = useCallback((action: WorkspaceAction): void => {
    if (client && workspace !== 'all') client.workspaceActionSet(workspace, action)
  }, [client, workspace])

  const remove = useCallback((id: string): void => {
    if (client && workspace !== 'all') client.workspaceActionDelete(workspace, id)
  }, [client, workspace])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || workspace === 'all' || !keymapOverrides.shortcuts_enabled) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('[role="dialog"], input, textarea, [contenteditable="true"]')) return
      const chord = chordLabel(chordFromEvent(event))
      const action = actions.find((item) => item.shortcut === chord)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      run(action)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [workspace, actions, run, keymapOverrides])

  return { byWorkspace, actions, run, save, remove }
}

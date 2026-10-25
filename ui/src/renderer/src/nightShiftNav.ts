import { useSyncExternalStore } from 'react'
import type { NoticeInput } from './notices'
import type { ServerMsg } from './houston/generated/ServerMsg'

/** The Night shift report a morning notice asked to open. */
export interface NightShiftFocus {
  workspace: string
  runId: number
}

/** A morning notice names its workspace as the app does, not by its path. */
export function nightNoticeWorkspace(path: string, workspaces: readonly { path: string; name: string }[]): string {
  return workspaces.find((w) => w.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** The workspace a Night shift view opens on: the requested one, else the first. */
export function nightWorkspaceId(initial: string | null, workspaces: readonly { id: string }[]): string | null {
  return initial ?? workspaces[0]?.id ?? null
}

/** False when the workspace vanished, so the view falls back to the first. */
export function nightWorkspaceKnown(workspace: string | null, workspaces: readonly { id: string }[]): boolean {
  return workspace !== null && workspaces.some((w) => w.id === workspace)
}

/** The workspace's display name; a path not among the workspaces shows as its tail. */
export function nightWorkspaceName(workspace: string | null, workspaces: readonly { id: string; name: string }[]): string {
  return workspaces.find((w) => w.id === workspace)?.name ?? workspace ?? ''
}

/** Raise one notice per settled run; opening it lands on the run's report. */
export function handleNightShiftNotice(
  msg: ServerMsg,
  push: (notice: NoticeInput) => void,
  workspaces: readonly { path: string; name: string }[],
  openReport: (workspace: string, runId: number) => void
): void {
  if (msg.type !== 'night_shift_notice') return
  const { workspace, run_id: runId } = msg
  push({
    code: `night-shift:${runId}`,
    kind: 'info',
    title: `Night shift: ${msg.headline}`,
    body: nightNoticeWorkspace(workspace, workspaces),
    durationMs: null,
    action: {
      label: 'Open report',
      onClick: () => openReport(workspace, runId)
    }
  })
}

let focus: NightShiftFocus | null = null
const listeners = new Set<() => void>()

export function setNightShiftFocus(next: NightShiftFocus | null): void {
  focus = next
  for (const l of listeners) l()
}

export function useNightShiftFocus(): NightShiftFocus | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => { listeners.delete(onChange) }
    },
    () => focus,
    () => null
  )
}

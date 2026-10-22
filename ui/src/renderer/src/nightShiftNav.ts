import { useSyncExternalStore } from 'react'

/** The Night shift report a morning notice asked to open. */
export interface NightShiftFocus {
  workspace: string
  runId: number
}

/** A morning notice names its workspace as the app does, not by its path. */
export function nightNoticeWorkspace(path: string, workspaces: readonly { path: string; name: string }[]): string {
  return workspaces.find((w) => w.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
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

import { useSyncExternalStore } from 'react'

/** The Night shift report a morning notice asked to open. */
export interface NightShiftFocus {
  workspace: string
  runId: number
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

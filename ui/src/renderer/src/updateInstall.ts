import { useSyncExternalStore } from 'react'
import { appUpdateInstall, onAppUpdateProgress, type UpdateSessions } from './houston/appUpdate'

// The install flight, renderer-side. One download at a time, the same line the
// backend holds, and the state lives above the panel so navigating away from
// Settings and back shows the running download instead of offering a second one.
export type UpdateInstallState =
  | { kind: 'idle' }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'verifying' }
  | { kind: 'stopping' }
  | { kind: 'installing' }
  | { kind: 'installed'; version: string }
  | { kind: 'up_to_date' }
  | { kind: 'failed'; version: string; error: string }

let current: UpdateInstallState = { kind: 'idle' }
// How many sessions the running install ends, so the step list can say whether a
// "Stop N sessions" step exists at all.
let stopping = 0
let inFlight = false
let stopProgress: (() => void) | null = null
const listeners = new Set<() => void>()

function commit(next: UpdateInstallState): void {
  current = next
  for (const l of listeners) l()
}

// A refusal reaches the renderer as the backend's own string; anything else is
// an infrastructure failure and keeps its message rather than becoming "error".
function errorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

export function startUpdateInstall(
  expectedVersion: string,
  sessions: UpdateSessions
): Promise<void> {
  if (inFlight) return Promise.resolve()
  inFlight = true
  stopping = sessions.mode === 'stop_all' ? sessions.expected.length : 0
  commit({ kind: 'downloading', downloaded: 0, total: null })
  return (async () => {
    stopProgress = await onAppUpdateProgress((progress) => {
      if (!inFlight) return
      if (progress.phase === 'installing') commit({ kind: 'installing' })
      else if (progress.phase === 'verifying') commit({ kind: 'verifying' })
      else if (progress.phase === 'stopping') commit({ kind: 'stopping' })
      else commit({ kind: 'downloading', downloaded: progress.downloaded, total: progress.total })
    })
    try {
      const outcome = await appUpdateInstall(expectedVersion, sessions)
      commit(
        outcome.kind === 'installed'
          ? { kind: 'installed', version: outcome.version }
          : { kind: 'up_to_date' }
      )
    } catch (err) {
      commit({ kind: 'failed', version: expectedVersion, error: errorText(err) })
    } finally {
      inFlight = false
      stopProgress?.()
      stopProgress = null
    }
  })()
}

// The way out of every terminal state; a fresh check starts from nothing.
export function resetUpdateInstall(): void {
  stopProgress?.()
  stopProgress = null
  inFlight = false
  commit({ kind: 'idle' })
}

export function isUpdateInstallRunning(state: UpdateInstallState): boolean {
  return (
    state.kind === 'downloading' ||
    state.kind === 'verifying' ||
    state.kind === 'stopping' ||
    state.kind === 'installing'
  )
}

export function useUpdateInstallStopCount(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => stopping
  )
}

export function setUpdateInstallForTests(state: UpdateInstallState): void {
  current = state
  for (const l of listeners) l()
}

export function useUpdateInstall(): UpdateInstallState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current
  )
}

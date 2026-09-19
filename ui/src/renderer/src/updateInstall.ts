import { useSyncExternalStore } from 'react'
import { appUpdateInstall, onAppUpdateProgress } from './houston/appUpdate'
import type { UpdateChannel } from './houston/generated/UpdateChannel'

// The install flight, renderer-side. One download at a time, the same line the
// backend holds, and the state lives above the panel so navigating away from
// Settings and back shows the running download instead of offering a second one.
export type UpdateInstallState =
  | { kind: 'idle' }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'installing' }
  | { kind: 'installed'; version: string }
  | { kind: 'up_to_date' }
  | { kind: 'failed'; version: string; error: string }

let current: UpdateInstallState = { kind: 'idle' }
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
  channel: UpdateChannel,
  expectedVersion: string
): Promise<void> {
  if (inFlight) return Promise.resolve()
  inFlight = true
  commit({ kind: 'downloading', downloaded: 0, total: null })
  return (async () => {
    stopProgress = await onAppUpdateProgress((progress) => {
      if (!inFlight) return
      if (progress.phase === 'installing') commit({ kind: 'installing' })
      else commit({ kind: 'downloading', downloaded: progress.downloaded, total: progress.total })
    })
    try {
      const outcome = await appUpdateInstall(channel, expectedVersion)
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

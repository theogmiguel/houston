import { useSyncExternalStore } from 'react'

// The daemon reports a session's exit code once, on session_state. SessionInfo
// does not carry it, so the renderer keeps the last report for an exited pane.
const exitCodes = new Map<number, number | null>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function rememberSessionExitCode(session: number, exitCode: number | null): void {
  if (exitCodes.get(session) === exitCode) return
  exitCodes.set(session, exitCode)
  emit()
}

export function forgetSessionExitCode(session: number): void {
  if (!exitCodes.delete(session)) return
  emit()
}

export function resetSessionExitCodes(): void {
  if (exitCodes.size === 0) return
  exitCodes.clear()
  emit()
}

export function readSessionExitCode(session: number): number | null | undefined {
  return exitCodes.get(session)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSessionExitCode(session: number): number | null | undefined {
  return useSyncExternalStore(subscribe, () => exitCodes.get(session), () => undefined)
}

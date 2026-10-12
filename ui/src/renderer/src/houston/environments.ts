import { isTauri } from './host'

// The high bit marks WSL; each environment reserves 24 bits for daemon session IDs.
export const ENVIRONMENT_SESSION_BASE = 0x80000000
export const ENVIRONMENT_SESSION_SPAN = 0x1000000

export interface EnvironmentRosterPending {
  sessionSlots: ReadonlySet<number>
  workspaces: boolean
  discovering: boolean
}

const windowsDesktop = typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.platform.startsWith('Win') && isTauri()
let rosterPending: EnvironmentRosterPending = {
  sessionSlots: new Set(), workspaces: windowsDesktop, discovering: windowsDesktop
}
let rosterOwner: symbol | null = null
const rosterListeners = new Set<() => void>()

export function getEnvironmentRosterPending(): EnvironmentRosterPending {
  return rosterPending
}

export function subscribeEnvironmentRosterPending(listener: () => void): () => void {
  rosterListeners.add(listener)
  return () => { rosterListeners.delete(listener) }
}

/** A replaced socket's late disposal cannot overwrite the new mux's readiness. */
export function claimEnvironmentRoster(): (pending: EnvironmentRosterPending) => void {
  const owner = Symbol()
  rosterOwner = owner
  const publish = (pending: EnvironmentRosterPending): void => {
    if (rosterOwner !== owner) return
    if (pending.workspaces === rosterPending.workspaces && pending.discovering === rosterPending.discovering &&
        pending.sessionSlots.size === rosterPending.sessionSlots.size &&
        [...pending.sessionSlots].every((slot) => rosterPending.sessionSlots.has(slot))) return
    rosterPending = pending
    for (const listener of rosterListeners) listener()
  }
  publish({ ...rosterPending, workspaces: true, discovering: true })
  return publish
}

export interface EnvironmentEntry {
  id: string
  kind: 'local' | 'wsl'
  distro?: string
  slot: number
  port: number
  token: string
  state: 'starting' | 'ready' | 'error'
  reason?: string
}

// POSIX workspace path -> distro, kept by the environment mux from each WSL daemon's
// workspace list. Empty whenever no WSL environment is enabled.
export const wslWorkspaces = new Map<string, string>()

export function wslWorkspaceOf(path: string): { root: string; distro: string } | null {
  let best: { root: string; distro: string } | null = null
  for (const [root, distro] of wslWorkspaces) {
    const inside = path === root || path.startsWith(root === '/' ? root : `${root}/`)
    if (inside && (best === null || root.length > best.root.length)) best = { root, distro }
  }
  return best
}

export async function listEnvironments(): Promise<EnvironmentEntry[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<EnvironmentEntry[]>('env_list')
}

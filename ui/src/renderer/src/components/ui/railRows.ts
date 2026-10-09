import type { SessionInfo } from '../../houston/client'

export type RailStatusKind = 'needs-input' | 'working' | 'starting' | 'exited' | 'done' | 'idle' | 'unavailable'

export interface GridStatusModel {
  kind: RailStatusKind
  label: string
  since: number | null
}

const STATUS_RANK: Record<RailStatusKind, number> = {
  'needs-input': 7,
  exited: 6,
  working: 5,
  starting: 4,
  unavailable: 3,
  done: 2,
  idle: 1,
}

/** True while any running pane spawned, directly or transitively, by `id` is working or starting. */
export function hasWorkingDescendant(id: number, sessions: Iterable<SessionInfo>): boolean {
  const children = new Map<number, SessionInfo[]>()
  for (const session of sessions) {
    if (session.spawned_by == null) continue
    const group = children.get(session.spawned_by) ?? []
    group.push(session)
    children.set(session.spawned_by, group)
  }
  const seen = new Set([id])
  const queue = [id]
  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (seen.has(child.id) || child.state !== 'running') continue
      if (child.status === 'working' || child.status === 'spawning') return true
      seen.add(child.id)
      queue.push(child.id)
    }
  }
  return false
}

/** An idle orchestrator reads as working until its delegated work finishes; its own status stays on the roster. */
export function liftDelegatedWork(session: SessionInfo, sessions: Iterable<SessionInfo>): SessionInfo {
  if (session.state !== 'running' || session.status !== 'idle' || !hasWorkingDescendant(session.id, sessions)) return session
  return { ...session, status: 'working' }
}

export function gridStatus(sessions: readonly SessionInfo[]): GridStatusModel {
  if (sessions.length === 0) return { kind: 'idle', label: 'No panes', since: null }
  const statuses = sessions.map((session): GridStatusModel => {
    if (session.state !== 'running') return { kind: 'exited', label: 'Exited', since: session.status_since_ms ?? null }
    if (session.children_waiting > 0) return { kind: 'needs-input', label: 'Input', since: session.status === 'needs-input' ? session.status_since_ms ?? null : null }
    switch (session.status) {
      case 'needs-input': return { kind: 'needs-input', label: 'Input', since: session.status_since_ms ?? null }
      case 'working': return { kind: 'working', label: 'Working', since: session.status_since_ms ?? null }
      case 'spawning': return { kind: 'starting', label: 'Starting', since: session.status_since_ms ?? null }
      case 'unavailable': return { kind: 'unavailable', label: 'Unavailable', since: session.status_since_ms ?? null }
      case 'idle': return { kind: 'idle', label: 'Idle', since: session.status_since_ms ?? null }
      default: return { kind: 'unavailable', label: 'Status unavailable', since: session.status_since_ms ?? null }
    }
  })
  return statuses.sort((a, b) => STATUS_RANK[b.kind] - STATUS_RANK[a.kind] || (a.since ?? Infinity) - (b.since ?? Infinity))[0]
}

export function formatRailDuration(since: number | null, now = Date.now()): string | null {
  if (since == null || !Number.isFinite(since)) return null
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

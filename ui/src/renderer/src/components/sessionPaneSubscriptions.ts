import type { SessionInfo } from '../houston/client'
import type { PaneRoster } from './DelegationCard'

export function endedLabel(s: SessionInfo['state']): string | null {
  switch (s) {
    case 'exited':
      return 'DONE'
    case 'killed':
      return 'KILLED'
    case 'interrupted':
      return 'INTERRUPTED'
    default:
      return null
  }
}

export function rosterSessions(roster: PaneRoster | undefined): ReadonlyMap<number, SessionInfo> | undefined {
  return roster?.sessions
}

export function withSessionFamily(
  roster: PaneRoster | undefined,
  sessions: ReadonlyMap<number, SessionInfo>
): PaneRoster | undefined {
  return roster ? { ...roster, sessions } : undefined
}

export function rosterChildren(
  sessions: ReadonlyMap<number, SessionInfo> | undefined,
  parentId: number
): SessionInfo[] {
  return [...(sessions?.values() ?? [])]
    .filter((child) => child.spawned_by === parentId)
    .sort((a, b) => a.id - b.id)
}

export function visiblePeek(
  children: SessionInfo[],
  peekId: number | null,
  gridSessionIds: ReadonlySet<number> | undefined
): SessionInfo | undefined {
  return children.find((child) => child.id === peekId && !gridSessionIds?.has(child.id))
}

export function isGridSession(
  id: number | null,
  gridSessionIds: ReadonlySet<number> | undefined
): id is number {
  return id !== null && gridSessionIds?.has(id) === true
}

export function recentAfterSelection(previous: number[], id: number, limit: number): number[] {
  return [id, ...previous.filter((other) => other !== id)].slice(0, limit)
}

import { useEffect, useRef } from 'react'
import type { SessionInfo } from './houston/client'
import { notifyNative } from './houston/bridge'
import { childGroup } from './components/ChildrenRoster'

export function useOrchestrationNotifications(sessions: ReadonlyMap<number, SessionInfo>): void {
  const previous = useRef(new Set<number>())
  useEffect(() => {
    const next = new Set<number>()
    const parents = new Map<number, number>()
    for (const child of sessions.values()) {
      if (child.spawned_by == null || childGroup(child) !== 'Needs you') continue
      next.add(child.id)
      if (!previous.current.has(child.id)) parents.set(child.spawned_by, (parents.get(child.spawned_by) ?? 0) + 1)
    }
    for (const [id, count] of parents) {
      const parent = sessions.get(id)
      if (parent) void notifyNative(`${parent.title} needs you`, `${count} children need input`).catch(() => {})
    }
    previous.current = next
  }, [sessions])
}

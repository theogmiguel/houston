import { useEffect, useRef } from 'react'
import type { SessionInfo } from './houston/client'
import { notifyNative } from './houston/bridge'

export function useOrchestrationNotifications(sessions: ReadonlyMap<number, SessionInfo>): void {
  const previous = useRef(new Set<number>())
  useEffect(() => {
    const next = new Set<number>()
    for (const pane of sessions.values()) {
      if (pane.spawned_by != null || pane.state !== 'running' || pane.status !== 'needs-input') continue
      next.add(pane.id)
      if (!previous.current.has(pane.id)) void notifyNative(`${pane.title} needs you`, 'Waiting for your input').catch(() => {})
    }
    previous.current = next
  }, [sessions])
}

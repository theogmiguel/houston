import { useEffect, useRef, useState } from 'react'
import type { AgentStatus, SessionInfo } from '../houston/client'
import { attentionStatus } from '../sessionAttention'
import { useSession } from '../sessionsStore'
import { StatusNote } from './ui/StatusNote'

// A status that flips back within this window (a tool call between two turns, hooks
// arriving close together) is not worth interrupting a screen reader for.
export const ANNOUNCE_SETTLE_MS = 1500
// Clearing the region afterwards makes a later identical message a change, so it is read again.
export const ANNOUNCE_CLEAR_MS = 7000

export interface AnnouncerSnapshot {
  pane: number | null
  title: string
  status: AgentStatus | null
  /** Panes other than the focused one whose input request the user owns. */
  othersNeedingYou: number
}

function statusPhrase(title: string, from: AgentStatus | null, to: AgentStatus | null): string | null {
  if (to === from) return null
  if (to === 'working') return `${title} is working`
  if (to === 'needs-input') return `${title} needs your input`
  if (to === 'idle') return from === 'working' ? `${title} finished` : `${title} is ready`
  return null
}

function countPhrase(count: number): string {
  if (count === 0) return 'No other panes need you'
  return count === 1 ? '1 other pane needs you' : `${count} other panes need you`
}

/** What to say between two settled snapshots; null when nothing a listener asked to hear changed. A focus move only re-baselines. */
export function announcement(from: AnnouncerSnapshot, to: AnnouncerSnapshot): string | null {
  if (from.pane !== to.pane) return null
  const parts = [
    to.pane === null ? null : statusPhrase(to.title, from.status, to.status),
    from.othersNeedingYou === to.othersNeedingYou ? null : countPhrase(to.othersNeedingYou),
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : `${parts.join('. ')}.`
}

export function announcerSnapshot(session: SessionInfo | undefined, needingYou: readonly number[]): AnnouncerSnapshot {
  return {
    pane: session ? session.id : null,
    title: session?.title ?? '',
    status: session ? attentionStatus(session) ?? null : null,
    othersNeedingYou: needingYou.filter((id) => id !== session?.id).length,
  }
}

/** App re-renders on layout changes only, so the focused pane's status is read from its own store subscription. */
export function PaneStatusAnnouncer({ activeId, needingYou }: { activeId: number | null; needingYou: readonly number[] }): React.JSX.Element {
  const session = useSession(activeId ?? -1)
  return <StatusAnnouncerRegion snapshot={announcerSnapshot(session, needingYou)} />
}

/** One polite live region for the focused pane's reported status and the needs-you count. Never fed terminal text. */
export function StatusAnnouncerRegion({ snapshot }: { snapshot: AnnouncerSnapshot }): React.JSX.Element {
  const [message, setMessage] = useState('')
  const spoken = useRef(snapshot)
  const latest = useRef(snapshot)
  latest.current = snapshot
  // The title is read when the timer fires, not watched: CLI titles can update faster than the settle window.
  const { pane, status, othersNeedingYou } = snapshot
  useEffect(() => {
    if (spoken.current.pane !== pane) {
      spoken.current = latest.current
      return
    }
    const settle = window.setTimeout(() => {
      const next = announcement(spoken.current, latest.current)
      spoken.current = latest.current
      if (next !== null) setMessage(next)
    }, ANNOUNCE_SETTLE_MS)
    return () => window.clearTimeout(settle)
  }, [pane, status, othersNeedingYou])
  useEffect(() => {
    if (message === '') return
    const clear = window.setTimeout(() => setMessage(''), ANNOUNCE_CLEAR_MS)
    return () => window.clearTimeout(clear)
  }, [message])
  return <StatusNote variant="announcer" data-testid="pane-status-announcer">{message}</StatusNote>
}

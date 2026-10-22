import { createContext } from 'react'
import type { SessionInfo } from '../houston/client'

// A sleeping pane the user hid from its grid, keyed by session origin so the
// entry follows the conversation across the replacement Wake and Start fresh make.
export interface HiddenPane {
  workspace: string
  gridId: string
}
export type HiddenPanes = ReadonlyMap<number, HiddenPane>

const KEY = 'tr-hidden-panes'

export function sessionOrigin(session: { id: number; session_origin?: number | null }): number {
  return session.session_origin ?? session.id
}

export function loadHiddenPanes(): Map<number, HiddenPane> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return new Map()
    const out = new Map<number, HiddenPane>()
    for (const [origin, entry] of Object.entries(raw as Record<string, unknown>)) {
      const e = entry as Partial<HiddenPane> | null
      if (Number.isInteger(Number(origin)) && typeof e?.workspace === 'string' && typeof e.gridId === 'string') {
        out.set(Number(origin), { workspace: e.workspace, gridId: e.gridId })
      }
    }
    return out
  } catch {
    return new Map()
  }
}

export function saveHiddenPanes(panes: HiddenPanes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(panes)))
  } catch { /* Storage can be unavailable in private contexts. */ }
}

// The newest session of a conversation is the one its grid slot shows.
export function newestOfOrigin(sessions: Iterable<SessionInfo>, origin: number): SessionInfo | undefined {
  let newest: SessionInfo | undefined
  for (const s of sessions) if (sessionOrigin(s) === origin && (!newest || s.id > newest.id)) newest = s
  return newest
}

export function canSleep(info: SessionInfo): boolean {
  return info.spawned_by == null && (info.agent === 'claude' || info.agent === 'codex') && !info.task
}

export interface HiddenPaneActions {
  hide: (session: number) => void
  sleepAndHide: (session: number) => void
}

export const HiddenPaneActionsContext = createContext<HiddenPaneActions | null>(null)

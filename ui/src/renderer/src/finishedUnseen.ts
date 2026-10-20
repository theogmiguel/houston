import type { AgentStatus, SessionInfo } from './houston/client'

// Renderer-only record of top-level panes that finished while no grid showed
// them. It never crosses the wire: the rail folds the set into its unread dot,
// and focusing the pane clears the mark.

// The same hook-reported finish the notices use: a visible, running, top-level
// pane whose status moved working -> idle. Never inferred from terminal text.
function unseenFinish(previous: SessionInfo, status: AgentStatus, visible: ReadonlySet<number>): boolean {
  if (previous.hidden || previous.state !== 'running' || previous.spawned_by != null) return false
  return previous.status === 'working' && status === 'idle' && !visible.has(previous.id)
}

export function finishedUnseenOnStatus(
  state: ReadonlySet<number>,
  previous: SessionInfo | undefined,
  status: AgentStatus,
  visible: ReadonlySet<number>,
): ReadonlySet<number> {
  if (!previous) return state
  if (unseenFinish(previous, status, visible)) {
    if (state.has(previous.id)) return state
    return new Set(state).add(previous.id)
  }
  // A marked pane that starts again supersedes the unseen finish; an idle
  // repeat changes nothing the user has not already been told about.
  if (!state.has(previous.id) || status === 'idle') return state
  const next = new Set(state)
  next.delete(previous.id)
  return next
}

/** Drops one pane's mark: the pane was focused (seen) or left the roster. */
export function finishedUnseenWithout(state: ReadonlySet<number>, paneId: number): ReadonlySet<number> {
  if (!state.has(paneId)) return state
  const next = new Set(state)
  next.delete(paneId)
  return next
}

export function pruneFinishedUnseen(state: ReadonlySet<number>, known: ReadonlySet<number>): ReadonlySet<number> {
  const kept = [...state].filter((id) => known.has(id))
  return kept.length === state.size ? state : new Set(kept)
}

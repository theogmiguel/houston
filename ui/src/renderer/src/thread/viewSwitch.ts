import { isLive, type SessionInfo } from '../houston/client'
import type { AgentStatus } from '../houston/generated/AgentStatus'

const TURN_STATUS_WORD: Partial<Record<AgentStatus, string>> = { working: 'Working', spawning: 'Starting', 'needs-input': 'Needs input' }

/** Why the pane cannot move to the other view right now, in the daemon's words; `null` when it can. */
export function viewSwitchRefusal(info: SessionInfo, queued = 0): string | null {
  if (info.state === 'sleeping') return 'The session is sleeping; wake it first'
  if (!isLive(info.state)) return `The session is ${info.state}; restart it first`
  if (info.view !== 'thread' && info.delegation) return `It is a child of pane ${info.delegation.parent}, which could not see its questions or permission requests; keep it a terminal`
  if (info.view === 'thread' && queued > 0) return `${queued} queued messages wait in this thread; send or clear them first`
  const busy = info.status ? TURN_STATUS_WORD[info.status] : undefined
  return busy ? `Claude's status is ${busy}; wait for the turn to end or stop it first` : null
}

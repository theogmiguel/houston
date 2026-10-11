import type { AgentStatus, SessionInfo } from './houston/client'
import { isLive } from './houston/client'

export function ownUserInput(session: SessionInfo): boolean {
  if (!isLive(session.state)) return false
  if (session.spawned_by != null) return session.delegation?.input_request?.owner === 'user'
  return session.status === 'needs-input'
}

export function needsUserInput(session: SessionInfo): boolean {
  return isLive(session.state) && (ownUserInput(session) || session.children_waiting > 0)
}

export function askedOrchestrator(session: SessionInfo): boolean {
  return isLive(session.state) && session.spawned_by != null && !needsUserInput(session) &&
    (session.delegation?.input_request?.owner === 'orchestrator' || session.delegation?.state === 'asked_orchestrator' ||
      session.status === 'needs-input' || session.delegation?.state === 'needs_input')
}

export function attentionReason(session: SessionInfo): string | null {
  return ownUserInput(session) ? session.delegation?.input_request?.reason ?? null : null
}

export function inputEpisode(session: SessionInfo): string | null {
  return ownUserInput(session) ? session.delegation?.input_request?.id ?? `status:${session.status_since_ms ?? 0}` : null
}

export function attentionStatus(session: SessionInfo): AgentStatus | null | undefined {
  if (needsUserInput(session)) return 'needs-input'
  if (askedOrchestrator(session)) return 'idle'
  return session.status
}

export function attentionLabel(session: SessionInfo): string {
  if (askedOrchestrator(session)) return session.delegation?.input_request?.kind === 'permission' ? 'Blocked · asked orchestrator' : 'Asked orchestrator'
  return needsUserInput(session) ? 'Needs you' : session.status ?? 'unavailable'
}

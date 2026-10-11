import type { SessionInfo } from '../houston/client'
import type { ChildInputOwner } from '../houston/generated/ChildInputOwner'

export function withInputOwner(session: SessionInfo, owner: ChildInputOwner, reason: string | null = null, id = 'input-1'): SessionInfo {
  return { ...session, status: 'needs-input', delegation: {
    parent: session.spawned_by ?? 1, started_at: 0, state: owner === 'user' ? 'needs_input' : 'asked_orchestrator',
    stalled: false, result_staged: false, superseded: 0, turn_end_source: 'stop-hook', inbox_owed: 0,
    inbox_provisional: 0, reusable: false, ...session.delegation,
    input_request: { id, kind: 'question', owner, reason, escalation_reason: owner === 'user' ? 'explicit' : null, escalation_detail: null }
  } }
}

export function withPermissionOwner(session: SessionInfo, owner: ChildInputOwner): SessionInfo {
  const owned = withInputOwner(session, owner, 'Allow this command?', 'permission-1')
  return { ...owned, delegation: { ...owned.delegation!, input_request: {
    ...owned.delegation!.input_request!, kind: 'permission',
    permission: { provider: session.agent, command: { state: 'reported', text: 'curl https://example.test --header Authorization:[redacted]' }, block_reason: { state: 'not_reported', provider: session.agent } },
    escalation_detail: owner === 'user' ? 'Deny this command until the destination is verified.' : null
  } } }
}

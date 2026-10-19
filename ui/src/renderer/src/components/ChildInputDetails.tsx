import type { HoustonClient, SessionInfo } from '../houston/client'
import type { ProviderReportedText } from '../houston/generated/ProviderReportedText'
import { attentionLabel, askedOrchestrator, ownUserInput } from '../sessionAttention'
import { Notice } from './ui'
import { Text } from './ui/Text'
import { OrchestrationDetails, OrchestrationReason } from './ui/OrchestrationContent'

function reportedText(value: ProviderReportedText): string {
  return value.state === 'reported' ? value.text : `not reported by ${value.provider}`
}

export function ChildInputDetails({ info }: { info: SessionInfo }): React.JSX.Element | null {
  const input = info.delegation?.input_request
  if (!input) return null
  const permission = input.permission
  return <OrchestrationDetails>
    {input.reason && <OrchestrationReason>{input.reason}</OrchestrationReason>}
    {input.kind === 'permission' && <>
      <OrchestrationReason>Command: {permission ? reportedText(permission.command) : `not reported by ${info.detected_agent ?? info.agent}`}</OrchestrationReason>
      <OrchestrationReason>Block reason: {permission ? reportedText(permission.block_reason) : `not reported by ${info.detected_agent ?? info.agent}`}</OrchestrationReason>
    </>}
    {input.owner === 'user' && input.escalation_detail && <OrchestrationReason>Orchestrator recommendation: {input.escalation_detail}</OrchestrationReason>}
  </OrchestrationDetails>
}

/** Only a worker-reported ask can be dismissed; provider prompts clear on provider evidence. */
export function canDismissInput(info: SessionInfo): boolean {
  return ownUserInput(info) && info.delegation?.input_request?.id.startsWith('report:') === true
}

export function ChildInputBanner({ info, client }: { info: SessionInfo; client?: HoustonClient }): React.JSX.Element | null {
  if (info.spawned_by == null || !ownUserInput(info)) return null
  const input = info.delegation?.input_request
  const dismiss = client && input && canDismissInput(info)
    ? { label: 'Dismiss', onClick: () => client.childInputResolve(info.id, input.id) }
    : undefined
  return <Notice tone="warn" inset="compact-inline" className="flex-none" action={dismiss}><Text weight="semibold">Needs you</Text><ChildInputDetails info={info} /></Notice>
}

export function ParentOwnedInput({ info }: { info: SessionInfo }): React.JSX.Element | null {
  if (!askedOrchestrator(info)) return null
  return <OrchestrationReason>{attentionLabel(info)}</OrchestrationReason>
}

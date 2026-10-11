import type { SessionInfo } from '../houston/client'
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

export function ChildInputBanner({ info }: { info: SessionInfo }): React.JSX.Element | null {
  if (info.spawned_by == null || !ownUserInput(info)) return null
  return <Notice tone="warn" inset="compact-inline" className="flex-none"><Text weight="semibold">Needs you</Text><ChildInputDetails info={info} /></Notice>
}

export function ParentOwnedInput({ info }: { info: SessionInfo }): React.JSX.Element | null {
  if (!askedOrchestrator(info)) return null
  return <OrchestrationReason>{attentionLabel(info)}</OrchestrationReason>
}

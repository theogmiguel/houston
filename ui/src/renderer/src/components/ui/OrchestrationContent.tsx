import type { ReactNode } from 'react'
import { Text } from './Text'
import { Button } from './Button'
import { OrchestratorActionRow } from './OrchestratorOverview'

export function OrchestrationInset({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)] p-[var(--space-3)]">{children}</div>
}

export function OrchestrationBody({ children }: { children: ReactNode }): React.JSX.Element {
  return <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--tool-code-bg)] p-[var(--space-3)] font-mono text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-primary)]">{children}</pre>
}

export function OrchestrationReason({ children, userOwned = false }: { children: ReactNode; userOwned?: boolean }): React.JSX.Element {
  return <Text size="small" tone={userOwned ? 'warn' : 'muted'} className="whitespace-pre-wrap break-words">{children}</Text>
}

export function OrchestrationDetails({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid max-h-[12rem] overflow-auto gap-[var(--space-1)]">{children}</div>
}

export function OrchestrationContentSpecimen(): React.JSX.Element {
  return <OrchestrationInset><OrchestrationDetails><OrchestrationReason userOwned>Permission needed: allow this command?</OrchestrationReason><OrchestrationReason>Command: curl https://example.test</OrchestrationReason><OrchestrationReason>Block reason: not reported by claude</OrchestrationReason></OrchestrationDetails><OrchestrationReason>Held after recovery. Resume deliberately.</OrchestrationReason><OrchestratorActionRow><Button size="sm" variant="secondary">Inspect instruction</Button><Button size="sm" variant="ghost">Cancel instruction</Button><Button size="sm" variant="secondary">Resume instruction</Button></OrchestratorActionRow><OrchestrationBody>{'Full result\nVerified the changes.\nArtifacts: output.txt'}</OrchestrationBody></OrchestrationInset>
}

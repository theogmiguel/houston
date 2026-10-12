import type { AgentKind } from '../../houston/generated/AgentKind'
import { IconAgent, IconChevronRight } from '../icons'
import { Icon } from './Icon'
import { SetupDot, type SetupTone } from './AgentSetupRow'
import { Text } from './Text'
import { Button } from './Button'
import { ROW_STATE } from './rowState'

export function ProviderGlyphTile({ agent, state = 'on' }: { agent: AgentKind; state?: 'on' | 'off' | 'differs' }): React.JSX.Element {
  return <span aria-hidden="true" className={`relative ${state === 'off' ? 'opacity-45' : ''} flex h-[var(--space-6)] w-[var(--space-6)] flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-[var(--card-bg)]`}><IconAgent agent={agent} className="h-[var(--space-4)] w-[var(--space-4)]" />{state === 'differs' && <span className="absolute -right-[var(--space-0-5)] -top-[var(--space-0-5)] h-[var(--space-2)] w-[var(--space-2)] rounded-full border-2 border-[var(--card-bg)] bg-[var(--danger)]" />}</span>
}
export function AgentCliRow({ provider, name, version, detail, mark, status, tone, pending, action, onAction, onOpen }: { provider: AgentKind; name: string; version: string | null; detail: string; mark: string; status: string; tone: SetupTone; pending: boolean; action?: string; onAction?: () => void; onOpen: () => void }): React.JSX.Element {
  return <div data-testid="agent-status-row" data-settings-row-name={name} data-provider={provider} data-status={mark} className={`flex items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] [&+&]:border-t [&+&]:border-[var(--divider)] ${ROW_STATE.rest} ${mark === 'absent' ? 'text-[var(--text-secondary)]' : ''}`}>
    <ProviderGlyphTile agent={provider} />
    <button type="button" aria-label={`Open ${name} details`} onClick={onOpen} className="grid min-w-0 flex-1 gap-[var(--space-1)] border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-[var(--border-focus)]">
      <span className="flex items-baseline gap-[var(--space-2)]"><Text size="ui" tone={mark === 'absent' ? 'secondary' : 'primary'}>{name}</Text><Text size="small" mono tone="muted">{version ?? '—'}</Text></span><Text size="small" tone="muted">{detail}</Text>
    </button>
    <span className="flex flex-none items-center gap-[var(--space-1-5)]"><SetupDot tone={tone} /><Text size="small" tone={tone}>{status}</Text></span>
    {action ? <Button variant={mark === 'absent' ? 'ghost' : 'secondary'} disabled={pending} onClick={onAction}>{action}</Button> : <Button variant="ghost" aria-label={`Open ${name} details`} onClick={onOpen}><Icon glyph={IconChevronRight} role="small" /></Button>}
  </div>
}

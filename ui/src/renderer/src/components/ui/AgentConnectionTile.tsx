import type { ReactNode } from 'react'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { ProviderGlyphTile } from './AgentCliRow'
import { Text } from './Text'
import { Switch } from './Switch'
export function AgentConnectionTile({ agent, label, server, checked, status, reason, onChange, testId }: { agent: AgentKind; label: string; server: string; checked: boolean; status: string; reason?: string; onChange: () => void; testId: string }): React.JSX.Element {
  return <div data-testid={testId} className="flex min-w-0 items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-2-5)] py-[var(--space-2)]"><ProviderGlyphTile agent={agent} state={checked ? 'on' : 'off'} /><span className="grid min-w-0 flex-1 gap-[var(--space-0-5)]"><Text size="ui">{label}</Text><Text size="small" tone={reason ? 'danger' : 'muted'}>{status}</Text>{reason && <Text size="small" tone="danger">{reason}</Text>}</span><Switch on={checked} label={`${server} in ${label}`} onChange={onChange} /></div>
}

export function AgentConnectionGrid({ children }: { children: ReactNode }): React.JSX.Element { return <div className="grid grid-cols-2 gap-[var(--space-2)] lg:grid-cols-4">{children}</div> }

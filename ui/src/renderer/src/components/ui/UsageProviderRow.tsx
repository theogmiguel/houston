import type { ReactNode } from 'react'
import { IconAgent } from '../icons'
import { ICON_ROLE_CLS } from './Icon'
import { Text } from './Text'

export function UsageAgentMark({ agent }: { agent: string }): React.JSX.Element {
  return <span aria-hidden="true" className="inline-flex size-[var(--h-ctl-mini)] flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border border-[var(--border)]"><IconAgent agent={agent} brand className={ICON_ROLE_CLS.ui} /></span>
}

export function UsageShareTrack({ share, color, label }: { share: number; color: string; label?: string }): React.JSX.Element {
  const percent = Math.max(0, Math.min(1, share)) * 100
  return <span className="block h-[var(--space-1)] w-full overflow-hidden rounded-full bg-[var(--divider)]" role={label ? 'progressbar' : undefined} aria-label={label} aria-valuenow={label ? percent : undefined} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? 100 : undefined}><span className="block h-full rounded-full" style={{ width: `${percent}%`, background: color }} /></span>
}

export function UsageProviderRow({ mark, label, sessions, amount, note, color, share = 0 }: {
  mark: ReactNode
  label: string
  sessions: number
  amount: string
  note: string
  color: string
  share?: number
}): React.JSX.Element {
  return <div className="grid min-w-0 gap-[var(--space-1-5)] px-[var(--space-4)] py-[var(--space-2-5)] [&+&]:border-t [&+&]:border-[var(--divider)]" data-testid="usage-provider-row">
    <div className="flex min-w-0 items-center gap-[var(--space-2-5)]">
      {mark}
      <span className="grid min-w-0 flex-1"><Text size="ui" weight="medium" tone="primary">{label}</Text><Text size="small" tone="muted">{sessions.toLocaleString('en-US')} sessions · {note}</Text></span>
      <span className="grid text-right"><Text size="ui" weight="medium" tone="primary" tabular>{amount}</Text><Text size="small" tone="muted" tabular>{(share * 100).toFixed(1)}%</Text></span>
    </div>
    <UsageShareTrack share={share} color={color} label={`${label} share of cost`} />
  </div>
}

export function UsageShareCell({ share, color }: { share: number; color: string }): React.JSX.Element {
  return <span className="flex items-center gap-[var(--space-2)]"><UsageShareTrack share={share} color={color} /><Text size="small" tone="muted" tabular className="w-[44px] flex-none text-right">{(share * 100).toFixed(1)}%</Text></span>
}

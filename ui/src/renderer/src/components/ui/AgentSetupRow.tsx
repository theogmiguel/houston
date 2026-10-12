import type { ReactNode } from 'react'
import { IconChevronRight } from '../icons'
import { Icon } from './Icon'
import { Text } from './Text'
import { ROW_STATE } from './rowState'

export type SetupTone = 'danger' | 'warn' | 'ok' | 'muted'
export function SetupDot({ tone }: { tone: SetupTone }): React.JSX.Element {
  return <span aria-hidden="true" data-tone={tone} className={`h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full ${ { danger: 'bg-[var(--danger)]', warn: 'bg-[var(--warn)]', ok: 'bg-[var(--ok)]', muted: 'bg-[var(--text-faint)]' }[tone]}`} />
}
export function AgentSetupRow({ heading, detail, tone, action, onClick, status, leading }: { heading: ReactNode; detail: ReactNode; tone: SetupTone; action?: ReactNode; onClick?: () => void; status?: string; leading?: ReactNode }): React.JSX.Element {
  const content = <>{leading ?? (!onClick && <SetupDot tone={tone} />)}<span className="grid min-w-0 flex-1 gap-[var(--space-1)]"><Text size="ui" weight="medium" tone="primary">{heading}</Text><Text size="small" tone="muted">{detail}</Text></span>{onClick ? <span className="flex flex-none items-center gap-[var(--space-2)]"><SetupDot tone={tone} /><Text size="small" tone={tone}>{status}</Text><Icon glyph={IconChevronRight} role="small" /></span> : action}</>
  const classes = `flex w-full items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] text-left [&+&]:border-t [&+&]:border-[var(--divider)] ${ROW_STATE.rest}`
  return onClick ? <button type="button" onClick={onClick} className={`${classes} border-0 focus-visible:outline focus-visible:outline-[var(--border-focus)]`}>{content}</button> : <div className={classes}>{content}</div>
}

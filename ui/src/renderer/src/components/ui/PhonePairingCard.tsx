import type { ReactNode } from 'react'
import { IconCheck, IconPhone } from '../icons'
import { Card } from './Card'
import { Icon } from './Icon'
import { Text } from './Text'

/// The 200px field leaves 12px around the camera-friendly 176px code.
export function PhonePairingCard({ children, code }: { children: ReactNode; code?: ReactNode }): React.JSX.Element {
  return <Card shape="card" padding="page" layout="fields" data-testid="phone-pairing-card"><div className="grid items-center gap-[var(--space-6)] [@container_(min-width:640px)]:grid-cols-[minmax(0,1fr)_auto]"><div className="grid min-w-0 gap-[var(--space-4)]">{children}</div><div className={`mx-auto flex h-[200px] w-[200px] items-center justify-center rounded-[var(--tr-radius-card)] border border-[var(--divider)] ${code ? 'bg-white' : 'border-dashed bg-[var(--content-bg)]'}`}>{code ?? <Text tone="faint"><Icon glyph={IconPhone} role="ui" /></Text>}</div></div></Card>
}

export function PairingSteps({ children }: { children: ReactNode }): React.JSX.Element {
  return <ol className="m-0 grid list-none gap-[var(--space-3)] p-0">{children}</ol>
}

export function PairingStep({ number, heading, detail, done = false }: { number: number; heading: string; detail: ReactNode; done?: boolean }): React.JSX.Element {
  return <li className="flex items-start gap-[var(--space-3)]"><span aria-hidden="true" className={`flex h-[var(--space-5)] w-[var(--space-5)] flex-none items-center justify-center rounded-full border [font-size:var(--tr-text-small-size)] ${done ? 'border-[var(--ok)] bg-[var(--status-done-bg)] text-[var(--ok)]' : 'border-[var(--divider)] text-[var(--text-muted)]'}`}>{done ? <Icon glyph={IconCheck} role="small" /> : number}</span><div className="grid min-w-0 gap-[var(--space-0-5)]"><Text size="ui" weight="medium">{heading}</Text><Text size="small" tone="muted">{detail}</Text></div></li>
}

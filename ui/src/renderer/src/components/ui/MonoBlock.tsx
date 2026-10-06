import type { ReactNode } from 'react'
import { Text } from './Text'

const VARIANT = {
  algorithm: { tag: 'div', tone: 'secondary', breakAll: true, className: '' },
  fingerprint: { tag: 'code', tone: 'secondary', breakAll: false, className: 'block break-normal select-all' },
  struck: { tag: 'del', tone: 'danger', breakAll: true, className: 'block line-through select-all' },
  art: { tag: 'pre', tone: 'secondary', breakAll: false, className: 'm-0 bg-[var(--tool-code-bg)] border border-border rounded-[var(--tr-radius-sm)] px-[var(--space-2-5)] py-[var(--space-2)] leading-[var(--line-host-key-art)] whitespace-pre overflow-x-auto' },
  reason: { tag: 'code', tone: 'secondary', breakAll: false, className: 'block whitespace-pre-wrap break-words rounded-[var(--tr-radius-sm)] bg-[var(--content-bg)] p-[var(--space-2)]' }
} as const

export type MonoBlockVariant = keyof typeof VARIANT

export interface MonoBlockProps {
  variant: MonoBlockVariant
  children: ReactNode
  id?: string
  hidden?: boolean
  'aria-label'?: string
  'data-testid'?: string
}

/** Monospace values a user may need to read or copy: host keys, digests and diagnostic reasons. */
export function MonoBlock({ variant, children, ...rest }: MonoBlockProps): React.JSX.Element {
  const { tag, tone, breakAll, className } = VARIANT[variant]
  return <Text {...rest} as={tag} size="ui" weight="ui" tone={tone} mono breakAll={breakAll} className={className}>{children}</Text>
}

export function MonoBlockSpecimen(): React.JSX.Element {
  return (
    <div data-testid="mono-block-specimen" className="grid gap-[var(--space-2)]">
      <MonoBlock variant="algorithm">ssh-ed25519</MonoBlock>
      <MonoBlock variant="fingerprint">SHA256:0123 4567 89ab cdef</MonoBlock>
      <MonoBlock variant="struck">SHA256:ZZZZ9876543210</MonoBlock>
      <MonoBlock variant="art">{'+--[ED25519 256]--+\n|      .o..       |\n+----[SHA256]-----+'}</MonoBlock>
      <MonoBlock variant="reason">protocol 3 cannot hand off to protocol 4</MonoBlock>
    </div>
  )
}

import type { ReactNode } from 'react'
import { Count } from './Count'
import { Text } from './Text'

export interface SectionHeadProps {
  title: string
  count?: number
  action?: ReactNode
  inset?: boolean
  density?: 'default' | 'row'
  tone?: 'faint' | 'muted'
}

export function SectionHead({ title, count, action, inset = false, density = 'default', tone = 'faint' }: SectionHeadProps): React.JSX.Element {
  const row = density === 'row'
  return (
    <h2 className={`m-0 flex min-w-0 items-center gap-[var(--space-2)] ${row ? 'h-[var(--h-row)] px-[var(--space-3)]' : ''} ${inset ? 'pl-[var(--space-2-5)]' : ''}`}>
      <Text as="span" size="label" weight="label" tone={tone} className="flex min-w-0 items-center">
        {title}
        {count !== undefined && <Count value={count} />}
      </Text>
      {action && <span className="ml-auto flex flex-none items-center">{action}</span>}
    </h2>
  )
}

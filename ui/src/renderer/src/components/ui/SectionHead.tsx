import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconComponent } from '../icons'
import { Count } from './Count'
import { Text } from './Text'

export interface SectionHeadProps {
  title: string
  count?: number
  action?: ReactNode
  inset?: boolean
  density?: 'default' | 'row'
  tone?: 'faint' | 'muted'
  variant?: 'label' | 'sentence' | 'section'
  icon?: IconComponent
}

export function SectionHead({ title, count, action, inset = false, density = 'default', tone = 'faint', variant = 'label', icon }: SectionHeadProps): React.JSX.Element {
  if (variant === 'section') return <h2 className="m-0 flex min-w-0 items-baseline gap-[var(--space-2)] text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]"><span>{title}</span>{count !== undefined && <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]"><Count value={count} showZero /></span>}{action}</h2>
  const row = density === 'row'
  return (
    <h2 className={`m-0 flex min-w-0 items-center gap-[var(--space-2)] ${row ? 'h-[var(--h-row)] px-[var(--space-3)]' : ''} ${inset ? 'pl-[var(--space-2-5)]' : ''}`}>
      {icon && <Text as="span" tone="muted" className="flex"><Icon glyph={icon} role="small" /></Text>}
      <Text as="span" size={variant === 'sentence' ? 'small' : 'label'} weight={variant === 'sentence' ? 'semibold' : 'label'} tone={tone} className="flex min-w-0 items-center">
        {title}
        {count !== undefined && <Count value={count} />}
      </Text>
      {action && <span className="ml-auto flex flex-none items-center">{action}</span>}
    </h2>
  )
}

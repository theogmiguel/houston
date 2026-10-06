import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { variants } from './variants'

const labelClasses = variants('px-1.5 rounded-[var(--tr-radius-pill)] border border-[var(--border)]', {
  selected: { false: 'text-[var(--text-muted)]', true: 'text-[var(--text-primary)]' }
}, { selected: 'false' })

export function PullRequestLabel({ children, selected = false, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; selected?: boolean }): React.JSX.Element {
  return <Text {...props} size="caption" tone={selected ? 'primary' : 'muted'} className={`${labelClasses({ selected: selected ? 'true' : 'false' })} ${className}`}>{children}</Text>
}

export function PullRequestLabelSpecimen(): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-1)]"><PullRequestLabel>bug</PullRequestLabel><PullRequestLabel selected>needs review</PullRequestLabel></div>
}

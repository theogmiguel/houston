import type { HTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'
import { Text } from './Text'

const rowClasses = variants('flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-3)] border-t border-t-[var(--divider)] first:border-t-0 text-[length:var(--tr-text-small-size)]', {
  tone: {
    default: '',
    danger: 'bg-[color-mix(in_srgb,var(--danger)_7%,transparent)]'
  }
}, { tone: 'default' })

export interface MetadataRowProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  tone?: 'default' | 'danger'
}

export function MetadataRow({ children, tone = 'default', className = '', ...props }: MetadataRowProps): React.JSX.Element {
  return <div {...props} className={`${rowClasses({ tone })} ${className}`}>{children}</div>
}

export function MetadataRowSpecimen(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-[var(--tr-radius-sm)] border border-[var(--divider)]">
      <MetadataRow><Text>Reviewers</Text><MetadataValue>2</MetadataValue></MetadataRow>
      <MetadataRow tone="danger"><Text>Merge blocked</Text><MetadataValue>Checks failed</MetadataValue></MetadataRow>
    </div>
  )
}

export function MetadataValue({ children, tone = 'primary', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: 'primary' | 'muted' | 'faint' }): React.JSX.Element {
  return <Text {...props} size="small" tone={tone} className={`ml-auto ${className}`}>{children}</Text>
}

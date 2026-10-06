import type { HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { variants } from './variants'
import { MetadataValue, MetadataRow } from './MetadataRow'

const rowClasses = variants('flex items-center gap-[var(--space-2)] px-[var(--space-2)] py-[var(--space-1)]', {
  selected: { false: '', true: 'bg-[var(--card-hover)]' }
}, { selected: 'false' })

const stateClasses = variants('flex-none', {
  state: {
    open: 'text-[var(--ok)]',
    draft: 'text-[var(--warn)]',
    merged: 'text-[var(--info)]',
    closed: 'text-[var(--text-muted)]'
  }
}, { state: 'open' })

export interface StackLayer extends HTMLAttributes<HTMLDivElement> {
  number: number
  summary: string
  headRef: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  selected?: boolean
}

export function StackLayerList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="border border-[var(--border)] rounded-[var(--tr-radius-sm)] overflow-hidden flex flex-col bg-[var(--content-bg)]">{children}</div>
}

export function StackOverview({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`flex flex-col gap-[var(--space-1)] ${props.className ?? ''}`}>{children}</div>
}

export function StackSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" size="small" weight="small" tone="muted" className="block flex-none w-[var(--tr-stack-label-width)]">{children}</Text>
}

export function StackLayerRow({ number, summary, headRef, state, selected = false, className = '', ...props }: StackLayer): React.JSX.Element {
  return (
    <div {...props} className={`${rowClasses({ selected: selected ? 'true' : 'false' })} ${className}`}>
      <Text mono size="small" tone="faint" className="flex-none">#{number}</Text>
      <Text size="small" tone="primary" className="flex-1 min-w-0 truncate">{summary}</Text>
      <Text mono size="small" tone="faint" className="flex-none">{headRef}</Text>
      <Text size="small" className={stateClasses({ state })}>{state}</Text>
    </div>
  )
}

export function StackLayerNotice({ children, tone = 'muted', className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone?: 'danger' | 'muted' }): React.JSX.Element {
  return <Text {...props} size="small" tone={tone} className={`${tone === 'danger' ? 'break-words [overflow-wrap:anywhere]' : 'text-[var(--text-faint)]'} ${className}`}>{children}</Text>
}

export function StackLayerListSpecimen(): React.JSX.Element {
  return <StackOverview><MetadataRow><StackSectionLabel>Stack</StackSectionLabel><MetadataValue>2 layers</MetadataValue></MetadataRow><StackLayerList><StackLayerRow number={21} summary="Add review summary" headRef="review-summary" state="open" selected /><StackLayerRow number={20} summary="Update parser" headRef="parser" state="merged" /></StackLayerList><StackLayerNotice tone="danger">Checks failed</StackLayerNotice></StackOverview>
}

import type { MouseEventHandler, ReactNode } from 'react'
import { Text } from './Text'

/** A clipped pane title that expands with the available pane width. */
export function PaneTitle({ children, editable = false, onDoubleClick }: { children: ReactNode; editable?: boolean; onDoubleClick?: MouseEventHandler<HTMLElement> }): React.JSX.Element {
  return <Text size="small" weight="medium" tone="primary" tight onDoubleClick={onDoubleClick} className={`pane-title flex [flex:0_1_auto] leading-[var(--tr-text-tight-leading)] whitespace-nowrap overflow-hidden text-ellipsis min-w-[var(--w-pane-title-min)] max-w-[var(--w-pane-title-base)] [@container_(min-width:560px)]:max-w-[var(--w-pane-title-lg)] [@container_(min-width:760px)]:max-w-[var(--w-pane-title-xl)] [@container_(min-width:1000px)]:max-w-[var(--w-pane-title-2xl)] [@container_(min-width:1300px)]:max-w-[var(--w-pane-title-3xl)] [@container_(max-width:460px)]:max-w-[var(--w-pane-title-md)] [@container_(max-width:400px)]:max-w-[var(--w-pane-title-sm)] [@container_(max-width:280px)]:max-w-[var(--w-pane-title-xs)] [@container_(max-width:200px)]:max-w-[var(--w-pane-title-xxs)] [@container_(max-width:200px)]:min-w-[var(--w-pane-title-narrow)] ${editable ? 'cursor-text border-0 border-b border-dotted border-transparent group-hover:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] group-focus-within:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] [transition:border-color_0.2s,color_0.18s]' : ''}`}>{children}</Text>
}

export function PaneTitleSpecimen(): React.JSX.Element {
  return <div data-testid="pane-title-specimen" className="max-w-[var(--w-pane-title-md)] overflow-hidden"><PaneTitle>Session title that truncates when its pane narrows</PaneTitle></div>
}

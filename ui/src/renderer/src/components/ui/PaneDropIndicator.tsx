import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { Text } from './Text'

export function PaneDragScrim(props: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`pointer-events-none absolute inset-0 z-[calc(var(--z-pane)+3)] bg-overlay ${props.className ?? ''}`} />
}

export function PaneGridSurface({ dragging = false, resizing = false, ...props }: HTMLAttributes<HTMLDivElement> & { dragging?: boolean; resizing?: boolean; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...props} className={`layout bg-[var(--gutter-bg)] ${dragging ? 'dragging cursor-grabbing' : ''} ${resizing ? 'resizing' : ''} ${props.className ?? ''}`} />
}

export function PaneSlot({ column = true, ...props }: HTMLAttributes<HTMLDivElement> & { column?: boolean }): React.JSX.Element {
  return <div {...props} className={`pane-slot absolute flex ${column ? 'flex-col' : ''} overflow-hidden @container ${props.className ?? ''}`} />
}

export function PaneDropIndicator({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`pointer-events-none absolute z-[calc(var(--z-pane)+1)] flex items-center justify-center border-2 border-dashed [border-color:var(--accent)] rounded-[var(--tr-radius-md)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] motion-safe:[animation:term-enter_var(--animate-t-fast)_var(--animate-ease-panel)] ${props.className ?? ''}`}>{children}</div>
}

export function PaneDropLabel({ children, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }): React.JSX.Element {
  return <Text {...props} as="span" size="small" weight="small" className={`inline-flex h-[var(--h-pill)] items-center whitespace-nowrap rounded-[var(--tr-radius-sm)] bg-[var(--accent)] px-[var(--space-2)] text-white shadow-[var(--shadow-2)] ${props.className ?? ''}`}>{children}</Text>
}

export function SplitterAffordance({ axis = 'row', dragging = false, ...props }: HTMLAttributes<HTMLDivElement> & { axis?: 'row' | 'col'; dragging?: boolean }): React.JSX.Element {
  const axisClass = axis === 'row' ? 'w-2 -translate-x-1 cursor-col-resize after:w-px after:mx-auto' : 'h-2 -translate-y-1 cursor-row-resize after:h-px after:my-auto'
  return <div {...props} data-dragging={dragging || undefined} className={`splitter ${axisClass} absolute z-[var(--z-pane)] touch-none bg-transparent focus-visible:outline-none after:content-[''] after:absolute after:inset-0 after:rounded-[var(--r-splitter-line)] after:bg-transparent motion-safe:after:[transition:background-color_0.1s_ease-out] focus-visible:after:bg-[var(--text-faint)] data-[dragging]:after:bg-[var(--text-faint)] ${dragging ? 'pointer-events-none' : ''}`} />
}

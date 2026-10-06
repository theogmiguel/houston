import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { Icon } from './Icon'
import { IconClose, IconGrid } from '../icons'

export interface WorkspaceTreeRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  children: ReactNode
  kind: 'tree' | 'plain' | 'child' | 'editing'
  selected?: boolean
  dragging?: boolean
  dragged?: boolean
  className?: string
  selectionColor?: string
}

export function WorkspaceTreeRow({ children, kind, selected = false, dragging = false, dragged = false, className = '', selectionColor, ...props }: WorkspaceTreeRowProps): React.JSX.Element {
  const tree = kind === 'tree'
  const classes = kind === 'child'
    ? 'treerow child relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] pl-[var(--space-6)] pr-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full text-[var(--text-primary)]'
    : kind === 'editing'
      ? 'witem relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] py-0 px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 text-[var(--text-primary)] [font-size:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full'
      : tree
    ? `witem treerow ws relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`
    : `witem relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] py-0 px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 text-[length:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] ${selected ? 'bg-selected-fill text-[var(--text-primary)] on' : 'bg-transparent text-[var(--text-secondary)]'}`
  const cursor = kind === 'child' || kind === 'editing' ? '' : dragging ? 'cursor-grabbing' : 'cursor-pointer'
  const style = selectionColor
    ? {
        ...props.style,
        '--workspace-selection-outline-color': `color-mix(in srgb, ${selectionColor} var(--workspace-selection-outline-mix), transparent)`,
        background: `color-mix(in srgb, ${selectionColor} var(--workspace-selection-fill-mix), transparent)`
      } as CSSProperties
    : props.style
  return <div {...props} style={style} className={`${classes} ${cursor} ${selectionColor ? 'ring-1 ring-inset ring-[var(--workspace-selection-outline-color)]' : ''} ${dragged ? 'opacity-[var(--opacity-workspace-row-dragged)]' : ''} ${className}`}>{selectionColor && <span aria-hidden className="absolute left-0 top-[var(--space-1-5)] bottom-[var(--space-1-5)] w-[var(--sz-workspace-selection-rail)] rounded-r-[var(--tr-radius-workspace-selection-rail)]" style={{ background: selectionColor }} />}{children}</div>
}

export function WorkspaceTreeLabel({ children, size = 'ui' }: { children: ReactNode; size?: 'ui' | 'md' }): React.JSX.Element {
  return <Text size={size} className="min-w-0 truncate">{children}</Text>
}

export function WorkspaceTreeActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="ml-auto flex items-center gap-[var(--space-1)] flex-none">{children}</span>
}

export function WorkspaceTreeAuxButton({ children, selected = false, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; selected?: boolean }): React.JSX.Element {
  return <button {...props} type="button" className={`hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center w-[var(--sz-rail-row-action)] h-[var(--sz-rail-row-action)] flex-none rounded-[var(--tr-radius-input)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] ${selected ? 'inline-flex' : ''}`} onClick={onClick}>{children}</button>
}

export function WorkspaceDropIndicator(): React.JSX.Element {
  return <div className="h-0 mx-[var(--space-2)] relative pointer-events-none before:content-[''] before:absolute before:left-0 before:right-0 before:top-[var(--offset-workspace-drop-indicator)] before:h-[var(--h-workspace-drop-indicator)] before:rounded-[var(--tr-radius-workspace-drop-indicator)] before:bg-[var(--accent)]" />
}

export function EmptyListMessage({ children, kind = 'workspace' }: { children: ReactNode; kind?: 'workspace' | 'settings' }): React.JSX.Element {
  return <div className={kind === 'workspace' ? 'px-[var(--space-workspace-empty-list-x)] py-[var(--space-2)]' : 'px-[var(--space-2)] py-[var(--space-2)]'}><Text as="p" flush size="small" weight="small" tone={kind === 'workspace' ? 'faint' : 'muted'} leading="normal">{children}</Text></div>
}

export function WorkspaceTreeRowSpecimen(): React.JSX.Element {
  return <div className="grid w-[var(--w-rail-specimen)] gap-[var(--space-1)]"><WorkspaceTreeRow kind="tree" selected role="button"><span className="flex-none">▣</span><WorkspaceTreeLabel>Houston</WorkspaceTreeLabel><WorkspaceTreeActions><Icon glyph={IconClose} role="small" /></WorkspaceTreeActions></WorkspaceTreeRow><WorkspaceTreeRow kind="plain" role="button"><span className="flex-none">▣</span><WorkspaceTreeLabel>Editor</WorkspaceTreeLabel></WorkspaceTreeRow><WorkspaceTreeRow kind="child" role="button"><Icon glyph={IconGrid} role="ui" /><WorkspaceTreeLabel>Grid</WorkspaceTreeLabel></WorkspaceTreeRow><WorkspaceDropIndicator /><EmptyListMessage>No workspaces match your filter.</EmptyListMessage></div>
}

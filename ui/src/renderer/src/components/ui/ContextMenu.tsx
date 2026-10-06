import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { Text } from './Text'

const EDITOR_MENU_CLASS = 'ctx-menu fixed z-[var(--z-overlay)] min-w-[var(--w-editor-context-menu)] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)]'
const EDITOR_ITEM_CLASS = 'btn ctx-item border-none flex w-full items-center justify-between gap-[var(--space-editor-menu-gap)] rounded-[var(--tr-radius-input)] bg-transparent py-[var(--space-editor-menu-y)] px-2.5 text-left text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'

const MENU_CLASS =
  'ctxmenu fixed z-[var(--z-context)] w-[var(--w-context-menu)] overflow-hidden bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-menu)] shadow-[var(--shadow-1)] flex flex-col motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)] [&_.ctx-item]:grid [&_.ctx-item]:grid-cols-[var(--space-context-menu-icon-column)_minmax(0,1fr)_auto] [&_.ctx-item]:items-center [&_.ctx-item]:gap-[var(--space-1-5)] [&_.ctx-item]:w-full [&_.ctx-item]:h-[var(--h-context-menu-item)] [&_.ctx-item]:px-[var(--space-menu-item-x)] [&_.ctx-item]:py-0 [&_.ctx-item]:border-none [&_.ctx-item]:rounded-[var(--tr-radius-sm)] [&_.ctx-item]:bg-transparent [&_.ctx-item]:text-[var(--text-secondary)] [&_.ctx-item]:[font-size:var(--tr-text-label-size)] [&_.ctx-item]:font-normal [&_.ctx-item]:text-left [&_.ctx-item:hover]:bg-[var(--card-hover)] [&_.ctx-item:hover]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:bg-[var(--card-hover)] [&_.ctx-item:focus-visible]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:outline-none [&_.ctx-item:disabled]:text-[var(--text-faint)] [&_.ctx-item:disabled]:cursor-default [&_.ctx-item:disabled]:opacity-[var(--opacity-context-menu-disabled)] [&_.ctx-item_kbd]:text-[var(--text-faint)] [&_.ctx-item_kbd]:font-mono [&_.ctx-item_kbd]:[font-size:var(--tr-text-label-size)] [&_.ctx-item_kbd]:font-medium [&_.ctx-item>svg:first-child]:justify-self-center [&_.ctx-sep]:h-px [&_.ctx-sep]:bg-[var(--border)] [&_.ctx-sep]:my-[var(--space-context-menu-separator-y)] [&_.ctx-sep]:mx-0 [&_.ctx-sep]:flex-none [&_.ctx-item.danger]:text-[color-mix(in_srgb,var(--danger)_80%,transparent)] [&_.ctx-item.danger:hover]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] [&_.ctx-item.danger:hover]:text-[var(--danger)]'

export function ContextMenu({ children, className = '', ref, variant = 'default', ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement>; variant?: 'default' | 'editor' }): React.JSX.Element {
  return <div {...props} ref={ref} className={`${variant === 'editor' ? EDITOR_MENU_CLASS : MENU_CLASS} ${className}`}>{children}</div>
}

export function ContextMenuItems({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-[var(--space-context-menu-gap)] p-[var(--space-context-menu-pad)]">{children}</div>
}

export function ContextMenuItem({ danger = false, variant = 'default', shortcut, children, ref, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean; variant?: 'default' | 'editor'; shortcut?: string; ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  if (variant === 'editor') return <button {...props} ref={ref} type={props.type} className={`${EDITOR_ITEM_CLASS} ${props.className ?? ''}`}>{shortcut ? <><Text as="span" size="small" weight="small">{children}</Text><Text as="span" size="small" weight="small" tone="faint">{shortcut}</Text></> : children}</button>
  return <button {...props} ref={ref} type="button" className={`btn ctx-item ${danger ? 'danger' : ''} ${props.className ?? ''}`}>{children}</button>
}

export function ContextMenuHeading({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="flex flex-col justify-center gap-[var(--space-context-menu-title-gap)] min-h-[var(--h-context-menu-title)] px-[var(--space-context-menu-title-x)] py-[var(--space-context-menu-title-y)] border-b border-[var(--divider)]">
      <strong className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-context-menu-heading-weight)] text-[var(--text-primary)]">{title}</strong>
      <small className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">{subtitle}</small>
    </div>
  )
}

export function ContextMenuSeparator({ variant = 'default', ...props }: HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'editor' }): React.JSX.Element {
  if (variant === 'editor') return <div className="ctx-sep h-px flex-none bg-[var(--border)] my-1 mx-1.5" />
  return <div {...props} className={`ctx-sep ${props.className ?? ''}`} />
}

export function ContextMenuSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div role="presentation" className="px-[var(--space-context-menu-section-x)] pt-[var(--space-context-menu-section-top)] pb-[var(--space-context-menu-section-bottom)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--tr-text-label-tracking)] text-[var(--text-faint)]">{children}</div>
}

export function ContextMenuMessage({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`px-[var(--space-menu-item-x)] py-[var(--space-1-5)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)] ${className}`}>{children}</div>
}

export function ContextMenuColorDot({ color, size = 'tag' }: { color: string; size?: 'tag' | 'filter' }): React.JSX.Element {
  const metric = size === 'tag' ? '--space-context-menu-tag-dot' : '--space-context-menu-filter-dot'
  return <span aria-hidden className="rounded-full justify-self-center" style={{ width: `var(${metric})`, height: `var(${metric})`, background: color }} />
}

export function ContextMenuSpecimen(): React.JSX.Element {
  return <ContextMenu role="menu" aria-label="Context menu specimen" style={{ position: 'relative', inset: 'auto' }}><ContextMenuHeading title="Workspace" subtitle="/home/dev/code/workspace" /><ContextMenuItems><ContextMenuItem role="menuitem"><span>Open</span></ContextMenuItem><ContextMenuSeparator /><ContextMenuSectionLabel>Tags</ContextMenuSectionLabel><ContextMenuItem danger role="menuitem"><ContextMenuColorDot color="var(--accent)" /><span>Remove</span></ContextMenuItem></ContextMenuItems></ContextMenu>
}

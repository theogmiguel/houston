import './floatingSurface.css'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { Text } from './Text'

export function EditorContextMenu({ children, ref, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...props} ref={ref} className={`ctx-menu fixed z-[var(--z-overlay)] min-w-[var(--w-editor-context-menu)] flex flex-col p-1 floating-glass floating-pop-in [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)] ${props.className ?? ''}`}>{children}</div>
}

export function EditorContextMenuItem({ children, shortcut, ref, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; shortcut?: string; ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  return <button {...props} ref={ref} className={`btn ctx-item border-none flex w-full items-center justify-between gap-[var(--space-editor-menu-gap)] rounded-[var(--tr-radius-input)] bg-transparent py-[var(--space-editor-menu-y)] px-2.5 text-left text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)] ${props.className ?? ''}`}>{shortcut ? <><Text as="span" size="small" weight="small">{children}</Text><Text as="span" size="small" weight="small" tone="faint">{shortcut}</Text></> : children}</button>
}

export function EditorContextMenuSeparator(): React.JSX.Element {
  return <div className="ctx-sep h-px flex-none bg-[var(--border)] my-1 mx-1.5" />
}

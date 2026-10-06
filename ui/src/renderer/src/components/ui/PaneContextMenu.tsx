import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'
import { POP_ORIGIN_CLS } from './overlayChrome'

export function PaneContextMenu({ className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }): React.JSX.Element {
  return (
    <div
      {...rest}
      className={`ctx-menu fixed z-[var(--z-overlay)] min-w-[var(--w-pane-context-menu)] flex flex-col p-[var(--space-1)] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS} ${className}`.trim()}
    />
  )
}

export function PaneContextMenuSeparator(): React.JSX.Element {
  return <div className="ctx-sep h-px bg-[var(--border)] my-[var(--space-1)] mx-[var(--space-1-5)] flex-none" />
}

export function PaneContextMenuHead({ heading, detail }: { heading: string; detail: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-px px-[var(--space-2-5)] pt-[var(--space-1-5)] pb-[var(--space-1)] min-w-0 max-w-[var(--w-pane-context-menu-heading)]" data-testid="pane-menu-head">
      <Text size="small" weight="semibold" tone="primary" className="min-w-0 truncate">{heading}</Text>
      <Text size="small" weight="small" tone="muted" className="min-w-0 truncate">{detail}</Text>
    </div>
  )
}

export function PaneContextMenuRow({
  tone = 'normal',
  ...rest
}: { tone?: 'normal' | 'danger' } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...rest}
      className={`btn ctx-item border-none flex items-center justify-between gap-[var(--space-pane-menu-row-gap)] w-full py-[var(--space-pane-menu-row-block)] px-[var(--space-2-5)] rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] ${tone === 'danger' ? 'hover:text-[var(--danger)] disabled:hover:text-[var(--text-secondary)]' : 'hover:text-[var(--text-primary)] disabled:hover:text-[var(--text-secondary)]'} disabled:opacity-40 disabled:hover:bg-transparent`}
    />
  )
}

export function PaneContextMenuRowLabel({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <Text size="small" weight="small" tone="secondary" className={`flex items-center gap-[var(--space-2)] ${className}`.trim()}>{children}</Text>
}

export function PaneContextMenuCheck({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="text-[var(--accent)]">{children}</span>
}

export function PaneContextMenuChord({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" weight="small" tone="faint">{children}</Text>
}

export function PaneContextMenuGroupLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text
      as="div"
      size="label"
      weight="label"
      tone="faint"
      style={{ letterSpacing: 'var(--tr-text-label-tracking)' }}
      className="px-[var(--space-2-5)] pt-[var(--space-pane-menu-group-heading-top)] pb-px uppercase"
      role="presentation"
    >
      {children}
    </Text>
  )
}

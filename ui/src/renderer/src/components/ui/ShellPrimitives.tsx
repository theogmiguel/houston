import { createElement, forwardRef, type HTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { CopyChip } from './CopyChip'
import { Button } from './Button'
import { IconPencil } from '../icons'

type ShellRole =
  | 'browser-root' | 'browser-toolbar' | 'browser-address' | 'browser-favicon' | 'browser-server-menu'
  | 'browser-server-button' | 'browser-count' | 'browser-menu' | 'browser-menu-label' | 'browser-menu-url' | 'browser-card-meta'
  | 'browser-process' | 'browser-menu-empty' | 'browser-load' | 'browser-empty' | 'browser-content'
  | 'browser-section' | 'browser-live' | 'browser-cards' | 'browser-card' | 'browser-url' | 'browser-sub'
  | 'browser-pane-chip' | 'browser-hint' | 'browser-recent' | 'browser-recent-open' | 'browser-recent-favicon'
  | 'browser-remove' | 'browser-error' | 'browser-tab-favicon' | 'panel-pr-icon' | 'panel-header'
  | 'panel-tabs' | 'panel-icon-button' | 'panel-add-menu' | 'panel-add-item' | 'panel-add-key'
  | 'panel-launcher' | 'panel-launcher-column' | 'panel-launcher-title' | 'panel-launcher-rows'
  | 'panel-surface' | 'panel-linked-list' | 'panel-linked-row' | 'panel-linked-copy' | 'panel-linked-title'
  | 'panel-linked-meta' | 'panel-empty' | 'panel-body' | 'panel-overview' | 'pane-branch-detail-separator'
  | 'task-activity-content' | 'task-description-heading' | 'task-description-edit-button'
  | 'task-description-editor' | 'task-description-empty' | 'task-description-empty-label'
  | 'appearance-hidden-empty'

export type ShellState = 'overflowing' | 'disabled' | 'stop' | 'warn' | 'ok'

const SHELL_CLASS: Record<ShellRole, string> = {
  'browser-root': 'browser-surface',
  'browser-toolbar': 'browser-surface-toolbar',
  'browser-address': 'browser-surface-address',
  'browser-favicon': 'browser-surface-favicon',
  'browser-server-menu': 'browser-surface-server-menu',
  'browser-server-button': 'browser-surface-server-button',
  'browser-count': 'browser-surface-count',
  'browser-menu': 'browser-surface-menu',
  'browser-menu-label': 'browser-surface-menu-label',
  'browser-menu-url': 'browser-surface-menu-url',
  'browser-card-meta': 'browser-surface-card-meta',
  'browser-process': 'browser-surface-process',
  'browser-menu-empty': 'browser-surface-menu-empty',
  'browser-load': 'browser-surface-load',
  'browser-empty': 'browser-surface-empty',
  'browser-content': 'browser-surface-content',
  'browser-section': 'browser-surface-section',
  'browser-live': 'browser-surface-live',
  'browser-cards': 'browser-surface-cards',
  'browser-card': 'browser-surface-card',
  'browser-url': 'browser-surface-url',
  'browser-sub': 'browser-surface-sub',
  'browser-pane-chip': 'browser-surface-pane-chip',
  'browser-hint': 'browser-surface-hint',
  'browser-recent': 'browser-surface-recent',
  'browser-recent-open': 'browser-surface-recent-open',
  'browser-recent-favicon': 'browser-surface-recent-favicon',
  'browser-remove': 'browser-surface-remove',
  'browser-error': 'browser-surface-error',
  'browser-tab-favicon': 'browser-surface-tab-favicon',
  'panel-pr-icon': 'panel-tab-pr-icon',
  'panel-header': 'side-panel-header',
  'panel-tabs': 'side-panel-tabs',
  'panel-icon-button': 'side-panel-icon-button',
  'panel-add-menu': 'side-panel-add-menu',
  'panel-add-item': 'side-panel-add-item',
  'panel-add-key': 'side-panel-add-key',
  'panel-launcher': 'side-panel-launcher',
  'panel-launcher-column': 'side-panel-launcher-column',
  'panel-launcher-title': 'side-panel-launcher-title',
  'panel-launcher-rows': 'side-panel-launcher-rows',
  'panel-surface': 'side-panel-surface',
  'panel-linked-list': 'side-panel-linked-list',
  'panel-linked-row': 'side-panel-linked-row',
  'panel-linked-copy': 'side-panel-linked-copy',
  'panel-linked-title': 'side-panel-linked-title',
  'panel-linked-meta': 'side-panel-linked-meta',
  'panel-empty': 'side-panel-empty',
  'panel-body': 'side-panel-body',
  'panel-overview': 'side-panel-overview',
  'pane-branch-detail-separator': 'text-[var(--text-faint)]',
  'task-activity-content': 'grid gap-[var(--space-2)] p-[var(--space-3)]',
  'task-description-heading': 'group flex items-center',
  'task-description-edit-button': 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
  'task-description-editor': 'block w-full resize-none border-0 bg-transparent p-[var(--space-3)] text-[var(--text-primary)] outline-none focus-visible:shadow-[var(--focus-halo)]',
  'task-description-empty': 'flex items-center justify-between gap-[var(--space-2)] p-[var(--space-3)]',
  'task-description-empty-label': 'text-[var(--text-muted)]',
  'appearance-hidden-empty': 'px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]',
}

type ShellElementProps<T extends keyof React.JSX.IntrinsicElements> = {
  as: T
  shellRole: ShellRole
  state?: ShellState
} & Omit<React.ComponentPropsWithRef<T>, 'className'>

function shellClass(role: ShellRole, state?: ShellState): string {
  const modifier = state === 'overflowing' || state === 'disabled' || state === 'stop' || state === 'warn' || state === 'ok'
    ? ` is-${state}`
    : ''
  return `${SHELL_CLASS[role]}${modifier}`
}

export function ShellElement<T extends keyof React.JSX.IntrinsicElements>({ as, shellRole, state, ...props }: ShellElementProps<T>): React.JSX.Element {
  return createElement(as, { ...props, className: shellClass(shellRole, state) } as never)
}

export const ShellBrowserRoot = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ShellBrowserRoot(props, ref) {
  return <div {...props} ref={ref} className={SHELL_CLASS['browser-root']} />
})

export function ShellBranchCopyChip({ value, children }: { value: string; children: ReactNode }): React.JSX.Element {
  return <CopyChip value={value} className="h-5 rounded-[var(--tr-radius-xs)] px-[var(--space-1-5)] font-mono [font-size:var(--tr-text-label-size)]">{children}</CopyChip>
}

export function ShellTaskDescriptionEditButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return <Button variant="icon" icon={IconPencil} aria-label="Edit description" className={SHELL_CLASS['task-description-edit-button']} onClick={onClick} />
}

export const ShellTaskDescriptionTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function ShellTaskDescriptionTextarea(props, ref) {
  return <textarea {...props} ref={ref} className={SHELL_CLASS['task-description-editor']} />
})

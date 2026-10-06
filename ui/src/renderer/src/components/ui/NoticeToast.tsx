import type { ReactNode } from 'react'
import { HIT_TARGET_28 } from '../hitTarget'
import { IconAlertTriangle, IconCheck, IconClose, IconInfo, type IconComponent } from '../icons'
import { ICON_ROLE_CLS } from './Icon'
import { Text } from './Text'

export type NoticeToastKind = 'info' | 'success' | 'warning' | 'error'
export type NoticeToastAnchor = 'workspace-top' | 'workspace-top-right' | 'pane-corner'

const KIND_ICON: Record<NoticeToastKind, IconComponent> = {
  info: IconInfo,
  success: IconCheck,
  warning: IconAlertTriangle,
  error: IconAlertTriangle
}

const KIND_ICON_CLS: Record<NoticeToastKind, string> = {
  info: 'text-[var(--info)]',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--danger)]'
}

const KIND_BOX_CLS: Record<NoticeToastKind, string> = {
  info: 'border-[var(--border)] text-[var(--text-secondary)]',
  success: 'border-[color-mix(in_srgb,var(--success)_42%,transparent)] text-[var(--text-secondary)]',
  warning: 'border-[var(--border)] text-[var(--text-secondary)]',
  error: 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] text-[var(--text-primary)]'
}

const ANCHOR_CLS: Record<NoticeToastAnchor, string> = {
  'workspace-top':
    'absolute top-[var(--space-2)] left-1/2 -translate-x-1/2 z-[var(--z-notice-top-stack)] w-[min(var(--w-notice-top-stack),calc(100%-var(--space-5)))] flex flex-col gap-[var(--space-1)]',
  'workspace-top-right':
    'absolute top-[var(--space-3)] right-[var(--space-3)] z-[var(--z-toast)] flex flex-col items-end gap-[var(--space-2)]',
  'pane-corner':
    'absolute top-[var(--space-3)] right-[var(--space-3)] z-[var(--z-notice-pane-corner)] max-w-[min(var(--w-notice-pane-stack),calc(100%-var(--space-5)))] flex flex-col items-end gap-[var(--space-2)]'
}

// Entrances are keyed to the anchor: a top-centred stack drops in, a corner stack slides in.
const ANCHOR_MOTION: Record<NoticeToastAnchor, string> = {
  'workspace-top': 'motion-safe:[animation:var(--motion-notice-entry-top)]',
  'workspace-top-right': 'motion-safe:[animation:var(--motion-notice-entry-corner)]',
  'pane-corner': 'motion-safe:[animation:var(--motion-notice-entry-corner)]'
}

const ACTION_CLS =
  `${HIT_TARGET_28} shrink-0 min-w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] px-[var(--space-notice-action-inline)] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-inherit hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]`

/** Anchored, non-interactive region that stacks toasts; the toasts themselves take pointer events. */
export function NoticeToastRegion({ anchor, label, children }: {
  anchor: NoticeToastAnchor
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={label} aria-live="polite" className={`${ANCHOR_CLS[anchor]} pointer-events-none`}>
      {children}
    </section>
  )
}

/** One toast row: kind icon, title, optional mono body, an optional text action and an optional dismiss control. */
export function NoticeToast({ anchor, code, kind, heading, body, action, onDismiss }: {
  anchor: NoticeToastAnchor
  code: string
  kind: NoticeToastKind
  heading: string
  body?: string
  action?: { label: string; onClick: () => void }
  /** Present when the toast can be dismissed by the user. */
  onDismiss?: () => void
}): React.JSX.Element {
  const KindIcon = KIND_ICON[kind]
  return (
    <div
      data-notice={code}
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
      className={
        'pointer-events-auto flex items-center gap-[var(--space-notice-row-gap)] min-h-[var(--h-notice-row)] min-w-0 ' +
        'rounded-[var(--tr-radius-sm)] border bg-[color-mix(in_srgb,var(--card-bg)_94%,transparent)] ' +
        'py-[var(--space-notice-row-y)] pr-[var(--space-notice-inline-end)] pl-[var(--space-notice-inline-start)] ' +
        `${KIND_BOX_CLS[kind]} ` +
        ANCHOR_MOTION[anchor]
      }
    >
      <span className={`shrink-0 ${KIND_ICON_CLS[kind]}`}>
        <KindIcon className={ICON_ROLE_CLS.ui} />
      </span>
      <div className="flex flex-col gap-[var(--space-pixel)] min-w-0 flex-1">
        <Text size="caption" weight="label" tone="primary" className="break-words">
          {heading}
        </Text>
        {body && (
          <Text size="caption" weight="label" tone="faint" mono breakAll>
            {body}
          </Text>
        )}
      </div>
      {action && (
        <button type="button" onClick={action.onClick} className={ACTION_CLS}>
          <Text size="caption" weight="label" tone={kind === 'error' ? 'primary' : 'secondary'}>{action.label}</Text>
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label={`Dismiss ${heading}`}
          onClick={onDismiss}
          className={`${ACTION_CLS} inline-flex items-center justify-center`}
        >
          <IconClose className={ICON_ROLE_CLS.label} />
        </button>
      )}
    </div>
  )
}

/** Caption under a toast stack that says earlier toasts were dropped. */
export function NoticeEvictionCaption({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text size="caption" weight="label" tone="faint" className="pointer-events-none self-center">
      {children}
    </Text>
  )
}

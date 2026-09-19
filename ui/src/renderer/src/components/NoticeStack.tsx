import { HIT_TARGET_28 } from './hitTarget'
import { IconAlertTriangle, IconCheck, IconClose, IconInfo, type IconComponent } from './icons'
import { MAX_NOTICES, type NoticeKind, type NoticeStore } from '../notices'
import { ICON_ROLE_CLS } from './Icon'

export type NoticeAnchor = 'workspace-top' | 'pane-corner'

const KIND_ICON: Record<NoticeKind, IconComponent> = {
  info: IconInfo,
  success: IconCheck,
  warning: IconAlertTriangle,
  error: IconAlertTriangle
}

const KIND_ICON_CLS: Record<NoticeKind, string> = {
  info: 'text-[var(--info)]',
  success: 'text-[var(--success)]',
  warning: 'text-[var(--warning)]',
  error: 'text-[var(--danger)]'
}

const KIND_BOX_CLS: Record<NoticeKind, string> = {
  info: 'border-[var(--border)] text-[var(--text-secondary)]',
  success:
    'border-[color-mix(in_srgb,var(--success)_42%,transparent)] text-[var(--text-secondary)]',
  warning: 'border-[var(--border)] text-[var(--text-secondary)]',
  error: 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] text-[var(--text-primary)]'
}

const ANCHOR_CLS: Record<NoticeAnchor, string> = {
  'workspace-top':
    'absolute top-[8px] left-1/2 -translate-x-1/2 z-[calc(var(--z-leaf)+1)] w-[min(560px,100%-24px)] flex flex-col gap-[4px]',
  'pane-corner':
    'absolute bottom-[12px] right-[12px] z-[calc(var(--z-pane)+3)] max-w-[min(300px,100%-24px)] flex flex-col-reverse items-end gap-[6px]'
}

const ANCHOR_MOTION: Record<NoticeAnchor, string> = {
  'workspace-top': 'motion-safe:[animation:notice-in-top_200ms_var(--motion-menu-ease)]',
  'pane-corner': 'motion-safe:[animation:notice-in-corner_200ms_var(--motion-menu-ease)]'
}

export function NoticeStack({
  anchor,
  label,
  store
}: {
  anchor: NoticeAnchor
  label: string
  store: NoticeStore
}): React.JSX.Element | null {
  const rows = store.notices
  if (rows.length === 0) return null

  return (
    <section
      aria-label={label}
      aria-live="polite"
      className={`${ANCHOR_CLS[anchor]} pointer-events-none`}
    >
      {rows.map((n) => {
        const Icon = KIND_ICON[n.kind]
        return (
          <div
            key={n.id}
            data-notice={n.code}
            data-kind={n.kind}
            role={n.kind === 'error' ? 'alert' : 'status'}
            className={
              'pointer-events-auto flex items-center gap-[7px] min-h-[30px] min-w-0 ' +
              'rounded-[var(--tr-radius-sm)] border bg-[color-mix(in_srgb,var(--card-bg)_94%,transparent)] ' +
              'py-[5px] pr-[7px] pl-[9px] ' +
              `${KIND_BOX_CLS[n.kind]} ` +
              ANCHOR_MOTION[anchor]
            }
          >
            <span className={`shrink-0 ${KIND_ICON_CLS[n.kind]}`}>
              <Icon className={ICON_ROLE_CLS.ui} />
            </span>
            {}
            <div className="flex flex-col gap-px min-w-0 flex-1">
              <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-primary)] break-words">
                {n.title}
              </span>
              {n.body && (
                <span className="[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] font-mono text-[var(--text-faint)] break-all">
                  {n.body}
                </span>
              )}
            </div>
            {}
            {n.action && (
              <button
                type="button"
                onClick={n.action.onClick}
                className={`${HIT_TARGET_28} shrink-0 min-w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] px-[6px] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-inherit hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]`}
              >
                {n.action.label}
              </button>
            )}
            {n.dismissible && (
              <button
                type="button"
                aria-label={`Dismiss ${n.title}`}
                onClick={() => store.dismiss(n.code)}
                className={`${HIT_TARGET_28} shrink-0 inline-flex items-center justify-center min-w-[var(--h-ctl-mini)] h-[var(--h-ctl-mini)] px-[6px] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-inherit hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]`}
              >
                <IconClose className={ICON_ROLE_CLS.label} />
              </button>
            )}
          </div>
        )
      })}
      {store.evicted > 0 && (
        <span className="pointer-events-none self-center [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)]">
          {store.evicted === 1
            ? `1 earlier notice dropped — the stack holds ${MAX_NOTICES}`
            : `${store.evicted} earlier notices dropped — the stack holds ${MAX_NOTICES}`}
        </span>
      )}
    </section>
  )
}

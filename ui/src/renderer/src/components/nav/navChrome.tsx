import { IconChevronLeft } from '../icons'
import { Icon } from '../Icon'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'
import { PAGE_COLUMN_WIDE_CLS } from '../settingsPrimitives'

export const BLOCK =
  'overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--card-bg)]'

const ROW_BASE =
  'group/row relative px-[14px] py-[11px] [&+&]:border-t [&+&]:border-t-[var(--divider)] hover:bg-[var(--hover-fill)] focus-within:bg-[var(--hover-fill)]'
export const ROW = `${ROW_BASE} flex items-center gap-[12px]`
export const ROW_TOP = `${ROW_BASE} flex items-start gap-[12px]`
export const ROW_STACK = `${ROW_BASE} block`

export const ROW_TILE =
  'flex-none inline-flex items-center justify-center w-[34px] h-[34px] rounded-[var(--tr-radius-sm)] bg-[var(--hover-fill)] text-[var(--text-secondary)]'

export const ROW_TITLE =
  'truncate [font-size:var(--tr-text-ui-size)] font-semibold leading-[1.35] text-[var(--text-primary)]'

export const ROW_DETAIL =
  'truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.35] text-[var(--text-secondary)]'

export const ROW_FOOTER =
  'flex items-center min-h-[24px] mt-[2px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]'

export const ROW_ACTIONS =
  'ml-auto flex items-center gap-[2px] opacity-0 [transition:opacity_0.1s_ease-out] group-hover/row:opacity-100 group-focus-within/row:opacity-100'

const BUTTON_BASE =
  'btn inline-flex items-center justify-center gap-[7px] min-h-[var(--h-ctl)] px-[12px] rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default'
export const PRIMARY_BUTTON = `${BUTTON_BASE} border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 disabled:opacity-55`
export const SECONDARY_BUTTON = `${BUTTON_BASE} border border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:bg-[var(--selected-fill)] hover:text-[var(--text-primary)] disabled:opacity-55`

export const CHROME_BUTTON =
  `btn inline-flex items-center justify-center flex-none ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_0.1s_ease-out,background-color_0.1s_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--text-primary)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default`
export const CHROME_BUTTON_DANGER = `${CHROME_BUTTON} hover:not-disabled:text-[var(--danger)]!`

export const FIELD_LABEL = 'block mb-[7px] [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)]'
export const FIELD_INPUT =
  'w-full h-[36px] px-[12px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]'
export const FIELD_TEXTAREA =
  'w-full min-h-[88px] resize-y px-[12px] py-[9px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.5] text-[var(--text-primary)] outline-0 [font-family:inherit] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent)] disabled:opacity-[0.72]'

export function chipClass(pressed: boolean): string {
  return `btn min-h-[var(--h-ctl)] px-[9px] rounded-[var(--tr-radius-sm)] border border-[var(--border)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default disabled:opacity-60 ${
    pressed
      ? 'bg-[var(--selected-fill)] font-semibold text-[var(--text-primary)]'
      : 'bg-[var(--hover-fill)] font-medium text-[var(--text-secondary)] hover:not-disabled:bg-[var(--selected-fill)] hover:not-disabled:text-[var(--text-primary)]'
  }`
}

export function NavColumn({
  wide,
  children
}: {
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="nav-column"
      className={
        wide
          ? `w-full ${PAGE_COLUMN_WIDE_CLS} mx-auto px-[20px] py-[20px]`
          : 'w-[min(720px,100%-36px)] mx-auto pt-[18px] pb-[24px]'
      }
    >
      {children}
    </div>
  )
}

export function NavFeedback({
  tone = 'neutral',
  icon,
  children,
  onDismiss,
  testId
}: {
  tone?: 'neutral' | 'error' | 'warning'
  icon?: React.ReactNode
  children: React.ReactNode
  onDismiss?: () => void
  testId?: string
}): React.JSX.Element {
  const toneClass =
    tone === 'error'
      ? 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]'
      : tone === 'warning'
        ? 'border-[color-mix(in_srgb,var(--warning)_42%,transparent)] bg-[color-mix(in_srgb,var(--warning)_11%,transparent)]'
        : 'border-[var(--border)] bg-[var(--card-bg)]'
  const iconClass =
    tone === 'error'
      ? 'text-[var(--danger)]'
      : tone === 'warning'
        ? 'text-[var(--warning)]'
        : 'text-[var(--text-secondary)]'
  return (
    <div
      data-testid={testId}
      className={`flex items-center gap-[7px] min-h-[34px] mb-[10px] px-[10px] py-[8px] rounded-[var(--tr-radius-sm)] border [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--text-primary)] ${toneClass}`}
    >
      {icon && <span className={`flex-none ${iconClass}`}>{icon}</span>}
      <span className="flex-1 min-w-0">{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="btn flex-none border-0 bg-transparent px-[4px] py-[2px] [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-primary)] cursor-pointer"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

export function NavDetailState({
  title,
  detail,
  tone = 'neutral',
  action,
  testId
}: {
  title: string
  detail: string
  tone?: 'neutral' | 'error'
  action?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-busy={tone === 'neutral' ? true : undefined}
      className="flex flex-col items-center justify-center gap-[8px] p-[32px] text-center text-[var(--text-faint)]"
    >
      <strong
        className={`[font-size:var(--tr-text-ui-size)] font-semibold ${
          tone === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
        }`}
      >
        {title}
      </strong>
      <span className="max-w-[360px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5]">{detail}</span>
      {action && <div className="mt-[4px]">{action}</div>}
    </div>
  )
}

export function NavEmpty({
  icon,
  title,
  children,
  action,
  testId
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId ?? 'nav-empty'}
      className="flex flex-col items-center justify-center min-h-[330px] p-[28px] text-center"
    >
      <span className="inline-flex items-center justify-center w-[50px] h-[50px] mb-[14px] rounded-[10px] bg-[var(--hover-fill)] text-[var(--text-faint)]">
        {icon}
      </span>
      <h1 className="m-0 [font-size:var(--tr-text-ui-size)] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
        {title}
      </h1>
      <p className="max-w-[430px] mt-[7px] mb-[16px] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-secondary)] text-pretty">
        {children}
      </p>
      {action}
    </div>
  )
}

export function NavFootnote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      data-testid="nav-footnote"
      className="mt-[10px] mb-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.5] text-[var(--text-faint)]"
    >
      {children}
    </p>
  )
}

export function NavSwitch({
  on,
  disabled,
  label,
  onChange,
  testId
}: {
  on: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId ?? 'nav-switch'}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`btn relative flex-none w-[30px] h-[17px] p-0 rounded-full border cursor-pointer [transition:border-color_0.14s_ease-out,background-color_0.14s_ease-out] disabled:cursor-default disabled:opacity-55 ${HIT_TARGET_28} ${
        on
          ? 'border-[color-mix(in_srgb,var(--accent)_70%,transparent)] bg-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--hover-fill)]'
      }`}
    >
      {}
      <span
        className={`absolute top-[2px] left-[2px] w-[11px] h-[11px] rounded-full [transition:background-color_0.14s_ease-out,transform_0.14s_cubic-bezier(0.22,1,0.36,1)] ${
          on
            ? 'bg-[var(--accent-ink)] translate-x-[13px]'
            : 'bg-[var(--text-secondary)]'
        }`}
      />
    </button>
  )
}

export function NavBack({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex-none flex items-center gap-[8px] h-[42px] px-[14px] border-b border-[var(--divider)]">
      <button
        type="button"
        data-testid="nav-back"
        className="btn inline-flex items-center gap-[4px] p-0 border-0 bg-transparent [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]"
        onClick={onClick}
      >
        <Icon glyph={IconChevronLeft} role="label" />
        {label}
      </button>
      <span className="flex-1" />
      {children}
    </div>
  )
}

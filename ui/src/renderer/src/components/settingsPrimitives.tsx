import { Tooltip } from './Tooltip'
import { HIT_TARGET_28 } from './hitTarget'

export function Toggle({
  on,
  disabled,
  onChange,
  'data-testid': testId
}: {
  on: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      data-testid={testId}
      className={`btn sw relative w-[36px] h-[20px] rounded-full border-0 p-0 flex-none cursor-pointer disabled:opacity-50 disabled:cursor-default [transition:background_0.18s_ease] ${HIT_TARGET_28} ${
        on ? 'on bg-primary' : 'bg-[var(--border)]'
      }`}
      onClick={() => onChange(!on)}
    >
      {}
      <span
        className={`sw-knob absolute top-0.5 left-0.5 w-[16px] h-[16px] rounded-full [transition:transform_0.18s_var(--animate-ease-menu,ease),background_0.18s_ease] ${
          on ? '[transform:translateX(16px)] bg-white' : 'bg-[var(--text-muted)]'
        }`}
      />
    </button>
  )
}

// Exported here, not from SettingsView (off the boot path by rule), so a rail
// surface asks for the same column width instead of inventing a third number.
export const PAGE_COLUMN_CLS = 'max-w-[720px]'
export const PAGE_COLUMN_WIDE_CLS = 'max-w-[1040px]'

export type SettingsRowVariant = 'card' | 'flush' | 'list'

export function SettingsList({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-testid="settings-list"
      className={`border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] overflow-hidden ${className}`}
    >
      {children}
    </div>
  )
}

export function SectionHead({
  title,
  lede,
  actions
}: {
  title: string
  lede?: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="pb-[var(--space-5)] flex flex-col gap-[var(--space-1-5)]">
      <div className="flex items-center justify-between gap-[var(--space-4)]">
        <h1
          data-testid="settings-section-title"
          className="text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.25] text-[var(--text-primary)] m-0"
        >
          {title}
        </h1>
        {actions && (
          <div className="flex-none flex items-center gap-[var(--space-2)] h-[var(--h-ctl)]">{actions}</div>
        )}
      </div>
      {lede && (
        <p className="mb-0 text-[length:var(--tr-text-base)] leading-[1.6] text-[var(--text-muted)] max-w-[72ch]">
          {lede}
        </p>
      )}
    </header>
  )
}

export function SubHead({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2
      data-testid="settings-subhead"
      className="flex items-center gap-[var(--space-2)] pt-[var(--space-5)] pb-[var(--space-2)] pl-[2px] text-[length:var(--tr-text-label-size)] font-[var(--tr-text-label-weight)] tracking-[var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] text-[var(--text-faint)] [&:first-of-type]:pt-0"
    >
      {children}
    </h2>
  )
}

export function Group({
  heading,
  plain = false,
  children
}: {
  heading?: string
  plain?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid="settings-group" className="mb-0 [&+&]:pt-[var(--space-5)]">
      {heading && <SubHead>{heading}</SubHead>}
      {plain ? children : <SettingsList>{children}</SettingsList>}
    </section>
  )
}

export function SettingsRow({
  title,
  ...rest
}: Omit<React.ComponentProps<typeof Row>, 'variant'>): React.JSX.Element {
  return <Row variant="list" title={title} {...rest} />
}

export function Row({
  title,
  desc,
  indent,
  variant = 'card',
  children
}: {
  title: React.ReactNode
  desc?: React.ReactNode
  indent?: boolean
  variant?: SettingsRowVariant
  children?: React.ReactNode
}): React.JSX.Element {
  const geometry: Record<SettingsRowVariant, string> = {
    card: 'items-center gap-4 py-[11px] px-[14px] [&+&]:border-t [&+&]:border-t-[var(--divider)]',
    flush:
      'items-start gap-[var(--space-5)] py-[var(--space-3)] border-b border-b-[var(--divider)] last:border-b-0',
    list: 'items-center gap-[var(--space-5)] py-[var(--space-3)] px-[var(--space-4)] border-t border-t-[var(--divider)] first:border-t-0'
  }
  const indentPad: Record<SettingsRowVariant, string> = {
    card: 'pl-[30px]',
    flush: 'pl-[var(--space-4)]',
    list: 'pl-[var(--space-6)]'
  }
  const rowName = typeof title === 'string' ? title : undefined
  return (
    <div
      data-testid="settings-row"
      data-row-variant={variant}
      data-settings-row-name={rowName}
      className={`flex ${geometry[variant]} ${indent ? indentPad[variant] : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[var(--space-2)] text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{title}</div>
        {desc && (
          <Tooltip label={variant === 'list' && typeof desc === 'string' ? desc : undefined}>
            <div
              data-testid="settings-row-desc"
              className={`mt-[2px] text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)] ${
                variant === 'list'
                  ? typeof desc === 'string'
                    ? 'max-w-[58ch] overflow-hidden text-ellipsis whitespace-nowrap'
                    : ''
                  : variant === 'flush'
                    ? 'max-w-[62ch]'
                    : ''
              }`}
            >
              {desc}
            </div>
          </Tooltip>
        )}
      </div>
      {children && <div className="flex-none">{children}</div>}
    </div>
  )
}

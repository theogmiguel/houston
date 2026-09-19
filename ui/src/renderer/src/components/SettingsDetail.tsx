import { useEffect, useRef, useState } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { HIT_TARGET_28 } from './hitTarget'

export type RowDisableState = { disabled: false } | { disabled: true; reason: string }

export type SettingsRowControl =
  | { kind: 'node'; node: React.ReactNode }
  | {
      kind: 'destructive'
      label: string
      armedLabel: string
      onConfirm: () => void
    }

export interface SettingsRow {
  id: string
  label: string
  description?: string
  control: SettingsRowControl
  disable?: RowDisableState
}

export interface SettingsRowGroup {
  heading: string
  rows: SettingsRow[]
}

export interface SettingsDetailError {
  message: string
  onRetry: () => void
}

export interface SettingsDetailProps {
  title: string
  description?: string
  groups?: SettingsRowGroup[]
  loading?: boolean
  error?: SettingsDetailError
  onSave: () => void
  saveLabel?: string
  dirty?: boolean
  className?: string
}

const ARM_TIMEOUT_MS = 4000

function DestructiveControl({
  label,
  armedLabel,
  onConfirm,
  disabled
}: {
  label: string
  armedLabel: string
  onConfirm: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const disarm = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setArmed(false)
  }

  return (
    <button
      type="button"
      data-testid="settings-destructive"
      data-armed={armed || undefined}
      disabled={disabled}
      onBlur={disarm}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          timerRef.current = setTimeout(disarm, ARM_TIMEOUT_MS)
          return
        }
        disarm()
        onConfirm()
      }}
      className={`btn h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-button)] border text-[length:var(--tr-text-ui-size)] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed ${
        armed
          ? 'border-[var(--danger)] bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)]'
          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--danger)] hover:bg-[var(--surface-hover)]'
      }`}
    >
      {armed ? armedLabel : label}
    </button>
  )
}

function Spinner(): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[14px] w-[14px] animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

function RowView({ row }: { row: SettingsRow }): React.JSX.Element {
  const disable = row.disable
  const disabled = disable?.disabled === true
  const reason = disabled ? disable.reason : undefined

  let control: React.ReactNode
  if (row.control.kind === 'destructive') {
    control = (
      <DestructiveControl
        label={row.control.label}
        armedLabel={row.control.armedLabel}
        onConfirm={row.control.onConfirm}
        disabled={disabled}
      />
    )
  } else {
    control = row.control.node
  }

  return (
    <div
      data-testid="settings-detail-row"
      className="flex items-start gap-[var(--space-5)] py-[var(--space-3)] [&+&]:border-t [&+&]:border-t-[var(--divider)]"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{row.label}</div>
        {row.description && (
          <div className="mt-[3px] text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)] max-w-[62ch]">
            {row.description}
          </div>
        )}
        {reason && (
          <div
            data-testid="settings-row-disabled-reason"
            className="mt-[3px] text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--danger)]"
          >
            {reason}
          </div>
        )}
      </div>
      <div
        aria-disabled={disabled || undefined}
        onClickCapture={
          disabled
            ? (e) => {
                e.preventDefault()
                e.stopPropagation()
              }
            : undefined
        }
        className={`flex-none flex items-center gap-[var(--space-2)] ${
          disabled ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        {control}
      </div>
    </div>
  )
}

export function SettingsDetail({
  title,
  description,
  groups,
  loading = false,
  error,
  onSave,
  saveLabel = 'Save',
  dirty = false,
  className = ''
}: SettingsDetailProps): React.JSX.Element {
  return (
    <div data-testid="settings-detail" className={`flex flex-col h-full min-h-0 ${className}`}>
      <div className="flex-1 min-h-0 overflow-y-auto px-[var(--space-6)] py-[var(--space-6)]">
        <h1 className="[font-size:var(--tr-text-subhead-size)] font-semibold text-[var(--text-primary)] mb-[var(--space-1-5)]">{title}</h1>
        {description && (
          <p className="text-[length:var(--tr-text-base)] text-[var(--text-secondary)] leading-relaxed max-w-[72ch] mb-[var(--space-5)]">
            {description}
          </p>
        )}

        {error ? (
          <div
            data-testid="settings-detail-error"
            className="flex items-center gap-[var(--space-3)] rounded-[var(--tr-radius-card)] border border-[var(--danger)] bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <span className="flex-1 text-[length:var(--tr-text-small-size)]">{error.message}</span>
            <button
              type="button"
              onClick={error.onRetry}
              className={`bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current text-[length:var(--tr-text-small-size)] font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
            >
              Try again
            </button>
          </div>
        ) : loading ? (
          <div
            data-testid="settings-detail-loading"
            className="flex items-center gap-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] py-[var(--space-4)]"
          >
            <Spinner />
            Loading…
          </div>
        ) : groups === undefined ? (
          <div
            data-testid="settings-detail-empty"
            className="py-[var(--space-6)] text-center text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]"
          >
            Nothing here yet
          </div>
        ) : groups.length === 0 ? (
          <div
            data-testid="settings-detail-empty-set"
            className="py-[var(--space-6)] text-center text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]"
          >
            Nothing to configure here
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.heading} className="mb-[var(--space-6)] last:mb-0">
              <h2 className="[font-size:var(--tr-text-body-size)] font-semibold text-[var(--text-primary)] pb-[var(--space-2)] mb-[var(--space-1)] border-b border-[var(--divider)]">
                {group.heading}
              </h2>
              {group.rows.map((row) => (
                <RowView key={row.id} row={row} />
              ))}
            </section>
          ))
        )}
      </div>

      <div
        data-testid="settings-detail-save-bar"
        className="sticky bottom-0 flex-none flex items-center justify-end gap-[var(--space-2)] border-t border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-6)] py-[var(--space-3)]"
      >
        <button
          type="button"
          data-testid="settings-detail-save"
          disabled={!dirty || loading}
          onClick={onSave}
          className={`btn h-[var(--h-ctl)] px-[var(--space-4)] rounded-[var(--tr-radius-button)] border border-[var(--accent)] bg-[var(--accent)] text-[var(--primary-foreground)] text-[length:var(--tr-text-ui-size)] font-semibold hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  )
}

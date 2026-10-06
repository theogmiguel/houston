import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Text } from './Text'

export type RowDisableState = { disabled: false } | { disabled: true; reason: string }

export type SettingsRowControl =
  | { kind: 'node'; node: React.ReactNode }
  | { kind: 'destructive'; label: string; armedLabel: string; onConfirm: () => void }

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

function DestructiveControl({ label, armedLabel, onConfirm, disabled }: {
  label: string
  armedLabel: string
  onConfirm: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const disarm = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setArmed(false)
  }

  return <Button
    variant="danger-confirmation"
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
    className={armed
      ? 'border-[var(--danger)] bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)]'
      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--danger)] hover:bg-[var(--surface-hover)]'}
  >{armed ? armedLabel : label}</Button>
}

function LoadingIndicator(): React.JSX.Element {
  return <span role="status" aria-label="Loading" className="inline-block h-[var(--tr-icon-body-size)] w-[var(--tr-icon-body-size)] animate-spin rounded-[var(--tr-radius-pill)] border-2 border-current border-t-transparent opacity-70" />
}

function SettingsFeedback({ error, loading }: { error?: SettingsDetailError; loading: boolean }): React.JSX.Element {
  if (error) return <div data-testid="settings-detail-error" className="flex items-center gap-[var(--space-3)] rounded-[var(--tr-radius-card)] border border-[var(--danger)] bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] px-[var(--space-4)] py-[var(--space-3)]">
    <Text size="small" className="flex-1">{error.message}</Text>
    <Button variant="compact-outline" onClick={error.onRetry}>Try again</Button>
  </div>
  if (loading) return <div data-testid="settings-detail-loading" className="flex items-center gap-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] py-[var(--space-4)]">
    <LoadingIndicator />
    <Text size="small" tone="muted">Loading…</Text>
  </div>
  return <Text as="div" data-testid="settings-detail-empty" size="small" tone="muted" center className="py-[var(--space-6)]">Nothing here yet</Text>
}

function DetailRow({ row }: { row: SettingsRow }): React.JSX.Element {
  const disabled = row.disable?.disabled === true
  const reason = row.disable?.disabled === true ? row.disable.reason : undefined
  const control = row.control.kind === 'destructive'
    ? <DestructiveControl {...row.control} disabled={disabled} />
    : row.control.node
  return <div data-testid="settings-detail-row" className="flex items-start gap-[var(--space-5)] py-[var(--space-3)] [&+&]:border-t [&+&]:border-t-[var(--divider)]">
    <div className="min-w-0 flex-1">
      <div className="flex flex-col gap-[var(--space-settings-detail-caption)]">
        <Text as="div" className="text-[length:var(--tr-text-ui-size)] font-medium text-[var(--text-primary)]">{row.label}</Text>
        {row.description && <Text as="div" className="text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)] max-w-[var(--w-settings-description)]">{row.description}</Text>}
        {reason && <Text as="div" data-testid="settings-row-disabled-reason" className="text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--danger)]">{reason}</Text>}
      </div>
    </div>
    <div aria-disabled={disabled || undefined} onClickCapture={disabled ? (event) => {
      event.preventDefault()
      event.stopPropagation()
    } : undefined} className={`flex-none flex items-center gap-[var(--space-2)] ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
      {control}
    </div>
  </div>
}

export function SettingsDetailPanel({ title, description, groups, loading = false, error, onSave, saveLabel = 'Save', dirty = false, className = '' }: SettingsDetailProps): React.JSX.Element {
  const contentGap = description ? 'gap-[var(--space-5)]' : 'gap-[var(--space-1-5)]'
  return <div data-testid="settings-detail" className={`flex flex-col h-full min-h-0 ${className}`}>
    <div className={`flex flex-col flex-1 min-h-0 overflow-y-auto px-[var(--space-6)] py-[var(--space-6)] ${contentGap}`}>
      <header className="flex flex-col gap-[var(--space-1-5)]">
        <Text as="h1" size="subhead" weight="semibold" tone="primary">{title}</Text>
        {description && <Text as="p" className="text-[length:var(--tr-text-base)] text-[var(--text-secondary)] leading-relaxed max-w-[var(--w-settings-intro)]">{description}</Text>}
      </header>
      <div className="flex flex-col gap-[var(--space-6)]">
        {error ? <SettingsFeedback error={error} loading={loading} /> : loading ? <SettingsFeedback loading /> : groups === undefined ? <SettingsFeedback loading={false} /> : groups.length === 0 ? <Text as="div" data-testid="settings-detail-empty-set" size="small" tone="muted" center className="py-[var(--space-6)]">Nothing to configure here</Text> : groups.map((group) => <section key={group.heading} className="flex flex-col gap-[var(--space-1)]">
          <Text as="h2" className="[font-size:var(--tr-text-body-size)] font-semibold text-[var(--text-primary)] pb-[var(--space-2)] border-b border-[var(--divider)]">{group.heading}</Text>
          <div className="flex flex-col">{group.rows.map((row) => <DetailRow key={row.id} row={row} />)}</div>
        </section>)}
      </div>
    </div>
    <div data-testid="settings-detail-save-bar" className="sticky bottom-0 flex-none flex items-center justify-end gap-[var(--space-2)] border-t border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-6)] py-[var(--space-3)]">
      <Button variant="confirm-primary" data-testid="settings-detail-save" disabled={!dirty || loading} onClick={onSave}>{saveLabel}</Button>
    </div>
  </div>
}

export function SettingsDetailPanelSpecimen(): React.JSX.Element {
  return <div className="h-[var(--h-settings-detail-specimen)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)]"><SettingsDetailPanel
    title="Workspace settings"
    description="Control how Houston uses this workspace."
    groups={[{ heading: 'Workspace', rows: [{ id: 'name', label: 'Workspace name', description: 'The label shown in the sidebar.', control: { kind: 'node', node: <Text size="small" tone="secondary">Houston</Text> } }] }]}
    dirty
    onSave={() => {}}
  /></div>
}

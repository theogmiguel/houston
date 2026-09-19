import { useRef, useState } from 'react'
import { FOCUS_HALO } from './shadowChrome'
import { BTN_PRIMARY } from './buttonChrome'
import { Select } from './Select'
import { OVERLAY_RAISED_CLS, OVERLAY_RAISED_ATTRS } from './overlayChrome'
import { IconChevronDown } from './icons'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export interface ComposerChipOption {
  value: string
  label: string
}

export interface ComposerChip {
  id: string
  icon?: React.ReactNode
  label: string
  value: string
  options: ComposerChipOption[]
  onChange: (value: string) => void
  disabled?: boolean
  disabledReason?: string
}

export interface ComposerControlsProps {
  chips: ComposerChip[]
  sendLabel?: string
  onSend: () => void
  sendDisabled?: boolean
  loading?: boolean
  className?: string
}

const VISIBLE_CHIP_BUDGET = 3

function Spinner(): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[12px] w-[12px] animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

function DropdownChip({
  chip,
  open,
  onToggle,
  onClose
}: {
  chip: ComposerChip
  open: boolean
  onToggle: () => void
  onClose: () => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const title = chip.disabled ? chip.disabledReason : undefined

  return (
    <div
      ref={wrapRef}
      className="relative inline-flex"
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) onClose()
      }}
    >
      <Tooltip label={title} className="inline-flex">
        <button
          type="button"
          data-testid="composer-chip"
          data-chip-id={chip.id}
          disabled={chip.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
          className={`inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-full px-[var(--space-2)] border border-[var(--border)] bg-[var(--surface)] rounded-[var(--tr-radius-pill)] text-[length:var(--tr-text-small-size)] font-medium leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`}
        >
          {chip.icon && (
            <span aria-hidden className="flex-none">
              {chip.icon}
            </span>
          )}
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{chip.label}</span>
          <span aria-hidden className="flex-none">
            <Icon glyph={IconChevronDown} role="label" />
          </span>
        </button>
      </Tooltip>
      {open && (
        <div
          data-testid="composer-chip-menu"
          role="listbox"
          aria-label={chip.label}
          {...OVERLAY_RAISED_ATTRS}

          className={`${OVERLAY_RAISED_CLS} absolute left-0 top-[calc(100%+4px)] z-[var(--z-sticky)] flex flex-col gap-0.5 py-1 min-w-[160px]`}
        >
          {chip.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === chip.value}
              data-testid="composer-chip-option"
              onClick={() => {
                chip.onChange(opt.value)
                onClose()
              }}
              className={`flex items-center px-[var(--space-3)] min-h-[var(--h-ctl)] text-left bg-transparent border-none text-[length:var(--tr-text-small-size)] hover:bg-[var(--surface-hover)] ${
                opt.value === chip.value
                  ? 'text-[var(--text-primary)] font-semibold'
                  : 'text-[var(--text-secondary)] font-medium'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function OverflowChip({
  chips,
  open,
  onToggle,
  onClose
}: {
  chips: ComposerChip[]
  open: boolean
  onToggle: () => void
  onClose: () => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={wrapRef}
      className="relative inline-flex"
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) onClose()
      }}
    >
      <button
        type="button"
        data-testid="composer-chip-overflow"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={onToggle}
        className={`inline-flex items-center h-[var(--h-pill)] px-[var(--space-2)] border border-[var(--border)] bg-[var(--surface)] rounded-[var(--tr-radius-pill)] text-[length:var(--tr-text-small-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`}
      >
        +<span className="tabular-nums">{chips.length}</span>
      </button>
      {open && (
        <div
          data-testid="composer-chip-overflow-menu"
          {...OVERLAY_RAISED_ATTRS}

          className={`${OVERLAY_RAISED_CLS} absolute right-0 top-[calc(100%+4px)] z-[var(--z-sticky)] flex flex-col gap-[var(--space-2)] p-[var(--space-2)] min-w-[200px]`}
        >
          {chips.map((chip) => (
            <label
              key={chip.id}
              className="flex items-center justify-between gap-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)]"
            >
              <span className="flex-none">{chip.label.split(' · ')[0]}</span>
              <Select
                data-testid="composer-chip-overflow-select"
                value={chip.value}
                options={chip.options.map((opt) => ({ value: opt.value, label: opt.label }))}
                disabled={chip.disabled}
                title={chip.disabled ? chip.disabledReason : undefined}
                onChange={chip.onChange}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export function ComposerControls({
  chips,
  sendLabel = 'Send',
  onSend,
  sendDisabled = false,
  loading = false,
  className = ''
}: ComposerControlsProps): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const visible = chips.slice(0, VISIBLE_CHIP_BUDGET)
  const overflow = chips.slice(VISIBLE_CHIP_BUDGET)

  return (
    <div
      data-testid="composer-controls"
      className={`flex items-center gap-[var(--space-1-5)] flex-wrap ${className}`}
    >
      {visible.map((chip) => (
        <DropdownChip
          key={chip.id}
          chip={chip}
          open={openId === chip.id}
          onToggle={() => setOpenId((cur) => (cur === chip.id ? null : chip.id))}
          onClose={() => setOpenId((cur) => (cur === chip.id ? null : cur))}
        />
      ))}
      {overflow.length > 0 && (
        <OverflowChip
          chips={overflow}
          open={openId === '__overflow__'}
          onToggle={() => setOpenId((cur) => (cur === '__overflow__' ? null : '__overflow__'))}
          onClose={() => setOpenId((cur) => (cur === '__overflow__' ? null : cur))}
        />
      )}
      <button
        type="button"
        data-testid="composer-send"
        disabled={sendDisabled || loading}
        aria-busy={loading || undefined}
        onClick={onSend}
        className={`btn ${BTN_PRIMARY} ml-auto h-[var(--h-pill)] px-[var(--space-3)] rounded-[var(--tr-radius-pill)] text-[length:var(--tr-text-small-size)] inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {loading && <Spinner />}
        {sendLabel}
      </button>
    </div>
  )
}

import { useRef, useState } from 'react'
import { Select } from './ui/Select'
import { IconChevronDown } from './icons'
import { Icon } from './ui/Icon'
import { Tooltip } from './ui/Tooltip'
import { ComposerBar, ComposerPill, ComposerPillCount, ComposerPillField, ComposerPillMenu, ComposerPillOption, ComposerSendButton } from './ui/ComposerPill'

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
        <ComposerPill
          variant="dropdown"
          data-testid="composer-chip"
          data-chip-id={chip.id}
          disabled={chip.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        >
          {chip.icon && (
            <span aria-hidden className="flex-none">
              {chip.icon}
            </span>
          )}
          <span className="min-w-0 truncate">{chip.label}</span>
          <span aria-hidden className="flex-none">
            <Icon glyph={IconChevronDown} role="label" />
          </span>
        </ComposerPill>
      </Tooltip>
      {open && (
        <ComposerPillMenu variant="options" data-testid="composer-chip-menu" role="listbox" aria-label={chip.label}>
          {chip.options.map((opt) => (
            <ComposerPillOption
              key={opt.value}
              selected={opt.value === chip.value}
              data-testid="composer-chip-option"
              onClick={() => {
                chip.onChange(opt.value)
                onClose()
              }}
            >
              {opt.label}
            </ComposerPillOption>
          ))}
        </ComposerPillMenu>
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
      <ComposerPill variant="count" data-testid="composer-chip-overflow" aria-haspopup="true" aria-expanded={open} onClick={onToggle}>
        +<ComposerPillCount>{chips.length}</ComposerPillCount>
      </ComposerPill>
      {open && (
        <ComposerPillMenu variant="fields" data-testid="composer-chip-overflow-menu">
          {chips.map((chip) => (
            <ComposerPillField key={chip.id}>
              <span className="flex-none">{chip.label.split(' · ')[0]}</span>
              <Select
                data-testid="composer-chip-overflow-select"
                value={chip.value}
                options={chip.options.map((opt) => ({ value: opt.value, label: opt.label }))}
                disabled={chip.disabled}
                title={chip.disabled ? chip.disabledReason : undefined}
                onChange={chip.onChange}
              />
            </ComposerPillField>
          ))}
        </ComposerPillMenu>
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
    <ComposerBar data-testid="composer-controls" className={className}>
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
      <ComposerSendButton data-testid="composer-send" disabled={sendDisabled} loading={loading} onClick={onSend}>
        {sendLabel}
      </ComposerSendButton>
    </ComposerBar>
  )
}

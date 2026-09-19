import { useEffect, useState } from 'react'
import { BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { HIT_TARGET_28 } from './hitTarget'
import { Icon } from './Icon'
import { IconChevronDown } from './icons'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Tooltip } from './Tooltip'

export interface SplitButtonItem {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  testId?: string
}

export interface SplitButtonProps {
  label: string
  onClick: () => void
  items: SplitButtonItem[]
  testId?: string
  disabled?: boolean
  disabledReason?: string
}

export function SplitButton({
  label,
  onClick,
  items,
  testId,
  disabled = false,
  disabledReason
}: SplitButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  return (
    <div className="relative inline-flex">
      <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex">
        <button
          type="button"
          className={`btn ${BTN_PRIMARY} [border-top-right-radius:0] [border-bottom-right-radius:0]`}
          data-testid={testId}
          disabled={disabled}
          onClick={onClick}
        >
          {label}
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label={`${label} options`}
        data-testid={testId ? `${testId}-options` : undefined}
        aria-expanded={open}
        disabled={disabled}
        className={`btn ${BTN_PRIMARY} ${HIT_TARGET_28} [border-top-left-radius:0] [border-bottom-left-radius:0] border-l-[color-mix(in_srgb,var(--text-primary)_30%,var(--accent))] px-[var(--space-2)]`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon glyph={IconChevronDown} role="small" />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute bottom-[calc(100%+var(--space-1))] right-0 z-[var(--z-sticky)] min-w-[180px] flex flex-col p-[var(--space-1)] rounded-[var(--tr-radius-sm)] ${MATERIAL_CLS.raised}`}
          {...materialAttrs('raised')}
        >
          {items.map((item) => (
            <Tooltip key={item.label} label={item.disabled ? item.disabledReason : undefined} className="inline-flex w-full">
              <button
                type="button"
                role="menuitem"
                data-testid={item.testId}
                disabled={item.disabled}
                className={`btn ${BTN_SECONDARY} border-none rounded-[var(--tr-radius-sm)] w-full justify-start px-[var(--space-2)] py-[var(--space-1)] text-left text-[length:var(--tr-text-small-size)]`}
                onClick={() => {
                  if (item.disabled) return
                  setOpen(false)
                  item.onClick()
                }}
              >
                {item.label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}

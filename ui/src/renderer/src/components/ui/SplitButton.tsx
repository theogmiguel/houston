import { useEffect, useRef, useState } from 'react'
import { BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { HIT_TARGET_28 } from '../hitTarget'
import { Button } from './Button'
import { Icon } from './Icon'
import { IconChevronDown, IconColumns, IconGrid, IconRows } from '../icons'
import { MenuItem } from './MenuItem'
import { MATERIAL_CLS, materialAttrs } from './material'
import { Tooltip } from './Tooltip'
import type { ReactNode } from 'react'
import './floatingSurface.css'

export interface SplitButtonItem {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  testId?: string
  /** `titlebar-icon` menus only: leading glyph. */
  icon?: ReactNode
  /** `titlebar-icon` menus only: the chord, shown at the row's trailing edge. */
  shortcut?: string
}

export interface SplitButtonProps {
  label: string
  onClick: () => void
  items: SplitButtonItem[]
  testId?: string
  disabled?: boolean
  disabledReason?: string
  menuSide?: 'above' | 'below'
  glass?: boolean
  icon?: ReactNode
  /** `primary` is a filled text button; `titlebar-icon` is a quiet icon button for the topbar, where `label` is the accessible name. */
  variant?: 'primary' | 'titlebar-icon'
  /** `titlebar-icon` only: hover label for the main button when enabled. */
  tooltip?: string
}

export function SplitButton({
  label,
  onClick,
  items,
  testId,
  disabled = false,
  disabledReason,
  menuSide = 'above',
  glass = false,
  icon,
  variant = 'primary',
  tooltip
}: SplitButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  if (variant === 'titlebar-icon') {
    return (
      <div ref={rootRef} className="relative inline-flex items-center">
        <Tooltip label={disabled ? disabledReason : tooltip}>
          <Button variant="legacy-titlebar-icon" aria-label={label} data-testid={testId} disabled={disabled} onClick={onClick}>
            {icon}
          </Button>
        </Tooltip>
        <Tooltip label={`${label} options`}>
          <Button
            variant="legacy-titlebar-icon"
            className="!w-[var(--sz-split-chevron)]"
            aria-label={`${label} options`}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid={testId ? `${testId}-options` : undefined}
            disabled={disabled}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon glyph={IconChevronDown} role="small" />
          </Button>
        </Tooltip>
        {open && (
          <div
            role="menu"
            className={`absolute right-0 top-[calc(100%+var(--space-1))] z-[var(--z-sticky)] min-w-[200px] flex flex-col gap-[var(--space-1)] p-[var(--space-1)] rounded-[var(--tr-radius-md)] [-webkit-app-region:no-drag] ${MATERIAL_CLS.raised}`}
            {...materialAttrs('raised')}
          >
            {items.map((item) => (
              <MenuItem
                key={item.label}
                data-testid={item.testId}
                disabled={item.disabled}
                disabledReason={item.disabledReason}
                shortcut={item.shortcut}
                onClick={() => {
                  setOpen(false)
                  item.onClick()
                }}
              >
                <span className="flex items-center gap-[var(--space-2)]">
                  {item.icon}
                  {item.label}
                </span>
              </MenuItem>
            ))}
          </div>
        )}
      </div>
    )
  }
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
          {icon}{label}
        </button>
      </Tooltip>
      <Tooltip label={`${label} options`} className="inline-flex">
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
      </Tooltip>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-[var(--z-sticky)] min-w-[180px] flex flex-col p-[var(--space-1)] rounded-[var(--tr-radius-sm)] ${menuSide === 'below' ? 'top-[calc(100%+var(--space-1))]' : 'bottom-[calc(100%+var(--space-1))]'} ${glass ? 'floating-glass shadow-[var(--shadow-1)]' : MATERIAL_CLS.raised}`}
          {...materialAttrs(glass ? 'overlay-glass' : 'raised')}
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

export function SplitButtonSpecimen(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start gap-[var(--space-6)]">
      <SplitButton
        label="Commit"
        onClick={() => {}}
        items={[
          { label: 'Commit and push', onClick: () => {} },
          { label: 'Amend', onClick: () => {}, disabled: true, disabledReason: 'Nothing to amend' }
        ]}
      />
      <div className="h-[var(--h-primitives-preview)] w-[var(--w-split-specimen)] flex justify-end">
        <SplitButton
          variant="titlebar-icon"
          label="Tidy panes"
          tooltip="Tidy panes into a balanced grid"
          icon={<Icon glyph={IconGrid} role="ui" />}
          onClick={() => {}}
          items={[
            { label: 'Balanced grid', icon: <Icon glyph={IconGrid} role="ui" />, shortcut: 'y', onClick: () => {} },
            { label: 'One row', icon: <Icon glyph={IconRows} role="ui" />, shortcut: 'h', onClick: () => {} },
            { label: 'One column', icon: <Icon glyph={IconColumns} role="ui" />, shortcut: 'v', onClick: () => {} }
          ]}
        />
      </div>
    </div>
  )
}

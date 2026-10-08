import { useState } from 'react'
import type { ButtonHTMLAttributes, MouseEvent } from 'react'
import { Icon } from './Icon'
import { IconCheck } from '../icons'

export type CheckboxProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'size' | 'onChange' | 'defaultChecked'> & {
  label?: string
  size?: 'default' | 'xs'
  checked?: boolean
  defaultChecked?: boolean
  readOnly?: boolean
  onChange?: (checked: boolean) => void
}

export function Checkbox({
  label,
  size = 'default',
  className = '',
  checked,
  defaultChecked = false,
  readOnly = false,
  disabled = false,
  onChange,
  onClick,
  ...props
}: CheckboxProps): React.JSX.Element {
  const [uncontrolledChecked, setUncontrolledChecked] = useState(defaultChecked)
  const isChecked = checked ?? uncontrolledChecked

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    onClick?.(event)
    if (event.defaultPrevented || disabled || readOnly) return

    const nextChecked = !isChecked
    if (checked === undefined) setUncontrolledChecked(nextChecked)
    onChange?.(nextChecked)
  }

  return (
    <label
      className={`inline-flex min-w-0 items-center gap-2 text-[var(--text-secondary)] ${
        size === 'xs' ? 'text-[length:var(--tr-text-xs)]' : 'text-[length:var(--tr-text-ui-size)]'
      } ${className}`}
    >
      <button
        {...props}
        type="button"
        role="checkbox"
        aria-checked={isChecked}
        disabled={disabled}
        onClick={handleClick}
        className={`relative grid size-4 flex-none place-items-center rounded-[var(--tr-radius-xs)] border border-[var(--border)]
          ${isChecked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'bg-[var(--content-bg)]'}
          focus-visible:shadow-[var(--focus-halo)] cursor-pointer`}
      >
        {isChecked && <Icon glyph={IconCheck} role="small" className="pointer-events-none text-[var(--accent-contrast)]" />}
      </button>
      {label && <span className="truncate">{label}</span>}
    </label>
  )
}

export function CheckboxSpecimen(): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <Checkbox label="Default checkbox" checked readOnly />
      <Checkbox label="Extra small" size="xs" />
    </div>
  )
}
